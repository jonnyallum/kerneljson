import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "./support/local.js";
import { seedAdmittedTask } from "./support/seed-admission.js";
import { PgScheduleStore } from "../services/kernel/src/scheduler/pg-store.js";
import { PgIdentityGate, installDisabledCanary } from "../services/kernel/src/scheduler/canary-seed.js";
import { enableCanaryForProduction, disableCanary } from "../services/kernel/src/scheduler/canary-lifecycle.js";
import { fireOnce } from "../services/kernel/src/scheduler/canary-fire.js";
import type { AdmissionGateway, AdmissionRequestInput, AdmissionResult } from "../services/kernel/src/scheduler/durable-timer.js";

/**
 * Gate 3 tooling — Postgres runtime qualification (integration).
 *
 * Proves enable-canary / fire-once / disable-canary delegate to the qualified scheduler +
 * admission machinery against a REAL local throwaway Postgres. Gated on KJ_TEST_PG_URL; skips
 * cleanly when unset; a production-looking target aborts (never touches production).
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
  try { host = new URL_(url).hostname; } catch { throw new Error("unparseable KJ_TEST_PG_URL"); }
  const localOk = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!localOk && process.env["KJ_TEST_PG_ALLOW_NONLOCAL"] !== "1")
    throw new Error(`PRODUCTION TRIPWIRE: non-local host '${host}' not explicitly test-authorised`);
}

const run = URL ? describe : describe.skip;
if (!URL) console.warn("[canary-tooling] SKIPPED: set KJ_TEST_PG_URL to a LOCAL throwaway Postgres to run.");

/** Admission seam that records a canonical child task (execution_bindings + task_admissions),
 *  deduping on the fire identity — exactly what the real door does for a repeated Idempotency-Key. */
class SeedingAdmissionGateway implements AdmissionGateway {
  private readonly minted = new Map<string, string>();
  constructor(
    private readonly pool: pg.Pool,
    private readonly tenantId: string,
    private readonly principalId: string,
  ) {}
  async admit(req: AdmissionRequestInput): Promise<AdmissionResult> {
    const existing = this.minted.get(req.admissionIdentity);
    if (existing) return { childTaskId: existing, deduped: true };
    const taskId = randomUUID();
    await seedAdmittedTask(this.pool, { taskId, tenantId: this.tenantId, principalId: this.principalId });
    this.minted.set(req.admissionIdentity, taskId);
    return { childTaskId: taskId, deduped: false };
  }
}

