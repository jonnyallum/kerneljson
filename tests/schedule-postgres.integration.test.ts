import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  ScheduleSpec,
  fireIdentity,
  idempotencyKey,
  type FireInput,
} from "../services/kernel/src/scheduler/index.js";
import { PersistedScheduleSpec } from "../services/kernel/src/scheduler/persistence.js";
import { PgScheduleStore, } from "../services/kernel/src/scheduler/pg-store.js";
import { FireBindingConflict } from "../services/kernel/src/scheduler/store.js";

/**
 * Phase S1 — PostgreSQL RUNTIME qualification (integration).
 *
 * Requires an explicit LOCAL throwaway test DB via KJ_TEST_PG_URL. Skips clearly
 * when unset. NEVER falls back to production; a production-looking target aborts.
 */
const URL = process.env["KJ_TEST_PG_URL"];
const PROD_MARKERS = [
  "supabase.co", "supabase.com", "pooler.supabase", "supabase.in",
  "banqdzddfganzfhckdps", "lkwydqtfbdjhxaarelaz", // known KernelJSON / Brain prod refs
  "136.112.138.225", "35.242.183.206", "34.105.139.159", // estate VM IPs
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
if (!URL) console.warn("[schedule-postgres] SKIPPED: set KJ_TEST_PG_URL to a LOCAL throwaway Postgres to run.");

run("S1 Postgres runtime qualification", () => {
  let pool: pg.Pool;
  let pool2: pg.Pool; // independent connection for real concurrency
  let store: PgScheduleStore;
  const tenantId = randomUUID();
  const svc = randomUUID();
  const owner = randomUUID();
  const scheduleId = randomUUID();
  const evidence: Record<string, unknown> = {};

  const spec = ScheduleSpec.parse({
    scheduleId, version: "v1", tenant: { id: tenantId },
    principal: { id: svc, kind: "SERVICE" }, owner: { id: owner, kind: "HUMAN" },
    timezone: "Europe/London", calendar: { kind: "dailyAt", hour: 1, minute: 30 },
    state: "enabled", missedRunPolicy: "SKIP", maxBackfillRuns: 0,
    overlapPolicy: "FORBID", perScheduleConcurrency: 1, createdAt: "2026-09-10T00:00:00Z",
  });
  const persisted = PersistedScheduleSpec.parse({
    scheduleId, version: "v1", tenant: { id: tenantId },
    principal: { id: svc, kind: "SERVICE" }, owner: { id: owner, kind: "HUMAN" },
    name: "pg-qual", timezone: "Europe/London", calendar: { kind: "dailyAt", hour: 1, minute: 30 },
    missedRunPolicy: "SKIP", overlapPolicy: "FORBID", nonexistentTimePolicy: "SHIFT_FORWARD",
    maxBackfillRuns: 0, perScheduleConcurrency: 1, enabledForProduction: false,
    createdAt: "2026-09-10T00:00:00Z", createdBy: owner,
  });
  const WIN = "dailyAt/01:30|Europe/London|2026-09-11";
  const AT = "2026-09-11T00:30:00Z";
  const fireInput = (): FireInput => ({
    idempotencyKey: idempotencyKey(spec, WIN), scheduleId, version: "v1",
    fireWindowKey: WIN, fireIdentity: fireIdentity(spec, WIN), fireAtUtc: AT,
    createdAt: "2026-09-10T00:00:00Z",
  });

  async function seedTask(pool_: pg.Pool, id: string): Promise<void> {
    const traceId = randomUUID();
    const contract = {
      id, tenant: { id: tenantId }, principal: { id: svc }, status: "RECEIVED",
      acceptanceCriteria: ["seed"], objective: "seed task", traceId, createdAt: "2026-09-10T00:00:00Z",
    };
    await pool_.query(
      "insert into tasks(id,tenant_id,principal_id,trace_id,status,contract,created_at) values($1,$2,$3,$4,'RECEIVED',$5,now())",
      [id, tenantId, svc, traceId, JSON.stringify(contract)],
    );
  }

  beforeAll(async () => {
    assertLocalTestTarget(URL!);
    pool = new pg.Pool({ connectionString: URL });
    pool2 = new pg.Pool({ connectionString: URL });
    store = new PgScheduleStore(pool);
    // seed identity + spec
    await pool.query("insert into principals(id,kind) values($1,'SERVICE'),($2,'HUMAN')", [svc, owner]);
    await pool.query("insert into tenants(id,name) values($1,'pg-qual')", [tenantId]);
    await pool.query("insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'owner'),($1,$3,'member')", [tenantId, owner, svc]);
    await store.upsertSpecVersion(persisted);
    await store.setState({ scheduleId, state: "enabled", activeVersion: "v1", updatedAt: AT, updatedBy: owner });
  });

  afterAll(async () => {
    try {
      mkdirSync("docs/production/phase-s1-pg", { recursive: true });
      writeFileSync("docs/production/phase-s1-pg/RUNTIME_EVIDENCE.json", JSON.stringify(evidence, null, 2));
    } catch { /* evidence best-effort */ }
    await pool?.end(); await pool2?.end();
  });

  it("unique logical fire: sequential duplicate → one row", async () => {
    const a = await store.createOrGetFire(fireInput());
    const b = await store.createOrGetFire(fireInput());
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    const c = await pool.query("select count(*)::int n from schedule_fires where schedule_id=$1 and schedule_version='v1' and fire_window_key=$2", [scheduleId, WIN]);
    expect(c.rows[0].n).toBe(1);
    evidence["unique_sequential_rows"] = c.rows[0].n;
  });

  it("unique logical fire: concurrent duplicate from two independent pools → one row", async () => {
    const s2 = new PgScheduleStore(pool2);
    const win2 = "dailyAt/01:30|Europe/London|2026-09-12";
    const inp = (): FireInput => ({
      idempotencyKey: idempotencyKey(spec, win2), scheduleId, version: "v1",
      fireWindowKey: win2, fireIdentity: fireIdentity(spec, win2), fireAtUtc: "2026-09-12T00:30:00Z",
      createdAt: "2026-09-10T00:00:00Z",
    });
    const [r1, r2] = await Promise.all([store.createOrGetFire(inp()), s2.createOrGetFire(inp())]);
    expect([r1.created, r2.created].filter(Boolean).length).toBe(1); // exactly one creator
    const c = await pool.query("select count(*)::int n from schedule_fires where schedule_id=$1 and fire_window_key=$2", [scheduleId, win2]);
    expect(c.rows[0].n).toBe(1);
    evidence["unique_concurrent_creators"] = 1;
  });

  it("bind-once: DB rejects rebinding to a different task; same task replays", async () => {
    const taskA = randomUUID(); const taskB = randomUUID();
    await seedTask(pool, taskA); await seedTask(pool, taskB);
    const key = idempotencyKey(spec, WIN);
    const r1 = await store.bindAdmissionPrivileged(key, { admissionRequestId: randomUUID(), childTaskId: taskA, at: AT });
    expect(r1.replay).toBe(false);
    await expect(store.bindAdmissionPrivileged(key, { admissionRequestId: randomUUID(), childTaskId: taskB, at: AT }))
      .rejects.toBeInstanceOf(FireBindingConflict);
    const r3 = await store.bindAdmissionPrivileged(key, { admissionRequestId: randomUUID(), childTaskId: taskA, at: AT });
    expect(r3.replay).toBe(true);
    // prove the DB trigger itself rejects a raw rebind (not just app logic)
    let triggerBlocked = false; let msg = "";
    try {
      await pool.query("update schedule_fires set admitted_child_task_id=$2 where idempotency_key=$1", [key, taskB]);
    } catch (e) { triggerBlocked = true; msg = String((e as Error).message).slice(0, 120); }
    expect(triggerBlocked).toBe(true);
    evidence["bind_once_trigger_blocked"] = triggerBlocked;
    evidence["bind_once_trigger_msg"] = msg;
  });

  it("lease: expired lease recovered by another worker; epoch advances", async () => {
    const t0 = Date.parse("2026-09-11T00:00:00Z");
    const l1 = await store.claimLease(scheduleId, "worker-A", t0, 1000);
    expect(l1).not.toBeNull();
    const blocked = await store.claimLease(scheduleId, "worker-B", t0 + 500, 1000);
    expect(blocked).toBeNull(); // still held
    const l2 = await store.claimLease(scheduleId, "worker-B", t0 + 2000, 1000); // after expiry
    expect(l2).not.toBeNull();
    expect(l2!.epoch).toBeGreaterThan(l1!.epoch);
    evidence["lease_epoch_before"] = l1!.epoch; evidence["lease_epoch_after"] = l2!.epoch;
    // NOTE (reported as risk): stale-owner write fencing by epoch is NOT enforced on row writes yet.
  });

  it("backfill: DB CHECKs reject unbounded / self-approval / approved-without-approver; valid succeeds", async () => {
    const base = (o: Record<string, unknown> = {}) => ({
      id: randomUUID(), schedule_id: scheduleId, schedule_version: "v1", requested_by: owner,
      requested_from: "2026-09-01T00:00:00Z", requested_to: "2026-09-02T00:00:00Z",
      computed_windows: 2, max_runs: 3, preview_digest: "deadbeef", status: "PREVIEW",
      approved_by: null as string | null, created_at: AT, executed_at: null as string | null, ...o,
    });
    const ins = (r: ReturnType<typeof base>) => pool.query(
      `insert into schedule_backfill_requests
       (id,schedule_id,schedule_version,requested_by,requested_from,requested_to,computed_windows,max_runs,preview_digest,status,approved_by,created_at,executed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [r.id, r.schedule_id, r.schedule_version, r.requested_by, r.requested_from, r.requested_to,
       r.computed_windows, r.max_runs, r.preview_digest, r.status, r.approved_by, r.created_at, r.executed_at]);
    await expect(ins(base({ computed_windows: 10, max_runs: 3 }))).rejects.toBeTruthy();          // unbounded
    await expect(ins(base({ status: "APPROVED", approved_by: owner }))).rejects.toBeTruthy();      // self-approval
    await expect(ins(base({ status: "APPROVED", approved_by: null }))).rejects.toBeTruthy();       // approved w/o approver
    await expect(ins(base({ status: "APPROVED", approved_by: svc }))).resolves.toBeTruthy(); // valid: real approver != requester
    evidence["backfill_checks_enforced"] = true;
  });

  it("invalid persisted state: DB enum types reject unknown values", async () => {
    await expect(pool.query("update schedule_fires set state='BOGUS' where idempotency_key=$1", [idempotencyKey(spec, WIN)])).rejects.toBeTruthy();
    await expect(pool.query("update schedule_state set state='ZOMBIE' where schedule_id=$1", [scheduleId])).rejects.toBeTruthy();
    await expect(pool.query(
      "update schedule_specs set missed_run_policy='WHENEVER' where schedule_id=$1 and version='v1'", [scheduleId])).rejects.toBeTruthy();
    evidence["enum_fail_closed"] = true;
  });

  it("version namespace: same window under a new version is a distinct fire", async () => {
    const v2 = PersistedScheduleSpec.parse({ ...persisted, version: "v2" });
    await store.upsertSpecVersion(v2);
    const spec2 = ScheduleSpec.parse({ ...spec, version: "v2" });
    await store.createOrGetFire({
      idempotencyKey: idempotencyKey(spec2, WIN), scheduleId, version: "v2",
      fireWindowKey: WIN, fireIdentity: fireIdentity(spec2, WIN), fireAtUtc: AT, createdAt: AT,
    });
    const c = await pool.query("select count(*)::int n from schedule_fires where schedule_id=$1 and fire_window_key=$2", [scheduleId, WIN]);
    expect(c.rows[0].n).toBe(2); // v1 + v2, same civil window
    evidence["version_namespace_rows"] = c.rows[0].n;
  });

  it("immutable spec version cannot be silently rewritten", async () => {
    await expect(store.upsertSpecVersion({ ...persisted, name: "changed" })).rejects.toBeTruthy();
  });

  it("captures schema-level evidence (constraints/trigger)", async () => {
    const uniq = await pool.query(
      "select conname from pg_constraint where conrelid='public.schedule_fires'::regclass and contype='u'");
    const trg = await pool.query(
      "select tgname from pg_trigger where tgrelid='public.schedule_fires'::regclass and not tgisinternal");
    evidence["schedule_fires_unique_constraints"] = uniq.rows.map((r) => r.conname);
    evidence["schedule_fires_triggers"] = trg.rows.map((r) => r.tgname);
    expect(trg.rows.some((r) => String(r.tgname).includes("bind_once"))).toBe(true);
  });
});
