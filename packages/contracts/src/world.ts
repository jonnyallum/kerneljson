import { z } from "zod";
import { Id, Timestamp } from "./common.js";
import { MemoryItem } from "./memory.js";
export const WorldEntity = z.strictObject({
  id: Id,
  tenantId: Id,
  identityKey: z.string().trim().min(1).max(256),
  type: z.string().trim().min(1).max(64),
});
export type WorldEntity = z.infer<typeof WorldEntity>;
export const WorldObservation = z
  .strictObject({
    id: Id,
    tenantId: Id,
    entityId: Id,
    taskId: Id,
    evidenceId: Id,
    source: z.literal("kerneljson:verified-outcome/v1"),
    value: MemoryItem.shape.content,
    observedAt: Timestamp,
    validFrom: Timestamp,
    validUntil: Timestamp.nullable(),
    confidence: z.literal(1),
  })
  .refine(
    (o) => !o.validUntil || Date.parse(o.validUntil) > Date.parse(o.validFrom),
    "Invalid observation interval",
  );
export type WorldObservation = z.infer<typeof WorldObservation>;
export const WorldRelationship = z
  .strictObject({
    id: Id,
    tenantId: Id,
    sourceId: Id,
    targetId: Id,
    type: z.literal("SHARES_VERIFIED_RESULT"),
    taskId: Id,
    evidenceId: Id,
  })
  .refine((r) => r.sourceId !== r.targetId, "Self relationship rejected");
export type WorldRelationship = z.infer<typeof WorldRelationship>;
