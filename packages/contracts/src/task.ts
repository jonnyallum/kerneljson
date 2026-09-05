import { z } from "zod";
import {
  CapabilityRef,
  Id,
  Json,
  RiskClass,
  Text,
  Timestamp,
} from "./common.js";
import { PrincipalRef, TenantRef } from "./identity.js";
export const TaskStatus = z.enum([
  "RECEIVED",
  "COMPILED",
  "READY",
  "RUNNING",
  "WAITING",
  "APPROVAL_REQUIRED",
  "VERIFYING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;
export const Task = z
  .strictObject({
    id: Id,
    parentTaskId: Id.optional(),
    principal: PrincipalRef,
    tenant: TenantRef,
    objective: Text,
    acceptanceCriteria: z.array(Text).min(1),
    constraints: z.array(Text),
    riskClass: RiskClass,
    budget: z
      .strictObject({
        amount: z.number().nonnegative(),
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .optional(),
    deadline: Timestamp.optional(),
    status: TaskStatus,
    traceId: Id,
    createdAt: Timestamp,
    startedAt: Timestamp.optional(),
    completedAt: Timestamp.optional(),
  })
  .superRefine((t, ctx) => {
    if (t.parentTaskId === t.id)
      ctx.addIssue({ code: "custom", message: "Task cannot parent itself" });
    if (t.status === "COMPLETED" && !t.completedAt)
      ctx.addIssue({
        code: "custom",
        message: "Completion timestamp required",
      });
    if (t.startedAt && Date.parse(t.startedAt) < Date.parse(t.createdAt))
      ctx.addIssue({ code: "custom", message: "Start precedes creation" });
    if (
      t.completedAt &&
      Date.parse(t.completedAt) < Date.parse(t.startedAt ?? t.createdAt)
    )
      ctx.addIssue({ code: "custom", message: "Completion precedes start" });
  });
export type Task = z.infer<typeof Task>;
export const StepKind = z.enum([
  "DETERMINISTIC_FUNCTION",
  "TOOL_CALL",
  "LLM_CALL",
  "AGENT_LOOP",
  "PARALLEL_MAP",
  "SANDBOX_EXEC",
  "HUMAN_APPROVAL",
  "WAIT_FOR_EVENT",
  "SCHEDULE",
  "SUBWORKFLOW",
]);
export const TaskStep = z
  .strictObject({
    id: Id,
    taskId: Id,
    kind: StepKind,
    status: TaskStatus,
    dependencies: z.array(Id),
    requiredCapabilities: z.array(CapabilityRef),
    riskClass: RiskClass,
    retryPolicy: z.strictObject({
      maxAttempts: z.number().int().positive(),
      backoffMs: z.number().int().nonnegative(),
    }),
    timeout: z.number().int().positive().optional(),
    input: Json,
    output: Json.optional(),
    idempotencyKey: Text.optional(),
  })
  .refine(
    (s) => !s.dependencies.includes(s.id),
    "Step cannot depend on itself",
  );
export type TaskStep = z.infer<typeof TaskStep>;
