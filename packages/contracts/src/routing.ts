import { z } from "zod";
import { Id, Timestamp, CapabilityRef } from "./common.js";
import { Digest } from "./evaluation.js";
export const RouteObservation = z.strictObject({
  taskId: Id,
  evidenceId: Id,
  capability: CapabilityRef,
  descriptorDigest: Digest,
  observedAt: Timestamp,
  success: z.boolean(),
  latencyMs: z.number().finite().nonnegative(),
  costUnits: z.number().finite().nonnegative(),
});
export type RouteObservation = z.infer<typeof RouteObservation>;
export const RoutingLimits = z.strictObject({
  minSamples: z.number().int().min(1).max(1000),
  maxAgeMs: z.number().int().min(1),
  minSuccessRate: z.number().min(0).max(1),
  maxLatencyMs: z.number().finite().nonnegative(),
  maxCostUnits: z.number().finite().nonnegative(),
  allowColdStart: z.boolean().default(false),
});
export type RoutingLimits = z.infer<typeof RoutingLimits>;
