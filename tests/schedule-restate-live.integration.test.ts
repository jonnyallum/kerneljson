import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { DATABASE, INGRESS, ADMIN, migrate, until, compose } from "./support/local.js";
import { createGateway, bearerAuthenticator } from "../apps/gateway/src/server.js";
import { createRestateControls } from "../apps/gateway/src/index.js";
import { PgScheduleStore } from "../services/kernel/src/scheduler/pg-store.js";
import {
  fireIdentity,
  idempotencyKey,
  runtimeSpecFrom,
} from "../services/kernel/src/scheduler/index.js";

/**
 * Phase S1-R LIVE RUNTIME QUALIFICATION — the real end-to-end chain through a live
 * containerised Restate server (docker.restate.dev/restatedev/restate:1.7.9).
 *
 * Topology (host process behind the container, host.docker.internal):
 *   Restate (container) -> host.docker.internal:PORT -> host ScheduleDriver worker
 *   -> ScheduleTimerDriver (real wake handler) -> real KernelJSON admission door
 *   -> throwaway per-test Postgres (validation db on 127.0.0.1:55432).
 *
 * Gated on S1R_LIVE=1 (needs the disposable validation `db` + `restate` up). Skips
 * cleanly otherwise. Proves what the in-memory-timer runtime suite cannot: a REAL
 * durable timer that survives worker restart AND Restate restart, journaled
 * continuation that resumes after a crash between admission and bind, and — for every
 * fault — ONE ScheduleFire, ONE admission identity, ONE canonical child task.
 */

const RUN = process.env["S1R_LIVE"] === "1";
const WORKER_PORT = 9091;
const WORKER_URI = `http://host.docker.internal:${WORKER_PORT}`;
const D0_00 = Date.UTC(2026, 8, 11, 0, 0, 0);
const D0_12 = Date.UTC(2026, 8, 11, 12, 0, 0);
const WIN = "dailyAt/01:30|Europe/London|2026-09-11";
const iso = (ms: number) => new Date(ms).toISOString();
const sha8 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const evidence: Record<string, any> = {
  capturedAt: new Date().toISOString(),
  restateImage: "docker.restate.dev/restatedev/restate:1.7.9",
  sdk: "@restatedev/restate-sdk@1.17.0",
  note: "S1-R LIVE durable-timer qualification vs real Restate + real Postgres + real admission door",
};

/** Lifecycle for the host ScheduleDriver worker: spawn, wait-ready, SIGKILL, respawn
 *  on the SAME port so the existing Restate deployment re-delivers to it. Always
 *  crash-capable; the crash only fires when the flag file exists (opt-in per test). */
class Worker {
  proc?: ChildProcess;
  logs: string[] = [];
  exited = false;
  constructor(
    private readonly env: Record<string, string>,
    private readonly port: number,
  ) {}
  start(): void {
    this.exited = false;
    this.proc = spawn(
      process.execPath,
      ["--import", "tsx", "tests/support/schedule-worker.ts"],
      { env: { ...process.env, ...this.env, PORT: String(this.port) }, stdio: ["ignore", "pipe", "pipe"] },
    );
    this.proc.stdout?.on("data", (d) => this.logs.push(String(d)));
    this.proc.stderr?.on("data", (d) => this.logs.push(String(d)));
    this.proc.on("exit", () => (this.exited = true));
  }
  async waitReady(): Promise<void> {
    // The SDK endpoint speaks HTTP/2 (bidi), so a plain HTTP/1.1 GET is rejected; a
    // raw TCP connect is the reliable "listening" signal. Discovery is then driven by
    // Restate itself during registration.
    await until(
      () =>
        new Promise<boolean>((resolve) => {
          const s = net.connect({ host: "127.0.0.1", port: this.port }, () => {
            s.destroy();
            resolve(true);
          });
          s.on("error", () => {
            s.destroy();
            resolve(false);
          });
          s.setTimeout(1000, () => {
            s.destroy();
            resolve(false);
          });
        }),
      (up) => up === true,
      20000,
    );
  }
  kill(): void {
    this.proc?.kill("SIGKILL");
  }
  async waitExit(timeoutMs = 10000): Promise<void> {
    await until(async () => this.exited, (v) => v === true, timeoutMs);
  }
}

