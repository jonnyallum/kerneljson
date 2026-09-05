import { z } from "zod";
import { Id } from "./common.js";
import { IntentEnvelope } from "./intent.js";
export const RecipeId = z.enum(["uppercase-reverse/v1", "uppercase/v1"]);
export type RecipeId = z.infer<typeof RecipeId>;
export const KernelSubmission = z.strictObject({
  intent: IntentEnvelope,
  recipe: RecipeId,
});
export type KernelSubmission = z.infer<typeof KernelSubmission>;
export const PlanStep = z.strictObject({
  id: Id,
  taskId: Id,
  operation: z.enum(["UPPERCASE", "REVERSE", "WAIT_FOR_EVENT"]),
  dependencies: z.array(Id),
  input: z.discriminatedUnion("source", [
    z.strictObject({ source: z.literal("TASK_OBJECTIVE") }),
    z.strictObject({ source: z.literal("STEP_OUTPUT"), stepId: Id }),
  ]),
});
export type PlanStep = z.infer<typeof PlanStep>;
export const ExecutionPlan = z
  .strictObject({
    version: z.literal(1),
    taskId: Id,
    recipe: RecipeId,
    steps: z.array(PlanStep).min(1).max(32),
    resultStepId: Id,
  })
  .superRefine((plan, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    const ids = new Set(plan.steps.map((s) => s.id));
    if (ids.size !== plan.steps.length) fail("Duplicate step IDs");
    if (!ids.has(plan.resultStepId)) fail("Unknown result step");
    for (const step of plan.steps) {
      if (step.taskId !== plan.taskId) fail("Step belongs to another task");
      if (new Set(step.dependencies).size !== step.dependencies.length)
        fail("Duplicate dependencies");
      if (step.dependencies.some((id) => !ids.has(id) || id === step.id))
        fail("Invalid dependency");
      if (
        step.input.source === "STEP_OUTPUT" &&
        !step.dependencies.includes(step.input.stepId)
      )
        fail("Input must reference a direct dependency");
    }
    const resolved = new Set<string>();
    while (resolved.size < ids.size) {
      const ready = plan.steps.filter(
        (s) =>
          !resolved.has(s.id) && s.dependencies.every((id) => resolved.has(id)),
      );
      if (!ready.length) {
        fail("Graph contains a cycle or unresolved dependency");
        break;
      }
      ready.forEach((s) => resolved.add(s.id));
    }
    // Every step must contribute to the declared result; reject hidden/disconnected work.
    const ancestors = new Set<string>();
    const visit = (id: string): void => {
      if (ancestors.has(id)) return;
      ancestors.add(id);
      plan.steps.find((s) => s.id === id)?.dependencies.forEach(visit);
    };
    visit(plan.resultStepId);
    if (plan.steps.some((s) => !ancestors.has(s.id)))
      fail("Step does not contribute to result");
  });
export type ExecutionPlan = z.infer<typeof ExecutionPlan>;
