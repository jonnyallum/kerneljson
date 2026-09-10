import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { writeFileSync, mkdirSync } from "node:fs";
import { ScheduleSpec, fireIdentity, idempotencyKey, type FireInput } from "../services/kernel/src/scheduler/index.js";
import { PersistedScheduleSpec } from "../services/kernel/src/scheduler/persistence.js";
import { PgScheduleStore } from "../services/kernel/src/scheduler/pg-store.js";
import { StaleFenceError, FireBindingConflict } from "../services/kernel/src/scheduler/store.js";

/**
 * Phase S1-F — LEASE FENCING qualification (integration, real Postgres).
 * A worker holding a stale lease epoch must be physically unable to perform an
 * ownership-sensitive ScheduleFire mutation after another worker took ownership.
 * Requires a LOCAL throwaway KJ_TEST_PG_URL; skips cleanly and never touches prod.
 */
const URL = process.env["KJ_TEST_PG_URL"];
const PROD_MARKERS = ["supabase.co", "supabase.com", "pooler.supabase", "supabase.in",
  "banqdzddfganzfhckdps", "lkwydqtfbdjhxaarelaz", "136.112.138.225", "35.242.183.206", "34.105.139.159"];
const URL_ = globalThis.URL;
function assertLocalTestTarget(url: string): void {
  const lower = url.toLowerCase();
  for (const m of PROD_MARKERS) if (lower.includes(m)) throw new Error(`PRODUCTION TRIPWIRE: '${m}'`);
  let host: string;
  try { host = new URL_(url).hostname; } catch { throw new Error("unparseable KJ_TEST_PG_URL"); }
  const localOk = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!localOk && process.env["KJ_TEST_PG_ALLOW_NONLOCAL"] !== "1")
    throw new Error(`PRODUCTION TRIPWIRE: non-local host '${host}'`);
}
const run = URL ? describe : describe.skip;
if (!URL) console.warn("[schedule-fencing] SKIPPED: set KJ_TEST_PG_URL to a LOCAL throwaway Postgres.");

