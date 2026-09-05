import * as restate from "@restatedev/restate-sdk";
import {
  Task,
  TaskEvent,
  TaskStep,
  Evidence,
  Outcome,
  type TaskStatus,
} from "../../../packages/contracts/src/index.js";
import { Ledger, type Write } from "./ledger.js";
import {
  SubmitTask,
  Signal,
  stepA,
  stepB,
  digest,
  verifyEvidence,
  CRITERION,
} from "./deterministic.js";

function parse<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch {
    throw new restate.TerminalError("Invalid request", { errorCode: 400 });
  }
}
export function createTaskWorkflow(ledger: Ledger) {
  const decide = async (ctx: restate.WorkflowSharedContext, signal: Signal) => {
    const promise = ctx.promise<Signal>("decision");
    if (!(await promise.peek())) {
      try {
        await promise.resolve(signal);
      } catch (error) {
        if (!(await promise.peek())) throw error;
      }
    }
    return { decision: await promise, semantics: "first-decision-wins" };
  };
  return restate.workflow({
    name: "TaskWorkflow",
    handlers: {
      run: async (ctx: restate.WorkflowContext, raw: unknown) => {
        let task = parse(SubmitTask, raw);
        if (task.id !== ctx.key)
          throw new restate.TerminalError("Workflow key must match task ID", {
            errorCode: 400,
          });
        const now = async () => new Date(await ctx.date.now()).toISOString();
        const emit = async (
          key: string,
          type: TaskEvent["type"],
          status: TaskStatus,
          extra: Partial<Pick<Write, "step" | "evidence" | "outcome">> = {},
        ) => {
          const at = await now();
          task = Task.parse({
            ...task,
            status,
            ...(key === "start" ? { startedAt: at } : {}),
            ...(status === "COMPLETED" ? { completedAt: at } : {}),
          });
          const event = TaskEvent.parse({
            id: ctx.rand.uuidv4(),
            taskId: task.id,
            type,
            occurredAt: at,
            actor: task.principal,
            traceId: task.traceId,
            ...(extra.step ? { stepId: extra.step.id } : {}),
            payload: {
              status,
              ...(extra.step?.output !== undefined
                ? { output: extra.step.output }
                : {}),
            },
          });
          await ctx.run(key, () =>
            ledger.write({ key, task, event, ...extra }),
          );
          ctx.set("status", task.status);
        };
        await emit("create", "TASK_CREATED", "RECEIVED");
        await emit("compile", "PLAN_COMPILED", "COMPILED");
        await emit("ready", "TASK_READY", "READY");
        await emit("start", "TASK_STARTED", "RUNNING");
        const a = TaskStep.parse({
          id: ctx.rand.uuidv4(),
          taskId: task.id,
          kind: "DETERMINISTIC_FUNCTION",
          status: "RUNNING",
          dependencies: [],
          requiredCapabilities: [],
          riskClass: "LOW",
          retryPolicy: { maxAttempts: 3, backoffMs: 100 },
          input: task.objective,
          idempotencyKey: `${task.id}:A`,
        });
        await emit("a-start", "STEP_STARTED", "RUNNING", { step: a });
        const aResult = stepA(task.objective);
        await emit("a-complete", "STEP_COMPLETED", "RUNNING", {
          step: { ...a, status: "COMPLETED", output: aResult },
        });
        await emit("wait", "TASK_WAITING", "WAITING");
        // A single durable decision: the first signal or cancellation wins, including before wait.
        const decision = await ctx.promise<Signal>("decision");
        if (decision.action === "CANCEL") {
          const outcome = Outcome.parse({
            taskId: task.id,
            status: "CANCELLED",
            acceptanceResults: [],
            evidenceRefs: [],
            summary: decision.reason ?? "Cancelled at durable boundary",
            completedAt: await now(),
          });
          await emit("cancel", "TASK_CANCELLED", "CANCELLED", { outcome });
          return outcome;
        }
        await emit("resume", "TASK_RESUMED", "RUNNING");
        const b = TaskStep.parse({
          ...a,
          id: ctx.rand.uuidv4(),
          dependencies: [a.id],
          input: aResult,
          idempotencyKey: `${task.id}:B`,
        });
        await emit("b-start", "STEP_STARTED", "RUNNING", { step: b });
        const output = stepB(aResult);
        await emit("b-complete", "STEP_COMPLETED", "RUNNING", {
          step: { ...b, status: "COMPLETED", output },
        });
        const metadata = {
          input: task.objective,
          output,
          recipe: "uppercase-reverse/v1",
        };
        const evidence = Evidence.parse({
          id: ctx.rand.uuidv4(),
          taskId: task.id,
          stepId: b.id,
          type: "DETERMINISTIC_RESULT",
          source: "kerneljson:uppercase-reverse/v1",
          digest: digest(metadata),
          capturedAt: await now(),
          metadata,
        });
        await emit("evidence", "EVIDENCE_RECEIVED", "RUNNING", { evidence });
        await emit("verify", "TASK_VERIFYING", "VERIFYING");
        if (!verifyEvidence(evidence, task, b.id)) {
          const outcome = Outcome.parse({
            taskId: task.id,
            status: "FAILED",
            acceptanceResults: [],
            evidenceRefs: [],
            summary: "Deterministic verification failed",
            completedAt: await now(),
          });
          await emit("verification-failed", "VERIFICATION_FAILED", "VERIFYING");
          await emit("failed", "TASK_FAILED", "FAILED", { outcome });
          return outcome;
        }
        const outcome = Outcome.parse({
          taskId: task.id,
          status: "COMPLETED",
          acceptanceResults: [
            { criterion: CRITERION, passed: true, evidenceRefs: [evidence.id] },
          ],
          evidenceRefs: [evidence.id],
          summary: output,
          completedAt: await now(),
        });
        await emit("complete", "TASK_COMPLETED", "COMPLETED", { outcome });
        return outcome;
      },
      status: async (ctx: restate.WorkflowSharedContext) =>
        ctx.run("read-projection", () => ledger.status(ctx.key)),
      signal: async (ctx: restate.WorkflowSharedContext, raw: unknown) => {
        const signal = parse(Signal, raw);
        return decide(ctx, signal);
      },
      cancel: async (ctx: restate.WorkflowSharedContext) => {
        return decide(ctx, { action: "CANCEL" });
      },
    },
  });
}
