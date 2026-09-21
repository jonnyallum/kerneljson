import { createHash } from "node:crypto";
import type pg from "pg";
import {
  AssembledContext,
  CandidateSubmission,
  CanonicalMemoryVersion,
  ContextRequest,
  Id,
  TRUST_FOR_ORIGIN,
  type CandidateState,
  type ExternalContextItem,
  type MemoryClass,
  type MemoryEvidenceRef,
  type MemoryOrigin,
  type MemorySubject,
  type PromotionDecision,
  type TenantContext,
} from "../../../../packages/contracts/src/index.js";
import { withTenant, type Permission } from "../../../../packages/identity/src/index.js";
import { capabilityDigest } from "../../../../packages/capabilities/src/index.js";
import { stableId } from "../../../kernel/src/compiler/index.js";
import { verifiedResult } from "../../../kernel/src/provenance.js";
import { buildAssembled, pack, packExternal, purposeDigest, rankCandidates, type Candidate } from "./assembler.js";
import { POLICY_VERSION, decidePromotion, type PolicyDecisionResult, type PolicyOutcome } from "./policy.js";
import type { PromotionApprovals } from "./approval-binding.js";

/**
 * KJ-P5 - the canonical memory service. Every path that can create canonical memory is in this file, and every one of
 * them goes candidate -> deterministic policy -> promotion event -> version. The four `submit*` entry points are the
 * only place an ORIGIN is decided, and it is decided by which entry point was called, never by the candidate.
 */
export class MemoryError extends Error {
  constructor(
    readonly code: "FORBIDDEN_ORIGIN" | "CONFLICT" | "INVALID" | "NOT_FOUND" | "AMBIGUOUS",
    message: string,
  ) {
    super(message);
  }
}

export interface SubmissionResult {
  candidateId: string;
  origin: MemoryOrigin;
  state: CandidateState;
  decision: PromotionDecision;
  ruleId: string;
  reason: string;
  memoryId: string | null;
  version: number | null;
  approvalId: string | null;
  /** True when this call found the candidate already recorded and changed nothing. */
  replayed: boolean;
}

export interface MemoryView {
  memoryId: string;
  status: "CURRENT" | "RETRACTED" | "SUPERSEDED";
  supersededBy: string | null;
  supersedes: string[];
  conflictsWith: string[];
  head: CanonicalMemoryVersion;
  versions: CanonicalMemoryVersion[];
}

export interface AssembleOptions {
  consumer?: { taskId?: string | undefined; stepId?: string | undefined; callId?: string | undefined };
  external?: ExternalContextItem[];
}

interface Prepared {
  candidateId: string;
  sub: CandidateSubmission;
  contentDigest: string;
  requestDigest: string;
}

interface TargetState {
  memoryId: string;
  version: number;
  kind: "ASSERT" | "RETRACT";
  class: MemoryClass;
  subject: MemorySubject;
  content: string;
  superseded: boolean;
}

interface CandidateRow {
  id: string;
  tenant_id: string;
  origin: MemoryOrigin;
  submitted_by: string;
  proposed_class: MemoryClass;
  intent: "NEW" | "CORRECT" | "SUPERSEDE" | "RETRACT";
  target_memory_id: string | null;
  content: string;
  content_digest: string;
  subject_kind: MemorySubject["kind"];
  subject_ref: string;
  evidence: MemoryEvidenceRef[];
  reason: string;
  request_digest: string;
  state: CandidateState;
  approval_id: string | null;
  created_at: Date;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const normalise = (text: string): string => text.normalize("NFC").trim();
const iso = (d: Date): string => d.toISOString();
type Verdict = Omit<PolicyDecisionResult, "decision"> & { decision: PromotionDecision };
const STATE_FOR: Record<PolicyOutcome, CandidateState> = { ALLOW: "PROMOTED", REQUIRE_APPROVAL: "AWAITING_APPROVAL", HOLD: "HELD", REFUSE: "REFUSED" };

export class CanonicalMemory {
  constructor(
    private readonly pool: pg.Pool,
    private readonly options: { approvals?: PromotionApprovals; now?: () => Date } = {},
  ) {}

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  // ---------------------------------------------------------------- entry points (the only place an origin is set)

