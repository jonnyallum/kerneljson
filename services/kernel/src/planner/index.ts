import {
  ExecutionPlan,
  Task,
  TaskStep,
  RecipeId,
  type PlanStep,
} from "../../../../packages/contracts/src/index.js";
import { stableId, criteria } from "../compiler/index.js";
export function planTask(raw: Task, recipe: RecipeId): ExecutionPlan {
  recipe = RecipeId.parse(recipe);
  const task = Task.parse(raw);
  if (
    task.riskClass !== "LOW" ||
    task.constraints.length ||
    task.budget ||
    task.deadline ||
    task.acceptanceCriteria.length !== 1 ||
    task.acceptanceCriteria[0] !== criteria[recipe]
  )
    throw new Error("Task requirements do not match recipe");
  const operations: PlanStep["operation"][] =
    recipe === "uppercase-reverse/v1"
      ? ["UPPERCASE", "WAIT_FOR_EVENT", "REVERSE"]
      : ["UPPERCASE"];
  const steps: PlanStep[] = operations.map((operation, index) => ({
    id: stableId([task.id, recipe, index]),
    taskId: task.id,
    operation,
    dependencies: index === 0 ? [] : [stableId([task.id, recipe, index - 1])],
    input:
      index === 0
        ? { source: "TASK_OBJECTIVE" }
        : {
            source: "STEP_OUTPUT",
            stepId: stableId([task.id, recipe, index - 1]),
          },
  }));
  return ExecutionPlan.parse({
    version: 1,
    taskId: task.id,
    recipe,
    steps,
    resultStepId: steps.at(-1)!.id,
  });
}
export function orderedSteps(raw: ExecutionPlan): PlanStep[] {
  const plan = ExecutionPlan.parse(raw),
    done = new Set<string>(),
    result: PlanStep[] = [];
  while (result.length < plan.steps.length) {
    const next = plan.steps
      .filter(
        (s) => !done.has(s.id) && s.dependencies.every((id) => done.has(id)),
      )
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]!;
    result.push(next);
    done.add(next.id);
  }
  return result;
}
export function projectStep(step: PlanStep): TaskStep {
  return TaskStep.parse({
    id: step.id,
    taskId: step.taskId,
    kind:
      step.operation === "WAIT_FOR_EVENT"
        ? "WAIT_FOR_EVENT"
        : "DETERMINISTIC_FUNCTION",
    status: "READY",
    dependencies: step.dependencies,
    requiredCapabilities: [],
    riskClass: "LOW",
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    input: step.input,
    idempotencyKey: `${step.taskId}:${step.id}`,
  });
}
