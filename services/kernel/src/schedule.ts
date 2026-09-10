import {
  ScheduleSubmission,
  ScheduleConfig,
  SchedulePlan,
  Task,
  type PrincipalRef,
} from "../../../packages/contracts/src/index.js";
import { stableId } from "./compiler/index.js";
export const scheduleCriterion = (count: number) =>
  `All ${count} scheduled tasks have verified outcomes`;
export function compileSchedule(
  raw: unknown,
  rawConfig: ScheduleConfig,
  actor: PrincipalRef,
): SchedulePlan {
  const input = ScheduleSubmission.parse(raw),
    config = ScheduleConfig.parse(rawConfig),
    intent = input.intent;
  if (
    !config.enabled ||
    actor.kind !== "HUMAN" ||
    intent.principal.kind !== actor.kind ||
    intent.principal.id !== actor.id ||
    intent.attachments.length ||
    intent.contextRefs.length ||
    input.iterations > config.maxIterations ||
    input.iterations > input.budgetUnits ||
    input.budgetUnits > config.maxBudgetUnits ||
    input.intervalMs < config.minIntervalMs ||
    input.intervalMs > config.maxIntervalMs
  )
    throw new Error("Schedule is not authorized within configured limits");
  const id = stableId(["bounded-schedule/v1", intent.tenant.id, intent.id]);
  const task = Task.parse({
    id,
    principal: actor,
    tenant: intent.tenant,
    objective: `Run approved uppercase schedule: ${intent.objective}`,
    acceptanceCriteria: [scheduleCriterion(input.iterations)],
    constraints: [],
    riskClass: "LOW",
    status: "RECEIVED",
    traceId: intent.trace.traceId,
    createdAt: intent.receivedAt,
  });
  const children = Array.from({ length: input.iterations }, (_, index) => ({
    recipe: "uppercase/v1" as const,
    intent: {
      ...intent,
      id: stableId(["scheduled-intent/v1", id, index]),
      source: "kerneljson:bounded-schedule/v1",
    },
  }));
  return SchedulePlan.parse({
    version: 1,
    configVersion: config.version,
    task,
    intervalMs: input.intervalMs,
    budgetUnits: input.budgetUnits,
    children,
  });
}
