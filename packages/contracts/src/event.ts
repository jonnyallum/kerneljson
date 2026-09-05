import { z } from "zod";
import { Id, Json, Timestamp } from "./common.js";
import { PrincipalRef } from "./identity.js";
export const TaskEventType = z.enum([
  "TASK_CREATED",
  "INTENT_RESOLVED",
  "PLAN_COMPILED",
  "POLICY_CHECKED",
  "STEP_STARTED",
  "MODEL_CALLED",
  "TOOL_CALLED",
  "EVIDENCE_RECEIVED",
  "STEP_COMPLETED",
  "APPROVAL_REQUESTED",
  "APPROVAL_GRANTED",
  "VERIFICATION_FAILED",
  "REPLAN_TRIGGERED",
  "TASK_COMPLETED",
  "TASK_FAILED",
  "LEARNING_PROPOSED",
  "TASK_READY",
  "TASK_STARTED",
  "TASK_WAITING",
  "TASK_RESUMED",
  "TASK_VERIFYING",
  "TASK_CANCELLED",
]);
function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
export const TaskEvent = z
  .strictObject({
    id: Id,
    taskId: Id,
    stepId: Id.optional(),
    type: TaskEventType,
    occurredAt: Timestamp,
    actor: PrincipalRef,
    traceId: Id,
    payload: Json,
  })
  .transform(freezeJson)
  .readonly();
export type TaskEvent = z.infer<typeof TaskEvent>;
