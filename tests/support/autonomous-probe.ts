import { existsSync, unlinkSync } from "node:fs";
import { createAutonomousWorkflow } from "../../services/kernel/src/autonomous-workflow.js";
import { createGoldenWorkflow } from "../../services/kernel/src/golden-workflow.js";
import { UPPERCASE } from "../../packages/capabilities/src/index.js";
import type { Ledger } from "../../services/kernel/src/ledger.js";
import type { Authenticator } from "../../services/kernel/src/policy-workflow.js";
const owner = "10000000-0000-4000-8000-000000000001";
export function createAutonomousProbes(ledger: Ledger) {
  const authenticate: Authenticator = async (headers) => {
    if (headers.get("authorization") !== "Bearer test-owner")
      throw new Error("Invalid test actor");
    return { id: owner, kind: "HUMAN" };
  };
  const child = createGoldenWorkflow(
    ledger,
    {
      version: "autonomous-test/1",
      rules: [
        {
          tenantId: owner,
          principalId: owner,
          capability: UPPERCASE,
          effect: "ALLOW",
        },
      ],
    },
    authenticate,
    undefined,
    "SCHEDULED_CHILD",
  );
  const schedule = createAutonomousWorkflow(ledger, {
    config: {
      enabled: true,
      version: "test-schedule/1",
      maxIterations: 3,
      maxBudgetUnits: 3,
      minIntervalMs: 1000,
      maxIntervalMs: 30000,
    },
    authenticate,
    authorizedNow: async () => !existsSync("/tmp/kerneljson-revoke-schedule"),
    childHeaders: () => ({ authorization: "Bearer test-owner" }),
    afterOutcomeCommit: async () => {
      if (existsSync("/tmp/kerneljson-schedule-crash-once")) {
        unlinkSync("/tmp/kerneljson-schedule-crash-once");
        process.exit(137);
      }
    },
  });
  return [child, schedule];
}
