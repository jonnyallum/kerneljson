import { bindingProvenanceVerdict } from "./release-provenance.js";
import { aggregateDomain } from "./aggregate.js";
import { isUnavailable, type CheckResult, type DomainResult, type HealthStatus } from "./types.js";
import type {
  AdmissionSnapshot,
  AuthoritySnapshot,
  DatabaseSnapshot,
  EvidenceSnapshot,
  ExecutionSnapshot,
  HealthExpectations,
  LegacyAuthoritySnapshot,
  ProductionConfigSnapshot,
  ReleaseParitySnapshot,
  RestateSnapshot,
  SchedulerSnapshot,
} from "./snapshot.js";

const DEFAULT_FIRE_STALENESS_GRACE_MS = 25 * 3_600_000; // 25h — covers a dailyAt cadence + jitter
const DEFAULT_PLANNED_FIRE_GRACE_MS = 10 * 60_000; // 10min
const DEFAULT_STUCK_WAKE_GRACE_MS = 5 * 60_000; // 5min

function check(
  id: string,
  status: HealthStatus,
  evidence: string,
  message: string,
  checkedAt: string,
  extra?: { observed?: unknown; expected?: unknown },
): CheckResult {
  return { id, status, evidence, message, checkedAt, ...extra };
}

/** Unavailable-shaped UNKNOWN, so every "source not configured" collapses to the
 *  same recognisable shape instead of a bespoke message per check. */
function unknownFromUnavailable(
  id: string,
  reason: string,
  evidence: string,
  checkedAt: string,
): CheckResult {
  return check(id, "UNKNOWN", evidence, `evidence unavailable: ${reason}`, checkedAt);
}

// ---------------------------------------------------------------------------
// scheduler
// ---------------------------------------------------------------------------

