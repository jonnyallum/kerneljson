import { z } from "zod";
import { CapabilityRef, Id, Json, Text } from "./common.js";
import { TraceRef } from "./identity.js";

export const CapabilityInvocation = z.strictObject({
  runId: Id,
  taskId: Id,
  stepId: Id,
  trace: TraceRef,
  capability: CapabilityRef,
  idempotencyKey: Text.max(256),
  input: Json,
});
export type CapabilityInvocation = z.infer<typeof CapabilityInvocation>;

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const CapabilityResult = z.strictObject({
  runId: Id,
  taskId: Id,
  stepId: Id,
  trace: TraceRef,
  capability: CapabilityRef,
  idempotencyKey: Text.max(256),
  requestDigest: Digest,
  descriptorDigest: Digest,
  output: Json,
  outputDigest: Digest,
  verification: z.literal("PASSED"),
});
export type CapabilityResult = z.infer<typeof CapabilityResult>;
