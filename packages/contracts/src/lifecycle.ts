import { Outcome } from "./outcome.js";
import type { Task, TaskStatus } from "./task.js";
import type { Evidence } from "./evidence.js";
const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  RECEIVED: ["COMPILED", "FAILED", "CANCELLED"],
  COMPILED: ["READY", "APPROVAL_REQUIRED", "FAILED", "CANCELLED"],
  READY: ["RUNNING", "CANCELLED", "FAILED"],
  RUNNING: ["WAITING", "APPROVAL_REQUIRED", "VERIFYING", "FAILED", "CANCELLED"],
  WAITING: ["RUNNING", "FAILED", "CANCELLED"],
  APPROVAL_REQUIRED: ["READY", "RUNNING", "FAILED", "CANCELLED"],
  VERIFYING: ["COMPLETED", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};
export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!transitions[from].includes(to))
    throw new Error(`Invalid task transition: ${from} -> ${to}`);
}
// Verifier supplies only evidence whose contents it has independently checked.
export function assertCompletion(
  task: Task,
  outcome: Outcome,
  verified: readonly Evidence[],
): void {
  Outcome.parse(outcome);
  assertTransition(task.status, "COMPLETED");
  if (outcome.taskId !== task.id || outcome.status !== "COMPLETED")
    throw new Error("Outcome does not complete this task");
  if (
    task.acceptanceCriteria.length !== outcome.acceptanceResults.length ||
    task.acceptanceCriteria.some(
      (c) =>
        outcome.acceptanceResults.filter((r) => r.criterion === c && r.passed)
          .length !== 1,
    )
  )
    throw new Error("Acceptance criteria mismatch");
  if (
    outcome.evidenceRefs.some(
      (id) => !verified.some((e) => e.id === id && e.taskId === task.id),
    )
  )
    throw new Error("Evidence not verified for this task");
}
