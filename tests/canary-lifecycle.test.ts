import { describe, it, expect } from "vitest";
import { InMemoryScheduleStore } from "../services/kernel/src/scheduler/store.js";
import {
  installDisabledCanary,
  type IdentityGate,
  type IdentitySnapshot,
} from "../services/kernel/src/scheduler/canary-seed.js";
import {
  enableCanaryForProduction,
  disableCanary,
  CanaryLifecycleError,
} from "../services/kernel/src/scheduler/canary-lifecycle.js";

const SCHEDULE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_TENANT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const OWNER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const V1_AT = "2026-09-11T09:00:00.000+00:00";
const V2_AT = "2026-09-11T10:00:00.000+00:00";

const gate = (over: Partial<IdentitySnapshot> = {}): IdentityGate => ({
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

const installInput = {
  scheduleId: SCHEDULE,
  version: "v1",
  tenantId: TENANT,
  principalId: OWNER,
  ownerId: OWNER,
  createdBy: OWNER,
  name: "claude_md_check",
  timezone: "Europe/London",
  calendar: { kind: "dailyAt", hour: 9, minute: 0 },
  missedRunPolicy: "SKIP",
  overlapPolicy: "FORBID",
  nonexistentTimePolicy: "SHIFT_FORWARD",
  maxBackfillRuns: 0,
  perScheduleConcurrency: 1,
  createdAt: V1_AT,
} as const;

async function freshInstalled(): Promise<InMemoryScheduleStore> {
  const store = new InMemoryScheduleStore();
  await installDisabledCanary(store, gate(), installInput);
  return store;
}

const enableInput = (over: Record<string, unknown> = {}) => ({
  scheduleId: SCHEDULE,
  tenantId: TENANT,
  actorPrincipalId: OWNER,
  fromVersion: "v1",
  toVersion: "v2",
  createdAt: V2_AT,
  expectedState: "disabled",
  ...over,
});

async function enableCode(
  store: InMemoryScheduleStore,
  g: IdentityGate,
  input: unknown,
): Promise<string> {
  try {
    await enableCanaryForProduction(store, g, input);
    return "OK";
  } catch (e) {
    return e instanceof CanaryLifecycleError ? e.code : "OTHER";
  }
}

describe("enable-canary — disabled(v1) -> enabled(v2, production)", () => {
  it("creates v2 (production) and flips lifecycle to enabled@v2", async () => {
    const store = await freshInstalled();
    const r = await enableCanaryForProduction(store, gate(), enableInput());
    expect(r).toEqual({ scheduleId: SCHEDULE, enabled: true, alreadyEnabled: false, activeVersion: "v2" });

    const got = await store.getSchedule(SCHEDULE);
    expect(got?.state.state).toBe("enabled");
    expect(got?.state.activeVersion).toBe("v2");
    expect(got?.spec.version).toBe("v2");
    expect(got?.spec.enabledForProduction).toBe(true);
    // v2 is semantically identical to v1 in every other respect.
    expect(got?.spec.name).toBe("claude_md_check");
    expect(got?.spec.owner.id).toBe(OWNER);
    expect(got?.spec.calendar).toEqual({ kind: "dailyAt", hour: 9, minute: 0 });
  });

  it("is idempotent: a completed enable replays as alreadyEnabled with no change", async () => {
    const store = await freshInstalled();
    await enableCanaryForProduction(store, gate(), enableInput());
    const again = await enableCanaryForProduction(store, gate(), enableInput());
    expect(again).toEqual({ scheduleId: SCHEDULE, enabled: false, alreadyEnabled: true, activeVersion: "v2" });
    const got = await store.getSchedule(SCHEDULE);
    expect(got?.state.activeVersion).toBe("v2");
    expect(got?.spec.enabledForProduction).toBe(true);
  });

  it("rejects an unknown schedule", async () => {
    expect(await enableCode(new InMemoryScheduleStore(), gate(), enableInput())).toBe("UNKNOWN_SCHEDULE");
  });
  it("rejects a tenant mismatch", async () => {
    expect(await enableCode(await freshInstalled(), gate(), enableInput({ tenantId: OTHER_TENANT }))).toBe("TENANT_MISMATCH");
  });
  it("rejects an actor who is not the schedule owner", async () => {
    expect(await enableCode(await freshInstalled(), gate(), enableInput({ actorPrincipalId: OTHER }))).toBe("OWNER_MISMATCH");
  });
  it("rejects a non-HUMAN actor", async () => {
    expect(await enableCode(await freshInstalled(), gate({ ownerKind: "SERVICE" }), enableInput())).toBe("ACTOR_NOT_HUMAN");
  });
  it("rejects an unknown tenant (gate)", async () => {
    expect(await enableCode(await freshInstalled(), gate({ tenantExists: false }), enableInput())).toBe("UNKNOWN_TENANT");
  });
  it("rejects a missing membership (gate)", async () => {
    expect(await enableCode(await freshInstalled(), gate({ membershipExists: false }), enableInput())).toBe("MISSING_TENANT_MEMBERSHIP");
  });
  it("fails closed on unexpected current state", async () => {
    expect(await enableCode(await freshInstalled(), gate(), enableInput({ expectedState: "paused" }))).toBe("UNEXPECTED_STATE");
  });
  it("fails closed on unexpected active version", async () => {
    expect(await enableCode(await freshInstalled(), gate(), enableInput({ fromVersion: "v9" }))).toBe("UNEXPECTED_ACTIVE_VERSION");
  });
  it("rejects malformed input (from==to)", async () => {
    expect(await enableCode(await freshInstalled(), gate(), enableInput({ toVersion: "v1" }))).toBe("MALFORMED_INPUT");
  });
  it("fails closed when a different v2 already exists (partial/drift)", async () => {
    const store = await freshInstalled();
    const cur = await store.getSchedule(SCHEDULE);
    await store.upsertSpecVersion({ ...cur!.spec, version: "v2", name: "someone-elses-v2", enabledForProduction: true, createdAt: V2_AT, createdBy: OWNER });
    expect(await enableCode(store, gate(), enableInput())).toBe("CONFLICTING_V2");
  });
  it("writes nothing when it fails closed (state stays disabled@v1)", async () => {
    const store = await freshInstalled();
    await enableCode(store, gate(), enableInput({ actorPrincipalId: OTHER })); // OWNER_MISMATCH
    const got = await store.getSchedule(SCHEDULE);
    expect(got?.state.state).toBe("disabled");
    expect(got?.state.activeVersion).toBe("v1");
    expect(got?.spec.enabledForProduction).toBe(false);
  });
});

describe("disable-canary — the emergency stop", () => {
  const disableInput = (over: Record<string, unknown> = {}) => ({
    scheduleId: SCHEDULE,
    actorPrincipalId: OWNER,
    at: "2026-09-11T11:00:00.000+00:00",
    ...over,
  });
  async function disableCode(store: InMemoryScheduleStore, g: IdentityGate, input: unknown): Promise<string> {
    try {
      await disableCanary(store, g, input);
      return "OK";
    } catch (e) {
      return e instanceof CanaryLifecycleError ? e.code : "OTHER";
    }
  }

  it("enabled -> disabled, preserving the active version", async () => {
    const store = await freshInstalled();
    await enableCanaryForProduction(store, gate(), enableInput()); // now enabled@v2
    const r = await disableCanary(store, gate(), disableInput());
    expect(r).toEqual({ scheduleId: SCHEDULE, disabled: true, alreadyDisabled: false, activeVersion: "v2" });
    const got = await store.getSchedule(SCHEDULE);
    expect(got?.state.state).toBe("disabled");
    expect(got?.state.activeVersion).toBe("v2"); // preserved for history
    expect(got?.spec.enabledForProduction).toBe(true); // v2 spec is retained, not deleted
  });
  it("is safe to replay: already disabled -> no-op", async () => {
    const store = await freshInstalled(); // disabled@v1
    const r = await disableCanary(store, gate(), disableInput());
    expect(r).toEqual({ scheduleId: SCHEDULE, disabled: false, alreadyDisabled: true, activeVersion: "v1" });
  });
  it("rejects an unknown schedule", async () => {
    expect(await disableCode(new InMemoryScheduleStore(), gate(), disableInput())).toBe("UNKNOWN_SCHEDULE");
  });
  it("rejects a non-HUMAN actor", async () => {
    expect(await disableCode(await freshInstalled(), gate({ ownerKind: "SERVICE" }), disableInput())).toBe("ACTOR_NOT_HUMAN");
  });
  it("fails closed on active-version drift", async () => {
    const store = await freshInstalled();
    await enableCanaryForProduction(store, gate(), enableInput()); // enabled@v2
    expect(await disableCode(store, gate(), disableInput({ expectedActiveVersion: "v1" }))).toBe("UNEXPECTED_ACTIVE_VERSION");
  });
});
