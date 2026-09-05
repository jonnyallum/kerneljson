import type pg from "pg";
import {
  Id,
  Task,
  TaskStep,
  Outcome,
  SchedulePlan,
  Evidence,
  Timestamp,
  assertCompletion,
} from "../../../packages/contracts/src/index.js";
import { capabilityDigest } from "../../../packages/capabilities/src/index.js";
import { compileIntent, stableId } from "./compiler/index.js";
import { scheduleCriterion } from "./schedule.js";
export async function finishSchedule(
  pool: pg.Pool,
  taskId: string,
  audit: { eventId: string; evidenceId: string; at: string },
): Promise<Outcome> {
  Id.parse(taskId);
  Id.parse(audit.eventId);
  Id.parse(audit.evidenceId);
  Timestamp.parse(audit.at);
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      taskId,
    ]);
    const prior = await db.query<{ contract: unknown }>(
      "select contract from outcomes where task_id=$1",
      [taskId],
    );
    if (prior.rows[0]) {
      await db.query("commit");
      return Outcome.parse(prior.rows[0].contract);
    }
    const rows = await db.query<{ contract: unknown }>(
      "select contract from tasks where id=$1 for update",
      [taskId],
    );
    const task = Task.parse(rows.rows[0]?.contract);
    const plans = await db.query<{ payload: { schedule: unknown } }>(
      "select payload from task_events where task_id=$1 and type='PLAN_COMPILED'",
      [taskId],
    );
    const plan = SchedulePlan.parse(plans.rows[0]?.payload.schedule);
    if (
      task.status !== "VERIFYING" ||
      plan.task.id !== taskId ||
      capabilityDigest({ ...plan.task, status: "VERIFYING" }) !==
        capabilityDigest(task) ||
      capabilityDigest(task.acceptanceCriteria) !==
        capabilityDigest([scheduleCriterion(plan.children.length)])
    )
      throw new Error("Invalid schedule completion scope");
    const steps = await db.query<{ contract: unknown }>(
      "select contract from task_steps where task_id=$1",
      [taskId],
    );
    const step = TaskStep.parse(steps.rows[0]?.contract);
    if (
      steps.rowCount !== 1 ||
      step.id !== stableId(["schedule-step/v1", taskId]) ||
      step.kind !== "SCHEDULE" ||
      step.status !== "COMPLETED" ||
      capabilityDigest(step.input) !== capabilityDigest(plan)
    )
      throw new Error("Schedule step incomplete");
    const children = [];
    for (const submission of plan.children) {
      const expected = Task.parse({
        ...compileIntent(submission).task,
        parentTaskId: taskId,
      });
      const result = await db.query<{ task: unknown; outcome: unknown }>(
        "select t.contract as task,o.contract as outcome from tasks t join outcomes o on o.task_id=t.id where t.id=$1 and t.parent_task_id=$2 and t.tenant_id=$3 and t.status='COMPLETED'",
        [expected.id, taskId, task.tenant.id],
      );
      const child = Task.parse(result.rows[0]?.task),
        outcome = Outcome.parse(result.rows[0]?.outcome);
      if (
        capabilityDigest({
          ...expected,
          status: child.status,
          completedAt: child.completedAt,
        }) !== capabilityDigest(child)
      )
        throw new Error("Child task definition mismatch");
      const refs = await db.query<{ id: string }>(
        "select id from evidence where task_id=$1 and id=any($2::uuid[])",
        [child.id, outcome.evidenceRefs],
      );
      if (
        outcome.status !== "COMPLETED" ||
        outcome.taskId !== child.id ||
        refs.rowCount !== outcome.evidenceRefs.length ||
        !outcome.acceptanceResults.every(
          (r) => r.passed && child.acceptanceCriteria.includes(r.criterion),
        )
      )
        throw new Error("Child has no verified evidence");
      children.push({
        taskId: child.id,
        outcomeDigest: capabilityDigest(outcome),
        evidenceRefs: outcome.evidenceRefs,
      });
    }
    const metadata = { planDigest: capabilityDigest(plan), children };
    const evidence = Evidence.parse({
      id: audit.evidenceId,
      taskId,
      stepId: step.id,
      type: "DETERMINISTIC_RESULT",
      source: "kerneljson:bounded-schedule/v1",
      digest: capabilityDigest(metadata),
      capturedAt: audit.at,
      metadata,
    });
    const outcome = Outcome.parse({
      taskId,
      status: "COMPLETED",
      acceptanceResults: [
        {
          criterion: scheduleCriterion(children.length),
          passed: true,
          evidenceRefs: [evidence.id],
        },
      ],
      evidenceRefs: [evidence.id],
      summary: `${children.length} scheduled tasks completed with verified outcomes`,
      completedAt: audit.at,
    });
    assertCompletion(task, outcome, [evidence]);
    await db.query(
      "insert into evidence(id,task_id,step_id,type,source,digest,captured_at,metadata) values($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        evidence.id,
        taskId,
        step.id,
        evidence.type,
        evidence.source,
        evidence.digest,
        evidence.capturedAt,
        metadata,
      ],
    );
    await db.query(
      "insert into task_events(id,task_id,event_key,request_digest,type,occurred_at,actor_id,trace_id,payload) values($1,$2,'schedule-complete',$3,'TASK_COMPLETED',$4,$5,$6,$7)",
      [
        audit.eventId,
        taskId,
        capabilityDigest(outcome),
        audit.at,
        task.principal.id,
        task.traceId,
        { evidenceId: evidence.id, children },
      ],
    );
    await db.query(
      "insert into outcomes(id,task_id,status,contract,completed_at) values($1,$2,'COMPLETED',$3,$4)",
      [audit.eventId, taskId, outcome, audit.at],
    );
    await db.query(
      "update tasks set status='COMPLETED',contract=$2,updated_at=$3 where id=$1",
      [
        taskId,
        Task.parse({ ...task, status: "COMPLETED", completedAt: audit.at }),
        audit.at,
      ],
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
