import { pathToFileURL } from "node:url";
import pg from "pg";
import { runHumanProvision } from "../identity/provisioning-pg.js";
import { PgScheduleStore } from "../scheduler/pg-store.js";
import { PgIdentityGate, installDisabledCanary } from "../scheduler/canary-seed.js";
import {
  enableCanaryForProduction,
  disableCanary as runDisableCanary,
} from "../scheduler/canary-lifecycle.js";
import { fireOnce as runFireOnce } from "../scheduler/canary-fire.js";
import { HttpAdmissionGateway } from "../scheduler/http-admission.js";

/**
 * S1 canary — production execution runner (Gate 2).
 *
 * The SMALLEST possible wrapper around the reviewed TypeScript paths
 * (`runHumanProvision`, `installDisabledCanary`). It contains NO provisioning /
 * install business logic and NO raw SQL — it only parses explicit args, obtains
 * DATABASE_URL from the process environment, and delegates to the reviewed
 * functions. It never prints DATABASE_URL or any connection object, and fails
 * closed. Jonny runs it locally with the secret injected from jVault; the secret
 * never reaches Claude, chat, logs, evidence, or git.
 *
 * Explicit, separate operations (each fail-closed; no generated IDs; no hidden defaults):
 *   provision-human --principal-id <uuid> --tenant-id <uuid>
 *   install-canary  --schedule-id <uuid> --tenant-id <uuid> --owner-id <uuid> --created-at <iso>
 *   enable-canary   --schedule-id <uuid> --tenant-id <uuid> --actor-id <uuid>
 *                   --from-version <v> --to-version <v> --created-at <iso> --expected-state <state>
 *   disable-canary  --schedule-id <uuid> --actor-id <uuid> --at <iso> [--expected-active-version <v>]
 *   fire-once       --schedule-id <uuid> --tenant-id <uuid> --actor-id <uuid>
 *                   --expected-active-version <v> --last-tick <iso> --now <iso>
 *                   --owner <id> --production true [--preview true] [--lease-ttl-ms <n>]
 *
 * Gate 3 tooling (enable-canary / disable-canary / fire-once) is REPO-ONLY and production-
 * gated; fire-once execution additionally needs KJ_ADMISSION_URL + KJ_ADMISSION_BEARER
 * (jVault-injected) and a deployed admission door. `fire-once --preview true` is read-only.
 */

/** The canary's fixed schedule definition (disabled; state/enabled are forced by the seed). */
export const CANARY_SPEC = Object.freeze({
  version: "v1",
  name: "claude_md_check",
  timezone: "Europe/London",
  calendar: { kind: "dailyAt", hour: 9, minute: 0 } as const,
  missedRunPolicy: "SKIP" as const,
  overlapPolicy: "FORBID" as const,
  nonexistentTimePolicy: "SHIFT_FORWARD" as const,
  maxBackfillRuns: 0,
  perScheduleConcurrency: 1,
});

export class RunnerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RunnerError";
  }
}

export type Operation =
  | "provision-human"
  | "install-canary"
  | "enable-canary"
  | "disable-canary"
  | "fire-once";

export interface ParsedArgs {
  operation: Operation;
  values: Record<string, string>;
}

const REQUIRED: Record<Operation, string[]> = {
  "provision-human": ["principal-id", "tenant-id"],
  "install-canary": ["schedule-id", "tenant-id", "owner-id", "created-at"],
  "enable-canary": [
    "schedule-id",
    "tenant-id",
    "actor-id",
    "from-version",
    "to-version",
    "created-at",
    "expected-state",
  ],
  "disable-canary": ["schedule-id", "actor-id", "at"],
  "fire-once": [
    "schedule-id",
    "tenant-id",
    "actor-id",
    "expected-active-version",
    "last-tick",
    "now",
    "owner",
    "production",
  ],
};

