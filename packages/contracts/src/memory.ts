import { z } from "zod";
import { Id, Timestamp } from "./common.js";
import { PrincipalRef } from "./identity.js";
export const TenantContext = z.strictObject({
  tenantId: Id,
  principal: PrincipalRef,
});
export type TenantContext = z.infer<typeof TenantContext>;
export const MemoryItem = z
  .strictObject({
    id: Id,
    tenantId: Id,
    taskId: Id,
    evidenceId: Id,
    source: z.literal("kerneljson:verified-outcome/v1"),
    content: z.strictObject({
      kind: z.literal("TASK_RESULT"),
      text: z.string().min(1).max(49152),
      outcomeDigest: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    observedAt: Timestamp,
    validUntil: Timestamp.nullable(),
  })
  .refine(
    (m) => !m.validUntil || Date.parse(m.validUntil) > Date.parse(m.observedAt),
    "Invalid memory validity window",
  );
export type MemoryItem = z.infer<typeof MemoryItem>;
