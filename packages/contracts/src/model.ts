import { z } from "zod";
import { Id, Timestamp } from "./common.js";
import { TraceRef } from "./identity.js";

const Label = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const ModelRequest = z
  .strictObject({
    callId: Id,
    taskId: Id,
    stepId: Id,
    trace: TraceRef,
    messages: z
      .array(
        z.strictObject({
          role: z.enum(["system", "user", "assistant"]),
          content: z.string().min(1).max(128_000),
        }),
      )
      .min(1)
      .max(64),
    maxOutputTokens: z.number().int().min(1).max(8192),
  })
  .refine(
    (r) => r.messages.reduce((n, m) => n + m.content.length, 0) <= 128_000,
    "Combined prompt exceeds the port limit",
  );
export type ModelRequest = z.infer<typeof ModelRequest>;

export const ModelUsage = z
  .strictObject({
    inputTokens: Count,
    outputTokens: Count,
    totalTokens: Count,
  })
  .refine(
    (u) => u.totalTokens === u.inputTokens + u.outputTokens,
    "Inconsistent token usage",
  );
export type ModelUsage = z.infer<typeof ModelUsage>;

export const ModelErrorCode = z.enum([
  "AUTHENTICATION",
  "INSUFFICIENT_BALANCE",
  "RATE_LIMIT",
  "PROVIDER_UNAVAILABLE",
  "REQUEST_REJECTED",
  "NETWORK",
  "TIMEOUT",
  "CANCELLED",
  "RESPONSE_TOO_LARGE",
  "MALFORMED_RESPONSE",
  "OUTPUT_LIMIT",
  "CONTENT_FILTER",
  "UNSUPPORTED_RESPONSE",
]);
export type ModelErrorCode = z.infer<typeof ModelErrorCode>;
export const ModelFailure = z.strictObject({
  code: ModelErrorCode,
  retryable: z.boolean(),
  // Network interruption can occur after provider acceptance. This is not an
  // assurance that a repeated attempt will be free or produce the same answer.
  mayHaveRun: z.boolean(),
  httpStatus: z.number().int().min(100).max(599).optional(),
});
export type ModelFailure = z.infer<typeof ModelFailure>;

const ReceiptBase = z.strictObject({
  callId: Id,
  taskId: Id,
  stepId: Id,
  trace: TraceRef,
  provider: Label,
  model: Label,
  requestDigest: Digest,
  finishedAt: Timestamp,
  durationMs: Count,
});
const SuccessReceipt = ReceiptBase.extend({
  status: z.literal("SUCCEEDED"),
  providerRequestId: Label,
  responseModel: Label,
  usage: ModelUsage,
  outputDigest: Digest,
});
const FailedReceipt = ReceiptBase.extend({
  status: z.literal("FAILED"),
  error: ModelFailure,
});
export const ModelCallReceipt = z.discriminatedUnion("status", [
  SuccessReceipt,
  FailedReceipt,
]);
export type ModelCallReceipt = z.infer<typeof ModelCallReceipt>;
export const ModelCallResult = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("SUCCEEDED"),
    text: z.string().min(1),
    receipt: SuccessReceipt,
  }),
  z.strictObject({ status: z.literal("FAILED"), receipt: FailedReceipt }),
]);
export type ModelCallResult = z.infer<typeof ModelCallResult>;