  /** An explicit instruction from an authenticated human channel, for example Telegram `/remember`. */
  submitOperatorInstruction(ctx: TenantContext, raw: unknown): Promise<SubmissionResult> {
    if (ctx.principal.kind !== "HUMAN") throw new MemoryError("FORBIDDEN_ORIGIN", "Only a human principal can give a memory instruction");
    return this.submit("OPERATOR_INSTRUCTION", ctx, raw);
  }

  /** A verified task outcome proposing a memory. Its task evidence is checked against the ledger. */
  submitVerifiedOutcomeCandidate(ctx: TenantContext, raw: unknown): Promise<SubmissionResult> {
    if (ctx.principal.kind !== "SERVICE") throw new MemoryError("FORBIDDEN_ORIGIN", "A verified outcome is proposed by a service principal");
    return this.submit("VERIFIED_OUTCOME", ctx, raw);
  }

  /** Anything a model produced. It can only ever become a candidate. */
  submitModelCandidate(ctx: TenantContext, raw: unknown): Promise<SubmissionResult> {
    return this.submit("MODEL_PROPOSAL", ctx, raw);
  }

  /** Anything from the Shared Brain or another external system. It can only ever become a candidate. */
  submitExternalCandidate(ctx: TenantContext, raw: unknown): Promise<SubmissionResult> {
    return this.submit("SHARED_BRAIN", ctx, raw);
  }

  // ---------------------------------------------------------------- submission

  private prepare(raw: unknown): Prepared {
    const sub = CandidateSubmission.parse(raw);
    const contentDigest = sha256(normalise(sub.content));
    const requestDigest = capabilityDigest({
      class: sub.class,
      contentDigest,
      subject: sub.subject,
      evidence: sub.evidence,
      reason: sub.reason,
      intent: sub.intent,
      target: sub.targetMemoryId ?? null,
    });
    return { candidateId: "", sub, contentDigest, requestDigest };
  }

  private async submit(origin: MemoryOrigin, ctx: TenantContext, raw: unknown): Promise<SubmissionResult> {
    const prepared = this.prepare(raw);
    prepared.candidateId = stableId(["memory-candidate/v1", ctx.tenantId, prepared.sub.idempotencyKey]);

    // Phase 1: read only. Replay, or find out whether this candidate will need an approval created first.
    const first = await withTenant(
      this.pool,
      ctx,
      async (db) => {
        const existing = await this.existing(db, ctx, prepared);
        if (existing) return { replay: existing } as const;
        const target = await this.loadTarget(db, ctx.tenantId, prepared.sub.targetMemoryId, false);
        const verdict = await this.judge(db, origin, ctx, prepared.sub, target);
        return { replay: null, needsApproval: verdict.decision === "REQUIRE_APPROVAL" } as const;
      },
      "knowledge-write",
    );
    if (first.replay) return first.replay;

    // An approval is created through the existing ApprovalStore before the candidate row that references it.
    let approvalId: string | null = null;
    if (first.needsApproval && this.options.approvals) {
      const ticket = await this.options.approvals.request({
        tenantId: ctx.tenantId,
        candidateId: prepared.candidateId,
        candidateDigest: prepared.requestDigest,
        submitter: ctx.principal,
      });
      approvalId = ticket.approvalId;
    }

    // Phase 2: one transaction records the candidate, the decision and, when allowed, the canonical version.
    return withTenant(
      this.pool,
      ctx,
      async (db) => {
        const target = await this.loadTarget(db, ctx.tenantId, prepared.sub.targetMemoryId, true);
        let verdict = await this.judge(db, origin, ctx, prepared.sub, target);
        if (verdict.decision === "REQUIRE_APPROVAL" && approvalId === null)
          verdict = { ...verdict, decision: "HOLD", ruleId: "approval-unavailable", reason: "this promotion needs an approver and none is configured, so it stays a candidate" };
        const at = this.now();
        const inserted = await db.query(
          `insert into memory_candidates(id,tenant_id,origin,submitted_by,idempotency_key,proposed_class,intent,target_memory_id,content,content_digest,subject_kind,subject_ref,evidence,reason,request_digest,state,state_reason,approval_id,created_at,decided_at)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,$19,$19) on conflict do nothing returning id`,
          [
            prepared.candidateId,
            ctx.tenantId,
            origin,
            ctx.principal.id,
            prepared.sub.idempotencyKey,
            prepared.sub.class,
            prepared.sub.intent,
            prepared.sub.targetMemoryId ?? null,
            prepared.sub.content,
            prepared.contentDigest,
            prepared.sub.subject.kind,
            prepared.sub.subject.ref,
            JSON.stringify(prepared.sub.evidence),
            prepared.sub.reason,
            prepared.requestDigest,
            STATE_FOR[verdict.decision as PolicyOutcome],
            verdict.reason,
            verdict.decision === "REQUIRE_APPROVAL" ? approvalId : null,
            iso(at),
          ],
        );
        if (inserted.rowCount === 0) {
          const replay = await this.existing(db, ctx, prepared);
          if (!replay) throw new MemoryError("CONFLICT", "Candidate could not be recorded");
          return replay;
        }
        const row = await this.candidateRow(db, ctx.tenantId, prepared.candidateId);
        const result = await this.recordDecision(db, row, target, verdict, {
          phase: "decide",
          by: { kind: "POLICY_ENGINE", principal: ctx.principal.id },
          approvalId: verdict.decision === "REQUIRE_APPROVAL" ? approvalId : null,
          at,
        });
        return { ...result, replayed: false };
      },
      "knowledge-write",
    );
  }

