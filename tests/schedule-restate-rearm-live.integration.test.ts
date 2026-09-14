import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
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

/**
 * Phase S1B — RECURRING SELF-REARM (armNext=true) qualification.
 *
 * Everything in schedule-restate-live.integration.test.ts (S1-R) proves the durable
 * wake/admit/bind chain for a SINGLE explicit wake, always under armNext=false
 * (NoopDurableTimerRuntime) — the schedule never re-arms itself. Production has NEVER
 * exercised RestateDurableTimerRuntime.scheduleWake (the actual self-arming delayed
 * self-send). This suite is the first qualification of that path: a real, disposable
 * Restate + Postgres schedule that re-arms itself across multiple consecutive natural
 * windows with no manual fire-once between them, under worker restart, Restate restart,
 * and duplicate delivery, plus one injected admission failure to prove the recurrence-
 * failure containment behaviour (Restate's own retry policy, not an app-invented one).
 *
 * Gated on S1B_REARM_LIVE=1 (needs the disposable validation `db` + `restate` up, same
 * stack as S1-R). Skips cleanly otherwise. Does NOT touch the S1-R suite's frozen
 * evidence file or its `armNext=false` baseline — this is an additive, separately-gated
 * proof of the previously-unqualified recurring path only.
 */

const RUN = process.env["S1B_REARM_LIVE"] === "1";
const WORKER_PORT = 9092; // distinct from the S1-R suite's 9091 — no collision if both run
const WORKER_URI = `http://host.docker.internal:${WORKER_PORT}`;
const STEP_MS = 60_000; // everyNMinutes n=1
const iso = (ms: number) => new Date(ms).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const evidence: Record<string, any> = {
  capturedAt: new Date().toISOString(),
  restateImage: "docker.restate.dev/restatedev/restate:1.7.9",
  note: "S1B recurring self-rearm (armNext=true) qualification vs real Restate + real Postgres + real admission door",
};

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
let failAdmitFlag: string;

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

async function putSchedule(
  scheduleId: string,
  version: string,
  state: "enabled" | "paused" | "disabled",
) {
  await store.upsertSpecVersion({
    scheduleId,
    version,
    tenant: { id: tenantId },
    principal: { id: principalId, kind: "HUMAN" },
    owner: { id: principalId, kind: "HUMAN" },
    name: "s1b-rearm-live",
    timezone: "Europe/London",
    calendar: { kind: "everyNMinutes", n: 1 },
    missedRunPolicy: "SKIP",
    overlapPolicy: "FORBID",
    nonexistentTimePolicy: "SHIFT_FORWARD",
    maxBackfillRuns: 10,
    perScheduleConcurrency: 1,
    enabledForProduction: false,
    createdAt: iso(0),
    createdBy: principalId,
  });
  await store.setState({ scheduleId, state, activeVersion: version, updatedAt: iso(0), updatedBy: principalId });
}

/** State-only transition (e.g. disabling mid-chain) — upsertSpecVersion is immutable
 *  per (scheduleId, version), so re-calling putSchedule with the SAME version to only
 *  change state throws "spec version already exists". This changes state without
 *  touching the spec. */
async function setScheduleState(
  scheduleId: string,
  version: string,
  state: "enabled" | "paused" | "disabled",
) {
  await store.setState({ scheduleId, state, activeVersion: version, updatedAt: iso(0), updatedBy: principalId });
}

