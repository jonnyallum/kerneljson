import { Id } from "../../../../packages/contracts/src/index.js";

/**
 * S1 canary — HUMAN identity provisioning (Gate 1.6).
 *
 * A DELIBERATELY NARROW, fail-closed, typed path to provision the ONE HUMAN
 * authority the first S1 canary needs: a HUMAN principal plus an ACTIVE
 * "operator" membership in an existing tenant. It is production-capable but is
 * NOT executed here, and it creates NO production identity during Gate 1.6.
 *
 * This is NOT a generic identity console and NOT a SQL executor. It accepts only
 * explicit caller-supplied ids (never invents a production principal), is atomic
 * (principal + membership commit together or not at all), idempotent on an exact
 * repeat, and fails closed on any conflicting/partial state — it never updates,
 * reactivates, re-roles, or repairs existing identity (those are separate,
 * unauthorised operations). It has ZERO dependency on scheduler/task/runtime.
 *
 * Least privilege: the canary owner is "operator" (satisfies the scheduler
 * schedule/approve authorisation) rather than "owner".
 */

export const CANARY_MEMBERSHIP_ROLE = "operator" as const;

export type IdentityProvisionCode =
  | "MALFORMED_PRINCIPAL_UUID"
  | "MALFORMED_TENANT_UUID"
  | "UNSUPPORTED_ROLE"
  | "UNKNOWN_TENANT"
  | "PRINCIPAL_NOT_HUMAN"
  | "MEMBERSHIP_ROLE_CONFLICT"
  | "MEMBERSHIP_REVOKED"
  | "MEMBERSHIP_REMOVED"
  | "MEMBERSHIP_STATUS_UNEXPECTED"
  | "PARTIAL_STATE_UNSAFE"
  | "ORPHAN_MEMBERSHIP";

export class IdentityProvisionError extends Error {
  constructor(
    readonly code: IdentityProvisionCode,
    message: string,
  ) {
    super(message);
    this.name = "IdentityProvisionError";
  }
}

export type PrincipalKind = "HUMAN" | "SERVICE";
export type MembershipStatus = "ACTIVE" | "REVOKED" | "REMOVED";

/** Current identity state for (tenantId, principalId), read in one snapshot. */
export interface ProvisionSnapshot {
  tenantExists: boolean;
  principalExists: boolean;
  principalKind: PrincipalKind | null;
  membershipExists: boolean;
  membershipRole: string | null;
  membershipStatus: MembershipStatus | null;
}

export interface HumanPrincipalRecord {
  id: string;
  kind: "HUMAN";
}
export interface OperatorMembershipRecord {
  tenantId: string;
  principalId: string;
  role: "operator";
  status: "ACTIVE";
}

/**
 * Persistence boundary. `snapshot` reads current state; `provisionAtomic` commits
 * the HUMAN principal AND the ACTIVE operator membership in ONE transaction
 * (both or neither). SQL details live in the implementation, never in callers.
 */
export interface IdentityProvisioningStore {
  snapshot(args: { tenantId: string; principalId: string }): Promise<ProvisionSnapshot>;
  provisionAtomic(
    principal: HumanPrincipalRecord,
    membership: OperatorMembershipRecord,
  ): Promise<void>;
}

export interface ProvisionInput {
  principalId: string;
  tenantId: string;
  role: string;
}

export interface ProvisionResult {
  principalId: string;
  tenantId: string;
  provisioned: boolean;
  alreadyProvisioned: boolean;
}

/**
 * Provision (or recognise as already provisioned) the canary's HUMAN owner.
 * Fail-closed; never mutates existing identity on any conflict.
 */