/** Pure arg parser. Fails closed on missing/unknown operation or missing flags. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [op, ...rest] = argv;
  if (!op || !Object.prototype.hasOwnProperty.call(REQUIRED, op))
    throw new RunnerError(
      "OPERATION_REQUIRED",
      "first argument must be a known canary operation",
    );
  const operation = op as Operation;
  const values: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (!flag || !flag.startsWith("--") || value === undefined)
      throw new RunnerError("MALFORMED_ARGS", "flags must be --key value pairs");
    values[flag.slice(2)] = value;
  }
  for (const key of REQUIRED[operation])
    if (!values[key]) throw new RunnerError("MISSING_ARG", `--${key} is required`);
  return { operation, values };
}

/** Obtain DATABASE_URL from the environment only. Never returned to callers that print. */
export function resolveDatabaseUrl(env: Record<string, string | undefined>): string {
  const url = env["DATABASE_URL"];
  if (!url)
    throw new RunnerError(
      "DATABASE_URL_MISSING",
      "DATABASE_URL must be injected from jVault into the process environment",
    );
  return url;
}

/** Structured, NON-SECRET result formatting. Never includes DATABASE_URL or a pool. */
export function formatResult(operation: Operation, result: unknown): string {
  return JSON.stringify({ operation, ok: true, result }, null, 2);
}

/** Delegation seam (injectable for tests). NO business logic lives here. */
export interface RunnerDeps {
  provisionHuman(args: {
    pool: pg.Pool;
    principalId: string;
    tenantId: string;
  }): Promise<unknown>;
  installCanary(args: {
    pool: pg.Pool;
    scheduleId: string;
    tenantId: string;
    ownerId: string;
    createdAt: string;
  }): Promise<unknown>;
  enableCanary(args: {
    pool: pg.Pool;
    scheduleId: string;
    tenantId: string;
    actorPrincipalId: string;
    fromVersion: string;
    toVersion: string;
    createdAt: string;
    expectedState: string;
  }): Promise<unknown>;
  disableCanary(args: {
    pool: pg.Pool;
    scheduleId: string;
    actorPrincipalId: string;
    at: string;
    expectedActiveVersion?: string | undefined;
  }): Promise<unknown>;
  fireOnce(args: {
    pool: pg.Pool;
    scheduleId: string;
    tenantId: string;
    actorPrincipalId: string;
    expectedActiveVersion: string;
    lastTickMs: number;
    nowMs: number;
    owner: string;
    productionRuntime: boolean;
    preview: boolean;
    leaseTtlMs?: number | undefined;
  }): Promise<unknown>;
}

/** The canary recipe the scheduled admission requests. Fixed — this is a canary tool. */
const CANARY_RECIPE = "claude_md_check/v1";

/** Build the admission seam from the environment (jVault-injected). The bearer is read from
 *  the environment only and is NEVER an argument or printed. Preview mode never calls this. */
function buildAdmissionGatewayFromEnv(): HttpAdmissionGateway {
  const url = process.env["KJ_ADMISSION_URL"];
  const authorization = process.env["KJ_ADMISSION_BEARER"];
  if (!url || !authorization)
    throw new RunnerError(
      "ADMISSION_ENV_MISSING",
      "KJ_ADMISSION_URL and KJ_ADMISSION_BEARER must be injected from jVault for fire-once execution",
    );
  return new HttpAdmissionGateway(url, { authorization, recipe: CANARY_RECIPE });
}

