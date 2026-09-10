import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import pg from "pg";
import { DATABASE, migrate } from "./support/local.js";
import { createGateway, bearerAuthenticator } from "../apps/gateway/src/server.js";
import { createRestateControls } from "../apps/gateway/src/index.js";
import { PgScheduleStore } from "../services/kernel/src/scheduler/pg-store.js";
import { StaleFenceError, FireBindingConflict } from "../services/kernel/src/scheduler/store.js";
import { seedAdmittedTask } from "./support/seed-admission.js";
import {
  ScheduleTimerDriver,
  InMemoryDurableTimerRuntime,
  fireIdentity,
  idempotencyKey,
  runtimeSpecFrom,
  type AdmissionGateway,
  type AdmissionRequestInput,
  type AdmissionResult,
  type LeaseFence,
} from "../services/kernel/src/scheduler/index.js";

/**
 * Phase S1-R RUNTIME QUALIFICATION — scheduler boundary against REAL Postgres and
 * the REAL KernelJSON admission door (apps/gateway/src/server.ts). Gated on
 * S1R_RUNTIME=1 (needs the disposable validation `db` on 127.0.0.1:55432); skips
 * cleanly otherwise, like the other Postgres integration suites.
 *
 * What this proves at RUNTIME:
 *  - the scheduler->admission identity mapping (Idempotency-Key = fireIdentity):
 *    replay -> same taskId; 5 concurrent -> one taskId; changed payload -> 409;
 *  - createOrGetFire dedupe against real Postgres (one logical fire per triple);
 *  - lease fencing: a stale-fence bind is rejected (StaleFenceError / UPDATE 0).
 *
 * S1-R Option B (bind FK retargeted to kernel_private.task_admissions(task_id)):
 *  - the end-to-end wake -> createOrGetFire -> lease -> fence -> Admission -> bind
 *    now COMPLETES; the fire is ADMITTED and bound to the CANONICAL admission id,
 *    which exists synchronously (public.tasks is downstream and not required);
 *  - bind-once: rebinding the fire to a different admitted task fails closed;
 *  - later public.tasks materialisation uses the same canonical taskId.
 * See RESTATE_RUNTIME_EVIDENCE.json and the report.
 */

const RUN = process.env["S1R_RUNTIME"] === "1";
const D0_00 = Date.UTC(2026, 8, 11, 0, 0, 0);
const D0_12 = Date.UTC(2026, 8, 11, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const sha8 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 8);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const evidence: Record<string, any> = { capturedAt: new Date().toISOString(), note: "S1-R runtime qualification vs real Postgres + real admission door" };