let admin: pg.Pool, pool: pg.Pool, dbName: string, server: Server, gwUrl: string;
let tenantId: string, principalId: string, store: PgScheduleStore, worker: Worker;
let crashFlag: string, stallFlag: string;

async function register(): Promise<void> {
  await until(
    () =>
      fetch(`${ADMIN}/deployments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uri: WORKER_URI, force: true }),
      }),
    (r) => r.ok,
    30000,
  );
}

/** Teardown: remove this suite's disposable ScheduleDriver deployment from Restate so
 *  no dangling registration (pointing at the killed host worker) is left behind. */
async function deregisterWorker(): Promise<void> {
  try {
    const list = (await (await fetch(`${ADMIN}/deployments`)).json()) as {
      deployments: { id: string; uri: string }[];
    };
    for (const d of list.deployments)
      if (d.uri.includes(`:${WORKER_PORT}`))
        await fetch(`${ADMIN}/deployments/${d.id}?force=true`, { method: "DELETE" });
  } catch {
    /* best-effort teardown */
  }
}

async function putSchedule(scheduleId: string, version: string, state: "enabled" | "paused" | "disabled") {
  await store.upsertSpecVersion({
    scheduleId, version, tenant: { id: tenantId }, principal: { id: principalId, kind: "HUMAN" }, owner: { id: principalId, kind: "HUMAN" },
    name: "s1r-live", timezone: "Europe/London", calendar: { kind: "dailyAt", hour: 1, minute: 30 },
    missedRunPolicy: "SKIP", overlapPolicy: "FORBID", nonexistentTimePolicy: "SHIFT_FORWARD",
    maxBackfillRuns: 10, perScheduleConcurrency: 1, enabledForProduction: false, createdAt: iso(0), createdBy: principalId,
  });
  await store.setState({ scheduleId, state, activeVersion: version, updatedAt: iso(0), updatedBy: principalId });
}

/** Sync ingress call: awaits the handler result (blocks through ctx.sleep). */
async function fireSync(scheduleId: string, sleepMs: number): Promise<{ status: number; body: unknown; restateId: string | null; elapsedMs: number }> {
  const t0 = Date.now();
  const res = await fetch(`${INGRESS}/ScheduleDriver/${scheduleId}/fire`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lastTickMs: D0_00, nowMs: D0_12, sleepMs }),
    signal: AbortSignal.timeout(60000),
  });
  const restateId = res.headers.get("x-restate-id");
  const body = res.ok ? await res.json() : await res.text();
  return { status: res.status, body, restateId, elapsedMs: Date.now() - t0 };
}

/** One-way ingress send: returns immediately; the handler runs async in the worker. */
async function fireSend(scheduleId: string, sleepMs: number): Promise<string | null> {
  const res = await fetch(`${INGRESS}/ScheduleDriver/${scheduleId}/fire/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lastTickMs: D0_00, nowMs: D0_12, sleepMs }),
    signal: AbortSignal.timeout(10000),
  });
  try {
    const j = (await res.json()) as { invocationId?: string };
    return j.invocationId ?? null;
  } catch {
    return null;
  }
}

async function fireRow(scheduleId: string) {
  const r = await pool.query(
    "select state, admitted_child_task_id from public.schedule_fires where schedule_id=$1 and fire_window_key=$2",
    [scheduleId, WIN],
  );
  return r.rows[0] as { state: string; admitted_child_task_id: string | null } | undefined;
}

async function untilAdmitted(scheduleId: string, timeoutMs = 45000): Promise<{ state: string; admitted_child_task_id: string | null }> {
  const row = await until(() => fireRow(scheduleId), (r) => r?.state === "ADMITTED", timeoutMs);
  if (!row) throw new Error("unreachable: until resolved without an ADMITTED row");
  return row;
}

