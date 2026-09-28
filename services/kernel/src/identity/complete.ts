import type pg from "pg";
import { z } from "zod";
import {
  Id,
  IdentityActivationRow,
  IdentityDocument,
  IdentityDocumentDraft,
  IdentityVersionRow,
  Json,
  Outcome,
  Task,
  Timestamp,
} from "../../../../packages/contracts/src/index.js";
import { capabilityDigest } from "../../../../packages/capabilities/src/index.js";
import { assertResolvedEffects } from "../terminal.js";
import { classADigest, identityCoreDigest } from "./canonical.js";
import { activationRow, refusalOrRethrow, versionRow } from "./store.js";

/**
 * KJ-P7A - identity's own completion path, deliberately separate from VerificationStore.finish.
 *
 * verifyTaskEvidence (verification.ts) is hard-coded to the golden `uppercase` capability - it checks
 * a CapabilityResult, a capability_runs row and a registry descriptor that identity governance never
 * produces (IDENTITY_GOVERN is never routed through callCapability; the DB triggers on
 * identity_versions/identity_activations ARE the verification, not a capability receipt). Reusing it
 * here would always fail closed with INVALID_OR_INCOMPLETE_EVIDENCE, so identity gets its own minimal
 * completion, following the same low-level shape (advisory lock, idempotent replay on an existing
 * outcome, assertResolvedEffects, one TASK_COMPLETED event, one outcomes row, one tasks status update)
 * with acceptance proven by IDENTITY_CHANGE_CRITERION instead.
 *
 * The `proof` evidence row is NOT optional decoration: both Outcome's own zod superRefine and the
 * base schema's check_task_completion() trigger (20260905153704_intelligence_metadata.sql) refuse a
 * COMPLETED outcome with an empty evidenceRefs array, or an evidenceRef that doesn't correspond to a
 * real `evidence` row bound to this exact task.
 */
const Audit = z.strictObject({ eventId: Id, at: Timestamp });
const Proof = z.strictObject({ evidenceId: Id, digest: z.string().regex(/^[a-f0-9]{64}$/), metadata: z.record(z.string(), Json) });

/**
 * Moves one VERIFYING identity-change task to COMPLETED on the caller's open transaction: evidence,
 * TASK_COMPLETED event, outcome and task status. It never commits. On its own it is only a building
 * block - completeAndActivateIdentity() is the one production path, and it commits this together with
 * the version and activation or not at all. The caller must already hold the task's advisory lock.
 */
export async function completeIdentityTaskTx(
  db: pg.PoolClient,
  taskId: string,
  summary: string,
  rawProof: z.infer<typeof Proof>,
  rawAudit: z.infer<typeof Audit>,
): Promise<Outcome> {
  Id.parse(taskId);
  const proof = Proof.parse(rawProof);
  const audit = Audit.parse(rawAudit);
  const tasks = await db.query<{ contract: unknown }>("select contract from tasks where id=$1 for update", [taskId]);
  const task = Task.parse(tasks.rows[0]?.contract);
  await assertResolvedEffects(db, taskId);
  if (task.status !== "VERIFYING") throw new Error("Identity-change task must be VERIFYING before completion");
  await db.query(
    "insert into evidence(id,task_id,type,source,digest,captured_at,metadata) values($1,$2,'DETERMINISTIC_RESULT','kerneljson:identity-candidate/v1',$3,$4,$5)",
    [proof.evidenceId, taskId, proof.digest, audit.at, JSON.stringify(proof.metadata)],
  );
  const outcome = Outcome.parse({
    taskId,
    status: "COMPLETED",
    acceptanceResults: task.acceptanceCriteria.map((criterion) => ({ criterion, passed: true, evidenceRefs: [proof.evidenceId] })),
    evidenceRefs: [proof.evidenceId],
    summary,
    completedAt: audit.at,
  });
  const terminal = Task.parse({ ...task, status: outcome.status, completedAt: audit.at });
  await db.query(
    "insert into task_events(id,task_id,event_key,request_digest,type,occurred_at,actor_id,trace_id,payload) values($1,$2,$3,$4,'TASK_COMPLETED',$5,$6,$7,$8)",
    [audit.eventId, taskId, "final-completion", capabilityDigest(outcome), audit.at, task.principal.id, task.traceId, JSON.stringify(outcome)],
  );
  await db.query("insert into outcomes(id,task_id,status,contract,completed_at) values($1,$2,$3,$4,$5)", [audit.eventId, taskId, outcome.status, outcome, audit.at]);
  await db.query("update tasks set status=$2,contract=$3,updated_at=$4 where id=$1", [taskId, terminal.status, terminal, audit.at]);
  return outcome;
}

/** A COMPLETED identity-change task with no activation: a D8 violation that this module can no longer
 *  produce (see completeAndActivateIdentity), so meeting one means data written by something else. */