describe.skipIf(!RUN)("S1-R runtime qualification (real Postgres + real admission door)", () => {
  let admin: pg.Pool, pool: pg.Pool, dbName: string, server: Server, gwUrl: string;
  let tenantId: string, principalId: string, store: PgScheduleStore;

  class GatewayAdmission implements AdmissionGateway {
    seen = new Set<string>();
    admitCalls = 0;
    async admit(req: AdmissionRequestInput): Promise<AdmissionResult> {
      this.admitCalls++;
      const objective = `s1r ${req.scheduleId} ${req.fireWindowKey}`; // stable per fire
      const res = await fetch(gwUrl + "/v1/tasks", {
        method: "POST",
        headers: { authorization: "Bearer owner", "content-type": "application/json", "idempotency-key": req.admissionIdentity },
        body: JSON.stringify({ recipe: "uppercase/v1", objective }),
      });
      if (res.status === 409) throw new Error("IDEMPOTENCY_CONFLICT");
      if (res.status !== 202) throw new Error(`admit ${res.status}`);
      const body = (await res.json()) as { taskId: string };
      const deduped = this.seen.has(req.admissionIdentity);
      this.seen.add(req.admissionIdentity);
      return { childTaskId: body.taskId, deduped };
    }
  }

  async function putSchedule(scheduleId: string, version: string, state: "enabled" | "paused" | "disabled") {
    await store.upsertSpecVersion({
      scheduleId, version, tenant: { id: tenantId }, principal: { id: principalId, kind: "HUMAN" }, owner: { id: principalId, kind: "HUMAN" },
      name: "s1r", timezone: "Europe/London", calendar: { kind: "dailyAt", hour: 1, minute: 30 },
      missedRunPolicy: "SKIP", overlapPolicy: "FORBID", nonexistentTimePolicy: "SHIFT_FORWARD",
      maxBackfillRuns: 10, perScheduleConcurrency: 1, enabledForProduction: false, createdAt: iso(0), createdBy: principalId,
    });
    await store.setState({ scheduleId, state, activeVersion: version, updatedAt: iso(0), updatedBy: principalId });
  }

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE });
    dbName = `s1r_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database ${dbName}`);
    pool = new pg.Pool({ connectionString: DATABASE.replace("/kerneljson", `/${dbName}`) });
    await migrate(pool);
    tenantId = randomUUID(); principalId = randomUUID();
    await pool.query("insert into principals(id,kind) values($1,'HUMAN')", [principalId]);
    await pool.query("insert into tenants(id,name) values($1,'s1r')", [tenantId]);
    await pool.query("insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'owner')", [tenantId, principalId]);
    const ctx = { tenantId, principal: { id: principalId, kind: "HUMAN" as const } };
    const authenticate = bearerAuthenticator(async (t) => (t === "owner" ? ctx : null));
    const controls = createRestateControls("http://not-called.invalid", async () => ({}), { pool, fetch: async () => { throw new Error("unexpected transport"); } });
    const handler = createGateway({ pool, releaseId: "s1r-test", authenticate, admit: async () => true, controls, dispatch: async () => ({ status: "ACCEPTED" }) });
    server = createServer((req, res) => { void handler(req, res); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address(); if (!addr || typeof addr === "string") throw new Error("no addr");
    gwUrl = `http://127.0.0.1:${addr.port}`;
    store = new PgScheduleStore(pool);
  }, 120000);

  afterAll(async () => {
    server?.close();
    await pool?.end();
    try {
      mkdirSync("docs/production/phase-s1-r", { recursive: true });
      writeFileSync("docs/production/phase-s1-r/RESTATE_RUNTIME_EVIDENCE.json", JSON.stringify(evidence, null, 2) + "\n");
    } catch { /* evidence best-effort */ }
    await admin?.query(`drop database if exists ${dbName} with (force)`);
    await admin?.end();
  });

  it("admission mapping: fireIdentity as Idempotency-Key -> replay same task, concurrent one task, changed payload 409", async () => {
    const sid = randomUUID();
    await putSchedule(sid, "v1", "enabled");
    const sched = await store.getSchedule(sid);
    const spec = runtimeSpecFrom(sched!.spec, sched!.state);
    const win = "dailyAt/01:30|Europe/London|2026-09-11";
    const key = fireIdentity(spec, win);
    const objective = `s1r ${sid} ${win}`;
    const submit = (obj: string) => fetch(gwUrl + "/v1/tasks", { method: "POST", headers: { authorization: "Bearer owner", "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ recipe: "uppercase/v1", objective: obj }) });

    const conc = await Promise.all(Array.from({ length: 5 }, () => submit(objective)));
    expect(conc.every((r) => r.status === 202)).toBe(true);
    const ids = (await Promise.all(conc.map((r) => r.json()))).map((b) => (b as { taskId: string }).taskId);
    expect(new Set(ids).size).toBe(1); // concurrent duplicates -> one canonical task
    const taskId = ids[0]!;

    const replay = await (await submit(objective)).json();
    expect((replay as { taskId: string }).taskId).toBe(taskId); // replay -> same task

    const conflict = await submit("DIFFERENT PAYLOAD");
    expect(conflict.status).toBe(409); // same key, different payload -> fail closed

    const admRow = await pool.query("select 1 from kernel_private.task_admissions where task_id=$1", [taskId]);
    expect(admRow.rowCount).toBe(1);
    evidence.admission_mapping = { fireIdentity: key, keyDigest8: sha8(key), canonicalTaskId: taskId, concurrent: ids.length, distinctTaskIds: new Set(ids).size, replaySameTask: true, conflictStatus: conflict.status, admissionRows: admRow.rowCount };
  });

  it("createOrGetFire dedupe against real Postgres: one logical fire per (scheduleId,version,window)", async () => {
    const sid = randomUUID();
    await putSchedule(sid, "v1", "enabled");
    const sched = await store.getSchedule(sid);
    const spec = runtimeSpecFrom(sched!.spec, sched!.state);
    const win = "dailyAt/01:30|Europe/London|2026-09-11";
    const input = { idempotencyKey: idempotencyKey(spec, win), scheduleId: sid, version: "v1", fireWindowKey: win, fireIdentity: fireIdentity(spec, win), fireAtUtc: iso(D0_00), createdAt: iso(D0_12) };
    const a = await store.createOrGetFire(input);
    const b = await store.createOrGetFire(input); // duplicate wake
    expect(a.created).toBe(true);
    expect(b.created).toBe(false); // DB unique collapses the second to the existing row
    const rows = await pool.query("select count(*)::int n from public.schedule_fires where schedule_id=$1", [sid]);
    expect(rows.rows[0].n).toBe(1);
    evidence.createOrGetFire_dedupe = { firstCreated: a.created, secondCreated: b.created, fireRows: rows.rows[0].n };
  });

  it("lease fencing: a stale-fence bind is rejected at the DB (StaleFenceError / UPDATE 0)", async () => {
    const sid = randomUUID();
    await putSchedule(sid, "v1", "enabled");
    const sched = await store.getSchedule(sid);
    const spec = runtimeSpecFrom(sched!.spec, sched!.state);
    const win = "dailyAt/01:30|Europe/London|2026-09-11";
    await store.createOrGetFire({ idempotencyKey: idempotencyKey(spec, win), scheduleId: sid, version: "v1", fireWindowKey: win, fireIdentity: fireIdentity(spec, win), fireAtUtc: iso(D0_00), createdAt: iso(D0_12) });
    const a = await store.claimLease(sid, "A", D0_12, 1000);
    const b = await store.claimLease(sid, "B", D0_12 + 2000, 1000); // takeover after expiry
    expect(b!.epoch).toBeGreaterThan(a!.epoch);
    const staleFence: LeaseFence = { owner: a!.owner, epoch: a!.epoch };
    await expect(
      store.bindAdmission(idempotencyKey(spec, win), { admissionRequestId: fireIdentity(spec, win), childTaskId: randomUUID(), at: iso(D0_12) }, staleFence),
    ).rejects.toBeInstanceOf(StaleFenceError);
    evidence.fencing = { epochA: a!.epoch, epochB: b!.epoch, staleBindRejected: true };
  });

  it("Option B end-to-end: wake COMPLETES; fire ADMITTED bound to canonical admission id; public.tasks not required (A–D,G)", async () => {
    const sid = randomUUID();
    await putSchedule(sid, "v1", "enabled");
    const sched = await store.getSchedule(sid);
    const spec = runtimeSpecFrom(sched!.spec, sched!.state);
    const win = "dailyAt/01:30|Europe/London|2026-09-11";
    const timers = new InMemoryDurableTimerRuntime();
    const adm = new GatewayAdmission();
    const driver = new ScheduleTimerDriver(store, timers, adm, { owner: "driver-1", productionRuntime: false, leaseTtlMs: 3_600_000 });

    // D: the full wake chain now COMPLETES (no FK failure).
    const wake = await driver.onWake(sid, D0_00, D0_12);
    expect(wake.gated).toBe(false);
    expect(wake.admittedChildTaskIds).toHaveLength(1);
    const taskId = wake.admittedChildTaskIds[0]!;

    // A/B: admission succeeded and is recorded canonically in task_admissions.
    const inAdm = await pool.query("select 1 from kernel_private.task_admissions where task_id=$1", [taskId]);
    expect(inAdm.rowCount).toBe(1);
    // C: public.tasks is NOT materialised at bind time — and the bind still succeeded.
    const inTasksAtBind = await pool.query("select 1 from public.tasks where id=$1", [taskId]);
    expect(inTasksAtBind.rowCount).toBe(0);
    // fire is ADMITTED and bound to the canonical admission id.
    const fire = await pool.query("select state,admitted_child_task_id from public.schedule_fires where idempotency_key=$1", [idempotencyKey(spec, win)]);
    expect(fire.rows[0].state).toBe("ADMITTED");
    expect(fire.rows[0].admitted_child_task_id).toBe(taskId);

    // G: later public.tasks materialisation (ledger-shaped) uses the SAME canonical taskId.
    const trace = randomUUID();
    await pool.query(
      "insert into public.tasks(id,tenant_id,principal_id,trace_id,status,contract,created_at) values($1,$2,$3,$4,'RECEIVED',$5,now())",
      [taskId, tenantId, principalId, trace, JSON.stringify({ id: taskId, tenant: { id: tenantId }, principal: { id: principalId }, status: "RECEIVED", acceptanceCriteria: ["seed"], objective: "materialised", traceId: trace, createdAt: iso(D0_12) })],
    );
    const inTasksAfter = await pool.query("select 1 from public.tasks where id=$1", [taskId]);
    expect(inTasksAfter.rowCount).toBe(1); // fire's admitted id and the materialised task id align
    evidence.option_b_end_to_end = { taskId, fireState: fire.rows[0].state, boundId: fire.rows[0].admitted_child_task_id, inTaskAdmissions: inAdm.rowCount, inPublicTasksAtBind: inTasksAtBind.rowCount, inPublicTasksAfterMaterialise: inTasksAfter.rowCount };
  });

  it("duplicate wake / replay: same fire, same canonical taskId, idempotent bind", async () => {
    const sid = randomUUID();
    await putSchedule(sid, "v1", "enabled");
    const timers = new InMemoryDurableTimerRuntime();
    const adm = new GatewayAdmission();
    const driver = new ScheduleTimerDriver(store, timers, adm, { owner: "driver-1", productionRuntime: false, leaseTtlMs: 3_600_000 });

    const r1 = await driver.onWake(sid, D0_00, D0_12);
    const r2 = await driver.onWake(sid, D0_00, D0_12); // duplicate wake
    expect(r1.admittedChildTaskIds).toHaveLength(1);
    expect(r2.admittedChildTaskIds).toHaveLength(0);
    expect(r2.replays).toBe(1);
    const fires = await pool.query("select count(*)::int n, max(admitted_child_task_id::text) tid from public.schedule_fires where schedule_id=$1", [sid]);
    expect(fires.rows[0].n).toBe(1);
    expect(fires.rows[0].tid).toBe(r1.admittedChildTaskIds[0]);
    evidence.duplicate_wake = { firstAdmitted: r1.admittedChildTaskIds.length, secondReplays: r2.replays, fireRows: fires.rows[0].n };
  });

  it("bind-once: rebinding the fire to a DIFFERENT admitted task fails closed (E)", async () => {
    const sid = randomUUID();
    await putSchedule(sid, "v1", "enabled");
    const sched = await store.getSchedule(sid);
    const spec = runtimeSpecFrom(sched!.spec, sched!.state);
    const win = "dailyAt/01:30|Europe/London|2026-09-11";
    const timers = new InMemoryDurableTimerRuntime();
    const adm = new GatewayAdmission();
    const driver = new ScheduleTimerDriver(store, timers, adm, { owner: "driver-1", productionRuntime: false, leaseTtlMs: 3_600_000 });
    await driver.onWake(sid, D0_00, D0_12); // fire ADMITTED to taskA

    const other = randomUUID(); // a second, different, VALID canonical admitted id
    await seedAdmittedTask(pool, { taskId: other, tenantId, principalId });
    const lease = await store.claimLease(sid, "driver-1", D0_12, 3_600_000);
    await expect(
      store.bindAdmission(idempotencyKey(spec, win), { admissionRequestId: randomUUID(), childTaskId: other, at: iso(D0_12) }, { owner: lease!.owner, epoch: lease!.epoch }),
    ).rejects.toBeInstanceOf(FireBindingConflict);
    evidence.bind_once = { rebindDifferentAdmittedTaskRejected: true };
  });
});
