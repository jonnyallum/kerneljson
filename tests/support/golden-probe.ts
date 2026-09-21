import { existsSync, unlinkSync } from "node:fs";
import { createGoldenWorkflow } from "../../services/kernel/src/golden-workflow.js";
import { UPPERCASE } from "../../packages/capabilities/src/index.js";
import type { Ledger } from "../../services/kernel/src/ledger.js";
import { PgControlReplayStore, createControlVerifier } from "../../services/kernel/src/control-signing.js";
import { CONTROL_TEST_KEY, CONTROL_TEST_KEY_ID } from "./control-test-key.js";
export const policyOwner = "10000000-0000-4000-8000-000000000001";
export const policyReviewer = "70000000-0000-4000-8000-000000000002";
export function createGoldenProbe(ledger: Ledger) {
  // KJ-P4B.1: the production verifier, with the production Postgres replay store and a synthetic key, for
  // the two principals the probe knows. Signed assertions are tried first; the legacy test bearers below
  // remain so the earlier approval tests keep working unchanged.
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
  return createGoldenWorkflow(
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
    async (headers, request) => {
      if (headers.has("x-kj-control-signature")) {
        // The assertion names its principal inside the signature: whichever configured principal it
        // verifies for is the identity. Neither verifying means it is refused.
        try {
          return await asReviewer(headers, request);
        } catch (first) {
          if (first instanceof Error && first.name === "AuthenticatorUnavailableError") throw first;
          return asOwner(headers, request);
        }
      }
      // Deliberately synthetic identities on the private test-only endpoint.
      const token = headers.get("authorization");
      if (token === "Bearer test-owner")
        return { id: policyOwner, kind: "HUMAN" };
      if (token === "Bearer test-reviewer")
        return { id: policyReviewer, kind: "HUMAN" };
      throw new Error("Invalid test identity");
    },
    async () => {
      if (existsSync("/tmp/kerneljson-outcome-crash-once")) {
        unlinkSync("/tmp/kerneljson-outcome-crash-once");
        process.exit(137);
      }
    },
  );
}