export function evaluateScheduler(
  s: SchedulerSnapshot,
  exp: HealthExpectations,
  checkedAt: string,
): DomainResult {
  const checks: CheckResult[] = [];
  const fireGrace = exp.fireStalenessGraceMs ?? DEFAULT_FIRE_STALENESS_GRACE_MS;
  const plannedGrace = exp.plannedFireGraceMs ?? DEFAULT_PLANNED_FIRE_GRACE_MS;
  const stuckGrace = exp.stuckWakeGraceMs ?? DEFAULT_STUCK_WAKE_GRACE_MS;
  const now = Date.parse(checkedAt);

  if (!s.dbReachable) {
    // Every check below reads schedule_state/schedule_fires — without a database
    // connection none of them observed anything, so all report UNKNOWN. Conflating
    // "couldn't check" with "checked, found nothing" here is exactly the bug this
    // module exists to avoid (see database.reachable for the real CRITICAL signal).
    const dbUnknown = (id: string) =>
      check(id, "UNKNOWN", "schedule_state/schedule_fires", "database unreachable — see the database domain", checkedAt);
    checks.push(dbUnknown("scheduler.scheduleEnabled"));
    if (exp.activeVersion) checks.push(dbUnknown("scheduler.activeVersionExpected"));
    checks.push(dbUnknown("scheduler.recentFireExists"));
    checks.push(dbUnknown("scheduler.noDuplicateFireWindow"));
    checks.push(dbUnknown("scheduler.noOrphanPlannedFire"));
    checks.push(dbUnknown("scheduler.admittedFiresBoundConsistently"));
    // Restate-dependent checks are independent of Postgres reachability and still
    // evaluate normally below.
  } else {
  // scheduleEnabled
  if (!s.scheduleState) {
    checks.push(
      check(
        "scheduler.scheduleEnabled",
        "CRITICAL",
        "schedule_state",
        `no schedule_state row found for ${exp.scheduleId}`,
        checkedAt,
        { expected: exp.scheduleState, observed: null },
      ),
    );
  } else {
    checks.push(
      check(
        "scheduler.scheduleEnabled",
        s.scheduleState.state === exp.scheduleState ? "HEALTHY" : "CRITICAL",
        "schedule_state.state",
        s.scheduleState.state === exp.scheduleState
          ? `schedule is ${exp.scheduleState} as expected`
          : `schedule state is "${s.scheduleState.state}", expected "${exp.scheduleState}"`,
        checkedAt,
        { expected: exp.scheduleState, observed: s.scheduleState.state },
      ),
    );

    // activeVersionExpected
    if (exp.activeVersion) {
      checks.push(
        check(
          "scheduler.activeVersionExpected",
          s.scheduleState.activeVersion === exp.activeVersion ? "HEALTHY" : "CRITICAL",
          "schedule_state.active_version",
          s.scheduleState.activeVersion === exp.activeVersion
            ? `active version is ${exp.activeVersion} as expected`
            : `active version is "${s.scheduleState.activeVersion}", expected "${exp.activeVersion}"`,
          checkedAt,
          { expected: exp.activeVersion, observed: s.scheduleState.activeVersion },
        ),
      );
    }
  }

  // recentFireExists
  const sortedFires = [...s.fires].sort((a, b) => Date.parse(b.fireAtUtc) - Date.parse(a.fireAtUtc));
  const mostRecentFire = sortedFires[0] ?? null;
  if (!mostRecentFire) {
    checks.push(
      check(
        "scheduler.recentFireExists",
        s.scheduleState?.state === "enabled" ? "CRITICAL" : "UNKNOWN",
        "schedule_fires",
        s.scheduleState?.state === "enabled"
          ? "schedule is enabled but has never fired"
          : "no fires yet (schedule is not enabled, or not yet due)",
        checkedAt,
      ),
    );
  } else {
    const ageMs = now - Date.parse(mostRecentFire.fireAtUtc);
    checks.push(
      check(
        "scheduler.recentFireExists",
        ageMs <= fireGrace ? "HEALTHY" : "DEGRADED",
        "schedule_fires.fire_at_utc",
        ageMs <= fireGrace
          ? `most recent fire ${mostRecentFire.fireAtUtc} is within the ${Math.round(fireGrace / 3_600_000)}h staleness grace`
          : `most recent fire ${mostRecentFire.fireAtUtc} is ${Math.round(ageMs / 3_600_000)}h old, beyond the ${Math.round(fireGrace / 3_600_000)}h grace`,
        checkedAt,
        { observed: mostRecentFire.fireAtUtc },
      ),
    );
  }

  // noDuplicateFireWindow — the core double-admit invariant, cheap and structural
  const byWindow = new Map<string, number>();
  for (const f of s.fires) {
    const key = `${f.scheduleId}|${f.scheduleVersion}|${f.fireWindowKey}`;
    byWindow.set(key, (byWindow.get(key) ?? 0) + 1);
  }
  const duplicates = [...byWindow.entries()].filter(([, n]) => n > 1);
  checks.push(
    check(
      "scheduler.noDuplicateFireWindow",
      duplicates.length === 0 ? "HEALTHY" : "CRITICAL",
      "schedule_fires (schedule_id,schedule_version,fire_window_key)",
      duplicates.length === 0
        ? "no calendar window has more than one fire row"
        : `${duplicates.length} window(s) have duplicate fire rows: ${duplicates.map(([k]) => k).join(", ")}`,
      checkedAt,
      { observed: duplicates.map(([k, n]) => ({ window: k, count: n })) },
    ),
  );

  // noOrphanPlannedFire
  const stuckPlanned = s.fires.filter(
    (f) => f.state === "PLANNED" && !f.admittedChildTaskId && now - Date.parse(f.createdAt) > plannedGrace,
  );
  checks.push(
    check(
      "scheduler.noOrphanPlannedFire",
      stuckPlanned.length === 0 ? "HEALTHY" : "DEGRADED",
      "schedule_fires.state",
      stuckPlanned.length === 0
        ? "no fire is stuck PLANNED past the admission grace period"
        : `${stuckPlanned.length} fire(s) stuck PLANNED (never admitted) past ${Math.round(plannedGrace / 60_000)}min: ${stuckPlanned.map((f) => f.fireWindowKey).join(", ")}`,
      checkedAt,
      { observed: stuckPlanned.map((f) => f.fireWindowKey) },
    ),
  );

  // admittedFiresBoundConsistently — every ADMITTED fire actually has a child task id
  const inconsistentAdmitted = s.fires.filter((f) => f.state === "ADMITTED" && !f.admittedChildTaskId);
  checks.push(
    check(
      "scheduler.admittedFiresBoundConsistently",
      inconsistentAdmitted.length === 0 ? "HEALTHY" : "CRITICAL",
      "schedule_fires.state/admitted_child_task_id",
      inconsistentAdmitted.length === 0
        ? "every ADMITTED fire has a bound child task"
        : `${inconsistentAdmitted.length} fire(s) are ADMITTED with no admitted_child_task_id`,
      checkedAt,
    ),
  );
  } // end dbReachable branch

  // nextWakeArmedAndFuture + noZeroDelayLoop (Restate-dependent)
  if (isUnavailable(s.restateInvocations)) {
    checks.push(
      unknownFromUnavailable(
        "scheduler.nextWakeArmedAndFuture",
        s.restateInvocations.reason,
        "restate sys_invocation",
        checkedAt,
      ),
    );
    checks.push(
      unknownFromUnavailable(
        "scheduler.noZeroDelayLoop",
        s.restateInvocations.reason,
        "restate sys_invocation",
        checkedAt,
      ),
    );
  } else {
    const invocations = s.restateInvocations;
    const pending = invocations.filter((i) => i.status === "scheduled");
    if (exp.armNext) {
      if (pending.length === 0) {
        checks.push(
          check(
            "scheduler.nextWakeArmedAndFuture",
            "CRITICAL",
            "restate sys_invocation (status=scheduled)",
            "recurring mode is expected (armNext=true) but no next wake is durably armed — the self-rearm chain has stopped",
            checkedAt,
          ),
        );
      } else {
        const future = pending.filter((i) => i.scheduledStartAt && Date.parse(i.scheduledStartAt) > now);
        const stuck = pending.filter(
          (i) => i.scheduledStartAt && now - Date.parse(i.scheduledStartAt) > stuckGrace,
        );
        checks.push(
          check(
            "scheduler.nextWakeArmedAndFuture",
            stuck.length > 0 ? "CRITICAL" : future.length > 0 ? "HEALTHY" : "DEGRADED",
            "restate sys_invocation.scheduled_start_at",
            stuck.length > 0
              ? `${stuck.length} pending wake(s) are past their scheduled_start_at by more than ${Math.round(stuckGrace / 60_000)}min — stuck, not merely about to run`
              : future.length > 0
                ? `next wake is durably armed for ${pending[0]!.scheduledStartAt}, in the future`
                : "a wake is pending but not clearly in the future",
            checkedAt,
            { observed: pending.map((i) => i.scheduledStartAt) },
          ),
        );
      }
    } else {
      checks.push(
        check(
          "scheduler.nextWakeArmedAndFuture",
          "HEALTHY",
          "productionConfig.armNext",
          "recurring mode (armNext) is not expected on; a pending self-armed wake is not required",
          checkedAt,
        ),
      );
    }

    // zero-delay / self-loop detector: no more than one COMPLETED invocation for
    // this schedule key should land within the same 60s bucket — a real recurring
    // cadence (daily/hourly) never produces two completions a few seconds apart.
    const completed = invocations
      .filter((i) => i.status === "completed" && i.completedAt)
      .sort((a, b) => Date.parse(a.completedAt!) - Date.parse(b.completedAt!));
    let tightPairs = 0;
    for (let i = 1; i < completed.length; i++) {
      const gapMs = Date.parse(completed[i]!.completedAt!) - Date.parse(completed[i - 1]!.completedAt!);
      if (gapMs < 60_000) tightPairs++;
    }
    checks.push(
      check(
        "scheduler.noZeroDelayLoop",
        tightPairs === 0 ? "HEALTHY" : "CRITICAL",
        "restate sys_invocation.completed_at (consecutive gaps)",
        tightPairs === 0
          ? "no two completed invocations landed within 60s of each other"
          : `${tightPairs} consecutive-completion gap(s) under 60s — indicative of a zero-delay self-rearm loop`,
        checkedAt,
        { observed: completed.map((i) => i.completedAt) },
      ),
    );
  }

  return aggregateDomain(checks);
}

