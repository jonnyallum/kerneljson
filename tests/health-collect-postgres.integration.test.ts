import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { DATABASE, compose, holdRuntime, migrate, until } from "./support/local.js";
import { seedAdmittedTask } from "./support/seed-admission.js";
import { fetchAdmittedFiresMissingTasks } from "../services/kernel/src/health/collect.js";
import { PgScheduleStore } from "../services/kernel/src/scheduler/pg-store.js";

/**
 * KJ-P6 health-model correction — collector-level regression (2026-09-24 incident).
 *
 * The bug this guards against lived in SQL classification, not evaluation: the
 * original query pre-filtered on `t.id is null` (public.tasks missing) before ever
 * checking whether kernel_private.task_admissions existed, which silently hid a
 * genuine authority breach — a fire whose admitted_child_task_id happens to have a
 * public.tasks row but NO task_admissions row at all — from the P0 check entirely.
 * Real Postgres, real FK enforcement (schedule_fires.admitted_child_task_id
 * references kernel_private.task_admissions(task_id)), never a synthetic snapshot.
 */
const name = `kj_health_collect_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const admin = new pg.Pool({ connectionString: DATABASE, max: 1 });
let pool: pg.Pool;
let releaseRuntime = () => {};
let store: PgScheduleStore;
let tenantId: string, principalId: string;

async function seedSchedule(scheduleId: string): Promise<void> {
  await store.upsertSpecVersion({
    scheduleId, version: "v1", tenant: { id: tenantId }, principal: { id: principalId, kind: "HUMAN" },
    owner: { id: principalId, kind: "HUMAN" }, name: "health-collect-fixture", timezone: "Europe/London",
    calendar: { kind: "dailyAt", hour: 1, minute: 30 }, missedRunPolicy: "SKIP", overlapPolicy: "FORBID",
    nonexistentTimePolicy: "SHIFT_FORWARD", maxBackfillRuns: 0, perScheduleConcurrency: 1,
    enabledForProduction: false, createdAt: "2026-09-24T00:00:00Z", createdBy: principalId,
  });
  await store.setState({
    scheduleId, state: "enabled", activeVersion: "v1",
    updatedAt: "2026-09-24T00:00:00Z", updatedBy: principalId,
  });
}

/** Inserts an ADMITTED schedule_fires row bound to taskId. Real FK enforcement means
 *  this only succeeds if kernel_private.task_admissions already has a row for taskId
 *  — exactly like production. `bypassAdmissionFk` simulates the one path that could
 *  ever violate that (a trusted-owner raw DDL write, per the constitution's documented
 *  trust boundary), which is the exact hidden-bug scenario under test. */
async function insertAdmittedFire(
  scheduleId: string,
  fireWindowKey: string,
  taskId: string,
  opts: { bypassAdmissionFk?: boolean } = {},
): Promise<void> {
  const idempotencyKey = `${scheduleId}|v1|${fireWindowKey}`;
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (opts.bypassAdmissionFk) await client.query("set local session_replication_role = replica");
    await client.query(
      `insert into public.schedule_fires
        (idempotency_key, schedule_id, schedule_version, fire_window_key, fire_identity,
         fire_at_utc, state, admission_request_id, admitted_child_task_id, admitted_at)
       values ($1,$2,'v1',$3,$4,'2026-09-24T08:00:00Z','ADMITTED',$5,$6,'2026-09-24T08:00:00Z')`,
      [idempotencyKey, scheduleId, fireWindowKey, randomUUID(), randomUUID(), taskId],
    );
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

async function insertMaterialisedTask(taskId: string): Promise<void> {
  const trace = randomUUID();
  await pool.query(
    "insert into public.tasks(id,tenant_id,principal_id,trace_id,status,contract,created_at) values($1,$2,$3,$4,'RECEIVED',$5,now())",
    [
      taskId, tenantId, principalId, trace,
      JSON.stringify({
        id: taskId, tenant: { id: tenantId }, principal: { id: principalId }, status: "RECEIVED",
        acceptanceCriteria: ["seed"], objective: "health-collect fixture", traceId: trace,
        createdAt: "2026-09-24T08:00:00.000Z",
      }),
    ],
  );
}

beforeAll(async () => {
  releaseRuntime = holdRuntime();
  compose("up", "-d", "db");
  await until(() => admin.query("select 1"), (r) => r.rowCount === 1);
  await admin.query(`create database ${name}`);
  pool = new pg.Pool({ connectionString: DATABASE.replace(/\/kerneljson$/, `/${name}`), max: 2 });
  await migrate(pool);
  store = new PgScheduleStore(pool);
  tenantId = randomUUID();
  principalId = randomUUID();
  await pool.query("insert into principals(id,kind) values($1,'HUMAN')", [principalId]);
  await pool.query("insert into tenants(id,name) values($1,'health-collect-fixture')", [tenantId]);
  await pool.query("insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'owner')", [tenantId, principalId]);
});

afterAll(async () => {
  await pool?.end();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.end();
  releaseRuntime();
});

describe("fetchAdmittedFiresMissingTasks — real Postgres, real FK enforcement", () => {
  it("admission record exists, task never materialised -> unmaterialised, NOT the P0 missingAdmission list", async () => {
    const scheduleId = randomUUID();
    const taskId = randomUUID();
    await seedSchedule(scheduleId);
    await seedAdmittedTask(pool, { taskId, tenantId, principalId }); // real task_admissions + execution_bindings row
    await insertAdmittedFire(scheduleId, "dailyAt/01:30|Europe/London|2026-09-24", taskId);
    // public.tasks deliberately never populated for taskId.
    const result = await fetchAdmittedFiresMissingTasks(pool, scheduleId);
    expect(result).toEqual({ missingAdmission: [], unmaterialised: [taskId] });
  });

  it("THE HIDDEN BUG: fire's task exists in public.tasks but has NO task_admissions row -> still missingAdmission/P0", async () => {
    const scheduleId = randomUUID();
    const taskId = randomUUID();
    await seedSchedule(scheduleId);
    // No seedAdmittedTask call at all — task_admissions genuinely has no row for taskId.
    await insertAdmittedFire(scheduleId, "dailyAt/01:30|Europe/London|2026-09-24", taskId, { bypassAdmissionFk: true });
    // public.tasks DOES have a row — this is exactly what the old `t.id is null`
    // pre-filter hid from classification entirely.
    await insertMaterialisedTask(taskId);
    const result = await fetchAdmittedFiresMissingTasks(pool, scheduleId);
    expect(result).toEqual({ missingAdmission: [taskId], unmaterialised: [] });
  });

  it("both a real admission record and a materialised task -> neither list (fully healthy)", async () => {
    const scheduleId = randomUUID();
    const taskId = randomUUID();
    await seedSchedule(scheduleId);
    await seedAdmittedTask(pool, { taskId, tenantId, principalId });
    await insertAdmittedFire(scheduleId, "dailyAt/01:30|Europe/London|2026-09-24", taskId);
    await insertMaterialisedTask(taskId);
    const result = await fetchAdmittedFiresMissingTasks(pool, scheduleId);
    expect(result).toEqual({ missingAdmission: [], unmaterialised: [] });
  });

  it("a real FK still refuses an admitted fire with no task_admissions row at all when not bypassed — proves the bypass helper above is simulating a genuine trust-boundary breach, not a normal write path", async () => {
    const scheduleId = randomUUID();
    await seedSchedule(scheduleId);
    await expect(
      insertAdmittedFire(scheduleId, "dailyAt/01:30|Europe/London|2026-09-24", randomUUID()),
    ).rejects.toThrow(/foreign key/i);
  });
});