  private async existing(db: pg.PoolClient, ctx: TenantContext, p: Prepared): Promise<SubmissionResult | null> {
    const rows = await db.query<CandidateRow>("select * from memory_candidates where tenant_id=$1 and idempotency_key=$2", [ctx.tenantId, p.sub.idempotencyKey]);
    const row = rows.rows[0];
    if (!row) return null;
    if (row.request_digest !== p.requestDigest) throw new MemoryError("CONFLICT", "That idempotency key was already used for a different candidate");
    return this.resultFor(db, row, true);
  }

  private async candidateRow(db: pg.PoolClient, tenantId: string, id: string, lock = false): Promise<CandidateRow> {
    const rows = await db.query<CandidateRow>(`select * from memory_candidates where tenant_id=$1 and id=$2${lock ? " for update" : ""}`, [tenantId, id]);
    const row = rows.rows[0];
    if (!row) throw new MemoryError("NOT_FOUND", "Candidate not found");
    return row;
  }

  private async resultFor(db: pg.PoolClient, row: CandidateRow, replayed: boolean): Promise<SubmissionResult> {
    const p = await db.query<{ decision: PromotionDecision; rule_id: string; reason: string; approval_id: string | null; result_memory_id: string | null; result_version: number | null }>(
      `select decision,rule_id,reason,approval_id,result_memory_id,result_version from memory_promotions where candidate_id=$1
        order by (decision in ('ALLOW_APPROVED','REJECT_APPROVAL')) desc, created_at desc limit 1`,
      [row.id],
    );
    const promotion = p.rows[0];
    if (!promotion) throw new MemoryError("INVALID", "Candidate has no promotion record");
    return {
      candidateId: row.id,
      origin: row.origin,
      state: row.state,
      decision: promotion.decision,
      ruleId: promotion.rule_id,
      reason: promotion.reason,
      memoryId: promotion.result_memory_id,
      version: promotion.result_version,
      approvalId: row.approval_id,
      replayed,
    };
  }

  // ---------------------------------------------------------------- judgement

