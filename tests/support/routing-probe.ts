import {
  AdaptiveRouter,
  routeDurably,
} from "../../services/kernel/src/routing.js";
import { ApprovalStore } from "../../services/kernel/src/approval-store.js";
// Integration-only harness; production workflow journal sequences stay unchanged.
import * as restate from "@restatedev/restate-sdk";
import { appendFileSync, existsSync, unlinkSync } from "node:fs";
import {
  Task,
  TaskEvent,
  TaskStep,
  CapabilityInvocation,
  type CapabilityResult,
} from "../../packages/contracts/src/index.js";
import {
  createBuiltinRegistry,
  UPPERCASE,
} from "../../packages/capabilities/src/index.js";
import { callCapability } from "../../services/kernel/src/capabilities.js";
import { CapabilityStore } from "../../services/kernel/src/capability-store.js";
import type { Ledger } from "../../services/kernel/src/ledger.js";

export function createRoutingProbe(ledger: Ledger) {
  return restate.workflow({
    name: "RoutingProbeV1",
    handlers: {
      run: async (ctx: restate.WorkflowContext, raw: unknown) => {
        let task = Task.parse(raw);
        if (task.id !== ctx.key || task.status !== "RECEIVED")
          throw new restate.TerminalError("Invalid task");
        const request = CapabilityInvocation.parse({
          runId: ctx.rand.uuidv4(),
          taskId: task.id,
          stepId: ctx.rand.uuidv4(),
          trace: { traceId: task.traceId, correlationId: task.id },
          capability: UPPERCASE,
          idempotencyKey: "uppercase-1",
          input: { text: task.objective },
        });
        const recordedAt = new Date(await ctx.date.now()).toISOString();
        const audit = {
          evidenceId: ctx.rand.uuidv4(),
          eventId: ctx.rand.uuidv4(),
          recordedAt,
        };
        for (const [status, type] of [
          ["RECEIVED", "TASK_CREATED"],
          ["COMPILED", "PLAN_COMPILED"],
          ["READY", "TASK_READY"],
          ["RUNNING", "TASK_STARTED"],
        ] as const) {
          task = Task.parse({ ...task, status });
          const write = {
            key: status,
            task,
            event: TaskEvent.parse({
              id: ctx.rand.uuidv4(),
              taskId: task.id,
              traceId: task.traceId,
              actor: task.principal,
              occurredAt: recordedAt,
              type,
              payload: {},
            }),
            ...(status === "RUNNING" || status === "COMPILED"
              ? {
                  step: TaskStep.parse({
                    id: request.stepId,
                    taskId: task.id,
                    kind: "DETERMINISTIC_FUNCTION",
                    status: status === "COMPILED" ? "READY" : "RUNNING",
                    dependencies: [],
                    requiredCapabilities: [UPPERCASE],
                    riskClass: "LOW",
                    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
                    input: request.input,
                    idempotencyKey: request.idempotencyKey,
                  }),
                }
              : {}),
          };
          await ctx.run(status, () => ledger.write(write));
          if (status === "COMPILED") {
            const registry = createBuiltinRegistry();
            const router = new AdaptiveRouter(
              registry,
              {
                version: "probe-routing/1",
                compatible: [UPPERCASE],
                defaultCapability: UPPERCASE,
                limits: {
                  minSamples: 1,
                  maxAgeMs: 60000,
                  minSuccessRate: 1,
                  maxLatencyMs: 100,
                  maxCostUnits: 1,
                  allowColdStart: true,
                },
              },
              {
                version: "probe-policy/1",
                rules: [
                  {
                    tenantId: task.tenant.id,
                    principalId: task.principal.id,
                    capability: UPPERCASE,
                    effect: "ALLOW",
                  },
                ],
              },
              async () => true,
            );
            const routeEvent = TaskEvent.parse({
              id: ctx.rand.uuidv4(),
              taskId: task.id,
              traceId: task.traceId,
              actor: task.principal,
              occurredAt: recordedAt,
              type: "POLICY_CHECKED",
              payload: {},
            });
            await routeDurably(
              ctx,
              router,
              task,
              write.step!,
              request,
              recordedAt,
              async () => {
                appendFileSync(`/tmp/routing-${task.id}-reads`, "snapshot\n");
                return [];
              },
              async (selection) => {
                await new ApprovalStore(ledger.pool).record(
                  selection.evaluation,
                  selection.invocation,
                  task.id,
                );
                await ledger.write({
                  key: "routing-selection",
                  task,
                  event: TaskEvent.parse({ ...routeEvent, payload: selection }),
                });
                if (existsSync("/tmp/kerneljson-routing-crash-once")) {
                  unlinkSync("/tmp/kerneljson-routing-crash-once");
                  process.exit(137);
                }
              },
            );
          }
        }
        const registry = createBuiltinRegistry();
        const execute = registry.execute.bind(registry);
        registry.execute = (raw) => {
          appendFileSync(`/tmp/capability-${task.id}-calls`, "attempt\n");
          return execute(raw);
        };
        const store = new CapabilityStore(ledger.pool, registry);
        const result = await callCapability(
          ctx,
          registry,
          request,
          async (invocation, result) => {
            await store.record(invocation, result, audit);
            if (existsSync("/tmp/kerneljson-routing-unused")) {
              unlinkSync("/tmp/kerneljson-routing-unused");
              process.exit(137);
            }
          },
        );
        ctx.set("result", result);
        return result;
      },
      result: restate.handlers.workflow.shared(
        async (ctx: restate.WorkflowSharedContext) =>
          ctx.get<CapabilityResult>("result"),
      ),
    },
  });
}