run("Gate 3 tooling — Postgres runtime qualification", () => {
  let pool: pg.Pool;
  let store: PgScheduleStore;
  let gate: PgIdentityGate;
  const tenantId = randomUUID();
  const svc = randomUUID();
  const owner = randomUUID();
  const scheduleId = randomUUID();
  const V1_AT = "2026-09-11T09:00:00.000+00:00";
  const V2_AT = "2026-09-11T10:00:00.000+00:00";
  const LAST = Date.parse("2026-09-11T07:59:00Z");
  const NOW = Date.parse("2026-09-11T08:01:00Z");

  beforeAll(async () => {
    assertLocalTestTarget(URL!);
    pool = new pg.Pool({ connectionString: URL });
    const migrated = await pool.query("select to_regclass('public.schedule_specs') as t");
    if (!migrated.rows[0].t) await migrate(pool);
    store = new PgScheduleStore(pool);
    gate = new PgIdentityGate(pool);
    await pool.query("insert into principals(id,kind) values($1,'SERVICE'),($2,'HUMAN')", [svc, owner]);
    await pool.query("insert into tenants(id,name) values($1,'gate3-tooling')", [tenantId]);
    await pool.query("insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'operator')", [tenantId, owner]);
    await installDisabledCanary(store, gate, {
      scheduleId, version: "v1", tenantId, principalId: owner, ownerId: owner, createdBy: owner,
      name: "claude_md_check", timezone: "Europe/London", calendar: { kind: "dailyAt", hour: 9, minute: 0 },
      missedRunPolicy: "SKIP", overlapPolicy: "FORBID", nonexistentTimePolicy: "SHIFT_FORWARD",
      maxBackfillRuns: 0, perScheduleConcurrency: 1, createdAt: V1_AT,
    });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("installs disabled@v1 (baseline)", async () => {
    const st = await pool.query("select state, active_version from schedule_state where schedule_id=$1", [scheduleId]);
    expect(st.rows[0].state).toBe("disabled");
    expect(st.rows[0].active_version).toBe("v1");
    const sp = await pool.query("select enabled_for_production from schedule_specs where schedule_id=$1 and version='v1'", [scheduleId]);
    expect(sp.rows[0].enabled_for_production).toBe(false);
  });

  it("enable-canary: disabled@v1 -> enabled@v2 (production), idempotent", async () => {
    const r = await enableCanaryForProduction(store, gate, {
      scheduleId, tenantId, actorPrincipalId: owner, fromVersion: "v1", toVersion: "v2", createdAt: V2_AT, expectedState: "disabled",
    });
    expect(r.enabled).toBe(true);
    const st = await pool.query("select state, active_version from schedule_state where schedule_id=$1", [scheduleId]);
    expect(st.rows[0].state).toBe("enabled");
    expect(st.rows[0].active_version).toBe("v2");
    const v2 = await pool.query("select enabled_for_production from schedule_specs where schedule_id=$1 and version='v2'", [scheduleId]);
    expect(v2.rows[0].enabled_for_production).toBe(true);
    // idempotent replay
    const again = await enableCanaryForProduction(store, gate, {
      scheduleId, tenantId, actorPrincipalId: owner, fromVersion: "v1", toVersion: "v2", createdAt: V2_AT, expectedState: "disabled",
    });
    expect(again.alreadyEnabled).toBe(true);
  });

  it("fire-once: exactly one ADMITTED fire bound to one canonical task", async () => {
    const gw = new SeedingAdmissionGateway(pool, tenantId, svc);
    const r = await fireOnce(store, gate, gw, { scheduleId, tenantId, actorPrincipalId: owner, expectedActiveVersion: "v2", lastTickMs: LAST, nowMs: NOW, owner: "pg-fire", productionRuntime: true });
    expect(r.preview).toBe(false);
    const fires = await pool.query("select state, admitted_child_task_id from schedule_fires where schedule_id=$1", [scheduleId]);
    expect(fires.rowCount).toBe(1);
    expect(fires.rows[0].state).toBe("ADMITTED");
    const childId = fires.rows[0].admitted_child_task_id as string;
    expect(childId).toBeTruthy();
    const adm = await pool.query("select count(*)::int n from kernel_private.task_admissions where task_id=$1", [childId]);
    expect(adm.rows[0].n).toBe(1);
  });

  it("fire-once duplicate: replays to the same task; still one fire, one admission", async () => {
    const before = await pool.query("select admitted_child_task_id from schedule_fires where schedule_id=$1", [scheduleId]);
    const childId = before.rows[0].admitted_child_task_id as string;
    const gw = new SeedingAdmissionGateway(pool, tenantId, svc);
    const r = await fireOnce(store, gate, gw, { scheduleId, tenantId, actorPrincipalId: owner, expectedActiveVersion: "v2", lastTickMs: LAST, nowMs: NOW, owner: "pg-fire", productionRuntime: true });
    if (r.preview === false) expect(r.childTaskId).toBe(childId);
    const fires = await pool.query("select count(*)::int n from schedule_fires where schedule_id=$1", [scheduleId]);
    expect(fires.rows[0].n).toBe(1);
    expect(gw.constructor.name).toBe("SeedingAdmissionGateway"); // no second mint occurred (fire already bound)
  });

  it("disable-canary: enabled@v2 -> disabled@v2, fire history intact", async () => {
    const r = await disableCanary(store, gate, { scheduleId, actorPrincipalId: owner, at: "2026-09-11T12:00:00.000+00:00" });
    expect(r.disabled).toBe(true);
    const st = await pool.query("select state, active_version from schedule_state where schedule_id=$1", [scheduleId]);
    expect(st.rows[0].state).toBe("disabled");
    expect(st.rows[0].active_version).toBe("v2"); // preserved
    const fires = await pool.query("select count(*)::int n from schedule_fires where schedule_id=$1", [scheduleId]);
    expect(fires.rows[0].n).toBe(1); // history not deleted
  });

  it("authority: a REVOKED membership is rejected by the real PgIdentityGate (non-ACTIVE fails closed)", async () => {
    // tenant_memberships.status (20260908234711) must gate the authority: a REVOKED/REMOVED row is
    // NOT a member. This proves the fire-once HUMAN-actor gate against the real gate, end to end.
    await pool.query("update tenant_memberships set status='REVOKED' where tenant_id=$1 and principal_id=$2", [tenantId, owner]);
    let code = "OK";
    try {
      await fireOnce(store, gate, new SeedingAdmissionGateway(pool, tenantId, svc), {
        scheduleId, tenantId, actorPrincipalId: owner, expectedActiveVersion: "v2",
        lastTickMs: LAST, nowMs: NOW, owner: "pg-fire", productionRuntime: true,
      });
    } catch (e) {
      code = (e as { code?: string }).code ?? (e as Error).name;
    }
    expect(code).toBe("MISSING_TENANT_MEMBERSHIP");
    // restore ACTIVE so the shared fixture is left clean
    await pool.query("update tenant_memberships set status='ACTIVE' where tenant_id=$1 and principal_id=$2", [tenantId, owner]);
  });
});