run("S1-F lease fencing qualification", () => {
  let pool: pg.Pool;
  let store: PgScheduleStore;
  const tenantId = randomUUID(), svc = randomUUID(), owner = randomUUID(), scheduleId = randomUUID();
  const evidence: Record<string, unknown> = {};
  const spec = ScheduleSpec.parse({
    scheduleId, version: "v1", tenant: { id: tenantId }, principal: { id: svc, kind: "SERVICE" },
    owner: { id: owner, kind: "HUMAN" }, timezone: "Europe/London", calendar: { kind: "dailyAt", hour: 1, minute: 30 },
    state: "enabled", missedRunPolicy: "SKIP", maxBackfillRuns: 0, overlapPolicy: "FORBID",
    perScheduleConcurrency: 1, createdAt: "2026-09-10T00:00:00Z",
  });
  const persisted = PersistedScheduleSpec.parse({
    scheduleId, version: "v1", tenant: { id: tenantId }, principal: { id: svc, kind: "SERVICE" },
    owner: { id: owner, kind: "HUMAN" }, name: "fence-qual", timezone: "Europe/London",
    calendar: { kind: "dailyAt", hour: 1, minute: 30 }, missedRunPolicy: "SKIP", overlapPolicy: "FORBID",
    nonexistentTimePolicy: "SHIFT_FORWARD", maxBackfillRuns: 0, perScheduleConcurrency: 1,
    enabledForProduction: false, createdAt: "2026-09-10T00:00:00Z", createdBy: owner,
  });
  const fireFor = (day: string): FireInput => {
    const win = `dailyAt/01:30|Europe/London|2026-09-${day}`;
    return { idempotencyKey: idempotencyKey(spec, win), scheduleId, version: "v1", fireWindowKey: win,
      fireIdentity: fireIdentity(spec, win), fireAtUtc: `2026-09-${day}T00:30:00Z`, createdAt: "2026-09-10T00:00:00Z" };
  };
  async function seedTask(id: string): Promise<void> {
    const traceId = randomUUID();
    const contract = { id, tenant: { id: tenantId }, principal: { id: svc }, status: "RECEIVED",
      acceptanceCriteria: ["seed"], objective: "seed", traceId, createdAt: "2026-09-10T00:00:00Z" };
    await pool.query("insert into tasks(id,tenant_id,principal_id,trace_id,status,contract,created_at) values($1,$2,$3,$4,'RECEIVED',$5,now())",
      [id, tenantId, svc, traceId, JSON.stringify(contract)]);
  }
  const t0 = Date.parse("2026-09-11T00:00:00Z");
  let epochA = -1, epochB = -1;

  beforeAll(async () => {
    assertLocalTestTarget(URL!);
    pool = new pg.Pool({ connectionString: URL });
    store = new PgScheduleStore(pool);
    await pool.query("insert into principals(id,kind) values($1,'SERVICE'),($2,'HUMAN')", [svc, owner]);
    await pool.query("insert into tenants(id,name) values($1,'fence-qual')", [tenantId]);
    await pool.query("insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'owner'),($1,$3,'member')", [tenantId, owner, svc]);
    await store.upsertSpecVersion(persisted);
    await store.setState({ scheduleId, state: "enabled", activeVersion: "v1", updatedAt: "2026-09-11T00:30:00Z", updatedBy: owner });
    // fires under test
    for (const d of ["11", "12", "13", "14"]) await store.createOrGetFire(fireFor(d));
  });
  afterAll(async () => {
    try { mkdirSync("docs/production/phase-s1-pg", { recursive: true });
      writeFileSync("docs/production/phase-s1-pg/FENCING_EVIDENCE.json", JSON.stringify(evidence, null, 2)); } catch { /* best effort */ }
    await pool?.end();
  });

  it("A claims (epoch N); after expiry B claims (epoch N+1); stale A cannot mutate; only B's mutation persists", async () => {
    const taskA = randomUUID(), taskB = randomUUID();
    await seedTask(taskA); await seedTask(taskB);
    // 1-2. worker A claims and performs a protected mutation at its epoch
    const la = await store.claimLease(scheduleId, "worker-A", t0, 1000);
    epochA = la!.epoch;
    const bindA = await store.bindAdmission(fireFor("11").idempotencyKey, { admissionRequestId: randomUUID(), childTaskId: taskA, at: "2026-09-11T00:30:00Z" }, { owner: "worker-A", epoch: epochA });
    expect(bindA.replay).toBe(false);
    // 3-4. lease expires, worker B takes over (epoch advances)
    const lb = await store.claimLease(scheduleId, "worker-B", t0 + 2000, 1000);
    epochB = lb!.epoch;
    expect(epochB).toBe(epochA + 1);
    // 5. B performs a protected mutation successfully
    const bindB = await store.bindAdmission(fireFor("12").idempotencyKey, { admissionRequestId: randomUUID(), childTaskId: taskB, at: "2026-09-12T00:30:00Z" }, { owner: "worker-B", epoch: epochB });
    expect(bindB.replay).toBe(false);
    // 6-7. A wakes and attempts a protected mutation with its STALE epoch -> DB rejects
    const staleTask = randomUUID(); await seedTask(staleTask);
    await expect(store.bindAdmission(fireFor("13").idempotencyKey, { admissionRequestId: randomUUID(), childTaskId: staleTask, at: "2026-09-13T00:30:00Z" }, { owner: "worker-A", epoch: epochA }))
      .rejects.toBeInstanceOf(StaleFenceError);
    // 8. final rows: fire 13 remains unbound/PLANNED; fire 12 bound only to taskB
    const f13 = await pool.query("select state, admitted_child_task_id from schedule_fires where idempotency_key=$1", [fireFor("13").idempotencyKey]);
    expect(f13.rows[0].state).toBe("PLANNED");
    expect(f13.rows[0].admitted_child_task_id).toBeNull();
    const f12 = await pool.query("select admitted_child_task_id from schedule_fires where idempotency_key=$1", [fireFor("12").idempotencyKey]);
    expect(f12.rows[0].admitted_child_task_id).toBe(taskB);
    evidence["epochA"] = epochA; evidence["epochB"] = epochB;
    evidence["stale_A_bound_fire13"] = false;
  });

  it("wrong owner with correct-looking epoch is rejected", async () => {
    const t = randomUUID(); await seedTask(t);
    await expect(store.bindAdmission(fireFor("13").idempotencyKey, { admissionRequestId: randomUUID(), childTaskId: t, at: "2026-09-13T00:30:00Z" }, { owner: "worker-C", epoch: epochB }))
      .rejects.toBeInstanceOf(StaleFenceError);
  });

  it("right owner with stale epoch is rejected", async () => {
    const t = randomUUID(); await seedTask(t);
    await expect(store.bindAdmission(fireFor("13").idempotencyKey, { admissionRequestId: randomUUID(), childTaskId: t, at: "2026-09-13T00:30:00Z" }, { owner: "worker-B", epoch: epochA }))
      .rejects.toBeInstanceOf(StaleFenceError);
  });

  it("duplicate current-owner write succeeds (idempotent transition under current fence)", async () => {
    const fence = { owner: "worker-B", epoch: epochB };
    const a = await store.transition(fireFor("14").idempotencyKey, "SKIPPED", fence);
    const b = await store.transition(fireFor("14").idempotencyKey, "SKIPPED", fence);
    expect(a.state).toBe("SKIPPED"); expect(b.state).toBe("SKIPPED");
  });

  it("stale failure transition is rejected by the DB", async () => {
    await expect(store.transition(fireFor("13").idempotencyKey, "FAILED", { owner: "worker-A", epoch: epochA }))
      .rejects.toBeInstanceOf(StaleFenceError);
    const f13 = await pool.query("select state from schedule_fires where idempotency_key=$1", [fireFor("13").idempotencyKey]);
    expect(f13.rows[0].state).toBe("PLANNED"); // unchanged
  });

  it("stale release is a no-op; current owner keeps the lease", async () => {
    await store.releaseLease(scheduleId, "worker-A", epochA); // stale
    const l = await pool.query("select owner, epoch from schedule_leases where schedule_id=$1", [scheduleId]);
    expect(l.rows[0].owner).toBe("worker-B");
    expect(Number(l.rows[0].epoch)).toBe(epochB);
    evidence["lease_after_stale_release_owner"] = l.rows[0].owner;
  });

  it("bind-once remains intact under fencing; lease churn creates no extra fire and no second child", async () => {
    // current owner cannot rebind fire 12 to a different task (bind-once trigger)
    const other = randomUUID(); await seedTask(other);
    await expect(store.bindAdmission(fireFor("12").idempotencyKey, { admissionRequestId: randomUUID(), childTaskId: other, at: "2026-09-13T00:30:00Z" }, { owner: "worker-B", epoch: epochB }))
      .rejects.toBeInstanceOf(FireBindingConflict);
    const n = await pool.query("select count(*)::int c from schedule_fires where schedule_id=$1", [scheduleId]);
    expect(n.rows[0].c).toBe(4); // 11,12,13,14 — lease takeover never minted a new fire
    evidence["fire_count_after_churn"] = n.rows[0].c;
  });

  it("reads are NOT fenced (no over-fencing)", async () => {
    const fires = await store.listFires(scheduleId); // no fence param; must work regardless of owner
    expect(fires.length).toBe(4);
  });
});
