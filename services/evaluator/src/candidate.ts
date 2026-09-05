import {
  createBuiltinRegistry,
  UPPERCASE,
} from "../../../packages/capabilities/src/index.js";
import type { EvaluationCandidate } from "./index.js";
export function uppercaseCandidate(digest: string): EvaluationCandidate {
  const registry = createBuiltinRegistry(),
    id = "12000000-0000-4000-8000-000000000001";
  return {
    digest,
    execute: (input) =>
      registry.execute({
        runId: id,
        taskId: id,
        stepId: id,
        trace: { traceId: id, correlationId: id },
        capability: UPPERCASE,
        idempotencyKey: "golden-evaluation",
        input,
      }).output,
  };
}
