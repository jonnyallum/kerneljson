import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import {
  ApprovalAnswer,
  ApprovalResolution,
  CapabilityInvocation,
  PrincipalRef,
  Task,
  TaskEvent,
  TaskStep,
  type TaskStatus,
} from "../../../packages/contracts/src/index.js";
import {
  createBuiltinRegistry,
  UPPERCASE,
} from "../../../packages/capabilities/src/index.js";
import { PolicyRules, evaluatePolicy } from "./policy.js";
import { ApprovalError, ApprovalStore } from "./approval-store.js";
import { CapabilityStore } from "./capability-store.js";
import { callCapability } from "./capabilities.js";
import type { Ledger } from "./ledger.js";

export type Authenticator = (
  headers: ReadonlyMap<string, string>,
) => Promise<PrincipalRef>;
/** No default authenticator: deployment must supply a real trusted identity boundary. */
export function createPolicyWorkflow(
  ledger: Ledger,
  configuredRules: PolicyRules,
  authenticate: Authenticator,
) {
  ledger = ledger.forWorkflow("PolicyCapabilityWorkflowV1");
  const rules = PolicyRules.parse(configuredRules),
    registry = createBuiltinRegistry();
  const approvals = new ApprovalStore(ledger.pool),
    receipts = new CapabilityStore(ledger.pool, registry);
  async function identity(
    ctx: restate.Context | restate.WorkflowSharedContext,
  ) {
    try {
      return PrincipalRef.parse(await authenticate(ctx.request().headers));
    } catch {
      throw new restate.TerminalError("Unauthenticated", { errorCode: 401 });
    }
  }
  const notify = async (
    ctx: restate.WorkflowSharedContext,
    resolution: ApprovalResolution,
  ) => {
    const promise = ctx.promise<ApprovalResolution>("approval");
    if (!(await promise.peek())) {
      try {
        await promise.resolve(resolution);
      } catch (error) {
        if (!(await promise.peek())) throw error;
      }
    }
    return resolution;
  };
  return restate.workflow({
    name: "PolicyCapabilityWorkflowV1",
    handlers: {
      run: async (ctx: restate.WorkflowContext, raw: unknown) => {
        const actor = await ctx.run("authenticate-submission", () =>
          identity(ctx),
        );
        const parsed = Task.safeParse(raw);
        if (
          !parsed.success ||
          parsed.data.id !== ctx.key ||
          parsed.data.status !== "RECEIVED" ||
          parsed.data.principal.id !== actor.id ||
          parsed.data.principal.kind !== actor.kind
        )
          throw new restate.TerminalError("Invalid task identity", {
            errorCode: 403,
          });
        let task = parsed.data;
        const request = CapabilityInvocation.parse({
          runId: ctx.rand.uuidv4(),
          taskId: task.id,
          stepId: ctx.rand.uuidv4(),
          trace: { traceId: task.traceId, correlationId: task.id },
          capability: UPPERCASE,
          idempotencyKey: "policy-uppercase-1",
          input: { text: task.objective },
        });
        let step = TaskStep.parse({
          id: request.stepId,
          taskId: task.id,
          kind: "DETERMINISTIC_FUNCTION",
          status: "READY",
          dependencies: [],
          requiredCapabilities: [UPPERCASE],
          riskClass: "LOW",
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
          input: request.input,
          idempotencyKey: request.idempotencyKey,
        });
        const emit = async (
          key: string,
          type: TaskEvent["type"],
          status: TaskStatus,
          withStep = false,
        ) => {
          task = Task.parse({ ...task, status });
          const event = TaskEvent.parse({
            id: ctx.rand.uuidv4(),
            taskId: task.id,
            traceId: task.traceId,
            actor: task.principal,
            occurredAt: new Date(await ctx.date.now()).toISOString(),
            type,
            payload: {},
          });
          await ctx.run(key, () =>
            ledger.write({ key, task, event, ...(withStep ? { step } : {}) }),
          );
        };
        await emit("create", "TASK_CREATED", "RECEIVED");
        await emit("compile", "PLAN_COMPILED", "COMPILED", true);
        const approvalId = ctx.key; // One gate for this initial recipe; scoped to its task.
        const decisionId = ctx.rand.uuidv4(),
          at = new Date(await ctx.date.now()).toISOString();
        const evaluation = await ctx.run("evaluate-policy", () =>
          evaluatePolicy(
            rules,
            task,
            step,
            request,
            registry.describe(UPPERCASE),
            decisionId,
            at,
          ),
        );
        await ctx.run("record-policy", async () => {
          try {
            await approvals.record(evaluation, request, approvalId);
          } catch (error) {
            if (error instanceof ApprovalError || error instanceof z.ZodError)
              throw new restate.TerminalError("Policy persistence rejected", {
                errorCode: 403,
              });
            throw error;
          }
        });
        if (evaluation.decision.decision === "DENY") {
          await emit("deny", "TASK_FAILED", "FAILED");
          return { authorization: "DENIED" };
        }
        if (evaluation.decision.decision === "APPROVAL_REQUIRED") {
          await emit(
            "approval-required",
            "APPROVAL_REQUESTED",
            "APPROVAL_REQUIRED",
          );
          const timeout = Math.max(
            1,
            Date.parse(evaluation.expiresAt!) - (await ctx.date.now()),
          );
          try {
            await ctx
              .promise<ApprovalResolution>("approval")
              .get()
              .orTimeout(timeout);
          } catch (error) {
            if (!(error instanceof restate.TimeoutError)) throw error;
          }
          // Read the authoritative database decision. A timeout can race with a
          // committed grant whose signal was interrupted before acknowledgement.
          const evidenceId = ctx.rand.uuidv4(),
            eventId = ctx.rand.uuidv4();
          const resolution = await ctx.run("resolve-deadline", () =>
            approvals.expire(approvalId, evidenceId, eventId),
          );
          if (resolution.status !== "GRANTED") {
            await emit(
              "approval-rejected",
              resolution.reason === "CANCELLED"
                ? "TASK_CANCELLED"
                : "TASK_FAILED",
              resolution.reason === "CANCELLED" ? "CANCELLED" : "FAILED",
            );
            return { authorization: resolution.status };
          }
          await emit("approved", "TASK_READY", "READY");
        } else {
          await emit("ready", "TASK_READY", "READY");
        }
        step = TaskStep.parse({ ...step, status: "RUNNING" });
        await emit("start", "TASK_STARTED", "RUNNING", true);
        const audit = {
          evidenceId: ctx.rand.uuidv4(),
          eventId: ctx.rand.uuidv4(),
          recordedAt: new Date(await ctx.date.now()).toISOString(),
        };
        const result = await callCapability(
          ctx,
          registry,
          request,
          (r, result) => receipts.record(r, result, audit),
        );
        step = TaskStep.parse({
          ...step,
          status: "COMPLETED",
          output: result.output,
        });
        await emit("step-complete", "STEP_COMPLETED", "RUNNING", true);
        await emit("verify", "TASK_VERIFYING", "VERIFYING");
        return { authorization: "ALLOWED", result };
      },
      approve: restate.handlers.workflow.shared(
        async (ctx: restate.WorkflowSharedContext, raw: unknown) => {
          const actor = await identity(ctx),
            answer = ApprovalAnswer.safeParse(raw);
          if (!answer.success)
            throw new restate.TerminalError("Invalid approval answer", {
              errorCode: 400,
            });
          const evidenceId = ctx.rand.uuidv4(),
            eventId = ctx.rand.uuidv4();
          const resolution = await ctx.run("answer", async () => {
            try {
              return await approvals.resolve(
                ctx.key,
                answer.data,
                actor,
                evidenceId,
                eventId,
              );
            } catch (error) {
              if (error instanceof ApprovalError || error instanceof z.ZodError)
                throw new restate.TerminalError("Approval rejected", {
                  errorCode: 403,
                });
              throw error;
            }
          });
          return notify(ctx, resolution);
        },
      ),
      cancel: restate.handlers.workflow.shared(
        async (ctx: restate.WorkflowSharedContext) => {
          const actor = await identity(ctx),
            evidenceId = ctx.rand.uuidv4(),
            eventId = ctx.rand.uuidv4();
          const resolution = await ctx.run("cancel", async () => {
            try {
              return await approvals.cancel(
                ctx.key,
                actor,
                evidenceId,
                eventId,
              );
            } catch (error) {
              if (error instanceof ApprovalError)
                throw new restate.TerminalError("Cancellation rejected", {
                  errorCode: 403,
                });
              throw error;
            }
          });
          return notify(ctx, resolution);
        },
      ),
    },
  });
}
