import {
  ExecutionPlan,
  TaskStep,
  Evidence,
  assertCompletion,
  type Task,
  type Outcome,
  type PlanStep,
} from "../../../../packages/contracts/src/index.js";
import { planTask, orderedSteps, projectStep } from "../planner/index.js";
import { digest } from "../deterministic.js";
export function resolveInput(
  step: PlanStep,
  task: Task,
  outputs: ReadonlyMap<string, string>,
): string {
  if (step.taskId !== task.id) throw new Error("Step/task mismatch");
  if (step.input.source === "TASK_OBJECTIVE") return task.objective;
  if (
    !step.dependencies.includes(step.input.stepId) ||
    !outputs.has(step.input.stepId)
  )
    throw new Error("Dependency output is not available");
  return outputs.get(step.input.stepId)!;
}
export function executeFunction(
  operation: PlanStep["operation"],
  input: string,
): string {
  switch (operation) {
    case "UPPERCASE":
      return input.trim().toUpperCase();
    case "REVERSE":
      return Array.from(input).reverse().join("");
    default:
      throw new Error("Operation requires durable workflow handling");
  }
}
export interface StoredResult {
  step: unknown;
  record: unknown;
}
export function verifyPlanCompletion(
  task: Task,
  outcome: Outcome,
  rawPlan: unknown,
  storedSteps: readonly unknown[],
  records: readonly StoredResult[],
): void {
  const plan = ExecutionPlan.parse(rawPlan),
    expected = planTask(task, plan.recipe);
  if (digest(plan) !== digest(expected))
    throw new Error("Stored plan does not match the versioned recipe");
  const steps = storedSteps.map((s) => TaskStep.parse(s));
  if (steps.length !== plan.steps.length)
    throw new Error("Missing or extra persisted steps");
  const outputs = new Map<string, string>();
  for (const node of orderedSteps(plan)) {
    const input = resolveInput(node, task, outputs);
    // Independent expected-result calculation, not a claim from the execution output.
    const output =
      node.operation === "UPPERCASE"
        ? input.trim().toUpperCase()
        : node.operation === "REVERSE"
          ? [...input].reverse().join("")
          : input;
    const step = steps.find((s) => s.id === node.id);
    const base = projectStep(node);
    if (
      !step ||
      digest(step) !==
        digest(TaskStep.parse({ ...base, status: "COMPLETED", input, output }))
    )
      throw new Error("Persisted step does not match verified execution");
    outputs.set(node.id, output);
  }
  const metadata = {
    planDigest: digest(plan),
    input: task.objective,
    output: outputs.get(plan.resultStepId)!,
  };
  const verified = records.flatMap((r) => {
    const e = Evidence.parse(r.record);
    return e.taskId === task.id &&
      e.stepId === plan.resultStepId &&
      e.type === "DETERMINISTIC_RESULT" &&
      e.source === "kerneljson:plan/v1" &&
      e.digest === digest(metadata) &&
      Object.keys(e.metadata).length === 3 &&
      e.metadata["planDigest"] === metadata.planDigest &&
      e.metadata["input"] === metadata.input &&
      e.metadata["output"] === metadata.output
      ? [e]
      : [];
  });
  if (outcome.summary !== metadata.output)
    throw new Error("Outcome does not match verified result");
  assertCompletion(task, outcome, verified);
}
