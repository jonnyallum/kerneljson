import { z } from "zod";
import {
  ModelRequest,
  ModelCallResult,
  ModelCallReceipt,
  type ModelFailure,
  type ModelErrorCode,
} from "../../contracts/src/index.js";
import type { ModelPort } from "./port.js";
import { modelDigest } from "./digest.js";

const Endpoint = "https://api.deepseek.com/chat/completions";
const MaxResponseBytes = 1_048_576;
const Metadata = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/);
const Tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ProviderResponse = z.object({
  id: Metadata,
  object: z.literal("chat.completion"),
  model: Metadata,
  choices: z
    .array(
      z.object({
        index: z.literal(0),
        finish_reason: z.enum([
          "stop",
          "length",
          "content_filter",
          "tool_calls",
          "insufficient_system_resource",
        ]),
        message: z.object({
          role: z.literal("assistant"),
          content: z.string().nullable(),
          tool_calls: z.array(z.unknown()).optional(),
        }),
      }),
    )
    .length(1),
  usage: z
    .object({
      prompt_tokens: Tokens,
      completion_tokens: Tokens,
      total_tokens: Tokens,
    })
    .refine((u) => u.total_tokens === u.prompt_tokens + u.completion_tokens),
});

class ResponseLimit extends Error {}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Missing response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MaxResponseBytes) {
        await reader.cancel();
        throw new ResponseLimit();
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/** Deployment-only configuration. Never accept these values from a task/prompt. */
export function createDeepSeekPort(config: {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}): ModelPort {
  if (
    typeof config.apiKey !== "string" ||
    !/^[^\s]+$/.test(config.apiKey) ||
    !Metadata.safeParse(config.model).success
  )
    throw new Error(
      "Invalid DeepSeek configuration; inject credentials from jVault kerneljson",
    );
  const timeoutMs = config.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 120_000)
    throw new Error("Invalid model timeout");
  const send = config.fetch ?? globalThis.fetch;
  // Capture primitives; subsequent caller mutation cannot change the deployment.
  const { apiKey, model } = config;
  return {
    async generate(raw, options = {}) {
      const parsed = ModelRequest.safeParse(raw);
      if (!parsed.success) throw new Error("Invalid ModelRequest");
      const request = parsed.data;
      const start = performance.now();
      const base = {
        callId: request.callId,
        taskId: request.taskId,
        stepId: request.stepId,
        trace: request.trace,
        provider: "deepseek",
        model,
        requestDigest: modelDigest({ provider: "deepseek", model, request }),
      };
      const finish = () => ({
        ...base,
        finishedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - start),
      });
      const fail = (
        code: ModelErrorCode,
        retryable: boolean,
        mayHaveRun: boolean,
        httpStatus?: number,
      ): ModelCallResult => {
        const error: ModelFailure = {
          code,
          retryable,
          mayHaveRun,
          ...(httpStatus === undefined ? {} : { httpStatus }),
        };
        return ModelCallResult.parse({
          status: "FAILED",
          receipt: { ...finish(), status: "FAILED", error },
        });
      };
      if (options.signal?.aborted) return fail("CANCELLED", false, false);
      const deadline = AbortSignal.timeout(timeoutMs);
      const signal = options.signal
        ? AbortSignal.any([deadline, options.signal])
        : deadline;
      let response: Response;
      try {
        response = await send(Endpoint, {
          method: "POST",
          redirect: "error",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: request.messages,
            max_tokens: request.maxOutputTokens,
            stream: false,
            thinking: { type: "disabled" },
          }),
          signal,
        });
      } catch {
        return options.signal?.aborted
          ? fail("CANCELLED", false, true)
          : deadline.aborted
            ? fail("TIMEOUT", true, true)
            : fail("NETWORK", true, true);
      }
      if (!response.ok) {
        // Provider errors may echo prompts or credentials. Do not read/log them.
        await response.body?.cancel().catch(() => {});
        const status = response.status;
        if (status === 401 || status === 403)
          return fail("AUTHENTICATION", false, false, status);
        if (status === 402)
          return fail("INSUFFICIENT_BALANCE", false, false, status);
        if (status === 429) return fail("RATE_LIMIT", true, false, status);
        if (status >= 500)
          return fail("PROVIDER_UNAVAILABLE", true, true, status);
        return fail("REQUEST_REJECTED", false, false, status);
      }
      let value: unknown;
      try {
        value = await boundedJson(response);
      } catch (error) {
        if (options.signal?.aborted) return fail("CANCELLED", false, true);
        if (deadline.aborted) return fail("TIMEOUT", true, true);
        return fail(
          error instanceof ResponseLimit
            ? "RESPONSE_TOO_LARGE"
            : "MALFORMED_RESPONSE",
          false,
          true,
        );
      }
      const completion = ProviderResponse.safeParse(value);
      if (!completion.success) return fail("MALFORMED_RESPONSE", false, true);
      const data = completion.data;
      const choice = data.choices[0]!;
      if (choice.finish_reason === "length")
        return fail("OUTPUT_LIMIT", false, true);
      if (choice.finish_reason === "content_filter")
        return fail("CONTENT_FILTER", false, true);
      if (choice.finish_reason === "insufficient_system_resource")
        return fail("PROVIDER_UNAVAILABLE", true, true);
      if (
        choice.finish_reason === "tool_calls" ||
        choice.message.tool_calls?.length
      )
        return fail("UNSUPPORTED_RESPONSE", false, true);
      const text = choice.message.content;
      if (!text?.trim()) return fail("MALFORMED_RESPONSE", false, true);
      const receipt = ModelCallReceipt.parse({
        ...finish(),
        status: "SUCCEEDED",
        providerRequestId: data.id,
        responseModel: data.model,
        usage: {
          inputTokens: data.usage.prompt_tokens,
          outputTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        },
        outputDigest: modelDigest(text),
      });
      return ModelCallResult.parse({ status: "SUCCEEDED", text, receipt });
    },
  };
}