// ---------------------------------------------------------------------------
// authority
// ---------------------------------------------------------------------------

export function evaluateAuthority(s: AuthoritySnapshot, checkedAt: string, expectedRelease?: string): DomainResult {
  const checks: CheckResult[] = [];

  if (!s.dbReachable) {
    const dbUnknown = (id: string, evidence: string) =>
      check(id, "UNKNOWN", evidence, "database unreachable — see the database domain", checkedAt);
    checks.push(dbUnknown("authority.bindingReleaseConsistent", "kernel_private.execution_bindings"));
    checks.push(
      dbUnknown(
        "authority.admittedFiresHaveCanonicalTasks",
        "schedule_fires.admitted_child_task_id vs kernel_private.task_admissions",
      ),
    );
    checks.push(
      dbUnknown(
        "authority.admittedFiresMaterialised",
        "schedule_fires.admitted_child_task_id vs tasks.id (where task_admissions exists)",
      ),
    );
    checks.push(
      dbUnknown(
        "authority.noReleaseMismatchIncidents",
        'outcomes/task_events (text search: "Task requires its bound worker release")',
      ),
    );
    return aggregateDomain(checks);
  }

  const binding = bindingProvenanceVerdict(s.bindingProvenance, expectedRelease);
  checks.push(check("authority.bindingReleaseConsistent", binding.status,
    "database release epochs", binding.message, checkedAt, { observed: s.bindingProvenance }));

  checks.push(
    check(
      "authority.admittedFiresHaveCanonicalTasks",
      s.admittedFireTaskIdsMissingAdmission.length === 0 ? "HEALTHY" : "CRITICAL",
      "schedule_fires.admitted_child_task_id vs kernel_private.task_admissions",
      s.admittedFireTaskIdsMissingAdmission.length === 0
        ? "every admitted fire has a real KernelJSON admission record"
        : `${s.admittedFireTaskIdsMissingAdmission.length} admitted fire(s) reference a task id with NO kernel_private.task_admissions row — the scheduler minted without KernelJSON ever recording an admission`,
      checkedAt,
      { observed: s.admittedFireTaskIdsMissingAdmission },
    ),
  );

  // Distinct from the check above on purpose (see scheduler/persistence.ts's ADMITTED
  // doc-comment): a real task_admissions row means KernelJSON's own admission authority
  // decision already happened and is intact. A missing public.tasks row after that is a
  // downstream execution/materialisation failure (e.g. a worker refusing to write because
  // it doesn't hold the task's bound release) — real and worth surfacing, but not the
  // "scheduler minted outside KernelJSON" authority breach the check above guards against.
  checks.push(
    check(
      "authority.admittedFiresMaterialised",
      s.admittedFireTaskIdsUnmaterialised.length === 0 ? "HEALTHY" : "DEGRADED",
      "schedule_fires.admitted_child_task_id vs tasks.id (where task_admissions exists)",
      s.admittedFireTaskIdsUnmaterialised.length === 0
        ? "every admitted fire with a KernelJSON admission record has a materialised canonical task"
        : `${s.admittedFireTaskIdsUnmaterialised.length} admitted fire(s) have a real admission record but never materialised a canonical task — an execution/materialisation failure downstream of a successful admission, not an authority breach`,
      checkedAt,
      { observed: s.admittedFireTaskIdsUnmaterialised },
    ),
  );

  checks.push(
    check(
      "authority.noReleaseMismatchIncidents",
      s.boundReleaseRejectionSeen ? "CRITICAL" : "HEALTHY",
      'outcomes/task_events (text search: "Task requires its bound worker release")',
      s.boundReleaseRejectionSeen
        ? "a recent task was rejected for binding to the wrong worker release — a real release-parity incident occurred"
        : "no recent bound-worker-release rejection found",
      checkedAt,
    ),
  );

  return aggregateDomain(checks);
}

