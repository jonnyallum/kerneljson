import { it, expect, describe } from "vitest";
import { randomUUID } from "node:crypto";
import {
  ScheduleSpec,
  fireIdentity,
  idempotencyKey,
  InMemoryScheduleStore,
  FireBindingConflict,
  StoreError,
  ScheduleBackfillRequest,
  PersistedScheduleSpec,
  type FireInput,
} from "../services/kernel/src/scheduler/index.js";

/**
 * Phase S1 — durable persistence CONTRACT tests (EXECUTED, in-memory).
 *
 * These prove the store SEMANTICS against InMemoryScheduleStore, which mirrors
 * the DB-enforced guarantees in supabase/migrations/20260910180000_scheduler.sql.
 * The DB uniqueness/trigger equivalents are PROVEN BY STATIC SQL INSPECTION and
 * remain UNPROVEN-UNTIL-POSTGRES (no Docker here).
 */

const TENANT = randomUUID();
const HUMAN = { id: randomUUID(), kind: "HUMAN" as const };

function mkSpec(scheduleId: string, version = "v1"): ScheduleSpec {
  return ScheduleSpec.parse({
    scheduleId,
    version,
    tenant: { id: TENANT },
    principal: { id: randomUUID(), kind: "SERVICE" },
    owner: HUMAN,
    timezone: "Europe/London",
    calendar: { kind: "dailyAt", hour: 1, minute: 30 },
    state: "enabled",
    missedRunPolicy: "SKIP",
    maxBackfillRuns: 0,
    overlapPolicy: "FORBID",
    perScheduleConcurrency: 1,
    createdAt: "2026-09-10T00:00:00Z",
  });
}

function mkFireInput(spec: ScheduleSpec, windowKey: string, atIso: string): FireInput {
  return {
    idempotencyKey: idempotencyKey(spec, windowKey),
    scheduleId: spec.scheduleId,
    version: spec.version,
    fireWindowKey: windowKey,
    fireIdentity: fireIdentity(spec, windowKey),
    fireAtUtc: atIso,
    createdAt: "2026-09-10T00:00:00Z",
  };
}

const WIN = "dailyAt/01:30|Europe/London|2026-09-11";
const AT = "2026-09-11T00:30:00Z";

describe("S1 persistence: fire identity", () => {
  it("same logical fire created twice resolves to the same persisted fire", async () => {
    const store = new InMemoryScheduleStore();
    const spec = mkSpec(randomUUID());
    const a = await store.createOrGetFire(mkFireInput(spec, WIN, AT));
    const b = await store.createOrGetFire(mkFireInput(spec, WIN, AT));
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.fire.idempotencyKey).toBe(a.fire.idempotencyKey);
    expect((await store.listFires(spec.scheduleId)).length).toBe(1);
  });

  it("parallel create simulation yields exactly one logical fire", async () => {
    const store = new InMemoryScheduleStore();
    const spec = mkSpec(randomUUID());
    const input = mkFireInput(spec, WIN, AT);
    const results = await Promise.all([
      store.createOrGetFire(input),
      store.createOrGetFire(input),
      store.createOrGetFire(input),
    ]);
    expect(results.filter((r) => r.created).length).toBe(1);
    expect((await store.listFires(spec.scheduleId)).length).toBe(1);
  });

  it("schedule version creates a distinct fire namespace", async () => {
    const store = new InMemoryScheduleStore();
    const id = randomUUID();
    const v1 = mkSpec(id, "v1");
    const v2 = mkSpec(id, "v2");
    await store.createOrGetFire(mkFireInput(v1, WIN, AT));
    await store.createOrGetFire(mkFireInput(v2, WIN, AT));
    expect((await store.listFires(id)).length).toBe(2); // same window, different version
  });

  it("fire identity collision across distinct windows fails closed", async () => {
    const store = new InMemoryScheduleStore();
    const spec = mkSpec(randomUUID());
    const good = mkFireInput(spec, WIN, AT);
    await store.createOrGetFire(good);
    // forge a different window but reuse the same fireIdentity
    const forged = { ...mkFireInput(spec, "different-window", AT), fireIdentity: good.fireIdentity };
    await expect(store.createOrGetFire(forged)).rejects.toBeInstanceOf(StoreError);
  });
});

describe("S1 persistence: admission binding", () => {
  it("lost ack: rebinding the SAME child task is an idempotent REPLAY", async () => {
    const store = new InMemoryScheduleStore();
    const spec = mkSpec(randomUUID());
    const key = idempotencyKey(spec, WIN);
    await store.createOrGetFire(mkFireInput(spec, WIN, AT));
    const child = randomUUID();
    const r1 = await store.bindAdmission(key, { admissionRequestId: randomUUID(), childTaskId: child, at: AT });
    const r2 = await store.bindAdmission(key, { admissionRequestId: randomUUID(), childTaskId: child, at: AT });
    expect(r1.replay).toBe(false);
    expect(r2.replay).toBe(true);
    expect(r2.fire.admittedChildTaskId).toBe(child);
  });

  it("a fire cannot bind two different child tasks (FAIL CLOSED + AUTHORITY observation)", async () => {
    const store = new InMemoryScheduleStore();
    const spec = mkSpec(randomUUID());
    const key = idempotencyKey(spec, WIN);
    await store.createOrGetFire(mkFireInput(spec, WIN, AT));
    await store.bindAdmission(key, { admissionRequestId: randomUUID(), childTaskId: randomUUID(), at: AT });
    await expect(
      store.bindAdmission(key, { admissionRequestId: randomUUID(), childTaskId: randomUUID(), at: AT }),
    ).rejects.toBeInstanceOf(FireBindingConflict);
    const obs = await store.listObservations(spec.scheduleId);
    expect(obs.some((o) => o.kind === "AUTHORITY")).toBe(true);
  });

  it("an admitted fire cannot transition out of ADMITTED", async () => {
    const store = new InMemoryScheduleStore();
    const spec = mkSpec(randomUUID());
    const key = idempotencyKey(spec, WIN);
    await store.createOrGetFire(mkFireInput(spec, WIN, AT));
    await store.bindAdmission(key, { admissionRequestId: randomUUID(), childTaskId: randomUUID(), at: AT });
    await expect(store.transition(key, "PLANNED")).rejects.toBeInstanceOf(StoreError);
  });
});

