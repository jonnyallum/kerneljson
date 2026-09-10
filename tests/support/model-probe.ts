// Integration-only harness. Never registered by the production worker.
import * as restate from "@restatedev/restate-sdk";
import { appendFileSync, existsSync, unlinkSync } from "node:fs";
import { z } from "zod";
import {
  Task,
  TaskEvent,
  TaskStep,
  ModelRequest,
  type ModelCallResult,
} from "../../packages/contracts/src/index.js";
import { createDeepSeekPort } from "../../packages/models/src/index.js";
import { callModel } from "../../services/kernel/src/models.js";
import type { Ledger } from "../../services/kernel/src/ledger.js";

const Input = z.strictObject({
  task: Task,
  providerStatus: z.union([z.literal(200), z.literal(429)]),
});
export function createModelProbe(ledger: Ledger) {
  return restate.workflow({
    name: "ModelProbeV1",
    handlers: {
      run: async (ctx: restate.WorkflowContext, raw: unknown) => {
        const { task, providerStatus } = Input.parse(raw);
        if (ctx.key !== task.id)
          throw new restate.TerminalError("Task key mismatch");
        const stepId = ctx.rand.uuidv4();
        const callId = ctx.rand.uuidv4();
        const eventId = ctx.rand.uuidv4();
        const created = TaskEvent.parse({
          id: ctx.rand.uuidv4(),
          taskId: task.id,
          type: "TASK_CREATED",
          occurredAt: new Date(await ctx.date.now()).toISOString(),
          actor: task.principal,
          traceId: task.traceId,
          payload: {},
        });
        const request = ModelRequest.parse({
          taskId: task.id,
          stepId,
          callId,
          trace: { traceId: task.traceId, correlationId: task.id },
          messages: [{ role: "user", content: "private recovery test prompt" }],
          maxOutputTokens: 16,
        });
        const step = TaskStep.parse({
          id: stepId,
          taskId: task.id,
          kind: "LLM_CALL",
          status: "READY",
          dependencies: [],
          requiredCapabilities: [],
          riskClass: "LOW",
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
          input: request,
        });
        await ctx.run("create", () =>
          ledger.write({ key: "create", task, event: created, step }),
        );
        const port = createDeepSeekPort({
          apiKey: "test-only-not-a-secret",
          model: "test-model",
          fetch: async () => {
            // This file survives a stop/start of the existing worker container.
            // Appending once per invocation exposes replayed external requests.
            appendFileSync(`/tmp/model-${task.id}-calls`, "attempt\n");
            return Response.json(
              providerStatus === 200
                ? {
                    id: "test-completion",
                    object: "chat.completion",
                    model: "test-model",
                    choices: [
                      {
                        index: 0,
                        finish_reason: "stop",
                        message: {
                          role: "assistant",
                          content: "untrusted test result",
                        },
                      },
                    ],
                    usage: {
                      prompt_tokens: 3,
                      completion_tokens: 2,
                      total_tokens: 5,
                    },
                  }
                : { error: "test-only provider failure" },
              { status: providerStatus },
            );
          },
        });
        const result = await callModel(ctx, port, request, async (receipt) => {
          await ledger.write({
            key: `model:${callId}`,
            task,
            event: TaskEvent.parse({
              id: eventId,
              taskId: task.id,
              stepId,
              type: "MODEL_CALLED",
              occurredAt: receipt.finishedAt,
              actor: task.principal,
              traceId: task.traceId,
              payload: receipt,
            }),
          });
          if (existsSync("/tmp/kerneljson-model-crash-once")) {
            unlinkSync("/tmp/kerneljson-model-crash-once");
            process.exit(137);
          }
        });
        ctx.set("result", result);
        return result;
      },
      result: restate.handlers.workflow.shared(
        async (ctx: restate.WorkflowSharedContext) =>
          ctx.get<ModelCallResult>("result"),
      ),
    },
  });
}