  private async loadTarget(db: pg.PoolClient, tenantId: string, memoryId: string | undefined, lock: boolean): Promise<TargetState | null> {
    if (memoryId === undefined) return null;
    const head = await db.query<{ version: number; kind: "ASSERT" | "RETRACT"; class: MemoryClass; subject_kind: MemorySubject["kind"]; subject_ref: string; content: string }>(
      `select version,kind,class,subject_kind,subject_ref,content from memory_versions where tenant_id=$1 and memory_id=$2 order by version desc limit 1${lock ? " for update" : ""}`,
      [tenantId, memoryId],
    );
    const h = head.rows[0];
    if (!h) return null;
    const sup = await db.query("select 1 from memory_relations where tenant_id=$1 and kind='SUPERSEDES' and to_memory=$2", [tenantId, memoryId]);
    return {
      memoryId,
      version: h.version,
      kind: h.kind,
      class: h.class,
      subject: { kind: h.subject_kind, ref: h.subject_ref },
      content: h.content,
      superseded: (sup.rowCount ?? 0) > 0,
    };
  }

  /** The kernel's decision. Scope and target checks first, then the pure policy table. */
  private async judge(db: pg.PoolClient, origin: MemoryOrigin, ctx: TenantContext, sub: CandidateSubmission, target: TargetState | null): Promise<PolicyDecisionResult> {
    const refuse = (ruleId: string, reason: string): PolicyDecisionResult => ({ decision: "REFUSE", ruleId, reason, protected: false });
    if (origin === "OPERATOR_INSTRUCTION" && sub.subject.kind === "PRINCIPAL" && sub.subject.ref !== ctx.principal.id)
      return refuse("subject-scope", "a personal memory can only be written about yourself");
    if (sub.intent !== "NEW") {
      if (target === null) return refuse("target-not-found", "the memory to change does not exist");
      if (target.kind === "RETRACT") return refuse("target-retracted", "that memory has already been retracted");
      if (target.superseded) return refuse("target-superseded", "that memory has already been superseded");
      if (origin === "OPERATOR_INSTRUCTION" && target.subject.kind === "PRINCIPAL" && target.subject.ref !== ctx.principal.id)
        return refuse("subject-scope", "a personal memory can only be changed by its own subject");
      if (sub.intent !== "SUPERSEDE" && target.class !== sub.class) return refuse("class-mismatch", "a correction or retraction keeps the memory's class");
      if (sub.intent !== "SUPERSEDE" && (target.subject.kind !== sub.subject.kind || target.subject.ref !== sub.subject.ref))
        return refuse("subject-mismatch", "a correction or retraction keeps the memory's subject");
    }
    const verdict = decidePromotion({ origin, candidate: sub, targetClass: target?.class });
    if (origin === "VERIFIED_OUTCOME" && (verdict.decision === "ALLOW" || verdict.decision === "REQUIRE_APPROVAL")) {
      const ok = await this.taskEvidenceVerified(db, ctx.tenantId, sub.evidence);
      if (!ok) return refuse("outcome-not-verified", "the cited task evidence is not part of a verified, completed outcome");
    }
    return verdict;
  }

  /** TASK_EVIDENCE refs are `<taskId>/<evidenceId>`, and every one must be verified evidence of a completed task. */
  private async taskEvidenceVerified(db: pg.PoolClient, tenantId: string, evidence: readonly MemoryEvidenceRef[]): Promise<boolean> {
    const refs = evidence.filter((e) => e.type === "TASK_EVIDENCE");
    if (refs.length === 0) return false;
    for (const ref of refs) {
      const [taskId, evidenceId, extra] = ref.ref.split("/");
      if (!taskId || !evidenceId || extra !== undefined || !Id.safeParse(taskId).success || !Id.safeParse(evidenceId).success) return false;
      try {
        await db.query("savepoint verify_evidence");
        await verifiedResult(db, tenantId, taskId, evidenceId);
        await db.query("release savepoint verify_evidence");
      } catch {
        await db.query("rollback to savepoint verify_evidence");
        return false;
      }
    }
    return true;
  }

  // ---------------------------------------------------------------- recording (promotion event, version, relation)

