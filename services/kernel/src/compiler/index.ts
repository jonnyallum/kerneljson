import {
  KernelSubmission,
  Task,
  type RecipeId,
} from "../../../../packages/contracts/src/index.js";
import { digest, CRITERION } from "../deterministic.js";
export const criteria: Record<RecipeId, string> = {
  "uppercase-reverse/v1": CRITERION,
  "uppercase/v1": "Output equals uppercase(trim(objective))",
  "repository-read/v1":
    "repository.read returns content_sha256 (64 hex) with mutations_detected=0",
};
// A content-derived UUID in a kernel-specific namespace. Pure across processes.
export function stableId(value: unknown): string {
  const h = digest(["kerneljson:phase4:v1", value]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function compileIntent(raw: unknown): {
  task: Task;
  submission: KernelSubmission;
} {
  const submission = KernelSubmission.parse(raw);
  const { intent, recipe } = submission;
  if (intent.attachments.length || intent.contextRefs.length)
    throw new Error(
      "Attachments and context references are not supported by these recipes",
    );
  const task = Task.parse({
    id: stableId({ tenant: intent.tenant.id, intentId: intent.id, recipe }),
    principal: intent.principal,
    tenant: intent.tenant,
    objective: intent.objective,
    acceptanceCriteria: [criteria[recipe]],
    constraints: [],
    riskClass: "LOW",
    status: "RECEIVED",
    traceId: intent.trace.traceId,
    createdAt: intent.receivedAt,
  });
  return { task, submission };
}
