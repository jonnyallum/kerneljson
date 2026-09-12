import { authorize } from "../../../packages/identity/src/index.js";
import { assertResolvedEffects, readOutcome } from "./terminal.js";
import { bindingFor, persistBinding, workflowTargets, type WorkflowName } from "./execution-binding.js";
import pg from "pg";
import {
  Task,
  TaskEvent,
  TaskStep,
  Evidence,
  Outcome,
  assertTransition,
  assertCompletion,
} from "../../../packages/contracts/src/index.js";
import { digest, verifyEvidence, stepA, stepB } from "./deterministic.js";
import { verifyPlanCompletion, type CanaryVerifyConfig } from "./executor/index.js";
export interface Write {
  key: string;
  task: Task;
  event: TaskEvent;
  step?: TaskStep;
  steps?: TaskStep[];
  evidence?: Evidence;
  outcome?: Outcome;
}
export class CompletionVerificationError extends Error {}
function verifyCompletion(check:()=>void):void {
  try { check(); } catch { throw new CompletionVerificationError("Persisted completion verification failed"); }
}
export class Ledger {
  constructor(
    readonly pool: pg.Pool,
    private readonly afterCommit?: (key: string, taskId?: string) => Promise<void>,
    private readonly workflow?: WorkflowName,
    private readonly releaseId: string = process.env["KERNELJSON_RELEASE_ID"] ?? "unreleased-development",
    private readonly canary?: CanaryVerifyConfig,
  ) {}
  forWorkflow(workflow: WorkflowName): Ledger {
    return new Ledger(this.pool, this.afterCommit, workflow, this.releaseId, this.canary);
  }
  /** Same durable operation as completion; infrastructure uncertainty remains retryable. */
  async finish(input: Write): Promise<Outcome> {
    const existing = await readOutcome(this.pool, input.task.id);
    if (existing) return existing;
    try {
      await this.write(input);
      return Outcome.parse(input.outcome);
    } catch (error) {
      if (!(error instanceof CompletionVerificationError)) throw error;
      const outcome = Outcome.parse({taskId:input.task.id,status:"FAILED",acceptanceResults:input.task.acceptanceCriteria.map(criterion=>({criterion,passed:false,evidenceRefs:[]})),evidenceRefs:[],summary:"Persisted completion verification failed",completedAt:input.event.occurredAt});
      await this.write({...input,key:input.key+":verification-failed",task:Task.parse({...input.task,status:"FAILED"}),outcome,event:TaskEvent.parse({...input.event,type:"TASK_FAILED",payload:{reason:"VERIFICATION_FAILED"}})});
      return outcome;
    }
  }
  async write(input: Write): Promise<void> {
    const task = Task.parse(input.task),
      event = TaskEvent.parse(input.event);
    if (
      event.taskId !== task.id ||
      event.traceId !== task.traceId ||
      event.actor.id !== task.principal.id
    )
      throw new Error("Event/task mismatch");
    const step = input.step ? TaskStep.parse(input.step) : undefined;
    const steps = [...(input.steps ?? []), ...(step ? [step] : [])].map((s) =>
      TaskStep.parse(s),
    );
    if (
      new Set(steps.map((s) => s.id)).size !== steps.length ||
      steps.some((s) => s.taskId !== task.id)
    )
      throw new Error("Invalid task step batch");
    const evidence = input.evidence
      ? Evidence.parse(input.evidence)
      : undefined;
    const outcome = input.outcome ? Outcome.parse(input.outcome) : undefined;
    if (step && step.taskId !== task.id) throw new Error("Step/task mismatch");
    if (evidence && evidence.taskId !== task.id)
      throw new Error("Evidence/task mismatch");
    const hash = digest(input);
    const db = await this.pool.connect();
    try {
      await db.query("begin");
      // Serialize projection updates and idempotency checks for this task only.
      await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        task.id,
      ]);
      const prior = await db.query<{ request_digest: string }>(
        "select request_digest from public.task_events where task_id=$1 and event_key=$2",
        [task.id, input.key],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== hash)
          throw new Error("Idempotency key reused with different input");
        await db.query("commit");
        return;
      }
      const existing = await db.query<{ contract: Task }>(
        "select contract from public.tasks where id=$1 for update",
        [task.id],
      );
      const old = existing.rows[0]?.contract;
      if (!old) {
        if (task.status !== "RECEIVED" || event.type !== "TASK_CREATED")
          throw new Error("Task must begin RECEIVED");
        const actor = await db.query<{ kind: string }>(
          "select kind from public.principals where id=$1",
          [task.principal.id],
        );
        if (actor.rows[0]?.kind !== task.principal.kind)
          throw new Error("Principal kind mismatch");
        await authorize(db, {tenantId: task.tenant.id, principal: task.principal}, "submit");
        if (this.workflow) {
          const binding = await persistBinding(db, bindingFor(task, workflowTargets[this.workflow], this.releaseId));
          if (binding.releaseId !== this.releaseId) throw new Error("Task requires its bound worker release");
        }
        await db.query(
          "insert into public.tasks(id,tenant_id,principal_id,parent_task_id,trace_id,status,contract,created_at) values($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            task.id,
            task.tenant.id,
            task.principal.id,
            task.parentTaskId ?? null,
            task.traceId,
            task.status,
            task,
            task.createdAt,
          ],
        );
      } else {
        const original = Task.parse(old);
        const expected = Task.parse({
          ...original,
          status: task.status,
          ...(task.startedAt ? { startedAt: task.startedAt } : {}),
          ...(task.completedAt ? { completedAt: task.completedAt } : {}),
        });
        if (digest(expected) !== digest(task))
          throw new Error("Task definition is immutable");
        if (old.status !== task.status)
          assertTransition(old.status, task.status);
        if (task.status === "COMPLETED") {
          await assertResolvedEffects(db, task.id);
          if (!outcome) throw new CompletionVerificationError("Completion requires an outcome");
          const rows = await db.query<{ record: unknown; step: unknown }>(
            `select jsonb_build_object('id',e.id,'taskId',e.task_id,'stepId',e.step_id,'type',e.type,'source',e.source,'digest',e.digest,'capturedAt',to_char(e.captured_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'metadata',e.metadata) as record, s.contract as step from public.evidence e join public.task_steps s on s.id=e.step_id and s.task_id=e.task_id where e.task_id=$1`,
            [task.id],
          );
          const planEvent = await db.query<{ payload: { plan?: unknown } }>(
            "select payload from public.task_events where task_id=$1 and type='PLAN_COMPILED'",
            [task.id],
          );
          const plan = planEvent.rows[0]?.payload.plan;
          verifyCompletion(()=>{if (rows.rows.some(r => {
            const captured = Date.parse(Evidence.parse(r.record).capturedAt);
            return captured < Date.parse(task.createdAt) || captured > Date.parse(event.occurredAt);
          })) throw new Error("Evidence freshness mismatch");});
          if (planEvent.rows.length !== 1)
            throw new CompletionVerificationError(
              "Completion requires exactly one authoritative compiled plan",
            );
          if (plan !== undefined) {
            const persisted = await db.query<{ contract: unknown }>(
              "select contract from public.task_steps where task_id=$1",
              [task.id],
            );
            verifyCompletion(()=>verifyPlanCompletion(
              old,
              outcome,
              plan,
              persisted.rows.map((r) => r.contract),
              rows.rows,
              this.canary,
            ));
          } else {
            verifyCompletion(()=>{
            const checked = rows.rows.flatMap((r) => {
              const e = Evidence.parse(r.record),
                s = TaskStep.parse(r.step);
              return s.status === "COMPLETED" &&
                s.kind === "DETERMINISTIC_FUNCTION" &&
                s.idempotencyKey === `${task.id}:B` &&
                s.input === stepA(task.objective) &&
                s.output === stepB(stepA(task.objective)) &&
                verifyEvidence(e, old, s.id)
                ? [e]
                : [];
            });
            assertCompletion(old, outcome, checked);
            });
          }
          if (event.type !== "TASK_COMPLETED")
            throw new CompletionVerificationError("Completion event required");
        }
        await db.query(
          "update public.tasks set status=$2,contract=$3,updated_at=$4 where id=$1",
          [task.id, task.status, task, event.occurredAt],
        );
      }
      for (const step of steps)
        await db.query(
          "insert into public.task_steps(id,task_id,status,contract) values($1,$2,$3,$4) on conflict(id) do update set status=excluded.status,contract=excluded.contract where task_steps.task_id=excluded.task_id",
          [step.id, task.id, step.status, step],
        );
      if (evidence)
        await db.query(
          "insert into public.evidence(id,task_id,step_id,type,source,ref,uri,digest,captured_at,metadata) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [
            evidence.id,
            task.id,
            evidence.stepId ?? null,
            evidence.type,
            evidence.source,
            evidence.ref ?? null,
            evidence.uri ?? null,
            evidence.digest ?? null,
            evidence.capturedAt,
            evidence.metadata,
          ],
        );
      await db.query(
        "insert into public.task_events(id,task_id,step_id,event_key,request_digest,type,occurred_at,actor_id,trace_id,payload) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          event.id,
          task.id,
          event.stepId ?? null,
          input.key,
          hash,
          event.type,
          event.occurredAt,
          event.actor.id,
          event.traceId,
          JSON.stringify(event.payload),
        ],
      );
      if (outcome)
        await db.query(
          "insert into public.outcomes(id,task_id,status,contract,completed_at) values($1,$2,$3,$4,$5)",
          [event.id, task.id, outcome.status, outcome, outcome.completedAt],
        );
      await db.query("commit");
    } catch (error) {
      await db.query("rollback");
      throw error;
    } finally {
      db.release();
    }
    await this.afterCommit?.(input.key,task.id);
  }
  async status(id: string): Promise<Task | null> {
    const result = await this.pool.query<{ contract: unknown }>(
      "select contract from public.tasks where id=$1",
      [id],
    );
    return result.rows[0] ? Task.parse(result.rows[0].contract) : null;
  }
}