  private async recordDecision(
    db: pg.PoolClient,
    c: CandidateRow,
    target: TargetState | null,
    verdict: Verdict,
    how: { phase: "decide" | "settle"; by: { kind: "POLICY_ENGINE" | "APPROVED_HUMAN"; principal: string | null }; approvalId: string | null; at: Date },
  ): Promise<SubmissionResult> {
    const allowed = verdict.decision === "ALLOW" || verdict.decision === "ALLOW_APPROVED";
    const promotionId = stableId(["memory-promotion/v1", c.id, how.phase]);
    let memoryId: string | null = null;
    let version: number | null = null;
    if (allowed) {
      if (c.intent === "CORRECT" || c.intent === "RETRACT") {
        if (target === null) throw new MemoryError("INVALID", "A correction needs its target");
        memoryId = target.memoryId;
        version = target.version + 1;
      } else {
        memoryId = stableId(["memory/v2", c.tenant_id, c.id]);
        version = 1;
      }
    }
    await db.query(
      `insert into memory_promotions(id,tenant_id,candidate_id,decision,rule_id,policy_version,reason,promoted_by_kind,promoted_by_principal,approval_id,evidence,result_memory_id,result_version,created_at)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)`,
      [
        promotionId,
        c.tenant_id,
        c.id,
        verdict.decision,
        verdict.ruleId,
        POLICY_VERSION,
        verdict.reason.slice(0, 500),
        how.by.kind,
        how.by.principal,
        how.approvalId,
        JSON.stringify(c.evidence),
        memoryId,
        version,
        iso(how.at),
      ],
    );
    if (allowed && memoryId !== null && version !== null) {
      const retract = c.intent === "RETRACT";
      const content = retract ? (target?.content ?? c.content) : c.content;
      await db.query(
        `insert into memory_versions(memory_id,version,tenant_id,class,kind,content,content_digest,subject_kind,subject_ref,trust_class,confidence,provenance,evidence,policy,candidate_id,promotion_id,supersedes_version,created_at,promoted_at)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16,$17,$18,$19)`,
        [
          memoryId,
          version,
          c.tenant_id,
          retract || c.intent === "CORRECT" ? target?.class : c.proposed_class,
          retract ? "RETRACT" : "ASSERT",
          content,
          sha256(normalise(content)),
          c.subject_kind,
          c.subject_ref,
          TRUST_FOR_ORIGIN[c.origin],
          c.origin === "VERIFIED_OUTCOME" ? "VERIFIED" : "STATED",
          JSON.stringify({ origin: c.origin, submittedBy: c.submitted_by, candidateId: c.id, reason: c.reason }),
          JSON.stringify(c.evidence),
          JSON.stringify({ policyVersion: POLICY_VERSION, ruleId: verdict.ruleId, decision: verdict.decision, protected: verdict.protected, approvalId: how.approvalId }),
          c.id,
          promotionId,
          version === 1 ? null : version - 1,
          iso(c.created_at),
          iso(how.at),
        ],
      );
      if (c.intent === "SUPERSEDE" && target !== null)
        await db.query(
          "insert into memory_relations(id,tenant_id,kind,from_memory,to_memory,created_by_promotion_id,evidence) values($1,$2,'SUPERSEDES',$3,$4,$5,$6::jsonb)",
          [stableId(["memory-relation/v1", "SUPERSEDES", memoryId, target.memoryId]), c.tenant_id, memoryId, target.memoryId, promotionId, JSON.stringify(c.evidence)],
        );
    }
    if (how.phase === "settle")
      await db.query("update memory_candidates set state=$3, state_reason=$4, decided_at=$5 where tenant_id=$1 and id=$2", [
        c.tenant_id,
        c.id,
        allowed ? "PROMOTED" : "REJECTED",
        verdict.reason.slice(0, 500),
        iso(how.at),
      ]);
    return {
      candidateId: c.id,
      origin: c.origin,
      state: how.phase === "settle" ? (allowed ? "PROMOTED" : "REJECTED") : STATE_FOR[verdict.decision as PolicyOutcome],
      decision: verdict.decision,
      ruleId: verdict.ruleId,
      reason: verdict.reason,
      memoryId,
      version,
      approvalId: how.approvalId,
      replayed: false,
    };
  }

  // ---------------------------------------------------------------- approval settlement

