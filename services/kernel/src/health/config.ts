import type { HealthExpectations } from "./snapshot.js";

/**
 * Canonical production identity, per the S1D2 evidence record
 * (docs/production/PHASE_S1D2_PRODUCTION_RECURRING_ENABLEMENT_RESULT_2026-09-15.md).
 * These are DEFAULTS only — every one is overridable via env so the same module can
 * validate a disposable/staging deployment with different expectations.
 */
export const CANONICAL_SCHEDULE_ID = "acab9ebc-dc92-5c3a-90d6-4d6f9ddb0a1b";
export const CANONICAL_ACTIVE_VERSION = "v2";
export const CANONICAL_RECIPE = "claude_md_check/v1";
export const CANONICAL_SERVICES = [
  "ScheduleDriver",
  "KernelWorkflowV1",
  "TaskWorkflow",
  "CapabilityServiceV1",
] as const;

export interface HealthConnectionConfig {
  databaseUrl: string;
  /** Base URL of the admission door, e.g. http://gateway:8081 — optional; without
   *  it `admission.doorReachable` reports UNKNOWN, never a guess. */
  admissionUrl?: string;
  /** Base URL of the Restate admin API, e.g. http://restate:9070 — optional;
   *  without it every Restate-dependent check reports UNKNOWN. */
  restateAdminUrl?: string;
  /** Operator-supplied container restart counts (this module never shells out to
   *  docker itself) — e.g. `WORKER_RESTART_COUNT=$(docker inspect ... .RestartCount)`
   *  before invoking. Optional; absent -> UNKNOWN for that one check. */
  workerRestartCount?: number;
  doorRestartCount?: number;
}

function boolEnv(raw: string | undefined): boolean | null {
  if (raw === undefined || raw === "") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`expected "true" or "false", got ${JSON.stringify(raw)}`);
}

function intEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`expected a non-negative integer, got ${JSON.stringify(raw)}`);
  return n;
}

export function loadHealthExpectations(env: NodeJS.ProcessEnv): HealthExpectations {
  const armNext = boolEnv(env["EXPECTED_SCHED_ARM_NEXT"]);
  const approvedDigestSha256 = env["SCHED_APPROVED_SHA256"];
  const releaseId = env["EXPECTED_RELEASE_ID"];
  return {
    scheduleId: env["EXPECTED_SCHEDULE_ID"] ?? CANONICAL_SCHEDULE_ID,
    scheduleState: (env["EXPECTED_SCHEDULE_STATE"] as HealthExpectations["scheduleState"] | undefined) ?? "enabled",
    activeVersion: env["EXPECTED_SCHEDULE_VERSION"] ?? CANONICAL_ACTIVE_VERSION,
    recipe: env["EXPECTED_RECIPE"] ?? CANONICAL_RECIPE,
    ...(approvedDigestSha256 !== undefined ? { approvedDigestSha256 } : {}),
    armNext: armNext ?? true,
    ...(releaseId !== undefined ? { releaseId } : {}),
    services: env["EXPECTED_SERVICES"]
      ? env["EXPECTED_SERVICES"].split(",").map((s) => s.trim()).filter(Boolean)
      : CANONICAL_SERVICES,
  };
}

export function loadConnectionConfig(env: NodeJS.ProcessEnv): HealthConnectionConfig {
  const databaseUrl = env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL is required to run the health check");
  const admissionUrl = env["KJ_ADMISSION_URL"] || undefined;
  const restateAdminUrl = env["RESTATE_ADMIN_URL"] || undefined;
  const workerRestartCount = intEnv(env["WORKER_RESTART_COUNT"]);
  const doorRestartCount = intEnv(env["DOOR_RESTART_COUNT"]);
  return {
    databaseUrl,
    ...(admissionUrl !== undefined ? { admissionUrl } : {}),
    ...(restateAdminUrl !== undefined ? { restateAdminUrl } : {}),
    ...(workerRestartCount !== undefined ? { workerRestartCount } : {}),
    ...(doorRestartCount !== undefined ? { doorRestartCount } : {}),
  };
}
