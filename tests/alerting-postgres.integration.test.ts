import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { PgAlertStateStore } from "../services/kernel/src/alerting/pg-state-store.js";
import { reduceCheck } from "../services/kernel/src/alerting/reducer.js";
import { fingerprintFor } from "../services/kernel/src/alerting/fingerprint.js";
import type { CheckResult } from "../services/kernel/src/health/types.js";

/**
 * KJ-P1.2 persistence-wiring fix — REAL cross-process persistence proof.
 *
 * Requires an explicit LOCAL throwaway test DB via KJ_TEST_PG_URL, with
 * supabase/migrations/20260915220000_alert_state.sql already applied to it
 * (same operator responsibility as tests/schedule-postgres.integration.test.ts —
 * this suite seeds rows, not DDL). Skips clearly when unset. NEVER touches
 * production — see the tripwire below, identical to the existing integration
 * suites' convention.
 *
 * "Two separate engine/CLI-style runs" is modelled here as two independent
 * `PgAlertStateStore` instances (fresh `new pg.Pool` each) against the SAME
 * database — PgAlertStateStore itself holds no in-process state, so this is a
 * faithful stand-in for two separate `kerneljson alerts` process invocations.
 */
const URL = process.env["KJ_TEST_PG_URL"];
const PROD_MARKERS = [
  "supabase.co", "supabase.com", "pooler.supabase", "supabase.in",
  "banqdzddfganzfhckdps", "lkwydqtfbdjhxaarelaz",
  "136.112.138.225", "35.242.183.206", "34.105.139.159",
];
const URL_ = globalThis.URL;
function assertLocalTestTarget(url: string): void {
  const lower = url.toLowerCase();
  for (const m of PROD_MARKERS)
    if (lower.includes(m)) throw new Error(`PRODUCTION TRIPWIRE: refusing target containing '${m}'`);
  let host: string;
  try {
    host = new URL_(url).hostname;
  } catch {
    throw new Error("unparseable KJ_TEST_PG_URL");
  }
  const localOk = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!localOk && process.env["KJ_TEST_PG_ALLOW_NONLOCAL"] !== "1")
    throw new Error(`PRODUCTION TRIPWIRE: non-local host '${host}' not explicitly test-authorised`);
}

const run = URL ? describe : describe.skip;
if (!URL)
  console.warn(
    "[alerting-postgres] SKIPPED: set KJ_TEST_PG_URL to a LOCAL throwaway Postgres (with " +
      "supabase/migrations/20260915220000_alert_state.sql applied) to run.",
  );

function mkCheck(id: string, status: CheckResult["status"]): CheckResult {
  return { id, status, evidence: "test", message: `${id} is ${status}`, checkedAt: new Date().toISOString() };
}

