import * as restate from "@restatedev/restate-sdk";
import {
  Task,
  TaskEvent,
  TaskStep,
  Evidence,
  Outcome,
  type TaskStatus,
} from "../../../../packages/contracts/src/index.js";
import { compileIntent } from "../compiler/index.js";
import { planTask, orderedSteps, projectStep } from "../planner/index.js";
import { resolveInput, executeFunction } from "./index.js";
import { digest, Signal } from "../deterministic.js";
import { Ledger, type Write } from "../ledger.js";
export function createKernelWorkflow(ledger: Ledger) {
  const decide = async (ctx: restate.WorkflowSharedContext, raw: unknown) => {
    const parsed = Signal.safeParse(raw);
    if (!parsed.success)
      throw new restate.TerminalError("Invalid decision", { errorCode: 400 });
    const decision = ctx.promise<Signal>("decision");
    if (!(await decision.peek())) {
      try {
        await decision.resolve(parsed.data);
      } catch (error) {
        if (!(await decision.peek())) throw error;
      }
    }
    return { decision: await decision, semantics: "first-decision-wins" };
  };
  return restate.workflow({
    name: "KernelWorkflowV1",
    handlers: {
      run: async (ctx: restate.WorkflowContext, raw: unknown) => {
        let compiled: ReturnType<typeof compileIntent>;
        try {
          compiled = compileIntent(raw);
        } catch {
          throw new restate.TerminalError(
            "Unsupported or invalid kernel submission",
            { errorCode: 400 },
          );
        }
        let task = compiled.task;
        if (
          ctx.key !== task.id ||
          Date.parse(task.createdAt) > (await ctx.date.now())
        )
          throw new restate.TerminalError(
            "Invalid task key or future receivedAt",
            { errorCode: 400 },
          );
        const plan = planTask(task, compiled.submission.recipe);
        const now = async () => new Date(await ctx.date.now()).toISOString();
        const emit = async (
          key: string,
          type: TaskEvent["type"],
          status: TaskStatus,
          extra: Partial<
            Pick<Write, "step" | "steps" | "evidence" | "outcome">
          > = {},
          payload: Record<string, unknown> = {},
        ) => {
          const occurredAt = await now();
          task = Task.parse({
            ...task,
            status,
            ...(key === "start" ? { startedAt: occurredAt } : {}),
            ...(status === "COMPLETED" ? { completedAt: occurredAt } : {}),
          });
          const event = TaskEvent.parse({
            id: ctx.rand.uuidv4(),
            taskId: task.id,
            type,
            occurredAt,
            actor: task.principal,
            traceId: task.traceId,
            ...(extra.step ? { stepId: extra.step.id } : {}),
            payload: { status, ...payload },
          });
          await ctx.run(key, () =>
            ledger.write({ key, task, event, ...extra }),
          );
        };
        await emit(
          "create",
          "TASK_CREATED",
          "RECEIVED",
          {},
          {
            intent: compiled.submission.intent,
            recipe: plan.recipe,
            compilerVersion: 1,
          },
        );
        await emit(
          "intent",
          "INTENT_RESOLVED",
          "RECEIVED",
          {},
          {
            intentId: compiled.submission.intent.id,
            correlationId: compiled.submission.intent.trace.correlationId,
          },
        );
        await emit(
          "compile",
          "PLAN_COMPILED",
          "COMPILED",
          { steps: plan.steps.map(projectStep) },
          { plan, planDigest: digest(plan) },
        );
        await emit("ready", "TASK_READY", "READY");
        await emit("start", "TASK_STARTED", "RUNNING");
        const outputs = new Map<string, string>();
        const cancel = async (step?: TaskStep) => {
          const outcome = Outcome.parse({
            taskId: task.id,
            status: "CANCELLED",
            acceptanceResults: [],
            evidenceRefs: [],
            summary: "Cancelled at a step boundary",
            completedAt: await now(),
          });
          await emit("cancel", "TASK_CANCELLED", "CANCELLED", {
            outcome,
            ...(step
              ? { step: { ...step, status: "CANCELLED" as const } }
              : {}),
          });
          return outcome;
        };
        for (const node of orderedSteps(plan)) {
          if (
            (await ctx.promise<Signal>("decision").peek())?.action === "CANCEL"
          )
            return cancel();
          const input = resolveInput(node, task, outputs),
            base = projectStep(node);
          const step = TaskStep.parse({ ...base, status: "RUNNING", input });
          await emit(`step:${node.id}:start`, "STEP_STARTED", "RUNNING", {
            step,
          });
          let output: string;
          if (node.operation === "WAIT_FOR_EVENT") {
            await emit(`step:${node.id}:wait`, "TASK_WAITING", "WAITING", {
              step: { ...step, status: "WAITING" },
            });
            const decision = await ctx.promise<Signal>("decision");
            if (decision.action === "CANCEL") {
              return cancel(step);
            }
            await emit(`step:${node.id}:resume`, "TASK_RESUMED", "RUNNING", {
              step,
            });
            output = input;
          } else output = executeFunction(node.operation, input);
          await emit(
            `step:${node.id}:complete`,
            "STEP_COMPLETED",
            "RUNNING",
            { step: { ...step, status: "COMPLETED", output } },
            { output },
          );
          outputs.set(node.id, output);
        }
        const output = outputs.get(plan.resultStepId)!;
        const metadata = {
          planDigest: digest(plan),
          input: task.objective,
          output,
        };
        const evidence = Evidence.parse({
          id: ctx.rand.uuidv4(),
          taskId: task.id,
          stepId: plan.resultStepId,
          type: "DETERMINISTIC_RESULT",
          source: "kerneljson:plan/v1",
          digest: digest(metadata),
          capturedAt: await now(),
          metadata,
        });
        await emit("evidence", "EVIDENCE_RECEIVED", "RUNNING", { evidence });
        await emit("verify", "TASK_VERIFYING", "VERIFYING");
        const outcome = Outcome.parse({
          taskId: task.id,
          status: "COMPLETED",
          acceptanceResults: task.acceptanceCriteria.map((criterion) => ({
            criterion,
            passed: true,
            evidenceRefs: [evidence.id],
          })),
          evidenceRefs: [evidence.id],
          summary: output,
          completedAt: await now(),
        });
        // The ledger independently verifies the immutable plan, every persisted step,
        // and the evidence inside the transaction that commits completion.
        await emit("complete", "TASK_COMPLETED", "COMPLETED", { outcome });
        return outcome;
      },
      status: async (ctx: restate.WorkflowSharedContext) =>
        ctx.run("status", () => ledger.status(ctx.key)),
      signal: async (ctx: restate.WorkflowSharedContext, raw: unknown) =>
        decide(ctx, raw),
      cancel: async (ctx: restate.WorkflowSharedContext) =>
        decide(ctx, { action: "CANCEL" }),
    },
  });
}
