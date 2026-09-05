import { KernelSubmission } from "../../packages/contracts/src/index.js";
import { id, at, principal } from "./contracts.js";
export const kernelSubmission = KernelSubmission.parse({
  recipe: "uppercase-reverse/v1",
  intent: {
    id,
    principal,
    tenant: { id },
    source: "local-test",
    objective: "kerneljson",
    attachments: [],
    contextRefs: [],
    receivedAt: at,
    trace: { traceId: id, correlationId: id },
  },
});