// ---------------------------------------------------------------------------
// admission
// ---------------------------------------------------------------------------

export function evaluateAdmission(s: AdmissionSnapshot, checkedAt: string): DomainResult {
  const checks: CheckResult[] = [];

  if (isUnavailable(s.doorHealthy)) {
    checks.push(unknownFromUnavailable("admission.doorReachable", s.doorHealthy.reason, "GET /healthz", checkedAt));
  } else {
    checks.push(
      check(
        "admission.doorReachable",
        s.doorHealthy ? "HEALTHY" : "CRITICAL",
        "GET /healthz",
        s.doorHealthy ? "admission door responded 200 to /healthz" : "admission door did not respond healthy to /healthz",
        checkedAt,
      ),
    );
  }

  checks.push(
    !s.dbReachable
      ? check(
          "admission.humanOperatorPresent",
          "UNKNOWN",
          "principals / tenant_memberships",
          "database unreachable — see the database domain",
          checkedAt,
        )
      : check(
          "admission.humanOperatorPresent",
          s.humanOperatorPresent ? "HEALTHY" : "CRITICAL",
          "principals / tenant_memberships",
          s.humanOperatorPresent
            ? "at least one ACTIVE HUMAN operator principal exists"
            : "no ACTIVE HUMAN operator principal exists — admission cannot be owned/approved",
          checkedAt,
        ),
  );

  return aggregateDomain(checks);
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

export function evaluateExecution(
  s: ExecutionSnapshot,
  exp: HealthExpectations,
  checkedAt: string,
): DomainResult {
  const checks: CheckResult[] = [];
  const coreServices = ["KernelWorkflowV1", "TaskWorkflow"];

  if (isUnavailable(s.registeredServices)) {
    checks.push(
      unknownFromUnavailable(
        "execution.workerRegistered",
        s.registeredServices.reason,
        "restate admin /deployments",
        checkedAt,
      ),
    );
  } else {
    const missing = coreServices.filter((name) => !(s.registeredServices as string[]).includes(name));
    checks.push(
      check(
        "execution.workerRegistered",
        missing.length === 0 ? "HEALTHY" : "CRITICAL",
        "restate admin /deployments",
        missing.length === 0
          ? "canonical workflow services are registered"
          : `missing registered service(s): ${missing.join(", ")}`,
        checkedAt,
        { expected: coreServices, observed: s.registeredServices },
      ),
    );

    if (exp.services.includes("CapabilityServiceV1")) {
      const has = (s.registeredServices as string[]).includes("CapabilityServiceV1");
      checks.push(
        check(
          "execution.capabilityServiceRegistered",
          has ? "HEALTHY" : "CRITICAL",
          "restate admin /deployments",
          has
            ? "CapabilityServiceV1 is registered"
            : "CapabilityServiceV1 is not registered — the sealed canary capability cannot run",
          checkedAt,
        ),
      );
    }
  }

  if (isUnavailable(s.workerRestartCount)) {
    checks.push(
      unknownFromUnavailable(
        "execution.noWorkerRestartLoop",
        s.workerRestartCount.reason,
        "container restart count (operator-supplied)",
        checkedAt,
      ),
    );
  } else {
    checks.push(
      check(
        "execution.noWorkerRestartLoop",
        s.workerRestartCount === 0 ? "HEALTHY" : s.workerRestartCount < 3 ? "DEGRADED" : "CRITICAL",
        "container restart count (operator-supplied)",
        `worker restart count is ${s.workerRestartCount}`,
        checkedAt,
        { observed: s.workerRestartCount },
      ),
    );
  }

  return aggregateDomain(checks);
}

// ---------------------------------------------------------------------------
// restate
// ---------------------------------------------------------------------------

export function evaluateRestate(
  s: RestateSnapshot,
  exp: HealthExpectations,
  checkedAt: string,
  stuckGraceMs = DEFAULT_STUCK_WAKE_GRACE_MS,
): DomainResult {
  const checks: CheckResult[] = [];
  const now = Date.parse(checkedAt);

  if (isUnavailable(s.reachable)) {
    checks.push(unknownFromUnavailable("restate.reachable", s.reachable.reason, "GET restate admin /health", checkedAt));
  } else {
    checks.push(
      check(
        "restate.reachable",
        s.reachable ? "HEALTHY" : "CRITICAL",
        "GET restate admin /health",
        s.reachable ? "Restate admin endpoint responded healthy" : "Restate admin endpoint did not respond healthy",
        checkedAt,
      ),
    );
  }

  if (isUnavailable(s.registeredServices)) {
    checks.push(
      unknownFromUnavailable(
        "restate.expectedServicesRegistered",
        s.registeredServices.reason,
        "restate admin /deployments",
        checkedAt,
      ),
    );
  } else {
    const missing = exp.services.filter((name) => !(s.registeredServices as string[]).includes(name));
    checks.push(
      check(
        "restate.expectedServicesRegistered",
        missing.length === 0 ? "HEALTHY" : "CRITICAL",
        "restate admin /deployments",
        missing.length === 0
          ? "all expected services are registered"
          : `missing registered service(s): ${missing.join(", ")}`,
        checkedAt,
        { expected: exp.services, observed: s.registeredServices },
      ),
    );
  }

  if (isUnavailable(s.scheduleInvocations)) {
    checks.push(
      unknownFromUnavailable(
        "restate.noStuckInvocation",
        s.scheduleInvocations.reason,
        "restate sys_invocation",
        checkedAt,
      ),
    );
  } else {
    const stuck = s.scheduleInvocations.filter(
      (i) => i.status === "scheduled" && i.scheduledStartAt && now - Date.parse(i.scheduledStartAt) > stuckGraceMs,
    );
    checks.push(
      check(
        "restate.noStuckInvocation",
        stuck.length === 0 ? "HEALTHY" : "CRITICAL",
        "restate sys_invocation (status=scheduled, past scheduled_start_at)",
        stuck.length === 0
          ? "no scheduled invocation is stuck past its own wake time"
          : `${stuck.length} invocation(s) stuck past their scheduled_start_at`,
        checkedAt,
        { observed: stuck.map((i) => i.id) },
      ),
    );
  }

  return aggregateDomain(checks);
}

// ---------------------------------------------------------------------------
// database
// ---------------------------------------------------------------------------

export function evaluateDatabase(s: DatabaseSnapshot, checkedAt: string): DomainResult {
  const checks: CheckResult[] = [
    check(
      "database.reachable",
      s.reachable ? "HEALTHY" : "CRITICAL",
      "select 1",
      s.reachable ? "production database is reachable" : "production database is not reachable",
      checkedAt,
    ),
  ];
  if (s.reachable) {
    checks.push(
      check(
        "database.scheduleReadsSucceed",
        s.scheduleReadOk ? "HEALTHY" : "CRITICAL",
        "select from schedule_state/schedule_fires",
        s.scheduleReadOk ? "scheduler reads succeed" : "scheduler reads failed",
        checkedAt,
      ),
    );
    checks.push(
      check(
        "database.taskReadsSucceed",
        s.taskReadOk ? "HEALTHY" : "CRITICAL",
        "select from tasks",
        s.taskReadOk ? "task reads succeed" : "task reads failed",
        checkedAt,
      ),
    );
  }
  return aggregateDomain(checks);
}

// ---------------------------------------------------------------------------
// evidence
// ---------------------------------------------------------------------------

export function evaluateEvidence(
  s: EvidenceSnapshot,
  exp: HealthExpectations,
  checkedAt: string,
): DomainResult {
  const checks: CheckResult[] = [];

  if (!s.dbReachable) {
    checks.push(
      check(
        "evidence.mostRecentCompletedTaskHasEvidence",
        "UNKNOWN",
        "schedule_fires -> evidence",
        "database unreachable — see the database domain",
        checkedAt,
      ),
    );
    return aggregateDomain(checks);
  }

  if (!s.mostRecentScheduledTaskId) {
    checks.push(
      check(
        "evidence.mostRecentCompletedTaskHasEvidence",
        "UNKNOWN",
        "schedule_fires -> evidence",
        "no scheduled task exists yet to check evidence for",
        checkedAt,
      ),
    );
    return aggregateDomain(checks);
  }

  const rows = s.evidenceForTask;
  checks.push(
    check(
      "evidence.mostRecentCompletedTaskHasEvidence",
      rows.length > 0 ? "HEALTHY" : "CRITICAL",
      `evidence where task_id=${s.mostRecentScheduledTaskId}`,
      rows.length > 0
        ? "the most recently scheduled task has evidence recorded"
        : "the most recently scheduled task has no evidence at all",
      checkedAt,
    ),
  );

  const receipt = rows.find((r) => r.type === "TOOL_RECEIPT");
  checks.push(
    check(
      "evidence.toolReceiptPresentWhereRequired",
      receipt ? "HEALTHY" : "CRITICAL",
      `evidence where task_id=${s.mostRecentScheduledTaskId} and type='TOOL_RECEIPT'`,
      receipt ? "a TOOL_RECEIPT is present" : "no TOOL_RECEIPT found for the most recent scheduled task",
      checkedAt,
    ),
  );

  if (!exp.approvedDigestSha256) {
    checks.push(
      check(
        "evidence.digestMatchesApproved",
        "UNKNOWN",
        "SCHED_APPROVED_SHA256",
        "no approved digest configured to compare against",
        checkedAt,
      ),
    );
  } else if (!receipt) {
    checks.push(
      check(
        "evidence.digestMatchesApproved",
        "CRITICAL",
        "evidence.digest / metadata",
        "no TOOL_RECEIPT to read a digest from",
        checkedAt,
      ),
    );
  } else {
    const observedDigest =
      receipt.digest ?? (receipt.metadata["content_sha256"] as string | undefined) ?? null;
    checks.push(
      check(
        "evidence.digestMatchesApproved",
        observedDigest === exp.approvedDigestSha256 ? "HEALTHY" : "CRITICAL",
        "evidence.digest",
        observedDigest === exp.approvedDigestSha256
          ? "observed digest matches the approved digest exactly"
          : `observed digest "${observedDigest}" does not match approved "${exp.approvedDigestSha256}"`,
        checkedAt,
        { expected: exp.approvedDigestSha256, observed: observedDigest },
      ),
    );
  }

  const boundOk = rows.every((r) => r.taskId === s.mostRecentScheduledTaskId);
  checks.push(
    check(
      "evidence.boundToCorrectTask",
      boundOk ? "HEALTHY" : "CRITICAL",
      "evidence.task_id",
      boundOk ? "all returned evidence is bound to the queried task" : "evidence rows returned for the wrong task",
      checkedAt,
    ),
  );

  return aggregateDomain(checks);
}

// ---------------------------------------------------------------------------
// releaseParity
// ---------------------------------------------------------------------------

export function evaluateReleaseParity(
  s: ReleaseParitySnapshot,
  exp: HealthExpectations,
  checkedAt: string,
): DomainResult {
  const checks: CheckResult[] = [];

  checks.push(
    check(
      "releaseParity.selfReportedReleaseKnown",
      s.selfReportedReleaseId ? "HEALTHY" : "UNKNOWN",
      "process.env.KERNELJSON_RELEASE_ID",
      s.selfReportedReleaseId
        ? `this component reports release ${s.selfReportedReleaseId}`
        : "this component has no KERNELJSON_RELEASE_ID set",
      checkedAt,
      { observed: s.selfReportedReleaseId },
    ),
  );

  if (!exp.releaseId) {
    checks.push(
      check(
        "releaseParity.matchesExpected",
        "UNKNOWN",
        "EXPECTED_RELEASE_ID",
        "no expected release id configured to compare against",
        checkedAt,
      ),
    );
  } else if (!s.selfReportedReleaseId) {
    checks.push(
      check(
        "releaseParity.matchesExpected",
        "UNKNOWN",
        "process.env.KERNELJSON_RELEASE_ID",
        "this component does not report its own release id",
        checkedAt,
      ),
    );
  } else {
    checks.push(
      check(
        "releaseParity.matchesExpected",
        s.selfReportedReleaseId === exp.releaseId ? "HEALTHY" : "CRITICAL",
        "process.env.KERNELJSON_RELEASE_ID vs EXPECTED_RELEASE_ID",
        s.selfReportedReleaseId === exp.releaseId
          ? "self-reported release matches the expected release"
          : `self-reported release "${s.selfReportedReleaseId}" does not match expected "${exp.releaseId}"`,
        checkedAt,
        { expected: exp.releaseId, observed: s.selfReportedReleaseId },
      ),
    );
  }

  const binding = bindingProvenanceVerdict(s.dbReachable ? s.bindingProvenance : null, exp.releaseId);
  checks.push(check("releaseParity.recentBindingsConsistent", binding.status,
    "database release epochs", binding.message, checkedAt, { observed: s.bindingProvenance }));

  checks.push(
    !s.dbReachable
      ? check(
          "releaseParity.noBoundReleaseRejection",
          "UNKNOWN",
          'outcomes/task_events (text search: "Task requires its bound worker release")',
          "database unreachable — see the database domain",
          checkedAt,
        )
      : check(
          "releaseParity.noBoundReleaseRejection",
          s.boundReleaseRejectionSeen ? "CRITICAL" : "HEALTHY",
          'outcomes/task_events (text search: "Task requires its bound worker release")',
          s.boundReleaseRejectionSeen
            ? "a live release mismatch rejection was observed"
            : "no release mismatch rejection observed",
          checkedAt,
        ),
  );

  return aggregateDomain(checks);
}

// ---------------------------------------------------------------------------
// productionConfig
// ---------------------------------------------------------------------------

export function evaluateProductionConfig(
  s: ProductionConfigSnapshot,
  exp: HealthExpectations,
  checkedAt: string,
): DomainResult {
  const checks: CheckResult[] = [];

  if (s.armNext === null) {
    checks.push(
      check(
        "productionConfig.armNextExpected",
        "UNKNOWN",
        "process.env.SCHED_ARM_NEXT",
        "this component does not report SCHED_ARM_NEXT (expected when run against the admission door, which has no scheduler config)",
        checkedAt,
      ),
    );
  } else {
    checks.push(
      check(
        "productionConfig.armNextExpected",
        s.armNext === exp.armNext ? "HEALTHY" : "CRITICAL",
        "process.env.SCHED_ARM_NEXT",
        s.armNext === exp.armNext
          ? `SCHED_ARM_NEXT=${s.armNext} matches expectation`
          : `SCHED_ARM_NEXT=${s.armNext}, expected ${exp.armNext}`,
        checkedAt,
        { expected: exp.armNext, observed: s.armNext },
      ),
    );
  }

  if (s.approvedDigestShapeValid === null) {
    checks.push(
      check(
        "productionConfig.approvedDigestPresentAndValid",
        "UNKNOWN",
        "process.env.SCHED_APPROVED_SHA256",
        "SCHED_APPROVED_SHA256 not set on this component",
        checkedAt,
      ),
    );
  } else {
    checks.push(
      check(
        "productionConfig.approvedDigestPresentAndValid",
        s.approvedDigestShapeValid ? "HEALTHY" : "CRITICAL",
        "process.env.SCHED_APPROVED_SHA256",
        s.approvedDigestShapeValid
          ? "approved digest is present and correctly shaped"
          : "approved digest is present but not a valid 64-char lowercase hex sha256",
        checkedAt,
      ),
    );
  }

  const scheduleOk = s.scheduleIdConfigured === null || s.scheduleIdConfigured === exp.scheduleId;
  const recipeOk = s.recipeConfigured === null || s.recipeConfigured === exp.recipe;
  checks.push(
    check(
      "productionConfig.scheduleIdentityMatchesCanonical",
      scheduleOk && recipeOk ? "HEALTHY" : "CRITICAL",
      "process.env.SCHED_RECIPE vs canonical schedule/recipe",
      scheduleOk && recipeOk
        ? "configured schedule/recipe identity matches canonical production values"
        : `configured identity diverges — schedule=${s.scheduleIdConfigured ?? "n/a"} recipe=${s.recipeConfigured ?? "n/a"}`,
      checkedAt,
      { expected: { scheduleId: exp.scheduleId, recipe: exp.recipe } },
    ),
  );

  return aggregateDomain(checks);
}

// ---------------------------------------------------------------------------
// legacyAuthority
// ---------------------------------------------------------------------------

export function evaluateLegacyAuthority(s: LegacyAuthoritySnapshot, checkedAt: string): DomainResult {
  const checks: CheckResult[] = [];
  if (isUnavailable(s.b1FreezeObservable)) {
    checks.push(
      unknownFromUnavailable(
        "legacyAuthority.b1FreezeObservable",
        s.b1FreezeObservable.reason,
        "Shared Brain (cross-system, out of scope for this module)",
        checkedAt,
      ),
    );
  } else {
    checks.push(
      check(
        "legacyAuthority.b1FreezeObservable",
        s.b1FreezeObservable ? "HEALTHY" : "CRITICAL",
        "Shared Brain authority_mode observation",
        s.b1FreezeObservable
          ? "B1 authority freeze remains observably in effect"
          : "B1 authority freeze does not appear to be in effect",
        checkedAt,
      ),
    );
  }
  return aggregateDomain(checks);
}
