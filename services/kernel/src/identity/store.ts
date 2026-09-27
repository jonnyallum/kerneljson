import type pg from "pg";
import {
  IdentityActivationRow,
  IdentityCandidateRow,
  IdentityDocumentDraft,
  IdentityGovernanceClass,
  IdentityOrigin,
  IdentityProfileRow,
  IdentityVersionRow,
} from "../../../../packages/contracts/src/index.js";

/**
 * KJ-P7A - the identity governance store. Every write here is a thin, parameterised insert; the
 * REAL enforcement (governance class derivation, Class A byte-identity, the rate cap, the freeze,
 * bootstrap-once, apply/completion ordering) lives in the migration's own triggers - this module
 * never re-implements a guard the database already owns, it only surfaces the database's refusal
 * as a typed error IdentityChangeWorkflowV1 can react to.
 */
export class IdentityRefusal extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

/** A database refusal that will be refused identically on every retry: an integrity-constraint
 *  violation (SQLSTATE class 23 - every identity trigger raises 23514, and unique/FK refusals are
 *  23505/23503), a data exception (class 22), or a `select ... into strict` that found no row
 *  (P0002/P0003). Anything else - a dropped connection, a serialization failure (40001), a deadlock
 *  (40P01), an admin shutdown - is transient and must propagate unwrapped so Restate retries it,
 *  never be turned into a governance refusal that terminates the task. */
export function isDeterministicRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && (code.startsWith("23") || code.startsWith("22") || code === "P0002" || code === "P0003");
}

/** Wraps only a deterministic refusal; rethrows anything transient exactly as it was. */
export function refusalOrRethrow(context: string, error: unknown): never {
  if (error instanceof IdentityRefusal) throw error;
  if (!isDeterministicRefusal(error)) throw error;
  const message = error instanceof Error ? error.message : String(error);
  throw new IdentityRefusal(`${context}: ${message}`, error);
}

const profileRow = (r: Record<string, unknown>): IdentityProfileRow =>
  IdentityProfileRow.parse({
    id: r["id"], tenantId: r["tenant_id"], ownerPrincipalId: r["owner_principal_id"],
    name: r["name"], status: r["status"], createdAt: new Date(r["created_at"] as string).toISOString(),
  });
export const versionRow = (r: Record<string, unknown>): IdentityVersionRow =>
  IdentityVersionRow.parse({
    id: r["id"], identityId: r["identity_id"], tenantId: r["tenant_id"], version: r["version"],
    document: r["document"], identityCoreDigest: r["identity_core_digest"], classADigest: r["class_a_digest"],
    governanceClass: r["governance_class"], candidateId: r["candidate_id"], createdByTask: r["created_by_task"],
    createdAt: new Date(r["created_at"] as string).toISOString(),
  });
const candidateRow = (r: Record<string, unknown>): IdentityCandidateRow =>
  IdentityCandidateRow.parse({
    id: r["id"], identityId: r["identity_id"], tenantId: r["tenant_id"], document: r["document"],
    proposedDigest: r["proposed_digest"], origin: r["origin"], governanceClass: r["governance_class"],
    proposedByTask: r["proposed_by_task"], state: r["state"],
    createdAt: new Date(r["created_at"] as string).toISOString(),
    resolvedAt: r["resolved_at"] ? new Date(r["resolved_at"] as string).toISOString() : null,
  });
export const activationRow = (r: Record<string, unknown>): IdentityActivationRow =>
  IdentityActivationRow.parse({
    id: r["id"], identityId: r["identity_id"], tenantId: r["tenant_id"], version: r["version"],
    governanceClass: r["governance_class"], candidateId: r["candidate_id"], approvalId: r["approval_id"],
    requestTaskId: r["request_task_id"], activatedAt: new Date(r["activated_at"] as string).toISOString(),
    createdBy: r["created_by"],
  });

export class IdentityStore {
  constructor(private readonly pool: pg.Pool) {}

  /** Reads the tenant's Primary Identity profile, if one has been bootstrapped. Never creates one. */
  async readProfile(tenantId: string): Promise<IdentityProfileRow | null> {
    const res = await this.pool.query("select * from public.identity_profiles where tenant_id=$1", [tenantId]);
    return res.rows[0] ? profileRow(res.rows[0] as Record<string, unknown>) : null;
  }

  /** Bootstrap-once: the unique(tenant_id) constraint refuses a second profile for the same tenant.
   *  Replay-safe: if this exact profile (same id, tenant and owner) already exists - a previous attempt
   *  committed but its Restate journal entry was lost, or an earlier bootstrap was interrupted after
   *  creating it - that profile is returned rather than refused. A different profile for the tenant is
   *  refused; a second profile is never created. */
  async ensureProfile(input: { id: string; tenantId: string; ownerPrincipalId: string; name: string }): Promise<IdentityProfileRow> {
    const existing = await this.readProfile(input.tenantId);
    if (existing) return this.matchProfile(existing, input);
    try {
      const res = await this.pool.query(
        "insert into public.identity_profiles(id,tenant_id,owner_principal_id,name) values($1,$2,$3,$4) returning *",
        [input.id, input.tenantId, input.ownerPrincipalId, input.name],
      );
      return profileRow(res.rows[0] as Record<string, unknown>);
    } catch (error) {
      refusalOrRethrow("IDENTITY_BOOTSTRAP_REFUSED", error);
    }
  }

