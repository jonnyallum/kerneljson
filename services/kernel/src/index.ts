import { pathToFileURL } from "node:url";
import * as restate from "@restatedev/restate-sdk";
import pg from "pg";
import { Ledger } from "./ledger.js";
import { createTaskWorkflow } from "./workflow.js";
import { createKernelWorkflow } from "./executor/workflow.js";
import { createCapabilityService } from "./capability-service.js";
import { loadCanaryConfig } from "./scheduler/canary-config.js";

const connectionString = process.env["DATABASE_URL"];
if (!connectionString)
  throw new Error(
    "Inject DATABASE_URL at runtime from jVault project kerneljson",
  );
const pool = new pg.Pool({ connectionString });

// Canary executor is enabled only when a repository root is configured. Then the
// approved digest + recipe are loaded from the environment (fail-closed) and the
// sealed-local CapabilityServiceV1 is registered. Without KJ_REPO_ROOT the worker
// serves only the deterministic recipes, exactly as before.
const repositoryRoot = process.env["KJ_REPO_ROOT"];
const canaryConfig = repositoryRoot ? loadCanaryConfig(process.env) : undefined;
const canary = canaryConfig
  ? {
      recipe: canaryConfig.recipe,
      approvedContentSha256: canaryConfig.approvedContentSha256,
    }
  : undefined;
const capabilityService = repositoryRoot
  ? createCapabilityService({ repositoryRoot })
  : undefined;

const ledger = new Ledger(pool, undefined, undefined, undefined, canary);

export const services = [
  createTaskWorkflow(ledger),
  createKernelWorkflow(
    ledger,
    canary && capabilityService ? { canary, capabilityService } : undefined,
  ),
  ...(capabilityService ? [capabilityService] : []),
];

// Serve only when invoked directly (not when imported by the registration test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  restate.serve({ services, port: Number(process.env["PORT"] ?? 9080) });