run("KJ-P1.2 alert-state persistence (real Postgres)", () => {
  let poolA: pg.Pool;
  let poolB: pg.Pool;
  const scheduleId = "11111111-1111-1111-1111-111111111111";
  const checkId = "scheduler.noDuplicateFireWindow";

  beforeAll(() => {
    assertLocalTestTarget(URL!);
    poolA = new pg.Pool({ connectionString: URL });
    poolB = new pg.Pool({ connectionString: URL });
  });

  afterAll(async () => {
    await poolA?.end();
    await poolB?.end();
  });

  beforeEach(async () => {
    // Isolate each test's fingerprint by using a fresh entity id per test via a
    // unique checkId suffix would complicate the reducer's known policy table,
    // so instead just clear this suite's rows before each test.
    await poolA.query("delete from kernel_private.alert_state where entity_id = $1", [scheduleId]);
  });

  it("1. two separate engine/CLI-style runs against the same persistent store deduplicate the same failure", async () => {
    const storeRun1 = new PgAlertStateStore(poolA);
    const storeRun2 = new PgAlertStateStore(poolB); // a genuinely separate connection/instance

    const existing1 = new Map((await storeRun1.getAll()).map((r) => [r.fingerprint, r]));
    const { nextRow: row1, decision: decision1 } = reduceCheck(
      existing1.get(reduceFp(checkId, scheduleId)) ?? null,
      mkCheck(checkId, "CRITICAL"),
      scheduleId,
      "2026-09-16T10:00:00.000Z",
    );
    expect(decision1?.kind).toBe("NEW");
    await storeRun1.putAll(row1 ? [row1] : []);

    // Second "run": a fresh store instance reads what the first run persisted.
    const existing2 = new Map((await storeRun2.getAll()).map((r) => [r.fingerprint, r]));
    const priorRow = existing2.get(reduceFp(checkId, scheduleId));
    expect(priorRow).toBeDefined();
    expect(priorRow!.occurrenceCount).toBe(1);
    const { nextRow: row2, decision: decision2 } = reduceCheck(
      priorRow ?? null,
      mkCheck(checkId, "CRITICAL"),
      scheduleId,
      "2026-09-16T10:05:00.000Z",
    );
    expect(decision2).toBeNull(); // deduped — the second run knows about the first
    await storeRun2.putAll(row2 ? [row2] : []);

    const finalRows = await storeRun1.getAll();
    const finalRow = finalRows.find((r) => r.fingerprint === reduceFp(checkId, scheduleId));
    expect(finalRow!.occurrenceCount).toBe(2);
  });

  it("2. recovery persists across runs", async () => {
    const storeRun1 = new PgAlertStateStore(poolA);
    const storeRun2 = new PgAlertStateStore(poolB);

    const { nextRow: opened } = reduceCheck(null, mkCheck(checkId, "CRITICAL"), scheduleId, "2026-09-16T10:00:00.000Z");
    await storeRun1.putAll(opened ? [opened] : []);

    // Separate run performs the recovery.
    const existing = new Map((await storeRun2.getAll()).map((r) => [r.fingerprint, r]));
    const priorRow = existing.get(reduceFp(checkId, scheduleId)) ?? null;
    const { nextRow: recovered, decision } = reduceCheck(priorRow, mkCheck(checkId, "HEALTHY"), scheduleId, "2026-09-16T10:09:14.000Z");
    expect(decision?.kind).toBe("RECOVERED");
    await storeRun2.putAll(recovered ? [recovered] : []);

    // A third, independent read confirms the recovery is durable, not just in
    // the second run's local memory.
    const storeRun3 = new PgAlertStateStore(poolA);
    const rows = await storeRun3.getAll();
    const row = rows.find((r) => r.fingerprint === reduceFp(checkId, scheduleId));
    expect(row!.currentState).toBe("RECOVERED");
    expect(row!.recoveredAt).toBe("2026-09-16T10:09:14.000Z");
  });

  it("3. recurrence after persisted recovery creates a fresh NEW episode", async () => {
    const store1 = new PgAlertStateStore(poolA);
    const { nextRow: opened } = reduceCheck(null, mkCheck(checkId, "CRITICAL"), scheduleId, "2026-09-16T10:00:00.000Z");
    await store1.putAll(opened ? [opened] : []);

    const store2 = new PgAlertStateStore(poolB);
    const afterOpen = (await store2.getAll()).find((r) => r.fingerprint === reduceFp(checkId, scheduleId)) ?? null;
    const { nextRow: recovered } = reduceCheck(afterOpen, mkCheck(checkId, "HEALTHY"), scheduleId, "2026-09-16T10:09:00.000Z");
    await store2.putAll(recovered ? [recovered] : []);

    // A third run, later, sees the recurrence.
    const store3 = new PgAlertStateStore(poolA);
    const afterRecovery = (await store3.getAll()).find((r) => r.fingerprint === reduceFp(checkId, scheduleId)) ?? null;
    expect(afterRecovery!.currentState).toBe("RECOVERED");
    const { nextRow: recurred, decision } = reduceCheck(afterRecovery, mkCheck(checkId, "CRITICAL"), scheduleId, "2026-09-16T11:00:00.000Z");
    expect(decision?.kind).toBe("NEW");
    expect(recurred!.firstSeenAt).toBe("2026-09-16T11:00:00.000Z");
    expect(recurred!.occurrenceCount).toBe(1);
    await store3.putAll(recurred ? [recurred] : []);

    const finalRow = (await store1.getAll()).find((r) => r.fingerprint === reduceFp(checkId, scheduleId));
    expect(finalRow!.currentState).toBe("OPEN");
    expect(finalRow!.occurrenceCount).toBe(1);
  });
});

function reduceFp(checkId: string, entityId: string): string {
  return fingerprintFor(checkId, entityId);
}
