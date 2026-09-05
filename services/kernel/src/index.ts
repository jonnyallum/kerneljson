import * as restate from "@restatedev/restate-sdk";
import pg from "pg";
import { Ledger } from "./ledger.js";
import { createTaskWorkflow } from "./workflow.js";
import { createKernelWorkflow } from "./executor/workflow.js";
const connectionString = process.env["DATABASE_URL"];
if (!connectionString)
  throw new Error(
    "Inject DATABASE_URL at runtime from jVault project kerneljson",
  );
const pool = new pg.Pool({ connectionString });
restate.serve({
  services: [
    createTaskWorkflow(new Ledger(pool)),
    createKernelWorkflow(new Ledger(pool)),
  ],
  port: Number(process.env["PORT"] ?? 9080),
});
