import { createPolicyWorkflow } from "../../services/kernel/src/policy-workflow.js";
import { UPPERCASE } from "../../packages/capabilities/src/index.js";
import type { Ledger } from "../../services/kernel/src/ledger.js";
export const policyOwner = "10000000-0000-4000-8000-000000000001";
export const policyReviewer = "70000000-0000-4000-8000-000000000002";
export function createPolicyProbe(ledger: Ledger) {
  return createPolicyWorkflow(
    ledger,
    {
      version: "test-policy/1",
      rules: [
        {
          tenantId: policyOwner,
          principalId: policyOwner,
          capability: UPPERCASE,
          effect: "APPROVAL_REQUIRED",
          approver: { id: policyReviewer, kind: "HUMAN" },
          ttlMs: 30_000,
        },
      ],
    },
    async (headers) => {
      // Deliberately synthetic identities on the private test-only endpoint.
      const token = headers.get("authorization");
      if (token === "Bearer test-owner")
        return { id: policyOwner, kind: "HUMAN" };
      if (token === "Bearer test-reviewer")
        return { id: policyReviewer, kind: "HUMAN" };
      throw new Error("Invalid test identity");
    },
  );
}