/** Real delegation to the reviewed functions. */
export const realDeps: RunnerDeps = {
  provisionHuman: ({ pool, principalId, tenantId }) =>
    runHumanProvision({ pool, principalId, tenantId }),
  installCanary: ({ pool, scheduleId, tenantId, ownerId, createdAt }) =>
    installDisabledCanary(new PgScheduleStore(pool), new PgIdentityGate(pool), {
      scheduleId,
      version: CANARY_SPEC.version,
      tenantId,
      principalId: ownerId, // the acting principal for the canary is the HUMAN owner
      ownerId,
      createdBy: ownerId,
      name: CANARY_SPEC.name,
      timezone: CANARY_SPEC.timezone,
      calendar: CANARY_SPEC.calendar,
      missedRunPolicy: CANARY_SPEC.missedRunPolicy,
      overlapPolicy: CANARY_SPEC.overlapPolicy,
      nonexistentTimePolicy: CANARY_SPEC.nonexistentTimePolicy,
      maxBackfillRuns: CANARY_SPEC.maxBackfillRuns,
      perScheduleConcurrency: CANARY_SPEC.perScheduleConcurrency,
      createdAt,
    }),
  enableCanary: ({ pool, ...input }) =>
    enableCanaryForProduction(new PgScheduleStore(pool), new PgIdentityGate(pool), input),
  disableCanary: ({ pool, ...input }) =>
    runDisableCanary(new PgScheduleStore(pool), new PgIdentityGate(pool), input),
  fireOnce: ({ pool, ...input }) =>
    runFireOnce(
      new PgScheduleStore(pool),
      new PgIdentityGate(pool),
      input.preview ? null : buildAdmissionGatewayFromEnv(),
      input,
    ),
};

/** Dispatch to the selected reviewed operation. pg lives entirely in deps. */
export async function runCanaryOperation(
  deps: RunnerDeps,
  pool: pg.Pool,
  parsed: ParsedArgs,
): Promise<unknown> {
  if (parsed.operation === "provision-human")
    return deps.provisionHuman({
      pool,
      principalId: parsed.values["principal-id"]!,
      tenantId: parsed.values["tenant-id"]!,
    });
  if (parsed.operation === "install-canary")
    return deps.installCanary({
      pool,
      scheduleId: parsed.values["schedule-id"]!,
      tenantId: parsed.values["tenant-id"]!,
      ownerId: parsed.values["owner-id"]!,
      createdAt: parsed.values["created-at"]!,
    });
  if (parsed.operation === "enable-canary")
    return deps.enableCanary({
      pool,
      scheduleId: parsed.values["schedule-id"]!,
      tenantId: parsed.values["tenant-id"]!,
      actorPrincipalId: parsed.values["actor-id"]!,
      fromVersion: parsed.values["from-version"]!,
      toVersion: parsed.values["to-version"]!,
      createdAt: parsed.values["created-at"]!,
      expectedState: parsed.values["expected-state"]!,
    });
  if (parsed.operation === "disable-canary")
    return deps.disableCanary({
      pool,
      scheduleId: parsed.values["schedule-id"]!,
      actorPrincipalId: parsed.values["actor-id"]!,
      at: parsed.values["at"]!,
      expectedActiveVersion: parsed.values["expected-active-version"],
    });
  return deps.fireOnce({
    pool,
    scheduleId: parsed.values["schedule-id"]!,
    tenantId: parsed.values["tenant-id"]!,
    actorPrincipalId: parsed.values["actor-id"]!,
    expectedActiveVersion: parsed.values["expected-active-version"]!,
    lastTickMs: Date.parse(parsed.values["last-tick"]!),
    nowMs: Date.parse(parsed.values["now"]!),
    owner: parsed.values["owner"]!,
    productionRuntime: parsed.values["production"] === "true",
    preview: parsed.values["preview"] === "true",
    leaseTtlMs: parsed.values["lease-ttl-ms"]
      ? Number(parsed.values["lease-ttl-ms"])
      : undefined,
  });
}

async function main(argv: readonly string[]): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    process.stderr.write(
      JSON.stringify({ ok: false, error: e instanceof RunnerError ? e.code : "PARSE_FAILED" }) + "\n",
    );
    process.exitCode = 2;
    return;
  }
  const url = resolveDatabaseUrl(process.env);
  const pool = new pg.Pool({ connectionString: url });
  try {
    const result = await runCanaryOperation(realDeps, pool, parsed);
    process.stdout.write(formatResult(parsed.operation, result) + "\n");
  } catch (e) {
    // Print ONLY a code/name — never the message (which could echo connection detail).
    const code =
      (e as { code?: string })?.code ?? (e instanceof Error ? e.name : "UNKNOWN_ERROR");
    process.stderr.write(JSON.stringify({ ok: false, operation: parsed.operation, error: code }) + "\n");
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

// Run ONLY when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2));
}