  /** An existing profile may only be resumed (an interrupted bootstrap) by exactly the identity it
   *  already is: same id, same tenant, same owner. */
  matchProfile(profile: IdentityProfileRow, expected: { id: string; tenantId: string; ownerPrincipalId: string }): IdentityProfileRow {
    if (profile.id !== expected.id || profile.tenantId !== expected.tenantId || profile.ownerPrincipalId !== expected.ownerPrincipalId)
      throw new IdentityRefusal("IDENTITY_BOOTSTRAP_REFUSED: this tenant already has a different identity profile (id, tenant or owner differ)");
    return profile;
  }

  async readHead(identityId: string): Promise<IdentityVersionRow | null> {
    const res = await this.pool.query("select * from public.identity_head where identity_id=$1", [identityId]);
    return res.rows[0] ? versionRow(res.rows[0] as Record<string, unknown>) : null;
  }

  async readCurrent(identityId: string): Promise<IdentityVersionRow | null> {
    const res = await this.pool.query("select * from public.identity_current where identity_id=$1", [identityId]);
    return res.rows[0] ? versionRow(res.rows[0] as Record<string, unknown>) : null;
  }

  /** Used only by the ROLLBACK path: reads a prior version's own persisted document back out, so the
   *  workflow never trusts a caller-supplied document to faithfully reproduce that version's content. */
  async readVersion(identityId: string, version: number): Promise<IdentityVersionRow | null> {
    const res = await this.pool.query("select * from public.identity_versions where identity_id=$1 and version=$2", [identityId, version]);
    return res.rows[0] ? versionRow(res.rows[0] as Record<string, unknown>) : null;
  }

  async readCandidate(candidateId: string): Promise<IdentityCandidateRow | null> {
    const res = await this.pool.query("select * from public.identity_candidates where id=$1", [candidateId]);
    return res.rows[0] ? candidateRow(res.rows[0] as Record<string, unknown>) : null;
  }

  /** governanceClass here is a REQUEST, not a promise: identity_candidate_classify() overwrites it
   *  from the actual document diff (BOOTSTRAP/ROLLBACK aside, which it independently validates). The
   *  returned row's governanceClass is the one that was actually computed - always read it back. */
  async propose(input: {
    id: string; identityId: string; tenantId: string; document: IdentityDocumentDraft;
    proposedDigest: string; origin: IdentityOrigin; governanceClass: IdentityGovernanceClass;
    proposedByTask: string | null;
  }): Promise<IdentityCandidateRow> {
    // Replay-safe: the candidate id is journaled by the workflow, so a retry after a committed insert
    // whose journal entry was lost finds its own row here instead of a primary-key refusal.
    const prior = await this.pool.query(
      "select * from public.identity_candidates where id=$1 and identity_id=$2 and tenant_id=$3 and document=$4::jsonb and proposed_by_task is not distinct from $5",
      [input.id, input.identityId, input.tenantId, JSON.stringify(input.document), input.proposedByTask],
    );
    if (prior.rows[0]) return candidateRow(prior.rows[0] as Record<string, unknown>);
    try {
      const res = await this.pool.query(
        `insert into public.identity_candidates(id,identity_id,tenant_id,document,proposed_digest,origin,governance_class,proposed_by_task)
         values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [input.id, input.identityId, input.tenantId, JSON.stringify(input.document), input.proposedDigest, input.origin, input.governanceClass, input.proposedByTask],
      );
      return candidateRow(res.rows[0] as Record<string, unknown>);
    } catch (error) {
      refusalOrRethrow("IDENTITY_CANDIDATE_REFUSED", error);
    }
  }

  /** HELD -> APPROVED or HELD -> REJECTED. The transition-guard trigger refuses anything else
   *  (including a second resolution of an already-resolved candidate). */
  async resolveCandidate(candidateId: string, state: "APPROVED" | "REJECTED", resolvedAt: string): Promise<IdentityCandidateRow> {
    try {
      const res = await this.pool.query(
        "update public.identity_candidates set state=$2, resolved_at=$3 where id=$1 returning *",
        [candidateId, state, resolvedAt],
      );
      if (!res.rows[0]) throw new IdentityRefusal("IDENTITY_CANDIDATE_RESOLUTION_REFUSED: candidate not found");
      return candidateRow(res.rows[0] as Record<string, unknown>);
    } catch (error) {
      refusalOrRethrow("IDENTITY_CANDIDATE_RESOLUTION_REFUSED", error);
    }
  }
}
