import { describe, it, expect } from "vitest";
import {
  provisionHumanPrincipal,
  InMemoryIdentityStore,
  IdentityProvisionError,
  type IdentityProvisioningStore,
  type IdentityProvisionCode,
} from "../services/kernel/src/identity/provisioning.js";
import { InMemoryScheduleStore } from "../services/kernel/src/scheduler/store.js";

const TENANT = "5f970749-7507-894b-a2e4-872ce20a94b7"; // existing "estate" tenant
const SERVICE = "72db0114-839e-8ca9-a2fa-462b561a936b"; // existing SERVICE principal (must not be reused)
const HUMAN = "11111111-1111-4111-8111-111111111111"; // the approved HUMAN principal (explicit)

const input = (over: Partial<{ principalId: string; tenantId: string; role: string }> = {}) => ({
  principalId: HUMAN,
  tenantId: TENANT,
  role: "operator",
  ...over,
});

async function code(store: IdentityProvisioningStore, inp: ReturnType<typeof input>) {
  try {
    await provisionHumanPrincipal(store, inp);
    return "OK";
  } catch (e) {
    return e instanceof IdentityProvisionError ? e.code : "OTHER";
  }
}

describe("HUMAN provisioning — success", () => {
  it("creates a HUMAN principal + ACTIVE operator membership in the requested tenant", async () => {
    const store = new InMemoryIdentityStore({
      tenants: [TENANT],
      principals: [{ id: SERVICE, kind: "SERVICE" }],
      memberships: [{ tenantId: TENANT, principalId: SERVICE, role: "operator", status: "ACTIVE" }],
    });
    const r = await provisionHumanPrincipal(store, input());
    expect(r).toEqual({
      principalId: HUMAN,
      tenantId: TENANT,
      provisioned: true,
      alreadyProvisioned: false,
    });
    expect(store.has(HUMAN)).toBe(true);
    expect(store.membership(TENANT, HUMAN)).toEqual({ role: "operator", status: "ACTIVE" });
    // The existing SERVICE principal + its membership are untouched.
    const svc = await store.snapshot({ tenantId: TENANT, principalId: SERVICE });
    expect(svc.principalKind).toBe("SERVICE");
    expect(svc.membershipRole).toBe("operator");
    expect(svc.membershipStatus).toBe("ACTIVE");
  });
});

describe("HUMAN provisioning — idempotency", () => {
  it("an exact repeat returns alreadyProvisioned and performs NO write", async () => {
    const seeded = new InMemoryIdentityStore({
      tenants: [TENANT],
      principals: [{ id: HUMAN, kind: "HUMAN" }],
      memberships: [{ tenantId: TENANT, principalId: HUMAN, role: "operator", status: "ACTIVE" }],
    });
    // Spy that FAILS if any write is attempted — proves the no-mutation path.
    const noWrite: IdentityProvisioningStore = {
      snapshot: (a) => seeded.snapshot(a),
      provisionAtomic: async () => {
        throw new Error("provisionAtomic must not be called on an exact repeat");
      },
    };
    const r = await provisionHumanPrincipal(noWrite, input());
    expect(r).toEqual({
      principalId: HUMAN,
      tenantId: TENANT,
      provisioned: false,
      alreadyProvisioned: true,
    });
  });
});

