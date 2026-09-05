import * as restate from "@restatedev/restate-sdk";
import {
  ScheduleConfig,
  Task,
  TaskStep,
  TaskEvent,
  Outcome,
  PrincipalRef,
  type TenantContext,
  type TaskStatus,
} from "../../../packages/contracts/src/index.js";
import { withTenant } from "../../../packages/identity/src/index.js";
import { compileSchedule } from "./schedule.js";
import { compileIntent, stableId } from "./compiler/index.js";
import { finishSchedule } from "./schedule-store.js";
import type { Ledger } from "./ledger.js";
import type { Authenticator } from "./policy-workflow.js";
// Omit SDK jsonSchema?: object | undefined to preserve exactOptionalPropertyTypes.
const jsonSerde: restate.Serde<unknown> = {
  contentType: "application/json",
  serialize: (value) => restate.serde.json.serialize(value),
  deserialize: (bytes) => restate.serde.json.deserialize(bytes) as unknown,
};
export function createAutonomousWorkflow(
  ledger: Ledger,
  options: {
    config: ScheduleConfig;
    authenticate: Authenticator;
    authorizedNow: (context: TenantContext) => Promise<boolean>;
    childHeaders: (context: TenantContext) => Record<string, string>;
    afterOutcomeCommit?: () => Promise<void>;
  },
) {
  const config = ScheduleConfig.parse(options.config);
  const identity = async (
    ctx: restate.Context | restate.WorkflowSharedContext,
  ) => {
    try {
      return PrincipalRef.parse(
        await options.authenticate(ctx.request().headers),
      );
    } catch {
      throw new restate.TerminalError("Unauthenticated", { errorCode: 401 });
    }
  };
  return restate.workflow({
    name: "BoundedScheduleWorkflowV1",
    handlers: {
      run: async (ctx: restate.WorkflowContext, raw: unknown) => {
        const actor = await ctx.run("authenticate-schedule", () =>
          identity(ctx),
        );
        const plan = await ctx.run("compile-schedule", () => {
          try {
            return compileSchedule(raw, config, actor);
          } catch {
            throw new restate.TerminalError("Invalid or disabled schedule", {
              errorCode: 403,
            });
          }
        });
        if (plan.task.id !== ctx.key)
          throw new restate.TerminalError("Schedule key mismatch", {
            errorCode: 400,
          });
        let task = plan.task;
        const context: TenantContext = {
          tenantId: task.tenant.id,
          principal: actor,
        };
        const allowed = async () =>
          withTenant(
            ledger.pool,
            context,
            async () =>
              config.enabled &&
              config.version === plan.configVersion &&
              plan.children.length <= config.maxIterations &&
              plan.budgetUnits <= config.maxBudgetUnits &&
              plan.intervalMs >= config.minIntervalMs &&
              plan.intervalMs <= config.maxIntervalMs &&
              (await options.authorizedNow(context)),
          ).catch((error) => {
            if (
              error instanceof Error &&
              error.message === "Tenant access denied"
            )
              return false;
            throw error;
          });
        if (!(await ctx.run("authorize-schedule", allowed)))
          throw new restate.TerminalError("Schedule denied", {
            errorCode: 403,
          });
        let step = TaskStep.parse({
          id: stableId(["schedule-step/v1", task.id]),
          taskId: task.id,
          kind: "SCHEDULE",
          status: "READY",
          dependencies: [],
          requiredCapabilities: [],
          riskClass: "LOW",
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
          input: plan,
          idempotencyKey: task.id,
        });
        const emit = async (
          key: string,
          type: TaskEvent["type"],
          status: TaskStatus,
          includeStep = false,
        ) => {
          task = Task.parse({ ...task, status });
          const event = TaskEvent.parse({
            id: ctx.rand.uuidv4(),
            taskId: task.id,
            traceId: task.traceId,
            actor: task.principal,
            occurredAt: new Date(await ctx.date.now()).toISOString(),
            type,
            payload: type === "PLAN_COMPILED" ? { schedule: plan } : {},
          });
          await ctx.run(key, () =>
            ledger.write({
              key,
              task,
              event,
              ...(includeStep ? { step } : {}),
            }),
          );
          ctx.set("task", task);
        };
        await emit("create", "TASK_CREATED", "RECEIVED");
        await emit("compile", "PLAN_COMPILED", "COMPILED", true);
        await emit("ready", "TASK_READY", "READY");
        step = TaskStep.parse({ ...step, status: "RUNNING" });
        await emit("start", "TASK_STARTED", "RUNNING", true);
        let completedChildren = 0;
        const stop = async (status: "FAILED" | "CANCELLED") => {
          step = TaskStep.parse({ ...step, status });
          await emit(
            "stop",
            status === "FAILED" ? "TASK_FAILED" : "TASK_CANCELLED",
            status,
            true,
          );
          return { status, completedChildren };
        };
        for (let index = 0; index < plan.children.length; index++) {
          if (index > 0) {
            await emit(`wait:${index}`, "TASK_WAITING", "WAITING");
            try {
              await ctx
                .promise<boolean>("cancel")
                .get()
                .orTimeout(plan.intervalMs);
            } catch (error) {
              if (!(error instanceof restate.TimeoutError)) throw error;
            }
            if (await ctx.promise<boolean>("cancel").peek())
              return stop("CANCELLED");
            await emit(`resume:${index}`, "TASK_RESUMED", "RUNNING");
          }
          if (await ctx.promise<boolean>("cancel").peek())
            return stop("CANCELLED");
          if (!(await ctx.run(`authorize-child:${index}`, allowed)))
            return stop("CANCELLED");
          const submission = plan.children[index]!,
            child = compileIntent(submission).task;
          let result: unknown;
          try {
            result = await ctx.genericCall({
              service: "AutonomousChildTaskWorkflowV1",
              method: "run",
              key: child.id,
              parameter: { parentTaskId: task.id, submission },
              inputSerde: jsonSerde,
              outputSerde: jsonSerde,
              headers: options.childHeaders(context),
            });
          } catch (error) {
            if (error instanceof restate.TerminalError) return stop("FAILED");
            throw error;
          }
          const outcome = Outcome.safeParse(result);
          if (
            !outcome.success ||
            outcome.data.taskId !== child.id ||
            outcome.data.status !== "COMPLETED"
          )
            return stop("FAILED");
          completedChildren++;
        }
        if (await ctx.promise<boolean>("cancel").peek())
          return stop("CANCELLED");
        step = TaskStep.parse({
          ...step,
          status: "COMPLETED",
          output: { completedChildren },
        });
        await emit("steps-complete", "STEP_COMPLETED", "RUNNING", true);
        await emit("verify", "TASK_VERIFYING", "VERIFYING");
        const audit = {
          eventId: ctx.rand.uuidv4(),
          evidenceId: ctx.rand.uuidv4(),
          at: new Date(await ctx.date.now()).toISOString(),
        };
        const outcome = await ctx.run("verify-schedule", async () => {
          const outcome = await finishSchedule(ledger.pool, task.id, audit);
          await options.afterOutcomeCommit?.();
          return outcome;
        });
        ctx.set(
          "task",
          Task.parse({
            ...task,
            status: outcome.status,
            completedAt: outcome.completedAt,
          }),
        );
        return outcome;
      },
      cancel: restate.handlers.workflow.shared(
        async (ctx: restate.WorkflowSharedContext) => {
          const actor = await identity(ctx),
            task = await ctx.get<Task>("task");
          if (
            !task ||
            actor.id !== task.principal.id ||
            actor.kind !== task.principal.kind
          )
            throw new restate.TerminalError("Cancellation denied", {
              errorCode: 403,
            });
          await ctx.run("authorize-cancellation", () =>
            withTenant(
              ledger.pool,
              { tenantId: task.tenant.id, principal: actor },
              async () => true,
            ),
          );
          if (["COMPLETED", "FAILED", "CANCELLED"].includes(task.status))
            return { status: task.status };
          const signal = ctx.promise<boolean>("cancel");
          if (!(await signal.peek())) {
            try {
              await signal.resolve(true);
            } catch (error) {
              if (!(await signal.peek())) throw error;
            }
          }
          return { status: "CANCELLATION_REQUESTED" };
        },
      ),
    },
  });
}