  /**
   * Complete or reject an approval-bound candidate from the decision the ApprovalStore holds. The caller's identity is
   * not authority: the approval is, and it is checked to be bound to exactly this candidate and request.
   */
  async settleApproval(ctx: TenantContext, candidateId: string): Promise<SubmissionResult> {
    const approvals = this.options.approvals;
    if (!approvals) throw new MemoryError("INVALID", "No approval machinery is configured");
    const row = await withTenant(this.pool, ctx, (db) => this.candidateRow(db, ctx.tenantId, candidateId), "knowledge-write");
    if (row.state !== "AWAITING_APPROVAL" || row.approval_id === null) return withTenant(this.pool, ctx, async (db) => this.resultFor(db, await this.candidateRow(db, ctx.tenantId, candidateId), true), "knowledge-write");
    await approvals.expireIfDue(row.approval_id);
    const state = await approvals.state(row.approval_id);
    if (state.status === "PENDING") return withTenant(this.pool, ctx, async (db) => this.resultFor(db, row, true), "knowledge-write");
    if (state.boundCandidateId !== row.id || state.boundCandidateDigest !== row.request_digest)
      throw new MemoryError("CONFLICT", "The approval is not bound to this candidate");
    const approvalId = row.approval_id;
    return withTenant(
      this.pool,
      ctx,
      async (db) => {
        const locked = await this.candidateRow(db, ctx.tenantId, candidateId, true);
        if (locked.state !== "AWAITING_APPROVAL") return this.resultFor(db, locked, true);
        const target = await this.loadTarget(db, ctx.tenantId, locked.target_memory_id ?? undefined, true);
        const at = this.now();
        let verdict: Verdict;
        if (state.status === "GRANTED") {
          const stale =
            locked.intent !== "NEW" && (target === null || target.kind === "RETRACT" || target.superseded)
              ? "the memory this promotion would change is no longer current"
              : null;
          verdict = stale
            ? { decision: "REJECT_APPROVAL", ruleId: "approval-target-stale", reason: stale, protected: true }
            : { decision: "ALLOW_APPROVED", ruleId: "approved-by-human", reason: "granted by the named approver for this exact candidate", protected: true };
        } else {
          verdict = {
            decision: "REJECT_APPROVAL",
            ruleId: state.status === "EXPIRED" ? "approval-expired" : "approval-denied",
            reason: state.status === "EXPIRED" ? "the approval expired before it was granted" : "the approver declined this promotion",
            protected: true,
          };
        }
        const result = await this.recordDecision(db, locked, target, verdict, {
          phase: "settle",
          by: verdict.decision === "ALLOW_APPROVED" ? { kind: "APPROVED_HUMAN", principal: state.approver } : { kind: "POLICY_ENGINE", principal: null },
          approvalId,
          at,
        });
        return result;
      },
      "knowledge-write",
    );
  }

  // ---------------------------------------------------------------- conflicts

  /** A human flags two current memories as contradicting each other. Nothing is rewritten; both stay, flagged. */
  async flagConflict(ctx: TenantContext, a: string, b: string, evidence: MemoryEvidenceRef[]): Promise<{ created: boolean }> {
    if (ctx.principal.kind !== "HUMAN") throw new MemoryError("FORBIDDEN_ORIGIN", "Only a human can flag a conflict");
    Id.parse(a);
    Id.parse(b);
    const [from, to] = a < b ? [a, b] : [b, a];
    return withTenant(
      this.pool,
      ctx,
      async (db) => {
        const inserted = await db.query(
          "insert into memory_relations(id,tenant_id,kind,from_memory,to_memory,actor,evidence) values($1,$2,'CONFLICTS_WITH',$3,$4,$5,$6::jsonb) on conflict do nothing returning id",
          [stableId(["memory-relation/v1", "CONFLICTS_WITH", from, to]), ctx.tenantId, from, to, ctx.principal.id, JSON.stringify(evidence)],
        );
        return { created: (inserted.rowCount ?? 0) > 0 };
      },
      "knowledge-write",
    );
  }

  // ---------------------------------------------------------------- reads

  private visible(ctx: TenantContext, alias: string, params: unknown[]): string {
    params.push(ctx.principal.id);
    return `(${alias}.subject_kind <> 'PRINCIPAL' or ${alias}.subject_ref = $${params.length})`;
  }

