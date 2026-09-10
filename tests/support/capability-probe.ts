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

export function createCapabilityProbe(ledger: Ledger) {
  return restate.workflow({
    name: "CapabilityProbeV1",
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
            ...(status === "RUNNING"
              ? {
                  step: TaskStep.parse({
                    id: request.stepId,
                    taskId: task.id,
                    kind: "DETERMINISTIC_FUNCTION",
                    status,
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
            if (existsSync("/tmp/kerneljson-capability-crash-once")) {
              unlinkSync("/tmp/kerneljson-capability-crash-once");
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
