import { createGoldenProbe } from "./golden-probe.js";
import { createIdentityProbe } from "./identity-probe.js";
import { createCognitionProbe } from "./cognition-probe.js";
// Integration-only fault injection: crash after DB commit, before ctx.run acknowledgement.
import * as restate from "@restatedev/restate-sdk";
import pg from "pg";
import { existsSync, unlinkSync } from "node:fs";
import { Ledger } from "../../services/kernel/src/ledger.js";
import { createTaskWorkflow } from "../../services/kernel/src/workflow.js";
import { createKernelWorkflow } from "../../services/kernel/src/executor/workflow.js";
import { createModelProbe } from "./model-probe.js";
import { createCapabilityProbe } from "./capability-probe.js";
import { createPolicyProbe } from "./policy-probe.js";
// KJ-P8 B1: every stage-T worker mode records runtime statements and refusals.
if (["discover", "enforce"].includes(process.env["KJ_RUNTIME_ROLES"] ?? "")) await import("./runtime-roles.js");
const ledger = new Ledger(
  new pg.Pool({ connectionString: process.env["DATABASE_URL"] }),
  async (key, taskId) => {
    if (key.startsWith("model:") && key.endsWith(":called") && existsSync("/tmp/kerneljson-cognition-receipt-crash")) {
      unlinkSync("/tmp/kerneljson-cognition-receipt-crash");
      process.exit(137);
    }
    if(key==='verify' && existsSync('/tmp/kerneljson-corrupt-step-once')) {
      unlinkSync('/tmp/kerneljson-corrupt-step-once');
      // Deliberate corruption is test sabotage, not a worker capability: it uses the owner, never kj_worker.
      const db=new pg.Pool({connectionString:process.env['KJ_TEST_OWNER_DATABASE_URL']});
      try { await db.query("update task_steps set contract=jsonb_set(contract,'{output}','\"forged\"') where task_id=$1 and contract->>'kind'='DETERMINISTIC_FUNCTION'",[taskId]); } finally { await db.end(); }
    }
    if(key==='complete:verification-failed' && existsSync('/tmp/kerneljson-failed-crash-once')) {
      unlinkSync('/tmp/kerneljson-failed-crash-once');process.exit(137);
    }
    if (
      (key === "b-complete" ||
        (key.startsWith("step:") && key.endsWith(":complete"))) &&
      existsSync("/tmp/kerneljson-crash-once")
    ) {
      unlinkSync("/tmp/kerneljson-crash-once");
      // PID 1 in a container may ignore a self-sent SIGKILL. Exit immediately,
      // without returning to ctx.run or running graceful shutdown handlers.
      process.exit(137);
    }
  },
);
const cognitionProbe = createCognitionProbe(ledger);
restate.serve({
  services: [
    createTaskWorkflow(ledger),
    createKernelWorkflow(ledger, cognitionProbe.options),
    cognitionProbe.service,
    createModelProbe(ledger),
    createCapabilityProbe(ledger),
    createPolicyProbe(ledger),
    createGoldenProbe(ledger),
    createIdentityProbe(ledger),
    createRoutingProbe(ledger),
    ...createAutonomousProbes(ledger),
  ],
  port: 9080,
});
import { createRoutingProbe } from "./routing-probe.js";
import { createAutonomousProbes } from "./autonomous-probe.js";
