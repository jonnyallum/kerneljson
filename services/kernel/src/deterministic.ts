import { createHash } from "node:crypto";
import { z } from "zod";
import { Task, Evidence, Text } from "../../../packages/contracts/src/index.js";
export const CRITERION = "Output equals reverse(uppercase(trim(objective)))";
export const SubmitTask = Task.refine(
  (t) =>
    t.status === "RECEIVED" &&
    t.riskClass === "LOW" &&
    t.acceptanceCriteria.length === 1 &&
    t.acceptanceCriteria[0] === CRITERION &&
    t.constraints.length === 0 &&
    !t.budget &&
    !t.deadline &&
    !t.startedAt &&
    !t.completedAt,
  "This slice accepts only the fixed deterministic recipe with no additional constraints",
);
export const Signal = z.strictObject({
  action: z.enum(["RESUME", "CANCEL"]),
  reason: Text.optional(),
});
export type Signal = z.infer<typeof Signal>;
export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function stepA(input: string): string {
  return input.trim().toUpperCase();
}
export function stepB(input: string): string {
  return Array.from(input).reverse().join("");
}
export function verifyEvidence(
  evidence: Evidence,
  task: Task,
  stepId: string,
): boolean {
  const data = {
    input: task.objective,
    output: stepB(stepA(task.objective)),
    recipe: "uppercase-reverse/v1",
  };
  return (
    evidence.taskId === task.id &&
    evidence.stepId === stepId &&
    evidence.type === "DETERMINISTIC_RESULT" &&
    evidence.source === "kerneljson:uppercase-reverse/v1" &&
    evidence.digest === digest(data) &&
    Object.keys(evidence.metadata).length === 3 &&
    evidence.metadata["input"] === data.input &&
    evidence.metadata["output"] === data.output &&
    evidence.metadata["recipe"] === data.recipe
  );
}