  private mapVersion(r: Record<string, unknown>): CanonicalMemoryVersion {
    const at = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
    return CanonicalMemoryVersion.parse({
      memoryId: r["memory_id"],
      version: r["version"],
      tenantId: r["tenant_id"],
      class: r["class"],
      kind: r["kind"],
      content: r["content"],
      contentDigest: r["content_digest"],
      subject: { kind: r["subject_kind"], ref: r["subject_ref"] },
      trustClass: r["trust_class"],
      confidence: r["confidence"],
      provenance: r["provenance"],
      evidence: r["evidence"],
      policy: r["policy"],
      candidateId: r["candidate_id"],
      promotionId: r["promotion_id"],
      supersedesVersion: r["supersedes_version"] ?? null,
      createdAt: at(r["created_at"]),
      promotedAt: at(r["promoted_at"]),
    });
  }

  /** Find a memory by full id or by an unambiguous id prefix (Telegram users do not type 36 characters). */
  async find(ctx: TenantContext, idOrPrefix: string): Promise<MemoryView | null> {
    const wanted = idOrPrefix.trim().toLowerCase();
    if (!/^[0-9a-f-]{6,36}$/.test(wanted)) throw new MemoryError("INVALID", "That is not a memory id");
    return withTenant(this.pool, ctx, async (db) => {
      const params: unknown[] = [ctx.tenantId, `${wanted}%`];
      const guard = this.visible(ctx, "v", params);
      const ids = await db.query<{ memory_id: string }>(
        `select distinct v.memory_id from memory_versions v where v.tenant_id=$1 and v.memory_id::text like $2 and ${guard} limit 2`,
        params,
      );
      if (ids.rows.length === 0) return null;
      if (ids.rows.length > 1) throw new MemoryError("AMBIGUOUS", "That id prefix matches more than one memory");
      const memoryId = ids.rows[0]?.memory_id as string;
      const versionRows = await db.query("select * from memory_versions where tenant_id=$1 and memory_id=$2 order by version", [ctx.tenantId, memoryId]);
      const versions = versionRows.rows.map((r) => this.mapVersion(r));
      const head = versions[versions.length - 1] as CanonicalMemoryVersion;
      const rel = await db.query<{ kind: string; from_memory: string; to_memory: string }>(
        "select kind,from_memory,to_memory from memory_relations where tenant_id=$1 and (from_memory=$2 or to_memory=$2) order by created_at,id",
        [ctx.tenantId, memoryId],
      );
      const supersededBy = rel.rows.find((r) => r.kind === "SUPERSEDES" && r.to_memory === memoryId)?.from_memory ?? null;
      return {
        memoryId,
        status: head.kind === "RETRACT" ? "RETRACTED" : supersededBy ? "SUPERSEDED" : "CURRENT",
        supersededBy,
        supersedes: rel.rows.filter((r) => r.kind === "SUPERSEDES" && r.from_memory === memoryId).map((r) => r.to_memory),
        conflictsWith: rel.rows.filter((r) => r.kind === "CONFLICTS_WITH").map((r) => (r.from_memory === memoryId ? r.to_memory : r.from_memory)),
        head,
        versions,
      };
    });
  }

  /** The current memories this principal may see, newest first. Superseded and retracted memories are not listed. */
  async listCurrent(ctx: TenantContext, opts: { classes?: MemoryClass[]; limit?: number } = {}): Promise<CanonicalMemoryVersion[]> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    return withTenant(this.pool, ctx, async (db) => {
      const params: unknown[] = [ctx.tenantId];
      let classFilter = "";
      if (opts.classes && opts.classes.length > 0) {
        params.push(opts.classes);
        classFilter = ` and v.class = any($${params.length})`;
      }
      const guard = this.visible(ctx, "v", params);
      params.push(limit);
      const rows = await db.query(
        `select v.* from memory_current v where v.tenant_id=$1${classFilter} and ${guard} order by v.promoted_at desc, v.memory_id limit $${params.length}`,
        params,
      );
      return rows.rows.map((r) => this.mapVersion(r));
    });
  }

  // ---------------------------------------------------------------- retrieval and context assembly

