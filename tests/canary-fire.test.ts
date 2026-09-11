import { describe, it, expect } from "vitest";
import { InMemoryScheduleStore } from "../services/kernel/src/scheduler/store.js";
import {
  InMemoryAdmissionGateway,
  type AdmissionGateway,
} from "../services/kernel/src/scheduler/durable-timer.js";
import { PersistedScheduleSpec } from "../services/kernel/src/scheduler/persistence.js";
import { AdmissionIdempotencyConflict } from "../services/kernel/src/scheduler/http-admission.js";
import { fireOnce, CanaryFireError } from "../services/kernel/src/scheduler/canary-fire.js";
import type { IdentityGate, IdentitySnapshot } from "../services/kernel/src/scheduler/canary-seed.js";

const SCHEDULE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_TENANT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const OWNER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const V2_AT = "2026-09-11T10:00:00.000+00:00";

// A window that bounds EXACTLY the 2026-09-11 daily slot (09:00 Europe/London = 08:00Z, BST).
const LAST = Date.parse("2026-09-11T07:59:00Z");
const NOW = Date.parse("2026-09-11T08:01:00Z");
const WINDOW = "dailyAt/09:00|Europe/London|2026-09-11";

// Read-only authority gate stub. The approved actor is HUMAN with an ACTIVE tenant membership;
// overrides drive the fail-closed authority cases (SERVICE, unknown, non-ACTIVE membership).
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

async function enabledStore(
  opts: { state?: "enabled" | "paused" | "disabled"; enabledForProduction?: boolean; extraSchedule?: string } = {},
): Promise<InMemoryScheduleStore> {
  const store = new InMemoryScheduleStore();
  const spec = PersistedScheduleSpec.parse({
    scheduleId: SCHEDULE,
    version: "v2",
    tenant: { id: TENANT },
    principal: { id: OWNER, kind: "SERVICE" },
    owner: { id: OWNER, kind: "HUMAN" },
    name: "claude_md_check",
    timezone: "Europe/London",
    calendar: { kind: "dailyAt", hour: 9, minute: 0 },
    missedRunPolicy: "SKIP",
    overlapPolicy: "FORBID",
    nonexistentTimePolicy: "SHIFT_FORWARD",
    maxBackfillRuns: 0,
    perScheduleConcurrency: 1,
    enabledForProduction: opts.enabledForProduction ?? true,
    createdAt: V2_AT,
    createdBy: OWNER,
  });
  await store.upsertSpecVersion(spec);
  await store.setState({
    scheduleId: SCHEDULE,
    state: opts.state ?? "enabled",
    activeVersion: "v2",
    updatedAt: V2_AT,
    updatedBy: OWNER,
  });
  if (opts.extraSchedule) {
    await store.upsertSpecVersion(PersistedScheduleSpec.parse({ ...spec, scheduleId: opts.extraSchedule, version: "v1", enabledForProduction: false }));
    await store.setState({ scheduleId: opts.extraSchedule, state: "disabled", activeVersion: "v1", updatedAt: V2_AT, updatedBy: OWNER });
  }
  return store;
}

const input = (over: Record<string, unknown> = {}) => ({
  scheduleId: SCHEDULE,
  tenantId: TENANT,
  actorPrincipalId: OWNER, // the HUMAN principal authorising the fire
  expectedActiveVersion: "v2",
  lastTickMs: LAST,
  nowMs: NOW,
  owner: "fire-once/test", // lease owner label, distinct from the HUMAN actor
  productionRuntime: true,
  ...over,
});

async function fireCode(
  store: InMemoryScheduleStore,
  g: IdentityGate,
  gateway: AdmissionGateway | null,
  inp: unknown,
): Promise<string> {
  try {
    await fireOnce(store, g, gateway, inp);
    return "OK";
  } catch (e) {
    return e instanceof CanaryFireError ? e.code : (e as Error).name;
  }
}