describe("S1 persistence: lease / recovery", () => {
  it("an expired lease is recoverable by another worker, without re-minting", async () => {
    const store = new InMemoryScheduleStore();
    const spec = mkSpec(randomUUID());
    await store.createOrGetFire(mkFireInput(spec, WIN, AT));
    const t0 = Date.parse("2026-09-11T00:00:00Z");
    const l1 = await store.claimLease(spec.scheduleId, "worker-A", t0, 60_000);
    expect(l1).not.toBeNull();
    // another worker before expiry is refused
    expect(await store.claimLease(spec.scheduleId, "worker-B", t0 + 30_000, 60_000)).toBeNull();
    // after expiry, worker-B recovers it (epoch bumps), and NO new fire is minted
    const before = (await store.listFires(spec.scheduleId)).length;
    const l2 = await store.claimLease(spec.scheduleId, "worker-B", t0 + 61_000, 60_000);
    expect(l2).not.toBeNull();
    expect(l2!.epoch).toBeGreaterThan(l1!.epoch);
    expect((await store.listFires(spec.scheduleId)).length).toBe(before);
    expect((await store.listObservations(spec.scheduleId)).some((o) => o.kind === "LEASE_RECOVERED")).toBe(true);
  });
});

describe("S1 persistence: state + backfill + fail-closed", () => {
  it("disabled/paused schedule state persists and reads back", async () => {
    const store = new InMemoryScheduleStore();
    const spec = mkSpec(randomUUID());
    await store.upsertSpecVersion(mkPersisted(spec));
    await store.setState({ scheduleId: spec.scheduleId, state: "paused", activeVersion: "v1", updatedAt: AT, updatedBy: HUMAN.id });
    const got = await store.getSchedule(spec.scheduleId);
    expect(got?.state.state).toBe("paused");
    await store.setState({ scheduleId: spec.scheduleId, state: "disabled", activeVersion: "v1", updatedAt: AT, updatedBy: HUMAN.id });
    expect((await store.getSchedule(spec.scheduleId))?.state.state).toBe("disabled");
  });

  it("an immutable spec version cannot be silently changed", async () => {
    const store = new InMemoryScheduleStore();
    const spec = mkSpec(randomUUID());
    await store.upsertSpecVersion(mkPersisted(spec));
    await expect(store.upsertSpecVersion({ ...mkPersisted(spec), name: "changed-meaning" })).rejects.toBeInstanceOf(StoreError);
  });

  it("backfill request must be bounded and cannot be self-approved", async () => {
    const store = new InMemoryScheduleStore();
    const spec = mkSpec(randomUUID());
    const base = {
      id: randomUUID(),
      scheduleId: spec.scheduleId,
      version: "v1",
      requestedBy: HUMAN.id,
      requestedFrom: "2026-09-01T00:00:00Z",
      requestedTo: "2026-09-02T00:00:00Z",
      computedWindows: 2,
      maxRuns: 3,
      previewDigest: "deadbeef",
      status: "PREVIEW" as const,
      approvedBy: null,
      createdAt: AT,
      executedAt: null,
    };
    await expect(store.createBackfillRequest(ScheduleBackfillRequest.parse(base))).resolves.toBeTruthy();
    // unbounded (windows > maxRuns) rejected at parse
    expect(() => ScheduleBackfillRequest.parse({ ...base, computedWindows: 10, maxRuns: 3 })).toThrow();
    // self-approval rejected
    expect(() => ScheduleBackfillRequest.parse({ ...base, status: "APPROVED", approvedBy: HUMAN.id })).toThrow();
    // approval by a different principal is allowed
    expect(() => ScheduleBackfillRequest.parse({ ...base, status: "APPROVED", approvedBy: randomUUID() })).not.toThrow();
  });

  it("unknown policy / state values are rejected by the persisted contracts", () => {
    const p = mkPersisted(mkSpec(randomUUID()));
    expect(() => PersistedScheduleSpec.parse({ ...p, missedRunPolicy: "WHENEVER" })).toThrow();
    expect(() => PersistedScheduleSpec.parse({ ...p, overlapPolicy: "STAMPEDE" })).toThrow();
  });
});

function mkPersisted(spec: ScheduleSpec): PersistedScheduleSpec {
  return PersistedScheduleSpec.parse({
    scheduleId: spec.scheduleId,
    version: spec.version,
    tenant: spec.tenant,
    principal: spec.principal,
    owner: spec.owner,
    name: "test-schedule",
    timezone: spec.timezone,
    calendar: spec.calendar,
    missedRunPolicy: spec.missedRunPolicy,
    overlapPolicy: spec.overlapPolicy,
    nonexistentTimePolicy: spec.nonexistentTimePolicy,
    maxBackfillRuns: spec.maxBackfillRuns,
    perScheduleConcurrency: spec.perScheduleConcurrency,
    enabledForProduction: spec.enabledForProduction,
    createdAt: spec.createdAt,
    createdBy: HUMAN.id,
  });
}
