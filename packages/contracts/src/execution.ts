import { z } from "zod";
import { Id, Timestamp } from "./common.js";
import { PrincipalRef } from "./identity.js";
export const ControlAction = z.enum(["cancel", "signal", "approve"]);
export type ControlAction = z.infer<typeof ControlAction>;
export const ExecutionTarget = z.strictObject({
 service: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,99}$/),
 version: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
 routingId: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
 controls: z.array(ControlAction).max(3).refine(a=>new Set(a).size===a.length),
});
export type ExecutionTarget = z.infer<typeof ExecutionTarget>;
export const ExecutionBinding = ExecutionTarget.extend({
 taskId: Id, tenantId: Id, principal: PrincipalRef,
 releaseId: z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/),
 executionKey: Id, boundAt: Timestamp,
 definitionDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).refine(b=>b.executionKey===b.taskId,"Workflow key must equal task identity");
export type ExecutionBinding = z.infer<typeof ExecutionBinding>;
export const ControlResult = z.strictObject({
 taskId: Id, action: ControlAction,
 status: z.enum(["REQUESTED","ACCEPTED","COMPLETED","FAILED","UNSUPPORTED","UNRESOLVED"]),
});
export type ControlResult = z.infer<typeof ControlResult>;
export const EffectDisposition = z.enum(["NOT_STARTED","CONFIRMED","UNRESOLVED"]);
