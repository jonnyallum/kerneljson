import pg from "pg";
import { z } from "zod";
import {
  Id,
  Outcome,
  Task,
  Timestamp,
  type VerificationReport,
} from "../../../packages/contracts/src/index.js";
import { verifyTaskEvidence, type VerificationBundle } from "./verification.js";
import { capabilityDigest } from "../../../packages/capabilities/src/index.js";
const Audit = z.strictObject({
  eventId: Id,
  verificationEventId: Id,
  at: Timestamp,
});
export class VerificationStore {
  constructor(private readonly pool: pg.Pool) {}
  async finish(
    taskId: string,
    rawAudit: z.infer<typeof Audit>,
  ): Promise<Outcome> {
    Id.parse(taskId);
    const audit = Audit.parse(rawAudit);
    const db = await this.pool.connect();
    try {
      await db.query("begin");
      await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        taskId,
      ]);
      const existing = await db.query<{ contract: unknown }>(
        "select contract from outcomes where task_id=$1",
        [taskId],
      );
      if (existing.rows[0]) {
        const outcome = Outcome.parse(existing.rows[0].contract);
        await db.query("commit");
        return outcome;
      }
      const tasks = await db.query<{ contract: unknown }>(
        "select contract from tasks where id=$1 for update",
        [taskId],
      );
      const task = Task.parse(tasks.rows[0]?.contract);
      if (task.status !== "VERIFYING")
        throw new Error("Task must be VERIFYING before final verification");
      const report = verifyTaskEvidence(await readVerificationBundle(db, task));
      const passed = report.status === "PASSED";
      const outcome = Outcome.parse({
        taskId,
        status: passed ? "COMPLETED" : "FAILED",
        acceptanceResults: task.acceptanceCriteria.map((criterion) => ({
          criterion,
          passed,
          evidenceRefs: report.evidenceRefs,
        })),
        evidenceRefs: report.evidenceRefs,
        summary: passed
          ? task.objective.trim().toUpperCase()
          : `Verification failed: ${report.failures.join(", ")}`,
        completedAt: audit.at,
      });
      const terminal = Task.parse({
        ...task,
        status: outcome.status,
        completedAt: audit.at,
      });
      const event = async (
        id: string,
        key: string,
        type: string,
        payload: VerificationReport,
      ) =>
        db.query(
          "insert into task_events(id,task_id,event_key,request_digest,type,occurred_at,actor_id,trace_id,payload) values($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            id,
            taskId,
            key,
            capabilityDigest(payload),
            type,
            audit.at,
            task.principal.id,
            task.traceId,
            JSON.stringify(payload),
          ],
        );
      if (!passed)
        await event(
          audit.verificationEventId,
          "final-verification-failed",
          "VERIFICATION_FAILED",
          report,
        );
      await event(
        audit.eventId,
        "final-verification",
        passed ? "TASK_COMPLETED" : "TASK_FAILED",
        report,
      );
      await db.query(
        "insert into outcomes(id,task_id,status,contract,completed_at) values($1,$2,$3,$4,$5)",
        [audit.eventId, taskId, outcome.status, outcome, audit.at],
      );
      await db.query(
        "update tasks set status=$2,contract=$3,updated_at=$4 where id=$1",
        [taskId, terminal.status, terminal, audit.at],
      );
      await db.query("commit");
      return outcome;
    } catch (error) {
      await db.query("rollback");
      throw error;
    } finally {
      db.release();
    }
  }
}

/** Read persisted evidence within the caller's transaction and task lock. */
export async function readVerificationBundle(
  db: pg.PoolClient,
  task: Task,
): Promise<VerificationBundle> {
  const taskId = task.id;
  const steps = await db.query<{ contract: unknown }>(
    "select contract from task_steps where task_id=$1 order by id for share",
    [taskId],
  );
  const runs = await db.query<VerificationBundle["runs"][number]>(
    `select r.id,r.task_id as "taskId",r.step_id as "stepId",r.result,r.evidence_id as "evidenceId",v.contract as descriptor from capability_runs r join capability_versions v on v.id=r.capability_version_id where r.task_id=$1`,
    [taskId],
  );
  const evidence = await db.query<{ record: unknown }>(
    `select jsonb_strip_nulls(jsonb_build_object('id',id,'taskId',task_id,'stepId',step_id,'type',type,'source',source,'ref',ref,'uri',uri,'digest',digest,'capturedAt',to_char(captured_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'metadata',metadata)) as record from evidence where task_id=$1`,
    [taskId],
  );
  const policies = await db.query<VerificationBundle["policies"][number]>(
    `select id,task_id as "taskId",actor_id as "actorId",trace_id as "traceId",payload from task_events where task_id=$1 and type='POLICY_CHECKED' and event_key like 'policy-approval:%'`,
    [taskId],
  );
  const approvals = await db.query<VerificationBundle["approvals"][number]>(
    `select id,status,evidence_id as "evidenceId" from approvals where task_id=$1 for share`,
    [taskId],
  );
  return {
    task,
    steps: steps.rows.map((s) => s.contract),
    runs: runs.rows,
    evidence: evidence.rows.map((e) => e.record),
    policies: policies.rows,
    approvals: approvals.rows,
  };
}
