import { describe, it, expect } from "vitest";
import { InMemoryScheduleStore } from "../services/kernel/src/scheduler/store.js";
import {
  installDisabledCanary,
  CanarySeedError,
  type IdentityGate,
  type IdentitySnapshot,
} from "../services/kernel/src/scheduler/canary-seed.js";

const base = {
  scheduleId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  version: "v1",
  tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  principalId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  ownerId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  createdBy: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  name: "claude_md_check canary",
  timezone: "Europe/London",
  calendar: { kind: "dailyAt", hour: 9, minute: 0 },
  missedRunPolicy: "SKIP",
  overlapPolicy: "FORBID",
  nonexistentTimePolicy: "SHIFT_FORWARD",
  maxBackfillRuns: 0,
  perScheduleConcurrency: 1,
  createdAt: "2026-09-11T09:00:00.000+00:00",
} as const;

const gateWith = (over: Partial<IdentitySnapshot> = {}): IdentityGate => ({
  async snapshot() {
    return {
      tenantExists: true,
      principalExists: true,
      ownerExists: true,
      ownerKind: "HUMAN",
      membershipExists: true,
      ...over,
    };
  },
});

async function seedCode(store: InMemoryScheduleStore, gate: IdentityGate, input: unknown) {
  try {
    await installDisabledCanary(store, gate, input);
    return "OK";
  } catch (e) {
    return e instanceof CanarySeedError ? e.code : "OTHER";
  }
}

describe("canary seed — install (disabled, read-only, no execution)", () => {
  it("installs a disabled, not-for-production schedule via the store interface", async () => {
    const store = new InMemoryScheduleStore();
    const r = await installDisabledCanary(store, gateWith(), base);
    expect(r).toEqual({ scheduleId: base.scheduleId, installed: true, alreadyInstalled: false });

    const got = await store.getSchedule(base.scheduleId);
    expect(got?.state.state).toBe("disabled");
    expect(got?.spec.enabledForProduction).toBe(false);
    expect(got?.spec.owner.id).toBe(base.ownerId);

    // No fire, no admission, no execution produced by creation.
    expect(await store.listFires(base.scheduleId)).toHaveLength(0);
    expect(await store.listObservations(base.scheduleId)).toHaveLength(0);
  });

  it("is idempotent: an exact repeat is recognised as already installed", async () => {
    const store = new InMemoryScheduleStore();
    await installDisabledCanary(store, gateWith(), base);
    const again = await installDisabledCanary(store, gateWith(), base);
    expect(again).toEqual({
      scheduleId: base.scheduleId,
      installed: false,
      alreadyInstalled: true,
    });
    expect(await store.listFires(base.scheduleId)).toHaveLength(0);
  });

  it("FAILS on conflicting existing state rather than overwriting", async () => {
    const store = new InMemoryScheduleStore();
    await installDisabledCanary(store, gateWith(), base);
    const code = await seedCode(store, gateWith(), { ...base, name: "different name" });
    expect(code).toBe("CONFLICTING_EXISTING_STATE");
  });
});

describe("canary seed — fail-closed negatives", () => {
  it("rejects a non-HUMAN owner", async () => {
    expect(await seedCode(new InMemoryScheduleStore(), gateWith({ ownerKind: "SERVICE" }), base)).toBe(
      "OWNER_NOT_HUMAN",
    );
  });
  it("rejects a missing tenant membership", async () => {
    expect(
      await seedCode(new InMemoryScheduleStore(), gateWith({ membershipExists: false }), base),
    ).toBe("MISSING_TENANT_MEMBERSHIP");
  });
  it("rejects an unknown tenant", async () => {
    expect(await seedCode(new InMemoryScheduleStore(), gateWith({ tenantExists: false }), base)).toBe(
      "UNKNOWN_TENANT",
    );
  });
  it("rejects an unknown principal", async () => {
    expect(
      await seedCode(new InMemoryScheduleStore(), gateWith({ principalExists: false }), base),
    ).toBe("UNKNOWN_PRINCIPAL");
  });
  it("rejects an unknown owner", async () => {
    expect(await seedCode(new InMemoryScheduleStore(), gateWith({ ownerExists: false }), base)).toBe(
      "UNKNOWN_OWNER",
    );
  });
  it("rejects an attempt to set enabled_for_production=true (strict input)", async () => {
    expect(
      await seedCode(new InMemoryScheduleStore(), gateWith(), { ...base, enabledForProduction: true }),
    ).toBe("MALFORMED_INPUT");
  });
  it("rejects an attempt to set an enabled lifecycle state (strict input)", async () => {
    expect(await seedCode(new InMemoryScheduleStore(), gateWith(), { ...base, state: "enabled" })).toBe(
      "MALFORMED_INPUT",
    );
  });
  it("rejects malformed/incomplete input (missing field, bad timezone)", async () => {
    const { timezone: _t, ...missing } = base;
    expect(await seedCode(new InMemoryScheduleStore(), gateWith(), missing)).toBe("MALFORMED_INPUT");
    expect(
      await seedCode(new InMemoryScheduleStore(), gateWith(), { ...base, timezone: "Not/ARealZone" }),
    ).toBe("MALFORMED_INPUT");
  });
  it("never writes when identity verification fails (no spec/state persisted)", async () => {
    const store = new InMemoryScheduleStore();
    await seedCode(store, gateWith({ ownerKind: "SERVICE" }), base);
    expect(await store.getSchedule(base.scheduleId)).toBeNull();
  });
});