export async function provisionHumanPrincipal(
  store: IdentityProvisioningStore,
  input: ProvisionInput,
): Promise<ProvisionResult> {
  // Explicit, precise input validation (distinct codes for distinct failures).
  if (input.role !== CANARY_MEMBERSHIP_ROLE)
    throw new IdentityProvisionError(
      "UNSUPPORTED_ROLE",
      `role must be "${CANARY_MEMBERSHIP_ROLE}" for the S1 canary path`,
    );
  if (!Id.safeParse(input.principalId).success)
    throw new IdentityProvisionError("MALFORMED_PRINCIPAL_UUID", "principalId is not a valid UUID");
  if (!Id.safeParse(input.tenantId).success)
    throw new IdentityProvisionError("MALFORMED_TENANT_UUID", "tenantId is not a valid UUID");

  const snap = await store.snapshot({ tenantId: input.tenantId, principalId: input.principalId });

  if (!snap.tenantExists)
    throw new IdentityProvisionError("UNKNOWN_TENANT", "tenant does not exist");

  if (snap.principalExists) {
    if (snap.principalKind !== "HUMAN")
      throw new IdentityProvisionError(
        "PRINCIPAL_NOT_HUMAN",
        `principal already exists as ${snap.principalKind ?? "UNKNOWN"}; refusing to reuse`,
      );
    // Principal is HUMAN. The requested membership must already be the exact target,
    // otherwise the state is partial/conflicting and we refuse to mutate.
    if (snap.membershipExists) {
      if (snap.membershipStatus === "ACTIVE" && snap.membershipRole === CANARY_MEMBERSHIP_ROLE)
        return {
          principalId: input.principalId,
          tenantId: input.tenantId,
          provisioned: false,
          alreadyProvisioned: true,
        };
      if (snap.membershipRole !== CANARY_MEMBERSHIP_ROLE)
        throw new IdentityProvisionError(
          "MEMBERSHIP_ROLE_CONFLICT",
          `membership exists with role "${snap.membershipRole}", not "${CANARY_MEMBERSHIP_ROLE}"`,
        );
      if (snap.membershipStatus === "REVOKED")
        throw new IdentityProvisionError("MEMBERSHIP_REVOKED", "membership is REVOKED; refusing to reactivate");
      if (snap.membershipStatus === "REMOVED")
        throw new IdentityProvisionError("MEMBERSHIP_REMOVED", "membership is REMOVED; refusing to reactivate");
      throw new IdentityProvisionError(
        "MEMBERSHIP_STATUS_UNEXPECTED",
        `membership has unexpected status "${snap.membershipStatus}"`,
      );
    }
    // HUMAN principal exists but the requested membership does not: partial state.
    throw new IdentityProvisionError(
      "PARTIAL_STATE_UNSAFE",
      "HUMAN principal exists without the requested membership; refusing partial provision",
    );
  }

  // Principal does not exist. A membership for it should not exist either (FK).
  if (snap.membershipExists)
    throw new IdentityProvisionError(
      "ORPHAN_MEMBERSHIP",
      "membership exists without its principal; refusing unsafe state",
    );

  // Fresh state — create both atomically.
  await store.provisionAtomic(
    { id: input.principalId, kind: "HUMAN" },
    {
      tenantId: input.tenantId,
      principalId: input.principalId,
      role: CANARY_MEMBERSHIP_ROLE,
      status: "ACTIVE",
    },
  );
  return {
    principalId: input.principalId,
    tenantId: input.tenantId,
    provisioned: true,
    alreadyProvisioned: false,
  };
}

/* -------------------------------------------------------------------------- */
/* In-memory reference store (tests only) — reproduces PK/unique + transaction */
/* atomicity semantics, with an injectable membership-insert failure to prove  */
/* rollback. NOT production persistence.                                       */
/* -------------------------------------------------------------------------- */

export class IdentityStoreError extends Error {}

export class InMemoryIdentityStore implements IdentityProvisioningStore {
  private principals = new Map<string, PrincipalKind>();
  private tenants = new Set<string>();
  private memberships = new Map<string, { role: string; status: MembershipStatus }>();
  /** Test seam: force the membership insert step to fail (after the principal step). */
  failMembershipInsert = false;

  constructor(seed?: {
    tenants?: string[];
    principals?: { id: string; kind: PrincipalKind }[];
    memberships?: {
      tenantId: string;
      principalId: string;
      role: string;
      status: MembershipStatus;
    }[];
  }) {
    for (const t of seed?.tenants ?? []) this.tenants.add(t);
    for (const p of seed?.principals ?? []) this.principals.set(p.id, p.kind);
    for (const m of seed?.memberships ?? [])
      this.memberships.set(`${m.tenantId}|${m.principalId}`, { role: m.role, status: m.status });
  }

  private mkey(tenantId: string, principalId: string) {
    return `${tenantId}|${principalId}`;
  }

  has(principalId: string): boolean {
    return this.principals.has(principalId);
  }
  membership(tenantId: string, principalId: string) {
    return this.memberships.get(this.mkey(tenantId, principalId)) ?? null;
  }

  async snapshot(args: { tenantId: string; principalId: string }): Promise<ProvisionSnapshot> {
    const kind = this.principals.get(args.principalId) ?? null;
    const m = this.memberships.get(this.mkey(args.tenantId, args.principalId)) ?? null;
    return {
      tenantExists: this.tenants.has(args.tenantId),
      principalExists: this.principals.has(args.principalId),
      principalKind: kind,
      membershipExists: m !== null,
      membershipRole: m?.role ?? null,
      membershipStatus: m?.status ?? null,
    };
  }

  async provisionAtomic(
    principal: HumanPrincipalRecord,
    membership: OperatorMembershipRecord,
  ): Promise<void> {
    // Simulate PK / unique constraints.
    if (this.principals.has(principal.id)) throw new IdentityStoreError("duplicate principal");
    const mk = this.mkey(membership.tenantId, membership.principalId);
    if (this.memberships.has(mk)) throw new IdentityStoreError("duplicate membership");

    // begin
    this.principals.set(principal.id, principal.kind); // step 1: insert principal
    try {
      if (this.failMembershipInsert) throw new IdentityStoreError("membership insert failed");
      if (!this.tenants.has(membership.tenantId))
        throw new IdentityStoreError("fk violation: tenant missing"); // simulate FK
      this.memberships.set(mk, { role: membership.role, status: membership.status }); // step 2
      // commit (both present)
    } catch (e) {
      this.principals.delete(principal.id); // ROLLBACK step 1 — no orphan principal
      throw e;
    }
  }
}
