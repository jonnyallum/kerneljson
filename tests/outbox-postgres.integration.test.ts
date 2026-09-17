import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import pg from "pg";
import { PgAlertStateStore } from "../services/kernel/src/alerting/pg-state-store.js";
import { PgNotificationOutboxStore } from "../services/kernel/src/alerting/pg-outbox-store.js";
import { reduceCheck } from "../services/kernel/src/alerting/reducer.js";
import { intentsFromDecisions } from "../services/kernel/src/alerting/outbox.js";
import { runDeliveryWorker } from "../services/kernel/src/alerting/delivery-worker.js";
import { RecordingNotifier } from "../services/kernel/src/alerting/notifier.js";
import type { DeliveryConfig } from "../services/kernel/src/alerting/outbox-types.js";
import type { CheckResult } from "../services/kernel/src/health/types.js";

/**
 * KJ-P2.1 persistence-wiring proof — REAL cross-process persistence, mirroring
 * tests/alerting-postgres.integration.test.ts's pattern exactly.
 *
 * Requires an explicit LOCAL throwaway test DB via KJ_TEST_PG_URL, with
 * supabase/migrations/20260915220000_alert_state.sql AND
 * supabase/migrations/20260917120000_notification_outbox.sql already applied
 * to it. Skips clearly when unset. NEVER touches production — see the
 * tripwire below, identical to the existing integration suites' convention.
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
    "[outbox-postgres] SKIPPED: set KJ_TEST_PG_URL to a LOCAL throwaway Postgres (with " +
      "supabase/migrations/20260915220000_alert_state.sql and " +
      "supabase/migrations/20260917120000_notification_outbox.sql applied) to run.",
  );

function mkCheck(id: string, status: CheckResult["status"]): CheckResult {
  return { id, status, evidence: "test", message: `${id} is ${status}`, checkedAt: new Date().toISOString() };
}

run("KJ-P2.1 notification outbox persistence (real Postgres)", () => {
  let poolA: pg.Pool;
  let poolB: pg.Pool;
  const scheduleId = "22222222-2222-2222-2222-222222222222";
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
    await poolA.query("delete from kernel_private.notification_delivery_events");
    await poolA.query("delete from kernel_private.notification_outbox where entity_id = $1", [scheduleId]);
    await poolA.query("delete from kernel_private.alert_state where entity_id = $1", [scheduleId]);
  });

  it("1. an intent commits atomically with the state row that produced it", async () => {
    const state = new PgAlertStateStore(poolA);
    const { nextRow, decision } = reduceCheck(null, mkCheck(checkId, "CRITICAL"), scheduleId, "2026-09-17T10:00:00.000Z");
    expect(decision?.kind).toBe("NEW");
    const intents = intentsFromDecisions(decision ? [decision] : [], "2026-09-17T10:00:00.000Z");
    await state.putAll(nextRow ? [nextRow] : [], intents);

    const outbox = new PgNotificationOutboxStore(poolB);
    const due = await outbox.listDue("2026-09-17T10:00:01.000Z", 10);
    expect(due).toHaveLength(1);
    expect(due[0]!.fingerprint).toBe(nextRow!.fingerprint);
    expect(due[0]!.status).toBe("PENDING");
  });

  it("2. replaying the identical decision (same fingerprint/firstSeenAt/kind/occurrenceCount) never enqueues a duplicate intent", async () => {
    const state = new PgAlertStateStore(poolA);
    const { nextRow, decision } = reduceCheck(null, mkCheck(checkId, "CRITICAL"), scheduleId, "2026-09-17T10:00:00.000Z");
    const intents = intentsFromDecisions(decision ? [decision] : [], "2026-09-17T10:00:00.000Z");
    // Two separate "runs" (a Restate ctx.run retry, a crash-then-replay)
    // computing and persisting the SAME decision.
    await state.putAll(nextRow ? [nextRow] : [], intents);
    await state.putAll(nextRow ? [nextRow] : [], intents);

    const rows = await poolA.query(
      "select count(*) as n from kernel_private.notification_outbox where fingerprint = $1",
      [nextRow!.fingerprint],
    );
    expect(rows.rows[0].n).toBe("1");
  });

  it("3. listDue respects the next_attempt_at gate and status, oldest first, across independent pools", async () => {
    const outboxA = new PgNotificationOutboxStore(poolA);
    const outboxB = new PgNotificationOutboxStore(poolB);
    await outboxA.enqueue([
      mkIntent(scheduleId, "future", "2026-09-17T12:00:00.000Z"),
      mkIntent(scheduleId, "due-later", "2026-09-17T10:05:00.000Z"),
      mkIntent(scheduleId, "due-first", "2026-09-17T10:01:00.000Z"),
    ]);
    const due = await outboxB.listDue("2026-09-17T10:10:00.000Z", 10);
    const ids = due.map((r) => r.checkId).filter((id) => id.startsWith("kj-p2-test."));
    expect(ids).toEqual(["kj-p2-test.due-first", "kj-p2-test.due-later"]);
  });

  it("4. markSending/applyOutcome round-trip is durable and visible from a separate pool", async () => {
    const outboxA = new PgNotificationOutboxStore(poolA);
    const outboxB = new PgNotificationOutboxStore(poolB);
    const [intent] = [mkIntent(scheduleId, "roundtrip", "2026-09-17T10:00:00.000Z")];
    await outboxA.enqueue([intent!]);

    const claimed = await outboxA.markSending(intent!.notificationId, "2026-09-17T10:01:00.000Z");
    expect(claimed?.status).toBe("SENDING");
    expect(claimed?.attemptCount).toBe(1);

    // A DIFFERENT connection sees the SENDING state — proves it's a real
    // committed row, not connection-local state.
    const seenByB = await poolB.query("select status from kernel_private.notification_outbox where notification_id = $1", [intent!.notificationId]);
    expect(seenByB.rows[0].status).toBe("SENDING");

    await outboxA.applyOutcome({ ...claimed!, status: "DELIVERED", deliveredAt: "2026-09-17T10:01:05.000Z" }, "DELIVERED", null, 1, "2026-09-17T10:01:05.000Z", "console");

    const finalRow = (await outboxB.listDue("2026-09-17T99:00:00.000Z", 10)).find((r) => r.notificationId === intent!.notificationId);
    expect(finalRow).toBeUndefined(); // DELIVERED is never due again
    const events = await poolB.query("select outcome, transport from kernel_private.notification_delivery_events where notification_id = $1", [intent!.notificationId]);
    expect(events.rows).toEqual([{ outcome: "DELIVERED", transport: "console" }]);
  });

  it("5. recoverStaleSending-equivalent: listStaleSending finds an abandoned SENDING row from a prior (dead) run, leaves a fresh one alone", async () => {
    const outboxA = new PgNotificationOutboxStore(poolA);
    const stale = mkIntent(scheduleId, "abandoned", "2026-09-17T08:00:00.000Z");
    const fresh = mkIntent(scheduleId, "live", "2026-09-17T08:00:00.000Z");
    await outboxA.enqueue([stale, fresh]);
    await outboxA.markSending(stale.notificationId, "2026-09-17T09:00:00.000Z"); // 2h before the check below
    await outboxA.markSending(fresh.notificationId, "2026-09-17T10:59:00.000Z"); // 1 min before the check below

    const staleRows = await outboxA.listStaleSending("2026-09-17T11:00:00.000Z", 120000);
    expect(staleRows.map((r) => r.notificationId)).toEqual([stale.notificationId]);
  });

  it("6. runDeliveryWorker end to end: successful delivery marks DELIVERED and logs one DELIVERED event", async () => {
    const outbox = new PgNotificationOutboxStore(poolA);
    const intent = mkIntent(scheduleId, "e2e-success", "2026-09-17T10:00:00.000Z");
    await outbox.enqueue([intent]);
    const notifier = new RecordingNotifier();
    const summary = await runDeliveryWorker({ outbox, notifier, transport: "test", now: () => new Date("2026-09-17T10:00:01.000Z") });
    expect(summary).toMatchObject({ attempted: 1, delivered: 1, retried: 0, poisoned: 0, result: "OK" });
    expect(notifier.sent).toHaveLength(1);
    const row = (await poolA.query("select status from kernel_private.notification_outbox where notification_id = $1", [intent.notificationId])).rows[0];
    expect(row.status).toBe("DELIVERED");
    const events = await poolA.query("select outcome from kernel_private.notification_delivery_events where notification_id = $1", [intent.notificationId]);
    expect(events.rows).toEqual([{ outcome: "DELIVERED" }]);
  });

  it("7. a transient failure retries with backoff and does not touch alert_state or create a second outbox row", async () => {
    const outbox = new PgNotificationOutboxStore(poolA);
    const intent = mkIntent(scheduleId, "e2e-transient", "2026-09-17T10:00:00.000Z");
    await outbox.enqueue([intent]);
    const notify = vi.fn().mockRejectedValueOnce(new Error("transient transport hiccup")).mockResolvedValue(undefined);
    const failingOnce = { notify };
    const config: DeliveryConfig = { baseDelayMs: 1000, maxDelayMs: 60000, maxAttempts: 5, staleSendingMs: 120000 };
    const first = await runDeliveryWorker({ outbox, notifier: failingOnce, transport: "test", config, now: () => new Date("2026-09-17T10:00:01.000Z") });
    expect(first).toMatchObject({ attempted: 1, delivered: 0, retried: 1 });
    // Not due again at the same instant (bounded backoff).
    const tooSoon = await runDeliveryWorker({ outbox, notifier: failingOnce, transport: "test", config, now: () => new Date("2026-09-17T10:00:01.500Z") });
    expect(tooSoon.attempted).toBe(0);
    const second = await runDeliveryWorker({ outbox, notifier: failingOnce, transport: "test", config, now: () => new Date("2026-09-17T10:00:03.000Z") });
    expect(second).toMatchObject({ attempted: 1, delivered: 1 });
    const count = await poolA.query("select count(*) as n from kernel_private.notification_outbox where notification_id = $1", [intent.notificationId]);
    expect(count.rows[0].n).toBe("1"); // still exactly one row, never duplicated by the retries
  });

  it("8. poison after exhausting the attempt budget becomes queryable operational state", async () => {
    const outbox = new PgNotificationOutboxStore(poolA);
    const intent = mkIntent(scheduleId, "e2e-poison", "2026-09-17T10:00:00.000Z");
    await outbox.enqueue([intent]);
    const alwaysFails: { notify: () => Promise<void> } = { notify: async () => { throw new Error("permanent transport outage"); } };
    const config: DeliveryConfig = { baseDelayMs: 10, maxDelayMs: 100, maxAttempts: 2, staleSendingMs: 120000 };
    await runDeliveryWorker({ outbox, notifier: alwaysFails, transport: "test", config, now: () => new Date("2026-09-17T10:00:01.000Z") });
    const last = await runDeliveryWorker({ outbox, notifier: alwaysFails, transport: "test", config, now: () => new Date("2026-09-17T10:00:02.000Z") });
    expect(last.poisoned).toBe(1);
    const row = (await poolA.query("select status, attempt_count from kernel_private.notification_outbox where notification_id = $1", [intent.notificationId])).rows[0];
    expect(row.status).toBe("POISON");
    expect(row.attempt_count).toBe(2);
    // Operationally visible via a plain query — the literal requirement.
    const poisonedRows = await poolA.query("select notification_id from kernel_private.notification_outbox where status = 'POISON' and entity_id = $1", [scheduleId]);
    expect(poisonedRows.rows.map((r) => r.notification_id)).toContain(intent.notificationId);
  });

  it("9. process crash after delivery but before acknowledgement: recovered by a later run's stale-SENDING sweep, delivered exactly once MORE — proving AT-LEAST-ONCE, not exactly-once", async () => {
    const claimant = new PgNotificationOutboxStore(poolA);
    const intent = mkIntent(scheduleId, "e2e-ambiguous", "2026-09-17T10:00:00.000Z");
    await claimant.enqueue([intent]);

    class CrashBeforeAck extends PgNotificationOutboxStore {
      override async applyOutcome(): Promise<void> {
        // markSending (called by runDeliveryWorker just before this) already
        // committed durably. This never writes DELIVERED/the event — models
        // the process dying between the transport call succeeding and that
        // write landing. The row is left exactly as markSending left it:
        // status=SENDING, attempt_count=1.
        throw new Error("simulated crash before acknowledgement commit");
      }
    }
    const crashProneOutbox = new CrashBeforeAck(poolA);
    const notifier = new RecordingNotifier();
    const crashed = await runDeliveryWorker({ outbox: crashProneOutbox, notifier, transport: "test", now: () => new Date("2026-09-17T10:00:01.000Z") });
    expect(crashed.result).toBe("OUTBOX_FAILED");
    expect(notifier.sent).toHaveLength(1); // the transport call genuinely happened once

    const stuck = (await poolA.query("select status, attempt_count from kernel_private.notification_outbox where notification_id = $1", [intent.notificationId])).rows[0];
    expect(stuck.status).toBe("SENDING");
    expect(stuck.attempt_count).toBe(1);

    // A later, ordinary run — well past the stale-SENDING threshold —
    // recovers it and delivers for real.
    const recovering = new PgNotificationOutboxStore(poolB);
    const config: DeliveryConfig = { baseDelayMs: 1000, maxDelayMs: 60000, maxAttempts: 5, staleSendingMs: 120000 };
    const recovered = await runDeliveryWorker({ outbox: recovering, notifier, transport: "test", config, now: () => new Date("2026-09-17T10:05:00.000Z") });
    expect(recovered.recovered).toBe(1);
    expect(recovered.delivered).toBe(1);

    // The SAME notification was handed to the notifier TWICE — this is the
    // explicit, honest guarantee: AT-LEAST-ONCE with an idempotency key
    // (notificationId), never claimed as exactly-once.
    expect(notifier.sent).toHaveLength(2);
    expect(new Set(notifier.sent.map((p) => p.notificationId))).toEqual(new Set([intent.notificationId]));

    const finalRow = (await poolA.query("select status from kernel_private.notification_outbox where notification_id = $1", [intent.notificationId])).rows[0];
    expect(finalRow.status).toBe("DELIVERED");
    const events = await poolA.query(
      "select outcome, attempt_number from kernel_private.notification_delivery_events where notification_id = $1 order by attempt_number",
      [intent.notificationId],
    );
    expect(events.rows).toEqual([
      { outcome: "AMBIGUOUS_RECOVERED", attempt_number: 1 },
      { outcome: "DELIVERED", attempt_number: 2 },
    ]);

    // No duplicate alert episode — delivery never touches alert_state.
    const episodeCount = await poolA.query("select count(*) as n from kernel_private.alert_state where entity_id = $1", [scheduleId]);
    expect(Number(episodeCount.rows[0].n)).toBe(0); // this test never wrote one — the point is delivery alone can't create one
  });

  it("10. concurrent claim attempts on the same row: markSending's atomic UPDATE lets exactly one caller win, never both", async () => {
    const outboxA = new PgNotificationOutboxStore(poolA);
    const outboxB = new PgNotificationOutboxStore(poolB);
    const intent = mkIntent(scheduleId, "e2e-concurrent-claim", "2026-09-17T10:00:00.000Z");
    await outboxA.enqueue([intent]);
    const [claimedByA, claimedByB] = await Promise.all([
      outboxA.markSending(intent.notificationId, "2026-09-17T10:00:01.000Z"),
      outboxB.markSending(intent.notificationId, "2026-09-17T10:00:01.000Z"),
    ]);
    const winners = [claimedByA, claimedByB].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    const row = (await poolA.query("select attempt_count from kernel_private.notification_outbox where notification_id = $1", [intent.notificationId])).rows[0];
    expect(row.attempt_count).toBe(1); // not double-incremented by the loser
  });

  it("11. the DB itself rejects duration_ms on a non-RECOVERED row (schema-level evidence, not just app-level trust)", async () => {
    await expect(
      poolA.query(
        `insert into kernel_private.notification_outbox
           (notification_id, fingerprint, check_id, entity_id, first_seen_at, last_seen_at,
            kind, occurrence_count, severity, message, duration_ms,
            status, attempt_count, created_at, next_attempt_at)
         values ('bad-1', 'fp-bad', 'kj-p2-test.bad', $1, now(), now(), 'NEW', 1, 'P1', 'x', 1000, 'PENDING', 0, now(), now())`,
        [scheduleId],
      ),
    ).rejects.toThrow();
  });
});

function mkIntent(entityId: string, suffix: string, createdAt: string) {
  return {
    notificationId: `nid-${suffix}-${Math.random().toString(36).slice(2)}`,
    fingerprint: `fp-${suffix}`,
    checkId: `kj-p2-test.${suffix}`,
    entityId,
    firstSeenAt: createdAt,
    lastSeenAt: createdAt,
    kind: "NEW" as const,
    occurrenceCount: 1,
    severity: "P2" as const,
    message: "synthetic outbox-postgres integration fixture",
    durationMs: null,
    createdAt,
  };
}
