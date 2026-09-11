import { pathToFileURL } from "node:url";
import pg from "pg";
import { runHumanProvision } from "../identity/provisioning-pg.js";
import { PgScheduleStore } from "../scheduler/pg-store.js";
import { PgIdentityGate, installDisabledCanary } from "../scheduler/canary-seed.js";

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
 * Two explicit, separate operations:
 *   provision-human --principal-id <uuid> --tenant-id <uuid>
 *   install-canary  --schedule-id <uuid> --tenant-id <uuid> --owner-id <uuid> --created-at <iso>
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

export type Operation = "provision-human" | "install-canary";

export interface ParsedArgs {
  operation: Operation;
  values: Record<string, string>;
}

const REQUIRED: Record<Operation, string[]> = {
  "provision-human": ["principal-id", "tenant-id"],
  "install-canary": ["schedule-id", "tenant-id", "owner-id", "created-at"],
};

/** Pure arg parser. Fails closed on missing/unknown operation or missing flags. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [operation, ...rest] = argv;
  if (operation !== "provision-human" && operation !== "install-canary")
    throw new RunnerError(
      "OPERATION_REQUIRED",
      'first argument must be "provision-human" or "install-canary"',
    );
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
  return deps.installCanary({
    pool,
    scheduleId: parsed.values["schedule-id"]!,
    tenantId: parsed.values["tenant-id"]!,
    ownerId: parsed.values["owner-id"]!,
    createdAt: parsed.values["created-at"]!,
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