describe("fire-once — exactly one controlled fire", () => {
  it("executes exactly one window: one fire, ADMITTED, one canonical task", async () => {
    const store = await enabledStore();
    const gw = new InMemoryAdmissionGateway();
    const r = await fireOnce(store, gate(), gw, input());
    expect(r.preview).toBe(false);
    if (r.preview === false) {
      expect(r.fireWindowKey).toBe(WINDOW);
      expect(r.idempotencyKey).toBe(`${SCHEDULE}|v2|${WINDOW}`);
      expect(r.childTaskId).toBeTruthy();
      expect(r.fireCreated).toBe(true);
      expect(r.admissionReplay).toBe(false);
      const fires = await store.listFires(SCHEDULE);
      expect(fires).toHaveLength(1);
      expect(fires[0]!.state).toBe("ADMITTED");
      expect(fires[0]!.admittedChildTaskId).toBe(r.childTaskId);
    }
    expect(gw.mintedCount()).toBe(1);
    expect(gw.admitCalls()).toBe(1);
  });

  it("preview computes the window + identity with NO write", async () => {
    const store = await enabledStore();
    const r = await fireOnce(store, gate(), null, input({ preview: true }));
    expect(r.preview).toBe(true);
    expect(r.fireWindowKey).toBe(WINDOW);
    expect(r.idempotencyKey).toBe(`${SCHEDULE}|v2|${WINDOW}`);
    expect(r.fireIdentity).toMatch(/^[0-9a-f-]{36}$/);
    expect(await store.listFires(SCHEDULE)).toHaveLength(0);
  });

  it("preview identity equals the executed identity (stable Idempotency-Key)", async () => {
    const store = await enabledStore();
    const prev = await fireOnce(store, gate(), null, input({ preview: true }));
    const exec = await fireOnce(store, gate(), new InMemoryAdmissionGateway(), input());
    expect(exec.fireIdentity).toBe(prev.fireIdentity);
    expect(exec.idempotencyKey).toBe(prev.idempotencyKey);
  });

  it("duplicate invocation replays to the SAME task; no second fire, no second admission", async () => {
    const store = await enabledStore();
    const gw = new InMemoryAdmissionGateway();
    const a = await fireOnce(store, gate(), gw, input());
    const b = await fireOnce(store, gate(), gw, input());
    if (a.preview === false && b.preview === false) {
      expect(b.childTaskId).toBe(a.childTaskId);
      expect(b.admissionReplay).toBe(true);
      expect(b.fireCreated).toBe(false);
    }
    expect(await store.listFires(SCHEDULE)).toHaveLength(1);
    expect(gw.mintedCount()).toBe(1);
    expect(gw.admitCalls()).toBe(1); // the replay short-circuits before re-admitting
  });

  it("never creates a recurring wake (only the requested window fires)", async () => {
    const store = await enabledStore();
    await fireOnce(store, gate(), new InMemoryAdmissionGateway(), input());
    const fires = await store.listFires(SCHEDULE);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.fireWindowKey).toBe(WINDOW);
  });

  it("leaves an unrelated schedule untouched", async () => {
    const other = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const store = await enabledStore({ extraSchedule: other });
    await fireOnce(store, gate(), new InMemoryAdmissionGateway(), input());
    expect(await store.listFires(other)).toHaveLength(0);
    expect((await store.getSchedule(other))?.state.state).toBe("disabled");
  });
});

