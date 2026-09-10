import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  InMemoryScheduleStore,
  StaleFenceError,
  ScheduleTimerDriver,
  InMemoryDurableTimerRuntime,
  InMemoryAdmissionGateway,
  runtimeSpecFrom,
  dueFireWindows,
  idempotencyKey,
  fireIdentity,
  type AdmissionGateway,
  type AdmissionRequestInput,
  type AdmissionResult,
  type LeaseFence,
} from "../services/kernel/src/scheduler/index.js";

/**
 * Phase S1-R — Restate BOUNDARY proof (pure / interface-level, no Restate runtime,
 * no Docker, no production). Proves the architecture in
 * docs/production/phase-s1-r/S1R_RESTATE_BOUNDARY_DESIGN_2026-09-10.md:
 * Restate = durable waiting + continuation only; KernelJSON/Postgres = all schedule/
 * task truth; one logical fire -> one admission identity -> one canonical child task
 * across double wakes, replays, mid-handler crashes, lease takeover, schedule changes
 * and backfill; and Restate can never mint a canonical task.
 */

const iso = (ms: number): string => new Date(ms).toISOString();
const D0_00 = Date.UTC(2026, 8, 11, 0, 0, 0); // 2026-09-11 00:00Z
const D0_12 = Date.UTC(2026, 8, 11, 12, 0, 0);
const D1_12 = Date.UTC(2026, 8, 12, 12, 0, 0);

async function putSpec(
  store: InMemoryScheduleStore,
  a: { scheduleId: string; version: string; hour: number; minute: number; tz?: string; prod?: boolean },
): Promise<void> {
  const humanId = randomUUID();
  await store.upsertSpecVersion({
    scheduleId: a.scheduleId,
    version: a.version,
    tenant: { id: randomUUID() },
    principal: { id: randomUUID(), kind: "SERVICE" },
    owner: { id: humanId, kind: "HUMAN" },
    name: "s1r-test",
    timezone: a.tz ?? "Europe/London",
    calendar: { kind: "dailyAt", hour: a.hour, minute: a.minute },
    missedRunPolicy: "SKIP",
    overlapPolicy: "FORBID",
    nonexistentTimePolicy: "SHIFT_FORWARD",
    maxBackfillRuns: 10,
    perScheduleConcurrency: 1,
    enabledForProduction: a.prod ?? false,
    createdAt: iso(0),
    createdBy: humanId,
  });
}

async function putState(
  store: InMemoryScheduleStore,
  a: { scheduleId: string; state: "enabled" | "paused" | "disabled"; activeVersion: string },
): Promise<void> {
  await store.setState({
    scheduleId: a.scheduleId,
    state: a.state,
    activeVersion: a.activeVersion,
    updatedAt: iso(0),
    updatedBy: randomUUID(),
  });
}

async function registerDaily(
  store: InMemoryScheduleStore,
  a: { scheduleId: string; hour: number; minute: number; state?: "enabled" | "paused" | "disabled"; prod?: boolean },
): Promise<void> {
  await putSpec(store, {
    scheduleId: a.scheduleId,
    version: "v1",
    hour: a.hour,
    minute: a.minute,
    ...(a.prod !== undefined ? { prod: a.prod } : {}),
  });
  await putState(store, { scheduleId: a.scheduleId, state: a.state ?? "enabled", activeVersion: "v1" });
}

function makeDriver(
  store: InMemoryScheduleStore,
  timers: InMemoryDurableTimerRuntime,
  admission: AdmissionGateway,
  opts?: { owner?: string; productionRuntime?: boolean },
): ScheduleTimerDriver {
  return new ScheduleTimerDriver(store, timers, admission, {
    owner: opts?.owner ?? "driver-1",
    productionRuntime: opts?.productionRuntime ?? false,
    leaseTtlMs: 3_600_000,
  });
}

