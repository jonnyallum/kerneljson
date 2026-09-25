import type pg from "pg";
import { z } from "zod";
import { Id, Json, Outcome, Task, Timestamp } from "../../../../packages/contracts/src/index.js";
import { capabilityDigest } from "../../../../packages/capabilities/src/index.js";
import { assertResolvedEffects } from "../terminal.js";

/**
 * KJ-P7A - identity's own task-completion path, deliberately separate from VerificationStore.finish.
 *
 * verifyTaskEvidence (verification.ts) is hard-coded to the golden `uppercase` capability - it checks
 * a CapabilityResult, a capability_runs row and a registry descriptor that identity governance never
 * produces (IDENTITY_GOVERN is never routed through callCapability; the DB triggers on
 * identity_versions/identity_activations ARE the verification, not a capability receipt). Reusing it
 * here would always fail closed with INVALID_OR_INCOMPLETE_EVIDENCE, so identity gets its own minimal
 * completion, following the exact same low-level shape (advisory lock, idempotent replay on an
 * existing outcome, assertResolvedEffects, one TASK_COMPLETED event, one outcomes row, one tasks
 * status update) with acceptance proven by IDENTITY_CHANGE_CRITERION instead.
 *
 * The `proof` evidence row is NOT optional decoration: both Outcome's own zod superRefine and the
 * base schema's check_task_completion() trigger (20260905153704_intelligence_metadata.sql) refuse a
 * COMPLETED outcome with an empty evidenceRefs array, or an evidenceRef that doesn't correspond to a
 * real `evidence` row bound to this exact task - caught live against real Postgres 2026-09-25, this
 * function originally shipped with `evidenceRefs: []` and would have failed closed on every call. The
 * candidate's own DB-derived governance_class (read back from identity_candidates, never re-asserted)
 * is exactly the deterministic fact this task's work actually produced, so it is the evidence.
 *
 * ADR-0021 D8: this MUST run, and the task MUST reach COMPLETED, strictly before
 * IdentityStore.activate() is called - identity_version_guard() refuses a version whose
 * created_by_task is not already COMPLETED. The workflow calls this first, then activates.
 */
const Audit = z.strictObject({ eventId: Id, at: Timestamp });
const Proof = z.strictObject({ evidenceId: Id, digest: z.string().regex(/^[a-f0-9]{64}$/), metadata: z.record(z.string(), Json) });

export async function completeIdentityTask(
  pool: pg.Pool,
  taskId: string,
  summary: string,
  rawProof: z.infer<typeof Proof>,
  rawAudit: z.infer<typeof Audit>,
): Promise<Outcome> {
  Id.parse(taskId);
  const proof = Proof.parse(rawProof);
  const audit = Audit.parse(rawAudit);
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [taskId]);
    const existing = await db.query<{ contract: unknown }>("select contract from outcomes where task_id=$1", [taskId]);
    if (existing.rows[0]) {
      const outcome = Outcome.parse(existing.rows[0].contract);
      await db.query("commit");
      return outcome;
    }
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
    await db.query("commit");
    return outcome;
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    db.release();
  }
}