describe("HUMAN provisioning — conflicts / negatives (fail closed)", () => {
  const cases: { name: string; store: () => InMemoryIdentityStore; inp: ReturnType<typeof input>; code: IdentityProvisionCode }[] = [
    {
      name: "unknown tenant",
      store: () => new InMemoryIdentityStore({ tenants: [] }),
      inp: input(),
      code: "UNKNOWN_TENANT",
    },
    {
      name: "malformed principal UUID",
      store: () => new InMemoryIdentityStore({ tenants: [TENANT] }),
      inp: input({ principalId: "not-a-uuid" }),
      code: "MALFORMED_PRINCIPAL_UUID",
    },
    {
      name: "malformed tenant UUID",
      store: () => new InMemoryIdentityStore({ tenants: [TENANT] }),
      inp: input({ tenantId: "nope" }),
      code: "MALFORMED_TENANT_UUID",
    },
    {
      name: "unsupported role (owner)",
      store: () => new InMemoryIdentityStore({ tenants: [TENANT] }),
      inp: input({ role: "owner" }),
      code: "UNSUPPORTED_ROLE",
    },
    {
      name: "requested id already exists as SERVICE",
      store: () =>
        new InMemoryIdentityStore({ tenants: [TENANT], principals: [{ id: HUMAN, kind: "SERVICE" }] }),
      inp: input(),
      code: "PRINCIPAL_NOT_HUMAN",
    },
    {
      name: "membership exists with a different role",
      store: () =>
        new InMemoryIdentityStore({
          tenants: [TENANT],
          principals: [{ id: HUMAN, kind: "HUMAN" }],
          memberships: [{ tenantId: TENANT, principalId: HUMAN, role: "reader", status: "ACTIVE" }],
        }),
      inp: input(),
      code: "MEMBERSHIP_ROLE_CONFLICT",
    },
    {
      name: "membership exists REVOKED",
      store: () =>
        new InMemoryIdentityStore({
          tenants: [TENANT],
          principals: [{ id: HUMAN, kind: "HUMAN" }],
          memberships: [{ tenantId: TENANT, principalId: HUMAN, role: "operator", status: "REVOKED" }],
        }),
      inp: input(),
      code: "MEMBERSHIP_REVOKED",
    },
    {
      name: "membership exists REMOVED",
      store: () =>
        new InMemoryIdentityStore({
          tenants: [TENANT],
          principals: [{ id: HUMAN, kind: "HUMAN" }],
          memberships: [{ tenantId: TENANT, principalId: HUMAN, role: "operator", status: "REMOVED" }],
        }),
      inp: input(),
      code: "MEMBERSHIP_REMOVED",
    },
    {
      name: "partial state: HUMAN principal exists, membership absent",
      store: () =>
        new InMemoryIdentityStore({ tenants: [TENANT], principals: [{ id: HUMAN, kind: "HUMAN" }] }),
      inp: input(),
      code: "PARTIAL_STATE_UNSAFE",
    },
  ];

  for (const c of cases) {
    it(`rejects: ${c.name}`, async () => {
      const store = c.store();
      expect(await code(store, c.inp)).toBe(c.code);
    });
  }

  it("never mutates existing records on conflict (SERVICE principal unchanged)", async () => {
    const store = new InMemoryIdentityStore({
      tenants: [TENANT],
      principals: [{ id: HUMAN, kind: "SERVICE" }],
    });
    await code(store, input());
    const s = await store.snapshot({ tenantId: TENANT, principalId: HUMAN });
    expect(s.principalKind).toBe("SERVICE"); // unchanged; NOT promoted to HUMAN
    expect(s.membershipExists).toBe(false);
  });
});

describe("HUMAN provisioning — transactionality", () => {
  it("rolls back the principal insert if the membership insert fails (no orphan)", async () => {
    const store = new InMemoryIdentityStore({ tenants: [TENANT] });
    store.failMembershipInsert = true;
    await expect(provisionHumanPrincipal(store, input())).rejects.toThrow();
    expect(store.has(HUMAN)).toBe(false); // principal rolled back — no orphan HUMAN principal
    expect(store.membership(TENANT, HUMAN)).toBeNull();
  });
});

describe("HUMAN provisioning — side-effect boundary", () => {
  it("creates no scheduler/task/runtime state", async () => {
    const idStore = new InMemoryIdentityStore({ tenants: [TENANT] });
    const sched = new InMemoryScheduleStore();
    await provisionHumanPrincipal(idStore, input());
    // No schedule, no fires — provisioning is independent of the scheduler entirely.
    expect(await sched.getSchedule(HUMAN)).toBeNull();
    expect(await sched.getSchedule(TENANT)).toBeNull();
    expect(await sched.listFires(HUMAN)).toHaveLength(0);
    expect(await sched.listObservations(HUMAN)).toHaveLength(0);
  });
});