  /**
   * Bounded, deterministic assembly. Metadata filters run in SQL first (tenant, subject scope, allowed classes, current
   * head only); ranking and packing then run over that bounded set. The result is recorded before it is returned, so
   * exactly what a model is given is always on record.
   */
  async assemble(ctx: TenantContext, rawRequest: unknown, opts: AssembleOptions = {}): Promise<AssembledContext> {
    const request = ContextRequest.parse(rawRequest);
    const permission: Permission = "read";
    const consumer = { taskId: opts.consumer?.taskId ?? null, stepId: opts.consumer?.stepId ?? null, callId: opts.consumer?.callId ?? null };
    if (request.subject && request.subject.kind === "PRINCIPAL" && request.subject.ref !== ctx.principal.id)
      throw new MemoryError("FORBIDDEN_ORIGIN", "Memories about another principal cannot be requested");
    return withTenant(
      this.pool,
      ctx,
      async (db) => {
        const scopes: string[] = [`(v.subject_kind='PRINCIPAL' and v.subject_ref=$2)`, `(v.subject_kind='TENANT' and v.subject_ref=$3)`];
        const params: unknown[] = [ctx.tenantId, ctx.principal.id, ctx.tenantId, request.allowedClasses];
        if (request.project) {
          params.push(request.project);
          scopes.push(`(v.subject_kind='PROJECT' and v.subject_ref=$${params.length})`);
        }
        const rows = await db.query(
          `select v.* from memory_current v where v.tenant_id=$1 and v.class = any($4) and (${scopes.join(" or ")}) order by v.promoted_at desc, v.memory_id limit 500`,
          params,
        );
        const versions = rows.rows.map((r) => this.mapVersion(r));
        const ids = versions.map((v) => v.memoryId);
        const conflicts = new Map<string, string[]>();
        if (ids.length > 0) {
          const rel = await db.query<{ from_memory: string; to_memory: string }>(
            `select r.from_memory,r.to_memory from memory_relations r
              where r.tenant_id=$1 and r.kind='CONFLICTS_WITH' and (r.from_memory = any($2) or r.to_memory = any($2))
                and exists (select 1 from memory_current a where a.memory_id = r.from_memory) and exists (select 1 from memory_current b where b.memory_id = r.to_memory)`,
            [ctx.tenantId, ids],
          );
          for (const r of rel.rows) {
            conflicts.set(r.from_memory, [...(conflicts.get(r.from_memory) ?? []), r.to_memory]);
            conflicts.set(r.to_memory, [...(conflicts.get(r.to_memory) ?? []), r.from_memory]);
          }
        }
        const candidates: Candidate[] = versions.map((v) => ({
          memoryId: v.memoryId,
          version: v.version,
          class: v.class,
          trustClass: v.trustClass,
          content: v.content,
          contentDigest: v.contentDigest,
          origin: v.provenance.origin,
          evidence: v.evidence,
          promotedAt: v.promotedAt,
          subjectKind: v.subject.kind,
          conflictsWith: [...new Set(conflicts.get(v.memoryId) ?? [])].sort(),
        }));
        const selection = pack(rankCandidates(candidates, request.purpose), request.budget);
        const external = packExternal(opts.external ?? [], request.budget.maxTokens - selection.usedTokens);
        const assembled = buildAssembled({ tenantId: ctx.tenantId, request, selection, external, consumer });
        await db.query(
          `insert into memory_context_assemblies(id,tenant_id,principal_id,digest,purpose_digest,request,items,external,excluded,budget_max_tokens,budget_used_tokens,task_id,step_id,call_id)
           values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14) on conflict (id) do nothing`,
          [
            assembled.assemblyId,
            ctx.tenantId,
            ctx.principal.id,
            assembled.digest,
            purposeDigest(request.purpose),
            JSON.stringify(request),
            JSON.stringify(assembled.items),
            JSON.stringify(assembled.external),
            JSON.stringify(assembled.excluded),
            request.budget.maxTokens,
            assembled.budget.usedTokens,
            consumer.taskId,
            consumer.stepId,
            consumer.callId,
          ],
        );
        return assembled;
      },
      permission,
    );
  }
}
