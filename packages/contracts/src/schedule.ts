import { z } from "zod";
import { Id } from "./common.js";
import { Task } from "./task.js";
import { IntentEnvelope } from "./intent.js";
import { KernelSubmission } from "./plan.js";
export const ScheduleSubmission = z.strictObject({
  intent: IntentEnvelope,
  iterations: z.number().int().min(1).max(10),
  intervalMs: z.number().int().min(1000).max(86400000),
  budgetUnits: z.number().int().min(1).max(10),
});
export type ScheduleSubmission = z.infer<typeof ScheduleSubmission>;
export const ScheduleConfig = z
  .strictObject({
    enabled: z.boolean().default(false),
    version: z.string().min(1),
    maxIterations: z.number().int().min(1).max(10),
    maxBudgetUnits: z.number().int().min(1).max(10),
    minIntervalMs: z.number().int().min(1000),
    maxIntervalMs: z.number().int().min(1000).max(86400000),
  })
  .refine((c) => c.maxIntervalMs >= c.minIntervalMs, "Invalid schedule limits");
export type ScheduleConfig = z.infer<typeof ScheduleConfig>;
export const SchedulePlan = z
  .strictObject({
    version: z.literal(1),
    configVersion: z.string().min(1),
    task: Task,
    intervalMs: z.number().int().min(1000).max(86400000),
    budgetUnits: z.number().int().min(1).max(10),
    children: z.array(KernelSubmission).min(1).max(10),
  })
  .refine(
    (p) =>
      p.children.length <= p.budgetUnits &&
      new Set(p.children.map((c) => c.intent.id)).size === p.children.length,
    "Invalid schedule budget or child identities",
  );
export type SchedulePlan = z.infer<typeof SchedulePlan>;
export const ScheduledChildInput = z.strictObject({
  parentTaskId: Id,
  submission: KernelSubmission,
});
