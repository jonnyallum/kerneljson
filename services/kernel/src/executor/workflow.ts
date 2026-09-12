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
import { verifyClaudeMdCheck } from "../../../../packages/runtimes/src/index.js";
import type { CapabilityService } from "../capability-service.js";

/** Optional capability-recipe wiring. Present only on a worker configured to serve the
 *  canary: the registered CapabilityServiceV1 to call, the approved digest to verify
 *  against, and the fixed target file (never derived from task payload). */
export interface KernelWorkflowOptions {
  canary?: { recipe: string; approvedContentSha256: string };
  capabilityService?: CapabilityService;
  canaryTargetFile?: string;
}

export function createKernelWorkflow(
  ledger: Ledger,
  options?: KernelWorkflowOptions,
) {
  ledger = ledger.forWorkflow("KernelWorkflowV1");
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
          return status === "COMPLETED"
            ? ctx.run(key, () => ledger.finish({ key, task, event, ...extra }))
            : ctx.run(key, () => ledger.write({ key, task, event, ...extra }));
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
        // Capability recipe (canary): a single REPOSITORY_READ executed by the
        // registered CapabilityServiceV1 (filesystem I/O out of the deterministic
        // executor). The returned receipt is persisted into THIS task's ledger as
        // TOOL_RECEIPT evidence, then completion is decided by the shared
        // verifyClaudeMdCheck. Drift/mutation/wrong-target => terminal FAILED.
        const capabilityNode = orderedSteps(plan).find(
          (n) => n.operation === "REPOSITORY_READ",
        );
        if (capabilityNode) {
          if (!options?.canary || !options.capabilityService)
            throw new restate.TerminalError(
              "Capability recipe requires a configured capability service and approved digest",
              { errorCode: 500 },
            );
          const base = projectStep(capabilityNode);
          await emit(`step:${capabilityNode.id}:start`, "STEP_STARTED", "RUNNING", {
            step: TaskStep.parse({
              ...base,
              status: "RUNNING",
              input: capabilityNode.input,
            }),
          });
          const result = await ctx
            .serviceClient(options.capabilityService)
            .repositoryRead({
              runId: ctx.rand.uuidv4(),
              taskId: task.id,
              stepId: capabilityNode.id,
              trace: { traceId: task.traceId, correlationId: task.id },
              idempotencyKey: `${task.id}:${capabilityNode.id}`,
              targetFile: options.canaryTargetFile ?? "CLAUDE.md",
            });
          const receipt = result.output as Record<string, unknown>;
          const contentSha256 = String(receipt["content_sha256"]);
          const evidenceId = ctx.rand.uuidv4();
          const evidence = Evidence.parse({
            id: evidenceId,
            taskId: task.id,
            stepId: capabilityNode.id,
            type: "TOOL_RECEIPT",
            source: "kerneljson:repository-read-local/v1",
            digest: contentSha256,
            capturedAt: await now(),
            metadata: {
              capability: "repository.read",
              target_path: receipt["target_path"] ?? null,
              content_sha256: contentSha256,
              mutations_detected: receipt["mutations_detected"] ?? null,
              output_hash: receipt["output_hash"] ?? null,
            },
          });
          await emit(
            `step:${capabilityNode.id}:complete`,
            "STEP_COMPLETED",
            "RUNNING",
            {
              step: TaskStep.parse({
                ...base,
                status: "COMPLETED",
                input: capabilityNode.input,
                output: result.output,
              }),
              evidence,
            },
            { output: result.output },
          );
          await emit("verify", "TASK_VERIFYING", "VERIFYING");
          const candidate = Outcome.parse({
            taskId: task.id,
            status: "COMPLETED",
            acceptanceResults: task.acceptanceCriteria.map((criterion) => ({
              criterion,
              passed: true,
              evidenceRefs: [evidenceId],
            })),
            evidenceRefs: [evidenceId],
            summary: String(receipt["summary"] ?? "repository.read complete"),
            completedAt: await now(),
          });
          const verification = verifyClaudeMdCheck({
            taskId: task.id,
            result,
            evidence,
            outcome: candidate,
            approvedContentSha256: options.canary.approvedContentSha256,
          });
          if (verification.status === "PASSED")
            return (
              (await emit("complete", "TASK_COMPLETED", "COMPLETED", {
                outcome: candidate,
              })) ?? candidate
            );
          const failed = Outcome.parse({
            taskId: task.id,
            status: "FAILED",
            acceptanceResults: task.acceptanceCriteria.map((criterion) => ({
              criterion,
              passed: false,
              evidenceRefs: [],
            })),
            evidenceRefs: [],
            summary: `claude_md_check FAILED: ${
              verification.failures.join(",") || "CLAUDE_MD_DRIFT"
            }`,
            completedAt: await now(),
          });
          await emit("fail", "TASK_FAILED", "FAILED", { outcome: failed }, {
            failures: verification.failures,
          });
          return failed;
        }
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
        return await emit("complete", "TASK_COMPLETED", "COMPLETED", { outcome }) ?? outcome;
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
