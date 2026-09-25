import { createIdentityChangeWorkflow } from "../../services/kernel/src/identity-workflow.js";
import { IDENTITY_APPLY_A, IDENTITY_APPLY_ROLLBACK } from "../../packages/capabilities/src/index.js";
import type { Ledger } from "../../services/kernel/src/ledger.js";
import { PgControlReplayStore, createControlVerifier } from "../../services/kernel/src/control-signing.js";
import { CONTROL_TEST_KEY, CONTROL_TEST_KEY_ID } from "./control-test-key.js";
import { policyOwner, policyReviewer } from "./golden-probe.js";

/** KJ-P7A - the IdentityChangeWorkflowV1 probe, mirroring golden-probe.ts exactly: the same test
 *  principals, the same synthetic + signed authenticator, the same shape of policy rules - just for
 *  IDENTITY_APPLY_A/IDENTITY_APPLY_ROLLBACK instead of UPPERCASE. */
export function createIdentityProbe(ledger: Ledger) {
  const replay = new PgControlReplayStore(ledger.pool);
  const signedFor = (principalId: string) =>
    createControlVerifier({
      keys: new Map([[CONTROL_TEST_KEY_ID, CONTROL_TEST_KEY]]),
      tenantId: policyOwner,
      principalId,
      freshnessSeconds: 300,
      replay,
    });
  const asReviewer = signedFor(policyReviewer);
  const asOwner = signedFor(policyOwner);
  const rule = (capability: { id: string; version: string }) => ({
    tenantId: policyOwner,
    principalId: policyOwner,
    capability,
    effect: "APPROVAL_REQUIRED" as const,
    approver: { id: policyReviewer, kind: "HUMAN" as const },
    ttlMs: 30_000,
  });
  return createIdentityChangeWorkflow(
    ledger,
    { version: "test-identity-policy/1", rules: [rule(IDENTITY_APPLY_A), rule(IDENTITY_APPLY_ROLLBACK)] },
    async (headers, request) => {
      if (headers.has("x-kj-control-signature")) {
        try {
          return await asReviewer(headers, request);
        } catch (first) {
          if (first instanceof Error && first.name === "AuthenticatorUnavailableError") throw first;
          return asOwner(headers, request);
        }
      }
      const token = headers.get("authorization");
      if (token === "Bearer test-owner") return { id: policyOwner, kind: "HUMAN" as const };
      if (token === "Bearer test-reviewer") return { id: policyReviewer, kind: "HUMAN" as const };
      throw new Error("Invalid test identity");
    },
  );
}
