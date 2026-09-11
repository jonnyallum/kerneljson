import pg from "pg";
import {
  provisionHumanPrincipal,
  CANARY_MEMBERSHIP_ROLE,
  type IdentityProvisioningStore,
  type ProvisionSnapshot,
  type HumanPrincipalRecord,
  type OperatorMembershipRecord,
  type ProvisionResult,
  type PrincipalKind,
  type MembershipStatus,
} from "./provisioning.js";

/**
 * PostgreSQL-backed identity provisioning store (Gate 1.6).
 *
 * Uses the kernel's PRIVILEGED connection conventions (the same service-role /
 * superuser pool that the kernel uses for kernel_private); never anon/authenticated.
 * `provisionAtomic` wraps both inserts in a single transaction so the principal is
 * rolled back if the membership insert fails — no orphan identity. It touches only
 * public.principals and public.tenant_memberships.
 */
export class PgIdentityProvisioningStore implements IdentityProvisioningStore {
  constructor(private readonly pool: pg.Pool) {}

  async snapshot(args: {
    tenantId: string;
    principalId: string;
  }): Promise<ProvisionSnapshot> {
    const t = await this.pool.query("select 1 from public.tenants where id=$1", [args.tenantId]);
    const p = await this.pool.query("select kind from public.principals where id=$1", [
      args.principalId,
    ]);
    const m = await this.pool.query(
      "select role, status from public.tenant_memberships where tenant_id=$1 and principal_id=$2",
      [args.tenantId, args.principalId],
    );
    const principalKind = (p.rows[0]?.["kind"] as PrincipalKind | undefined) ?? null;
    const membership = m.rows[0] as { role: string; status: MembershipStatus } | undefined;
    return {
      tenantExists: (t.rowCount ?? 0) > 0,
      principalExists: (p.rowCount ?? 0) > 0,
      principalKind,
      membershipExists: (m.rowCount ?? 0) > 0,
      membershipRole: membership?.role ?? null,
      membershipStatus: membership?.status ?? null,
    };
  }

  async provisionAtomic(
    principal: HumanPrincipalRecord,
    membership: OperatorMembershipRecord,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      // Step 1: the HUMAN principal. Unique PK guards against a concurrent duplicate.
      await client.query("insert into public.principals (id, kind) values ($1, 'HUMAN')", [
        principal.id,
      ]);
      // Step 2: the ACTIVE operator membership. A failure here rolls back step 1.
      await client.query(
        "insert into public.tenant_memberships (tenant_id, principal_id, role, status) values ($1, $2, $3, 'ACTIVE')",
        [membership.tenantId, membership.principalId, membership.role],
      );
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }
}

/**
 * Prepared (NOT executed) Gate 2 invocation. The caller MUST supply the explicit,
 * change-window-approved HUMAN principal UUID and the existing production tenant id;
 * this function NEVER generates a UUID, so the principal being created is always
 * visible in the authorisation before any write. Role is fixed to "operator".
 */
export async function runHumanProvision(args: {
  pool: pg.Pool;
  principalId: string; // explicit, approved in the change window — never generated here
  tenantId: string; // existing production tenant
}): Promise<ProvisionResult> {
  const store = new PgIdentityProvisioningStore(args.pool);
  return provisionHumanPrincipal(store, {
    principalId: args.principalId,
    tenantId: args.tenantId,
    role: CANARY_MEMBERSHIP_ROLE,
  });
}