async function windowFor(store: InMemoryScheduleStore, sid: string, from: number, to: number) {
  const s = await store.getSchedule(sid);
  if (!s) throw new Error("no schedule");
  const spec = runtimeSpecFrom(s.spec, s.state);
  const w = dueFireWindows(spec, from, to)[0];
  if (!w) throw new Error("no window");
  return { spec, w };
}

describe("S1-R Restate boundary (pure/interface-level)", () => {
  it("base: a wake creates one fire and admits exactly one child (row #9)", async () => {
    const store = new InMemoryScheduleStore();
    const timers = new InMemoryDurableTimerRuntime();
    const adm = new InMemoryAdmissionGateway();
    const sid = randomUUID();
    await registerDaily(store, { scheduleId: sid, hour: 1, minute: 30 });

    const r = await makeDriver(store, timers, adm).onWake(sid, D0_00, D0_12);

    expect(r.gated).toBe(false);
    expect(r.createdFires).toBe(1);
    expect(r.admittedChildTaskIds).toHaveLength(1);
    expect(adm.mintedCount()).toBe(1);
    expect(await store.listFires(sid)).toHaveLength(1);
  });

  it("double wake -> one admission, one child, second is replay (rows #1,#3)", async () => {
    const store = new InMemoryScheduleStore();
    const timers = new InMemoryDurableTimerRuntime();
    const adm = new InMemoryAdmissionGateway();
    const sid = randomUUID();
    await registerDaily(store, { scheduleId: sid, hour: 1, minute: 30 });
    const driver = makeDriver(store, timers, adm);

    const r1 = await driver.onWake(sid, D0_00, D0_12);
    const r2 = await driver.onWake(sid, D0_00, D0_12); // duplicate wake

    expect(r1.admittedChildTaskIds).toHaveLength(1);
    expect(r2.admittedChildTaskIds).toHaveLength(0);
    expect(r2.replays).toBe(1);
    expect(adm.mintedCount()).toBe(1);
    const fires = await store.listFires(sid);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.state).toBe("ADMITTED");
    expect(fires[0]!.admittedChildTaskId).toBe(r1.admittedChildTaskIds[0]);
  });

  it("wake replay after Restate restart -> one admission (row #2)", async () => {
    const store = new InMemoryScheduleStore();
    const timers = new InMemoryDurableTimerRuntime();
    const adm = new InMemoryAdmissionGateway();
    const sid = randomUUID();
    await registerDaily(store, { scheduleId: sid, hour: 1, minute: 30 });

    // Same worker identity restarting; durable state (store/timers/admission) intact.
    await makeDriver(store, timers, adm, { owner: "worker-1" }).onWake(sid, D0_00, D0_12);
    const r2 = await makeDriver(store, timers, adm, { owner: "worker-1" }).onWake(sid, D0_00, D0_12);

    expect(r2.replays).toBe(1);
    expect(adm.mintedCount()).toBe(1);
    expect(await store.listFires(sid)).toHaveLength(1);
  });

  it("crash after createOrGetFire, before admit -> replay admits once (row #5)", async () => {
    const store = new InMemoryScheduleStore();
    const timers = new InMemoryDurableTimerRuntime();
    const inner = new InMemoryAdmissionGateway();
    // Admission throws the first time (crash before the admission commit).
    let failed = false;
    const flaky: AdmissionGateway = {
      async admit(req: AdmissionRequestInput): Promise<AdmissionResult> {
        if (!failed) {
          failed = true;
          throw new Error("simulated crash before admission commit");
        }
        return inner.admit(req);
      },
    };
    const sid = randomUUID();
    await registerDaily(store, { scheduleId: sid, hour: 1, minute: 30 });
    const driver = makeDriver(store, timers, flaky);

    await expect(driver.onWake(sid, D0_00, D0_12)).rejects.toThrow(/crash before admission/);
    // The fire row was created before the crash; it is PLANNED and unadmitted.
    const mid = await store.listFires(sid);
    expect(mid).toHaveLength(1);
    expect(mid[0]!.admittedChildTaskId).toBeNull();

    const r2 = await driver.onWake(sid, D0_00, D0_12); // replay after crash
    expect(r2.admittedChildTaskIds).toHaveLength(1);
    expect(inner.mintedCount()).toBe(1);
    expect(await store.listFires(sid)).toHaveLength(1);
  });

  it("crash after admit, before bind -> replay dedupes to one child (row #6)", async () => {
    class BindFailOnceStore extends InMemoryScheduleStore {
      private failed = false;
      override async bindAdmission(
        ...args: Parameters<InMemoryScheduleStore["bindAdmission"]>
      ): ReturnType<InMemoryScheduleStore["bindAdmission"]> {
        if (!this.failed) {
          this.failed = true;
          throw new Error("simulated crash after admit before bind");
        }
        return super.bindAdmission(...args);
      }
    }
    const store = new BindFailOnceStore();
    const timers = new InMemoryDurableTimerRuntime();
    const adm = new InMemoryAdmissionGateway();
    const sid = randomUUID();
    await registerDaily(store, { scheduleId: sid, hour: 1, minute: 30 });
    const driver = makeDriver(store, timers, adm);

    await expect(driver.onWake(sid, D0_00, D0_12)).rejects.toThrow(/after admit before bind/);
    expect(adm.mintedCount()).toBe(1); // admission minted before the bind crash

    const r2 = await driver.onWake(sid, D0_00, D0_12);
    expect(r2.admittedChildTaskIds).toHaveLength(1);
    expect(adm.mintedCount()).toBe(1); // replay deduped to the SAME child task
    const fires = await store.listFires(sid);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.admittedChildTaskId).toBe(r2.admittedChildTaskIds[0]);
  });

  it("reconciliation: fire exists but Restate lost timer state -> recompute from DB, no dup (row #10)", async () => {
    const store = new InMemoryScheduleStore();
    const timersA = new InMemoryDurableTimerRuntime();
    const adm = new InMemoryAdmissionGateway();
    const sid = randomUUID();
    await registerDaily(store, { scheduleId: sid, hour: 1, minute: 30 });

    await makeDriver(store, timersA, adm).onWake(sid, D0_00, D0_12);

    // Restate lost its durable timer state: a fresh, EMPTY timer runtime.
    const timersB = new InMemoryDurableTimerRuntime();
    const r2 = await makeDriver(store, timersB, adm).onWake(sid, D0_00, D0_12);

    expect(r2.replays).toBe(1); // fire already existed in Postgres
    expect(adm.mintedCount()).toBe(1); // no duplicate canonical work
    // Reconciled: the next wake was rescheduled from DB-derived state.
    expect(await timersB.observe(sid)).toHaveLength(1);
  });

  it("stale continuation after epoch bump is fenced; new owner proceeds (rows #11,#12)", async () => {
    const store = new InMemoryScheduleStore();
    const timers = new InMemoryDurableTimerRuntime();
    const adm = new InMemoryAdmissionGateway();
    const sid = randomUUID();
    await registerDaily(store, { scheduleId: sid, hour: 1, minute: 30 });
    const driver = makeDriver(store, timers, adm);

    const { spec, w } = await windowFor(store, sid, D0_00, D0_12);
    // A fire exists but is not yet admitted (e.g. handler created it, then stalled).
    await store.createOrGetFire({
      idempotencyKey: idempotencyKey(spec, w.fireWindowKey),
      scheduleId: spec.scheduleId,
      version: spec.version,
      fireWindowKey: w.fireWindowKey,
      fireIdentity: fireIdentity(spec, w.fireWindowKey),
      fireAtUtc: w.fireAtUtcIso,
      createdAt: iso(D0_12),
    });

    // Worker A claims (epoch 0); A stalls; worker B takes over after expiry (epoch 1).
    const leaseA = await store.claimLease(sid, "A", D0_12, 1_000);
    const fenceA: LeaseFence = { owner: leaseA!.owner, epoch: leaseA!.epoch };
    const leaseB = await store.claimLease(sid, "B", D0_12 + 2_000, 1_000);
    const fenceB: LeaseFence = { owner: leaseB!.owner, epoch: leaseB!.epoch };
    expect(fenceB.epoch).toBeGreaterThan(fenceA.epoch);

    // A's late continuation is fenced out at the store (fail closed).
    await expect(driver.processWindowUnderFence(spec, w, fenceA, iso(D0_12 + 3_000))).rejects.toBeInstanceOf(
      StaleFenceError,
    );
    // B (current owner) proceeds.
    const res = await driver.processWindowUnderFence(spec, w, fenceB, iso(D0_12 + 4_000));
    expect(res.replay).toBe(false);
    expect(adm.mintedCount()).toBe(1); // A's speculative admit deduped with B's
    const fires = await store.listFires(sid);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.admittedChildTaskId).toBe(res.childTaskId);
  });

  it("disabled schedule: no admission and outstanding timer cancelled (rows #14,#16)", async () => {
    const store = new InMemoryScheduleStore();
    const timers = new InMemoryDurableTimerRuntime();
    const adm = new InMemoryAdmissionGateway();
    const sid = randomUUID();
    await registerDaily(store, { scheduleId: sid, hour: 1, minute: 30 });
    const driver = makeDriver(store, timers, adm);

    await driver.onWake(sid, D0_00, D0_12); // schedules a next wake
    expect(await timers.observe(sid)).toHaveLength(1);

    await putState(store, { scheduleId: sid, state: "disabled", activeVersion: "v1" });
    const r = await driver.onWake(sid, D0_12, D1_12);

    expect(r.gated).toBe(true);
    expect(r.reason).toBe("state_disabled");
    expect(await timers.observe(sid)).toHaveLength(0); // outstanding wake cancelled
    expect(adm.mintedCount()).toBe(1); // no new work
  });

  it("paused schedule: no admission, no fire created (row #14)", async () => {
    const store = new InMemoryScheduleStore();
    const timers = new InMemoryDurableTimerRuntime();
    const adm = new InMemoryAdmissionGateway();
    const sid = randomUUID();
    await registerDaily(store, { scheduleId: sid, hour: 1, minute: 30, state: "paused" });

    const r = await makeDriver(store, timers, adm).onWake(sid, D0_00, D0_12);
    expect(r.gated).toBe(true);
    expect(r.reason).toBe("state_paused");
    expect(await store.listFires(sid)).toHaveLength(0);
    expect(adm.mintedCount()).toBe(0);
  });

  it("production gate: enabled but not enabledForProduction is gated in prod runtime", async () => {
    const store = new InMemoryScheduleStore();
    const timers = new InMemoryDurableTimerRuntime();
    const adm = new InMemoryAdmissionGateway();
    const sid = randomUUID();
    await registerDaily(store, { scheduleId: sid, hour: 1, minute: 30, prod: false });

    const r = await makeDriver(store, timers, adm, { productionRuntime: true }).onWake(sid, D0_00, D0_12);
    expect(r.gated).toBe(true);
    expect(r.reason).toBe("production_not_enabled");
    expect(adm.mintedCount()).toBe(0);
  });

  it("version replaced with outstanding timer: forward-only from cursor; distinct identity (row #15)", async () => {
    const store = new InMemoryScheduleStore();
    const timers = new InMemoryDurableTimerRuntime();
    const adm = new InMemoryAdmissionGateway();
    const sid = randomUUID();
    await registerDaily(store, { scheduleId: sid, hour: 1, minute: 30 });
    const driver = makeDriver(store, timers, adm);

    const r1 = await driver.onWake(sid, D0_00, D0_12); // v1 fires the 09-11 slot
    expect(r1.admittedChildTaskIds).toHaveLength(1);
    const v1Fire = (await store.listFires(sid))[0]!;

    // Version bump to v2 (semantic change = new version); activate it.
    await putSpec(store, { scheduleId: sid, version: "v2", hour: 1, minute: 30 });
    await putState(store, { scheduleId: sid, state: "enabled", activeVersion: "v2" });

    const r2 = await driver.onWake(sid, D0_12, D1_12); // forward window (09-12) under v2
    expect(r2.admittedChildTaskIds).toHaveLength(1);

    const fires = await store.listFires(sid);
    expect(fires).toHaveLength(2); // 09-11 v1 + 09-12 v2, no re-fire of the past slot
    const versions = fires.map((f) => f.version).sort();
    expect(versions).toEqual(["v1", "v2"]);
    // The already-fired v1 slot is unchanged (not rebound under v2).
    const stillV1 = fires.find((f) => f.version === "v1")!;
    expect(stillV1.admittedChildTaskId).toBe(v1Fire.admittedChildTaskId);
    expect(adm.mintedCount()).toBe(2);
  });

  it("backfill window coinciding with a timer window dedupes to one fire (row #17)", async () => {
    const store = new InMemoryScheduleStore();
    const timers = new InMemoryDurableTimerRuntime();
    const adm = new InMemoryAdmissionGateway();
    const sid = randomUUID();
    await registerDaily(store, { scheduleId: sid, hour: 1, minute: 30 });

    // Backfill (a separate path) pre-creates the fire for the same window/identity.
    const { spec, w } = await windowFor(store, sid, D0_00, D0_12);
    const pre = await store.createOrGetFire({
      idempotencyKey: idempotencyKey(spec, w.fireWindowKey),
      scheduleId: spec.scheduleId,
      version: spec.version,
      fireWindowKey: w.fireWindowKey,
      fireIdentity: fireIdentity(spec, w.fireWindowKey),
      fireAtUtc: w.fireAtUtcIso,
      createdAt: iso(D0_00),
    });
    expect(pre.created).toBe(true);

    const r = await makeDriver(store, timers, adm).onWake(sid, D0_00, D0_12);
    expect(r.createdFires).toBe(0); // the timer found the existing (backfill) fire
    expect(r.admittedChildTaskIds).toHaveLength(1);
    expect(await store.listFires(sid)).toHaveLength(1); // exactly one logical fire
    expect(adm.mintedCount()).toBe(1);
  });

  it("scheduler cannot mint: every child task id comes from the AdmissionGateway", async () => {
    const store = new InMemoryScheduleStore();
    const timers = new InMemoryDurableTimerRuntime();
    const adm = new InMemoryAdmissionGateway();
    const sid = randomUUID();
    await registerDaily(store, { scheduleId: sid, hour: 1, minute: 30 });

    const { spec, w } = await windowFor(store, sid, D0_00, D0_12);
    const r = await makeDriver(store, timers, adm).onWake(sid, D0_00, D0_12);

    const identity = fireIdentity(spec, w.fireWindowKey);
    // The admitted id is exactly the one KJ Admission minted for this fire identity.
    expect(r.admittedChildTaskIds[0]).toBe(adm.childTaskIdFor(identity));
  });

  it("removability: Postgres holds all truth; losing Restate loses no schedule/fire/task record", async () => {
    const store = new InMemoryScheduleStore();
    const timers = new InMemoryDurableTimerRuntime();
    const adm = new InMemoryAdmissionGateway();
    const sid = randomUUID();
    await registerDaily(store, { scheduleId: sid, hour: 1, minute: 30 });
    await makeDriver(store, timers, adm).onWake(sid, D0_00, D0_12);

    // "Restate disappeared": discard the timer runtime entirely.
    const firesBefore = await store.listFires(sid);
    const schedBefore = await store.getSchedule(sid);
    // The store (Postgres analogue) still knows the schedule, fire and bound child.
    expect(schedBefore).not.toBeNull();
    expect(firesBefore).toHaveLength(1);
    expect(firesBefore[0]!.admittedChildTaskId).not.toBeNull();
    // A replacement DurableTimerRuntime can be reattached with no truth loss.
    const timers2 = new InMemoryDurableTimerRuntime();
    const r = await makeDriver(store, timers2, adm).onWake(sid, D0_00, D0_12);
    expect(r.replays).toBe(1);
    expect(adm.mintedCount()).toBe(1);
  });
});
