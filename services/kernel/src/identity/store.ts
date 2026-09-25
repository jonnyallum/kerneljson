import type pg from "pg";
import {
  IdentityActivationRow,
  IdentityCandidateRow,
  IdentityDocument,
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

function asRefusal(context: string, error: unknown): IdentityRefusal {
  const message = error instanceof Error ? error.message : String(error);
  return new IdentityRefusal(`${context}: ${message}`, error);
}

const profileRow = (r: Record<string, unknown>): IdentityProfileRow =>
  IdentityProfileRow.parse({
    id: r["id"], tenantId: r["tenant_id"], ownerPrincipalId: r["owner_principal_id"],
    name: r["name"], status: r["status"], createdAt: new Date(r["created_at"] as string).toISOString(),
  });
const versionRow = (r: Record<string, unknown>): IdentityVersionRow =>
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
const activationRow = (r: Record<string, unknown>): IdentityActivationRow =>
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

  /** Bootstrap-once: the unique(tenant_id) constraint refuses a second profile for the same tenant,
   *  which is the ENTIRE enforcement - this method adds no logic beyond surfacing that refusal. */
  async createProfile(input: { id: string; tenantId: string; ownerPrincipalId: string; name: string }): Promise<IdentityProfileRow> {
    try {
      const res = await this.pool.query(
        "insert into public.identity_profiles(id,tenant_id,owner_principal_id,name) values($1,$2,$3,$4) returning *",
        [input.id, input.tenantId, input.ownerPrincipalId, input.name],
      );
      return profileRow(res.rows[0] as Record<string, unknown>);
    } catch (error) {
      throw asRefusal("IDENTITY_BOOTSTRAP_REFUSED", error);
    }
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
    try {
      const res = await this.pool.query(
        `insert into public.identity_candidates(id,identity_id,tenant_id,document,proposed_digest,origin,governance_class,proposed_by_task)
         values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [input.id, input.identityId, input.tenantId, JSON.stringify(input.document), input.proposedDigest, input.origin, input.governanceClass, input.proposedByTask],
      );
      return candidateRow(res.rows[0] as Record<string, unknown>);
    } catch (error) {
      throw asRefusal("IDENTITY_CANDIDATE_REFUSED", error);
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
      if (!res.rows[0]) throw new Error("candidate not found");
      return candidateRow(res.rows[0] as Record<string, unknown>);
    } catch (error) {
      throw asRefusal("IDENTITY_CANDIDATE_RESOLUTION_REFUSED", error);
    }
  }

  /** Version + activation in ONE transaction: they are two rows describing the same governed
   *  fact, and there is no meaningful state where one exists without the other. This does NOT by
   *  itself satisfy ADR-0021 D8 (the outer task must still independently reach COMPLETED - the
   *  version trigger enforces that ordering); it only guarantees these two rows are atomic
   *  w.r.t. each other. */
  async activate(input: {
    versionId: string; identityId: string; tenantId: string; version: number;
    document: IdentityDocument; identityCoreDigest: string; classADigest: string;
    candidateId: string; createdByTask: string;
    activationId: string; approvalId: string | null; requestTaskId: string;
  }): Promise<{ version: IdentityVersionRow; activation: IdentityActivationRow }> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const v = await client.query(
        `insert into public.identity_versions(id,identity_id,tenant_id,version,document,identity_core_digest,class_a_digest,governance_class,candidate_id,created_by_task)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
        [
          input.versionId, input.identityId, input.tenantId, input.version, JSON.stringify(input.document),
          input.identityCoreDigest, input.classADigest, "IGNORED_DERIVED_FROM_CANDIDATE", input.candidateId, input.createdByTask,
        ],
      );
      const a = await client.query(
        `insert into public.identity_activations(id,identity_id,tenant_id,version,governance_class,candidate_id,approval_id,request_task_id)
         values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [input.activationId, input.identityId, input.tenantId, input.version, "IGNORED_DERIVED_FROM_CANDIDATE", input.candidateId, input.approvalId, input.requestTaskId],
      );
      await client.query("commit");
      return { version: versionRow(v.rows[0] as Record<string, unknown>), activation: activationRow(a.rows[0] as Record<string, unknown>) };
    } catch (error) {
      await client.query("rollback");
      throw asRefusal("IDENTITY_ACTIVATION_REFUSED", error);
    } finally {
      client.release();
    }
  }
}