export class IdentityD8InvariantError extends Error {}

export interface IdentityApply {
  taskId: string;
  summary: string;
  proof: z.infer<typeof Proof>;
  audit: z.infer<typeof Audit>;
  identityId: string;
  tenantId: string;
  draftDocument: IdentityDocumentDraft;
  candidateId: string;
  versionId: string;
  activationId: string;
  approvalId: string | null;
}

/**
 * ADR-0021 D8 - `successful activation <=> the identity-change task completes successfully`, as ONE
 * database transaction:
 *
 *   lock task -> verify VERIFYING + effects resolved -> evidence -> TASK_COMPLETED event -> outcome ->
 *   tasks.status=COMPLETED -> identity version -> activation -> COMMIT
 *
 * identity_version_guard() sees the task as COMPLETED inside this same transaction, and the deferred
 * check_task_completion() constraint trigger runs at COMMIT. If the version or activation is refused
 * (the post-bootstrap freeze, the Class C/D rate cap, any identity trigger) or anything else fails,
 * the WHOLE transaction rolls back - completion, evidence, outcome and event included - so a
 * COMPLETED-without-activation state cannot be written by this path at all.
 *
 * Errors: a deterministic refusal (SQLSTATE class 23/22, see isDeterministicRefusal) is thrown as an
 * IdentityRefusal for the workflow to terminate the task FAILED through its normal lifecycle; anything
 * transient is rethrown unwrapped so Restate retries this step. A retry after a COMMIT whose Restate
 * journal entry was lost finds the existing outcome and returns the version/activation it committed -
 * it converges to exactly one completed task, one version and one activation.
 */
export async function completeAndActivateIdentity(
  pool: pg.Pool,
  input: IdentityApply,
): Promise<{ outcome: Outcome; version: IdentityVersionRow; activation: IdentityActivationRow; replayed: boolean }> {
  for (const id of [input.taskId, input.identityId, input.tenantId, input.candidateId, input.versionId, input.activationId]) Id.parse(id);
  const draft = IdentityDocumentDraft.parse(input.draftDocument);
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [input.taskId]);
    const existing = await db.query<{ contract: unknown }>("select contract from outcomes where task_id=$1", [input.taskId]);
    if (existing.rows[0]) {
      const outcome = Outcome.parse(existing.rows[0].contract);
      const applied = await db.query(
        `select v.*, to_jsonb(a) as activation from public.identity_activations a
           join public.identity_versions v on v.identity_id = a.identity_id and v.version = a.version
          where a.request_task_id = $1`,
        [input.taskId],
      );
      await db.query("commit");
      const row = applied.rows[0] as (Record<string, unknown> & { activation: Record<string, unknown> }) | undefined;
      if (outcome.status !== "COMPLETED" || !row)
        throw new IdentityD8InvariantError(`identity-change task ${input.taskId} has a ${outcome.status} outcome but no activation`);
      return { outcome, version: versionRow(row), activation: activationRow(row.activation), replayed: true };
    }
    const outcome = await completeIdentityTaskTx(db, input.taskId, input.summary, input.proof, input.audit);
    // Same advisory key identity_version_guard() takes, taken first so the head read below and the
    // version insert see one consistent head - a concurrent change serialises here instead of
    // computing the same next version number and losing the race inside the trigger.
    await db.query("select pg_advisory_xact_lock(hashtextextended($1 || ':identity-version', 0))", [input.identityId]);
    const head = await db.query<{ version: number }>("select version from public.identity_head where identity_id=$1", [input.identityId]);
    const version = (head.rows[0]?.version ?? 0) + 1;
    const document = IdentityDocument.parse({ ...draft, version });
    const v = await db.query(
      `insert into public.identity_versions(id,identity_id,tenant_id,version,document,identity_core_digest,class_a_digest,governance_class,candidate_id,created_by_task)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [
        input.versionId, input.identityId, input.tenantId, version, JSON.stringify(document),
        identityCoreDigest(document), classADigest(document.sections.classA), "IGNORED_DERIVED_FROM_CANDIDATE", input.candidateId, input.taskId,
      ],
    );
    const a = await db.query(
      `insert into public.identity_activations(id,identity_id,tenant_id,version,governance_class,candidate_id,approval_id,request_task_id)
       values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [input.activationId, input.identityId, input.tenantId, version, "IGNORED_DERIVED_FROM_CANDIDATE", input.candidateId, input.approvalId, input.taskId],
    );
    await db.query("commit");
    return { outcome, version: versionRow(v.rows[0] as Record<string, unknown>), activation: activationRow(a.rows[0] as Record<string, unknown>), replayed: false };
  } catch (error) {
    await db.query("rollback").catch(() => undefined);
    if (error instanceof IdentityD8InvariantError) throw error;
    refusalOrRethrow("IDENTITY_APPLY_REFUSED", error);
  } finally {
    db.release();
  }
}
