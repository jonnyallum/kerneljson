import { CapabilityInvocation } from "../../packages/contracts/src/index.js";
import { UPPERCASE } from "../../packages/capabilities/src/index.js";
export const capabilityInvocation = CapabilityInvocation.parse({
  runId: "60000000-0000-4000-8000-000000000010",
  taskId: "60000000-0000-4000-8000-000000000011",
  stepId: "60000000-0000-4000-8000-000000000012",
  trace: {
    traceId: "60000000-0000-4000-8000-000000000013",
    correlationId: "60000000-0000-4000-8000-000000000014",
  },
  capability: UPPERCASE,
  idempotencyKey: "test-uppercase-1",
  input: { text: " KernelJSON " },
});
