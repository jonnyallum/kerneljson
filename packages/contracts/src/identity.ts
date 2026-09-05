import { z } from "zod";
import { Id, Text } from "./common.js";
export const PrincipalRef = z.strictObject({
  id: Id,
  kind: z.enum(["HUMAN", "SERVICE"]),
});
export type PrincipalRef = z.infer<typeof PrincipalRef>;
export const TenantRef = z.strictObject({ id: Id });
export type TenantRef = z.infer<typeof TenantRef>;
export const TraceRef = z.strictObject({
  traceId: Id,
  correlationId: Id,
  spanId: Text.optional(),
});
export type TraceRef = z.infer<typeof TraceRef>;