async function countFires(scheduleId: string): Promise<number> {
  const r = await pool.query("select count(*)::int n from public.schedule_fires where schedule_id=$1", [scheduleId]);
  return r.rows[0].n as number;
}

async function countAdmissions(): Promise<number> {
  const r = await pool.query("select count(*)::int n from kernel_private.task_admissions");
  return r.rows[0].n as number;
}

describe.skipIf(!RUN)("S1-R LIVE durable-timer qualification (real Restate + real Postgres + real door)", () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE });
    dbName = `s1rlive_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database ${dbName}`);
    const dbUrl = DATABASE.replace("/kerneljson", `/${dbName}`);
    pool = new pg.Pool({ connectionString: dbUrl });
    await migrate(pool);
    tenantId = randomUUID();
    principalId = randomUUID();
    await pool.query("insert into principals(id,kind) values($1,'HUMAN')", [principalId]);
    await pool.query("insert into tenants(id,name) values($1,'s1r-live')", [tenantId]);
    await pool.query("insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'owner')", [tenantId, principalId]);
    store = new PgScheduleStore(pool);

    // Real admission door (host http server), backed by the per-test db.
    const ctx = { tenantId, principal: { id: principalId, kind: "HUMAN" as const } };
    const authenticate = bearerAuthenticator(async (t) => (t === "owner" ? ctx : null));
    const controls = createRestateControls("http://not-called.invalid", async () => ({}), { pool, fetch: async () => { throw new Error("unexpected transport"); } });
    const handler = createGateway({ pool, releaseId: "s1r-live", authenticate, admit: async () => true, controls, dispatch: async () => ({ status: "ACCEPTED" }) });
    server = createServer((req, res) => { void handler(req, res); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no gateway addr");
    gwUrl = `http://127.0.0.1:${addr.port}`;

    // Fault-capable host worker (crash/stall only when the respective flag file exists).
    crashFlag = join(tmpdir(), `s1r-crash-${randomUUID()}.flag`);
    stallFlag = join(tmpdir(), `s1r-stall-${randomUUID()}.flag`);
    worker = new Worker(
      { DATABASE_URL: dbUrl, ADMISSION_URL: gwUrl, SCHED_AUTH: "Bearer owner", SCHED_RECIPE: "uppercase/v1", SCHED_OWNER: "restate-driver", SCHED_CRASH_AFTER_ADMIT: crashFlag, SCHED_STALL_AFTER_ADMIT: stallFlag, SCHED_STALL_MS: "3000" },
      WORKER_PORT,
    );
    worker.start();
    await worker.waitReady();
    await register();
  }, 180000);

  afterAll(async () => {
    worker?.kill();
    await deregisterWorker();
    server?.close();
    try { if (existsSync(crashFlag)) unlinkSync(crashFlag); } catch { /* noop */ }
    try { if (existsSync(stallFlag)) unlinkSync(stallFlag); } catch { /* noop */ }
    try {
      mkdirSync("docs/production/phase-s1-r", { recursive: true });
      writeFileSync("docs/production/phase-s1-r/RESTATE_LIVE_EVIDENCE.json", JSON.stringify(evidence, null, 2) + "\n");
    } catch { /* best effort */ }
    await pool?.end();
    await admin?.query(`drop database if exists ${dbName} with (force)`);
    await admin?.end();
  });

  it("A: real durable timer wakes and completes wake->fireIdentity->createOrGetFire->lease->fence->Admission->task_admissions->bind->ADMITTED", async () => {
    const sid = randomUUID();
    await putSchedule(sid, "v1", "enabled");
    const sched = await store.getSchedule(sid);
    const spec = runtimeSpecFrom(sched!.spec, sched!.state);
    const key = fireIdentity(spec, WIN);
    const idem = idempotencyKey(spec, WIN);

    const r = await fireSync(sid, 1500); // durable sleep 1.5s then journaled wake
    expect(r.status).toBe(200);
    const wake = r.body as { gated: boolean; admittedChildTaskIds: string[] };
    expect(wake.gated).toBe(false);
    expect(wake.admittedChildTaskIds).toHaveLength(1);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(1400); // the real timer actually waited
    const taskId = wake.admittedChildTaskIds[0]!;

    const inAdm = await pool.query("select 1 from kernel_private.task_admissions where task_id=$1", [taskId]);
    expect(inAdm.rowCount).toBe(1); // canonical admission identity exists
    const inTasks = await pool.query("select 1 from public.tasks where id=$1", [taskId]);
    expect(inTasks.rowCount).toBe(0); // public.tasks not required for the bind (Option B)
    const fire = await fireRow(sid);
    expect(fire?.state).toBe("ADMITTED");
    expect(fire?.admitted_child_task_id).toBe(taskId);
    expect(await countFires(sid)).toBe(1);
    const lease = await pool.query("select owner,epoch from public.schedule_leases where schedule_id=$1", [sid]);

    evidence.A_normal_wake = {
      scheduleId: sid, fireIdentity: key, idempotencyKeyDigest8: sha8(idem), canonicalTaskId: taskId,
      restateInvocationId: r.restateId, durableSleepMs: 1500, observedElapsedMs: r.elapsedMs,
      leaseOwner: lease.rows[0]?.owner, leaseEpoch: lease.rows[0]?.epoch,
      fireState: fire?.state, boundTaskId: fire?.admitted_child_task_id,
      inTaskAdmissions: inAdm.rowCount, inPublicTasksAtBind: inTasks.rowCount, fireRows: 1,
    };
  }, 90000);

  it("B: duplicate wake dedupes to the same fire and the same canonical task (no second task)", async () => {
    const sid = randomUUID();
    await putSchedule(sid, "v1", "enabled");
    const first = await fireSync(sid, 0);
    const w1 = first.body as { admittedChildTaskIds: string[] };
    expect(w1.admittedChildTaskIds).toHaveLength(1);
    const taskId = w1.admittedChildTaskIds[0]!;
    const second = await fireSync(sid, 0); // duplicate logical wake
    const w2 = second.body as { admittedChildTaskIds: string[]; replays: number };
    expect(w2.admittedChildTaskIds).toHaveLength(0);
    expect(w2.replays).toBe(1);
    expect(await countFires(sid)).toBe(1);
    const fire = await fireRow(sid);
    expect(fire?.admitted_child_task_id).toBe(taskId);
    evidence.B_duplicate_wake = { scheduleId: sid, taskId, secondReplays: w2.replays, fireRows: 1 };
  }, 60000);

  it("C: durable timer survives WORKER restart mid-sleep; wake still completes exactly once", async () => {
    const sid = randomUUID();
    await putSchedule(sid, "v1", "enabled");
    await fireSend(sid, 6000); // long durable sleep, one-way
    await sleep(1500); // let the invocation reach the sleep
    worker.kill();
    await worker.waitExit();
    worker.start();
    await worker.waitReady(); // same port -> existing deployment re-delivers
    const row = await untilAdmitted(sid);
    expect(row.state).toBe("ADMITTED");
    expect(await countFires(sid)).toBe(1);
    const admCount = await pool.query("select count(*)::int n from kernel_private.task_admissions where task_id=$1", [row.admitted_child_task_id]);
    expect(admCount.rows[0].n).toBe(1);
    evidence.C_worker_restart = { scheduleId: sid, taskId: row.admitted_child_task_id, fireRows: 1, survived: true };
  }, 120000);

  it("D: durable timer survives RESTATE restart mid-sleep; wake still completes exactly once", async () => {
    const sid = randomUUID();
    await putSchedule(sid, "v1", "enabled");
    await fireSend(sid, 6000);
    await sleep(1500);
    compose("restart", "restate"); // disposable validation container; not Docker Desktop
    await until(() => fetch(`${ADMIN}/health`), (r) => r.ok, 60000);
    const row = await untilAdmitted(sid, 60000);
    expect(row.state).toBe("ADMITTED");
    expect(await countFires(sid)).toBe(1);
    evidence.D_restate_restart = { scheduleId: sid, taskId: row.admitted_child_task_id, fireRows: 1, survived: true };
  }, 120000);

  it("H: crash AFTER admission commits, BEFORE bind -> replay re-admits same id, binds once (Section 16)", async () => {
    const sid = randomUUID();
    await putSchedule(sid, "v1", "enabled");
    const sched = await store.getSchedule(sid);
    const spec = runtimeSpecFrom(sched!.spec, sched!.state);
    const key = fireIdentity(spec, WIN);

    const admBefore = await countAdmissions(); // baseline (tests run sequentially)
    writeFileSync(crashFlag, "arm"); // arm the crash for the next admit
    await fireSend(sid, 0);
    await worker.waitExit(); // worker admitted (task_admissions committed) then exited
    expect(existsSync(crashFlag)).toBe(false); // decorator consumed the flag (one-shot)
    // At this instant: admission committed (+1 row), fire created but NOT yet bound.
    const admDuringCrash = await countAdmissions();
    expect(admDuringCrash).toBe(admBefore + 1);
    const fireDuringCrash = await fireRow(sid);
    expect(fireDuringCrash?.admitted_child_task_id).toBeNull(); // not bound before the crash

    worker.start();
    await worker.waitReady(); // Restate re-delivers; replay re-admits (same key), binds
    const row = await untilAdmitted(sid);
    expect(row.state).toBe("ADMITTED");
    expect(await countFires(sid)).toBe(1);
    // The replay's re-admit deduped on the Idempotency-Key: NO second canonical task.
    expect(await countAdmissions()).toBe(admBefore + 1);
    const boundInAdm = await pool.query("select 1 from kernel_private.task_admissions where task_id=$1", [row.admitted_child_task_id]);
    expect(boundInAdm.rowCount).toBe(1); // the bound id is the canonical admitted id
    evidence.H_crash_between_admit_and_bind = {
      scheduleId: sid, fireIdentity: key, taskId: row.admitted_child_task_id,
      admissionsDelta: (await countAdmissions()) - admBefore, fireRows: 1, boundToCanonical: true,
    };
  }, 120000);

  it("K: stale continuation after epoch takeover is fenced out at Postgres; no duplicate; reconciles later (Section 17)", async () => {
    const sid = randomUUID();
    await putSchedule(sid, "v1", "enabled");
    const admBefore = await countAdmissions();

    // Arm a stall AFTER admit: the continuation claims the lease (epoch 0), admits,
    // then holds ~3s before bind — a window for a takeover to bump the epoch.
    writeFileSync(stallFlag, "arm");
    await fireSend(sid, 0);
    await sleep(1200); // continuation now holds epoch 0, admitted, stalling pre-bind

    // Takeover: a different owner bumps the lease epoch. The stalling continuation's
    // fence (epoch 0) is now stale.
    const bump = await pool.query(
      "update public.schedule_leases set owner='takeover-worker', epoch=epoch+1 where schedule_id=$1 returning epoch",
      [sid],
    );
    const takeoverEpoch = bump.rows[0].epoch as number;
    expect(takeoverEpoch).toBeGreaterThan(0);

    // Let the continuation resume; its fenced bind (epoch 0) must be rejected by
    // Postgres (UPDATE 0 / StaleFenceError). The service fails closed (no retry loop).
    await sleep(3500);
    const fenced = await fireRow(sid);
    expect(fenced?.admitted_child_task_id).toBeNull(); // stale continuation did NOT bind
    expect(await countFires(sid)).toBe(1);
    expect(await countAdmissions()).toBe(admBefore + 1); // admitted once; no duplicate

    // Reconciliation: the takeover lease clears (expiry); the driver wakes again,
    // re-admits (same Idempotency-Key -> same task) and binds the SAME canonical id.
    await pool.query("delete from public.schedule_leases where schedule_id=$1", [sid]);
    const recon = await fireSync(sid, 0);
    expect((recon.body as { admittedChildTaskIds: string[] }).admittedChildTaskIds).toHaveLength(1);
    const row = await fireRow(sid);
    expect(row?.state).toBe("ADMITTED");
    expect(await countFires(sid)).toBe(1);
    expect(await countAdmissions()).toBe(admBefore + 1); // still exactly ONE canonical task
    evidence.K_stale_continuation_fenced = {
      scheduleId: sid, takeoverEpoch, staleBindRejectedByPostgres: true,
      admissionsDelta: (await countAdmissions()) - admBefore, reconciledBoundTaskId: row?.admitted_child_task_id, fireRows: 1,
    };
  }, 120000);

  it("J: recovery after a temporary Postgres outage during the wake; completes exactly once", async () => {
    const sid = randomUUID();
    await putSchedule(sid, "v1", "enabled");
    await fireSend(sid, 2500); // durable sleep; the DB steps run after it
    await sleep(1500); // still sleeping (no DB yet)
    compose("pause", "db"); // freeze Postgres so the wake's DB steps hit an outage
    await sleep(3000); // outage window: sleep ends (~2.5s) and getSchedule/bind block
    compose("unpause", "db"); // Postgres back — the journaled steps resume
    const row = await untilAdmitted(sid, 60000);
    expect(row.state).toBe("ADMITTED"); // no fabricated state; recovered and bound
    expect(await countFires(sid)).toBe(1);
    const admIn = await pool.query("select 1 from kernel_private.task_admissions where task_id=$1", [row.admitted_child_task_id]);
    expect(admIn.rowCount).toBe(1);
    evidence.J_postgres_outage = { scheduleId: sid, taskId: row.admitted_child_task_id, fireRows: 1, recovered: true };
  }, 120000);

  it("L/M: paused and disabled schedules admit NO canonical work on wake", async () => {
    const paused = randomUUID();
    await putSchedule(paused, "v1", "paused");
    const rp = await fireSync(paused, 0);
    expect((rp.body as { gated: boolean }).gated).toBe(true);
    expect(await countFires(paused)).toBe(0);

    const disabled = randomUUID();
    await putSchedule(disabled, "v1", "disabled");
    const rd = await fireSync(disabled, 0);
    expect((rd.body as { gated: boolean }).gated).toBe(true);
    expect(await countFires(disabled)).toBe(0);
    evidence.LM_pause_disable = { pausedGated: true, pausedFires: 0, disabledGated: true, disabledFires: 0 };
  }, 60000);

  it("N: version change -> wake admits under the ACTIVE version identity, not the old one", async () => {
    const sid = randomUUID();
    await putSchedule(sid, "v1", "enabled");
    await putSchedule(sid, "v2", "enabled"); // v2 now active
    const sched = await store.getSchedule(sid);
    const spec = runtimeSpecFrom(sched!.spec, sched!.state);
    expect(spec.version).toBe("v2");
    const v2Identity = fireIdentity(spec, WIN);
    const r = await fireSync(sid, 0);
    const wake = r.body as { admittedChildTaskIds: string[] };
    expect(wake.admittedChildTaskIds).toHaveLength(1);
    const fireV2 = await pool.query("select fire_identity from public.schedule_fires where schedule_id=$1 and schedule_version='v2' and fire_window_key=$2", [sid, WIN]);
    expect(fireV2.rows[0]?.fire_identity).toBe(v2Identity); // v2 identity, not v1
    const fireV1 = await pool.query("select count(*)::int n from public.schedule_fires where schedule_id=$1 and schedule_version='v1'", [sid]);
    expect(fireV1.rows[0].n).toBe(0); // the old-version window was not silently created
    evidence.N_version_change = { scheduleId: sid, activeVersion: "v2", v2Identity, v1Fires: 0 };
  }, 60000);
});