describe("fire-once — fail closed", () => {
  it("requires an explicit productionRuntime=true acknowledgement", async () => {
    expect(await fireCode(await enabledStore(), gate(), new InMemoryAdmissionGateway(), input({ productionRuntime: false }))).toBe("PRODUCTION_ACK_REQUIRED");
  });
  it("blocks a disabled schedule", async () => {
    expect(await fireCode(await enabledStore({ state: "disabled" }), gate(), new InMemoryAdmissionGateway(), input())).toBe("NOT_FIRABLE");
  });
  it("blocks when enabled_for_production is false", async () => {
    expect(await fireCode(await enabledStore({ enabledForProduction: false }), gate(), new InMemoryAdmissionGateway(), input())).toBe("NOT_FIRABLE");
  });
  it("blocks a tenant mismatch", async () => {
    expect(await fireCode(await enabledStore(), gate(), new InMemoryAdmissionGateway(), input({ tenantId: OTHER_TENANT }))).toBe("TENANT_MISMATCH");
  });
  it("blocks an unknown schedule", async () => {
    expect(await fireCode(new InMemoryScheduleStore(), gate(), new InMemoryAdmissionGateway(), input())).toBe("UNKNOWN_SCHEDULE");
  });
  it("blocks a non-HUMAN (SERVICE) actor — Gate 3 is HUMAN-only", async () => {
    expect(await fireCode(await enabledStore(), gate({ ownerKind: "SERVICE" }), new InMemoryAdmissionGateway(), input())).toBe("ACTOR_NOT_HUMAN");
  });
  it("blocks an unknown actor principal", async () => {
    expect(await fireCode(await enabledStore(), gate({ principalExists: false }), new InMemoryAdmissionGateway(), input())).toBe("UNKNOWN_PRINCIPAL");
  });
  it("blocks an unknown tenant (gate)", async () => {
    expect(await fireCode(await enabledStore(), gate({ tenantExists: false }), new InMemoryAdmissionGateway(), input())).toBe("UNKNOWN_TENANT");
  });
  it("blocks an actor with no ACTIVE tenant membership", async () => {
    expect(await fireCode(await enabledStore(), gate({ membershipExists: false }), new InMemoryAdmissionGateway(), input())).toBe("MISSING_TENANT_MEMBERSHIP");
  });
  it("fails closed on active-version drift (wrong expected active version)", async () => {
    expect(await fireCode(await enabledStore(), gate(), new InMemoryAdmissionGateway(), input({ expectedActiveVersion: "v1" }))).toBe("UNEXPECTED_ACTIVE_VERSION");
  });
  it("enforces authority even in preview (no read without approved HUMAN authority)", async () => {
    expect(await fireCode(await enabledStore(), gate({ ownerKind: "SERVICE" }), null, input({ preview: true }))).toBe("ACTOR_NOT_HUMAN");
  });
  it("writes nothing when the actor authority fails closed", async () => {
    const store = await enabledStore();
    await fireCode(store, gate({ ownerKind: "SERVICE" }), new InMemoryAdmissionGateway(), input());
    expect(await store.listFires(SCHEDULE)).toHaveLength(0);
  });
  it("blocks a window that is not exactly one slot (too many)", async () => {
    expect(
      await fireCode(await enabledStore(), gate(), new InMemoryAdmissionGateway(), input({ lastTickMs: Date.parse("2026-09-11T00:00:00Z"), nowMs: Date.parse("2026-09-13T00:00:00Z") })),
    ).toBe("WINDOW_NOT_UNIQUE");
  });
  it("blocks a window that is not exactly one slot (none)", async () => {
    expect(
      await fireCode(await enabledStore(), gate(), new InMemoryAdmissionGateway(), input({ lastTickMs: Date.parse("2026-09-11T06:00:00Z"), nowMs: Date.parse("2026-09-11T07:00:00Z") })),
    ).toBe("WINDOW_NOT_UNIQUE");
  });
  it("fails closed on an admission idempotency conflict (409)", async () => {
    const conflict: AdmissionGateway = {
      async admit(req) {
        throw new AdmissionIdempotencyConflict(req.admissionIdentity);
      },
    };
    await expect(fireOnce(await enabledStore(), gate(), conflict, input())).rejects.toBeInstanceOf(AdmissionIdempotencyConflict);
  });
  it("is blocked by a live lease held by another owner (LeaseFence)", async () => {
    const store = await enabledStore();
    await store.claimLease(SCHEDULE, "another-owner", NOW, 3_600_000);
    expect(await fireCode(store, gate(), new InMemoryAdmissionGateway(), input())).toBe("NOT_FIRABLE");
  });
});
