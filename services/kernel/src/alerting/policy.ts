import type { HealthStatus } from "../health/types.js";
import type { AlertPolicyEntry, AlertSeverity } from "./types.js";

/**
 * KJ-P1.2 — the explicit check-id -> severity policy table.
 *
 * Deliberately NOT a blind 1:1 map from HealthStatus. Two checks can both be
 * CRITICAL and warrant very different severities: `scheduler.noDuplicateFireWindow`
 * CRITICAL means the double-admit invariant broke (P0 — the exact "authority
 * corruption / unsafe production behaviour" case); `evidence.toolReceiptPresentWhereRequired`
 * CRITICAL means one task's evidence is incomplete (P2 — needs attention, isn't
 * an emergency). Every entry states its `rationale` so a future change has to
 * argue against a stated reason, not just edit a number.
 *
 * P0 = authority corruption / runaway execution / unsafe production behaviour.
 * P1 = critical production execution or scheduler outage.
 * P2 = degraded service / repeated retry / evidence or release issue needing attention.
 * P3 = operational warning / observability gap / non-urgent degradation.
 *
 * UNKNOWN defaults to P3 (an unreachable/unconfigured *optional* source is a
 * warning, not an emergency) unless a specific check's rationale says otherwise.
 * DEGRADED with no explicit mapping falls back to P2. A status with no mapping at
 * all (including every HEALTHY) alerts nothing — `resolvePolicy`'s caller only
 * ever asks about non-HEALTHY statuses in the first place (see engine.ts).
 */

function simple(
  checkId: string,
  map: Partial<Record<Exclude<HealthStatus, "HEALTHY">, AlertSeverity>>,
  rationale: string,
  extra?: { notify?: boolean; alertMessage?: AlertPolicyEntry["alertMessage"] },
): AlertPolicyEntry {
  return {
    checkId,
    severityFor: (status) => (status === "HEALTHY" ? null : (map[status as Exclude<HealthStatus, "HEALTHY">] ?? null)),
    rationale,
    ...(extra?.notify !== undefined ? { notify: extra.notify } : {}),
    ...(extra?.alertMessage ? { alertMessage: extra.alertMessage } : {}),
  };
}