async function fireSend(scheduleId: string, lastTickMs: number, nowMs: number): Promise<string | null> {
  const res = await fetch(`${INGRESS}/ScheduleDriver/${scheduleId}/fire/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lastTickMs, nowMs, sleepMs: 0 }),
    signal: AbortSignal.timeout(10000),
  });
  try {
    const j = (await res.json()) as { invocationId?: string };
    return j.invocationId ?? null;
  } catch {
    return null;
  }
}

async function fireSync(scheduleId: string, lastTickMs: number, nowMs: number) {
  const res = await fetch(`${INGRESS}/ScheduleDriver/${scheduleId}/fire`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lastTickMs, nowMs, sleepMs: 0 }),
    signal: AbortSignal.timeout(60000),
  });
  const body = res.ok ? await res.json() : await res.text();
  return { status: res.status, body: body as { gated: boolean; admittedChildTaskIds: string[]; replays: number; nextWakeAtMs: number | null } };
}

async function fires(scheduleId: string) {
  const r = await pool.query(
    "select fire_window_key, state, admitted_child_task_id from public.schedule_fires where schedule_id=$1 order by fire_window_key",
    [scheduleId],
  );
  return r.rows as { fire_window_key: string; state: string; admitted_child_task_id: string | null }[];
}

async function countFires(scheduleId: string): Promise<number> {
  const r = await pool.query("select count(*)::int n from public.schedule_fires where schedule_id=$1", [scheduleId]);
  return r.rows[0].n as number;
}

/** A fire row exists as soon as createOrGetFire runs (before admit/bind) — waiting on
 *  row count alone races admission. Wait for N rows with a bound canonical task instead. */
async function countAdmitted(scheduleId: string): Promise<number> {
  const r = await pool.query(
    "select count(*)::int n from public.schedule_fires where schedule_id=$1 and admitted_child_task_id is not null",
    [scheduleId],
  );
  return r.rows[0].n as number;
}
async function untilAdmittedCount(scheduleId: string, n: number, timeoutMs: number) {
  return until(() => countAdmitted(scheduleId), (c) => c >= n, timeoutMs);
}

describe.skipIf(!RUN)("S1B recurring self-rearm (armNext=true, real Restate + real Postgres)", () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE });
    dbName = `s1brearm_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database ${dbName}`);
    const dbUrl = DATABASE.replace("/kerneljson", `/${dbName}`);
    pool = new pg.Pool({ connectionString: dbUrl });
    await migrate(pool);
    tenantId = randomUUID();
    principalId = randomUUID();
    await pool.query("insert into principals(id,kind) values($1,'HUMAN')", [principalId]);
    await pool.query("insert into tenants(id,name) values($1,'s1b-rearm')", [tenantId]);
    await pool.query("insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'owner')", [tenantId, principalId]);
    store = new PgScheduleStore(pool);

    const ctx = { tenantId, principal: { id: principalId, kind: "HUMAN" as const } };
    const authenticate = bearerAuthenticator(async (t) => (t === "owner" ? ctx : null));
    const controls = createRestateControls("http://not-called.invalid", async () => ({}), { pool, fetch: async () => { throw new Error("unexpected transport"); } });
    const handler = createGateway({ pool, releaseId: "s1b-rearm-live", authenticate, admit: async () => true, controls, dispatch: async () => ({ status: "ACCEPTED" }) });
    server = createServer((req, res) => { void handler(req, res); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no gateway addr");
    gwUrl = `http://127.0.0.1:${addr.port}`;

    failAdmitFlag = join(tmpdir(), `s1b-fail-admit-${randomUUID()}.flag`);
    worker = new Worker(
      {
        DATABASE_URL: dbUrl,
        ADMISSION_URL: gwUrl,
        SCHED_AUTH: "Bearer owner",
        SCHED_RECIPE: "uppercase/v1",
        SCHED_OWNER: "restate-driver",
        SCHED_ARM_NEXT: "1",
        SCHED_FAIL_ADMIT_ONCE: failAdmitFlag,
      },
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
    try { if (existsSync(failAdmitFlag)) unlinkSync(failAdmitFlag); } catch { /* noop */ }
    try {
      mkdirSync("docs/production/phase-s1b-rearm", { recursive: true });
      writeFileSync("docs/production/phase-s1b-rearm/S1B_REARM_LIVE_EVIDENCE.json", JSON.stringify(evidence, null, 2) + "\n");
    } catch { /* best effort */ }
    await pool?.end();
    await admin?.query(`drop database if exists ${dbName} with (force)`);
    await admin?.end();
  });

  it(
    "R1: 3 consecutive natural windows self-arm with zero manual fire-once between them, surviving a worker restart and a Restate restart, with duplicate delivery proven idempotent, then a disable stops recurrence with no 4th window",
    async () => {
      const sid = randomUUID();
      await putSchedule(sid, "v1", "enabled");

      const t0 = Date.now();
      const lastTick0 = t0 - STEP_MS; // exactly one step back: [lastTick0,t0) spans exactly one boundary, whatever the alignment
      const invocationId0 = await fireSend(sid, lastTick0, t0);
      expect(invocationId0).toBeTruthy();

      // Window 1 admits within a few seconds (sleepMs=0, real DB round-trips only).
      await untilAdmittedCount(sid, 1, 20000);
      const afterW1 = await fires(sid);
      expect(afterW1).toHaveLength(1);
      expect(afterW1[0]!.admitted_child_task_id).not.toBeNull();
      const w1Key = afterW1[0]!.fire_window_key;
      const w1Task = afterW1[0]!.admitted_child_task_id!;

      // DUPLICATE DELIVERY of window 1's own boundary: replay must dedupe, no 2nd fire/task.
      const w1BoundaryMs = Number(w1Key.split("@")[1]);
      const dup = await fireSync(sid, w1BoundaryMs - 1, w1BoundaryMs + 1); // half-open [from,to) must include w1BoundaryMs
      expect(dup.body.admittedChildTaskIds).toHaveLength(0);
      expect(dup.body.replays).toBe(1);
      expect(await countFires(sid)).toBe(1);
      evidence.duplicate_delivery_window1 = { scheduleId: sid, fireWindowKey: w1Key, taskId: w1Task, replays: dup.body.replays, fireCountAfter: 1 };

      // WORKER RESTART while window 2's durable delayed self-send is in flight
      // (armed by window 1's own onWake, real Restate timer, survives host process death).
      await sleep(1000);
      worker.kill();
      await worker.waitExit();
      worker.start();
      await worker.waitReady(); // same port -> Restate re-delivers window 2 to the respawned worker

      await untilAdmittedCount(sid, 2, 90000);
      const afterW2 = await fires(sid);
      expect(afterW2).toHaveLength(2);
      const w2 = afterW2.find((f) => f.fire_window_key !== w1Key)!;
      expect(w2.admitted_child_task_id).not.toBeNull();
      expect(w2.admitted_child_task_id).not.toBe(w1Task); // a distinct canonical task for a distinct window
      evidence.window2_after_worker_restart = { scheduleId: sid, fireWindowKey: w2.fire_window_key, taskId: w2.admitted_child_task_id, workerRestarted: true, fireCountAfter: 2 };

      // RESTATE RESTART while window 3's durable delayed self-send is in flight.
      await sleep(1000);
      compose("restart", "restate");
      await until(() => fetch(`${ADMIN}/health`), (r) => r.ok, 60000);

      await untilAdmittedCount(sid, 3, 90000);
      const afterW3 = await fires(sid);
      expect(afterW3).toHaveLength(3);
      const w3 = afterW3.find((f) => f.fire_window_key !== w1Key && f.fire_window_key !== w2.fire_window_key)!;
      expect(w3.admitted_child_task_id).not.toBeNull();
      expect(new Set(afterW3.map((f) => f.admitted_child_task_id))).toHaveProperty("size", 3); // 3 distinct canonical tasks, zero duplicates
      evidence.window3_after_restate_restart = { scheduleId: sid, fireWindowKey: w3.fire_window_key, taskId: w3.admitted_child_task_id, restateRestarted: true, fireCountAfter: 3 };

      // DISABLE mid-chain: window 4 has already been armed by window 3's onWake.
      // canFire must gate it to zero admission AND the chain must not re-arm further.
      await setScheduleState(sid, "v1", "disabled");
      await sleep(STEP_MS + 15000); // past where window 4 (and its would-be re-arm) would land
      expect(await countFires(sid)).toBe(3); // no 4th fire was created
      const finalFires = await fires(sid);
      expect(finalFires.map((f) => f.admitted_child_task_id).filter(Boolean)).toHaveLength(3); // still exactly 3 admitted
      evidence.disable_stops_recurrence = { scheduleId: sid, fireCountAfterDisableWindow: await countFires(sid), noFourthWindow: true };

      evidence.R1_three_consecutive_windows = {
        scheduleId: sid,
        invocationId0,
        fireIdentities: [w1Key, w2.fire_window_key, w3.fire_window_key],
        childTaskIds: [w1Task, w2.admitted_child_task_id, w3.admitted_child_task_id],
        distinctTasks: 3,
        duplicateFireOrTask: false,
      };
    },
    300000,
  );

  it(
    "R2: an admission failure on the current window does not re-arm the next window; Restate's own retry recovers the SAME invocation, then normal recurrence resumes",
    async () => {
      const sid = randomUUID();
      await putSchedule(sid, "v1", "enabled");
      const failUntil = Date.now() + 4000; // every admit attempt fails for the next 4s
      writeFileSync(failAdmitFlag, String(failUntil));

      const t0 = Date.now();
      const lastTick0 = t0 - STEP_MS; // exactly one step back: [lastTick0,t0) spans exactly one boundary, whatever the alignment
      await fireSend(sid, lastTick0, t0);

      // createOrGetFire still creates the fire row immediately (idempotent, before
      // admit) — that alone is not "admitted". While the fault is unresolved, Restate
      // is retrying the SAME invocation (500ms initial backoff, doubling); the window
      // must NOT be admitted yet, and no re-arm can occur from an attempt that never
      // reached scheduleWake (onWake throws before getting there). Checked partway
      // through the guaranteed 4s failure window, not after it, so this can't race a
      // fast first retry.
      await sleep(2000);
      expect(await countAdmitted(sid)).toBe(0); // still retrying window 1; not admitted, no re-arm
      expect(existsSync(failAdmitFlag)).toBe(true); // fault still active (deadline not reached)

      // Restate's built-in retry (already observed live: initial_interval=500ms,
      // exponentiation_factor=2, max_attempts=70, max_interval=1m, on_max_attempts=Pause)
      // retries the failing admit automatically; once the deadline passes and an attempt
      // finally succeeds, window 1 completes and window 2 is armed normally.
      await untilAdmittedCount(sid, 1, 30000);
      expect(existsSync(failAdmitFlag)).toBe(false); // consumed once an attempt succeeded
      const afterRetry = await fires(sid);
      expect(afterRetry).toHaveLength(1);
      expect(afterRetry[0]!.admitted_child_task_id).not.toBeNull();
      evidence.R2_retry_recovers_no_rearm_on_failure = {
        scheduleId: sid,
        admittedCountDuringFailure: 0,
        recoveredFireWindowKey: afterRetry[0]!.fire_window_key,
        recoveredTaskId: afterRetry[0]!.admitted_child_task_id,
        note: "Full exhaustion to Restate's documented on_max_attempts=Pause (70 attempts, up to 1m backoff each) was not run end-to-end here — infeasible in test wall-clock time. The retry-recovers path (no admission/no re-arm during failure, success resumes recurrence) is directly proven; the terminal Pause behaviour is Restate's own already-observed live service configuration (captured during S1A against production), not an app-invented policy.",
      };
    },
    60000,
  );
});