export const ALERT_POLICY: readonly AlertPolicyEntry[] = [
  // ---- authority ---------------------------------------------------------
  simple(
    "authority.bindingReleaseConsistent",
    { CRITICAL: "P1", UNKNOWN: "P3" },
    "Binding release must match its canonical database activation epoch; historical epochs preserve their original release.",
  ),
  simple(
    "authority.admittedFiresHaveCanonicalTasks",
    { CRITICAL: "P0" },
    'An admitted schedule fire whose child task has NO kernel_private.task_admissions row at all means the scheduler minted without KernelJSON ever recording an admission — a direct breach of "KernelJSON is the sole task authority". Authority corruption, P0. (A materialised admission whose public.tasks row is merely missing is a separate, lower-severity check — see authority.admittedFiresMaterialised.)',
    { alertMessage: () => "An admitted schedule fire has no corresponding KernelJSON admission record — the scheduler may have minted outside KernelJSON's authority" },
  ),
  simple(
    "authority.admittedFiresMaterialised",
    { DEGRADED: "P2" },
    "A real kernel_private.task_admissions row means KernelJSON's own admission authority already succeeded (see scheduler/persistence.ts's ADMITTED semantics); a missing public.tasks row after that is a downstream execution/materialisation failure — e.g. a worker correctly refusing to write because it does not hold the task's bound release (KJ-P6 incident, 2026-09-24). Real and worth attention, not authority corruption. P2.",
  ),
  simple(
    "authority.noReleaseMismatchIncidents",
    { CRITICAL: "P1" },
    "A live bound-worker-release rejection means the runtime's own guard correctly refused to execute under the wrong release — it failed CLOSED, so this is a critical execution/deploy-hygiene incident, not corruption in progress. P1.",
  ),

  // ---- admission ----------------------------------------------------------
  simple(
    "admission.doorReachable",
    { CRITICAL: "P1", UNKNOWN: "P3" },
    "The admission door being unreachable blocks all new task admission — a critical execution outage. P1.",
  ),
  simple(
    "admission.humanOperatorPresent",
    { CRITICAL: "P1" },
    "No ACTIVE HUMAN operator principal means admission cannot be owned/approved — a critical execution-path issue, P1.",
  ),

  // ---- scheduler ------------------------------------------------------------
  simple(
    "scheduler.scheduleEnabled",
    { CRITICAL: "P1" },
    "The canonical production schedule not being in its expected state (e.g. unexpectedly disabled) is a scheduler outage, P1.",
  ),
  simple(
    "scheduler.activeVersionExpected",
    { CRITICAL: "P2" },
    "An active-version mismatch is most often EXPECTED_SCHEDULE_VERSION lagging a legitimate spec bump rather than an unauthorised change — treated as a config-drift warning to investigate, not an emergency. P2.",
  ),
  simple(
    "scheduler.recentFireExists",
    { CRITICAL: "P1", DEGRADED: "P2" },
    "An enabled schedule that has never fired at all is a real outage (P1); a merely-stale most-recent-fire is a warning to watch (P2).",
  ),
  simple(
    "scheduler.noDuplicateFireWindow",
    { CRITICAL: "P0" },
    "Two fire rows for the same calendar window is the core double-admit invariant breaking — proven-dangerous in S1-R qualification. Runaway/unsafe production behaviour, P0.",
    { alertMessage: (c) => `Duplicate fire row detected for a canonical window — ${c.message}` },
  ),
  simple(
    "scheduler.noOrphanPlannedFire",
    { DEGRADED: "P2" },
    "A fire stuck PLANNED (never admitted) is a stuck-retry symptom needing attention, not yet a confirmed outage. P2.",
  ),
  simple(
    "scheduler.admittedFiresBoundConsistently",
    { CRITICAL: "P0" },
    "An ADMITTED fire with no bound child task id is a structural integrity break in the admission/bind invariant — authority-adjacent corruption, P0.",
  ),
  simple(
    "scheduler.nextWakeArmedAndFuture",
    { CRITICAL: "P1", DEGRADED: "P2" },
    "Recurring mode expected on with no durably-armed future wake means the self-rearm chain has stopped — a scheduler outage, P1. A wake that exists but isn't clearly future-dated is a warning to watch, P2.",
    { alertMessage: (c) => `Enabled production schedule has no valid future wake — ${c.message}` },
  ),
  simple(
    "scheduler.noZeroDelayLoop",
    { CRITICAL: "P0" },
    "Two completed invocations under 60s apart is the exact signature of the S1B zero-delay self-rearm loop defect. Runaway execution, P0.",
    { alertMessage: (c) => `Possible zero-delay self-rearm loop detected — ${c.message}` },
  ),

  // ---- execution ------------------------------------------------------------
  simple(
    "execution.workerRegistered",
    { CRITICAL: "P1" },
    "Canonical workflow services missing from Restate registration is a worker execution outage, P1.",
  ),
  simple(
    "execution.capabilityServiceRegistered",
    { CRITICAL: "P1" },
    "CapabilityServiceV1 missing means the production canary recipe cannot execute at all — critical execution outage, P1.",
  ),
  simple(
    "execution.noWorkerRestartLoop",
    { CRITICAL: "P1", DEGRADED: "P2" },
    "A worker in an active crash-restart loop (>=3) is a critical execution outage, P1; 1-2 restarts is a warning worth a look, P2.",
  ),

  // ---- restate ------------------------------------------------------------
  simple(
    "restate.reachable",
    { CRITICAL: "P1" },
    "Restate admin unreachable blocks durable wake/execution continuity across the board — critical outage, P1.",
  ),
  simple(
    "restate.expectedServicesRegistered",
    { CRITICAL: "P1" },
    "A missing expected Restate service registration is a critical execution-path gap, P1.",
  ),
  simple(
    "restate.noStuckInvocation",
    { CRITICAL: "P1" },
    "A durable wake stuck past its own scheduled time means the recurring chain has stalled — critical scheduler outage, P1.",
    { alertMessage: (c) => `A scheduled wake is stuck past its own due time — ${c.message}` },
  ),

  // ---- database ------------------------------------------------------------
  simple(
    "database.reachable",
    { CRITICAL: "P1" },
    "Production database unreachable is a critical execution outage (nothing can be verified or admitted) — but it is the system being DOWN, not doing something actively wrong, so P1 rather than P0.",
  ),
  simple(
    "database.scheduleReadsSucceed",
    { CRITICAL: "P1" },
    "Scheduler reads failing (while otherwise connected) is a critical execution-path fault, P1.",
  ),
  simple(
    "database.taskReadsSucceed",
    { CRITICAL: "P1" },
    "Task reads failing is a critical execution-path fault, P1.",
  ),

  // ---- evidence ------------------------------------------------------------
  simple(
    "evidence.mostRecentCompletedTaskHasEvidence",
    { CRITICAL: "P2" },
    "A completed scheduled task with zero evidence is an evidence-completeness gap needing attention — P2, per the suggested semantics grouping evidence issues there.",
  ),
  simple(
    "evidence.toolReceiptPresentWhereRequired",
    { CRITICAL: "P2" },
    "A missing TOOL_RECEIPT is an evidence-completeness gap, P2.",
  ),
  simple(
    "evidence.digestMatchesApproved",
    { CRITICAL: "P1" },
    "A digest mismatch means the observed content diverges from the approved baseline the canary is supposed to be verifying against — a real integrity signal, more serious than a bookkeeping gap. P1.",
  ),
  simple(
    "evidence.boundToCorrectTask",
    { CRITICAL: "P0" },
    "Evidence bound to the wrong task is a data-integrity corruption in the evidence ledger itself — P0.",
  ),

  // ---- releaseParity ------------------------------------------------------------
  simple(
    "releaseParity.selfReportedReleaseKnown",
    { UNKNOWN: "P3" },
    "Not reporting a self release id is routine when run against a component that legitimately doesn't carry one (e.g. the admission door) — informational, P3.",
  ),
  simple(
    "releaseParity.matchesExpected",
    { CRITICAL: "P1" },
    "The wrong release running in production is a critical execution-correctness issue, P1.",
  ),
  simple(
    "releaseParity.recentBindingsConsistent",
    { CRITICAL: "P1" },
    "A binding differing from its canonical activation epoch, or the active release differing from expectation, is a critical execution-correctness issue, P1.",
  ),
  simple(
    "releaseParity.noBoundReleaseRejection",
    { CRITICAL: "P1" },
    "Mirrors authority.noReleaseMismatchIncidents in a different domain — the guard fired closed, critical but not corruption. P1.",
  ),

  // ---- productionConfig ------------------------------------------------------------
  simple(
    "productionConfig.armNextExpected",
    { CRITICAL: "P1" },
    "SCHED_ARM_NEXT drifting from expectation silently changes whether the production schedule self-perpetuates — a critical config-correctness issue, P1.",
  ),
  simple(
    "productionConfig.approvedDigestPresentAndValid",
    { CRITICAL: "P1" },
    "A malformed/missing approved digest breaks the canary's own verification baseline — critical, P1.",
  ),
  simple(
    "productionConfig.scheduleIdentityMatchesCanonical",
    { CRITICAL: "P1" },
    "A configured schedule id/recipe diverging from the canonical production identity is a critical config-correctness issue, P1.",
  ),

  // ---- legacyAuthority ------------------------------------------------------------
  simple(
    "legacyAuthority.b1FreezeObservable",
    { UNKNOWN: "P3", CRITICAL: "P0" },
    'A KNOWN, DOCUMENTED, PERMANENT gap (see docs/operations/HEALTH_MODEL.md "Known gaps") — this module has no Shared Brain credentials, so this check is UNKNOWN by design, not a live problem. Tracked (a state row exists, for audit) but deliberately never notified: alerting on a gap we already know about and cannot act on in this phase would be pure noise. If B1 freeze observability is ever wired up and genuinely reports CRITICAL (the freeze visibly broke), that IS a real authority-corruption signal — P0, and notified normally.',
    { notify: false },
  ),
] as const;

const POLICY_BY_CHECK_ID: ReadonlyMap<string, AlertPolicyEntry> = new Map(
  ALERT_POLICY.map((entry) => [entry.checkId, entry]),
);

/** Fallback for a check id P1.2 doesn't explicitly know about yet (new check
 *  added to the health model without a policy update) — CRITICAL still alerts
 *  (P2, conservative but not silent), everything else stays quiet. Explicit
 *  entries above should always be preferred; this exists so a genuinely new
 *  CRITICAL never goes completely unnoticed while its real policy is written. */
const DEFAULT_POLICY: AlertPolicyEntry = {
  checkId: "*",
  severityFor: (status) => (status === "CRITICAL" ? "P2" : null),
  rationale: "No explicit policy entry for this check id yet — conservative default (CRITICAL only, P2).",
};

export function resolvePolicy(checkId: string): AlertPolicyEntry {
  return POLICY_BY_CHECK_ID.get(checkId) ?? DEFAULT_POLICY;
}
