import { describe, it, expect } from "vitest";
import { evaluateHealthSnapshot } from "../services/kernel/src/health/run.js";
import { aggregateDomain, aggregateOverall } from "../services/kernel/src/health/aggregate.js";
import type { HealthExpectations, HealthSnapshot } from "../services/kernel/src/health/snapshot.js";
import type { CheckResult, DomainResult } from "../services/kernel/src/health/types.js";

/**
 * KJ-P1.1 — Production Health Model deterministic tests.
 *
 * Entirely synthetic snapshots: no Postgres, no Restate, no Docker. This is the
 * point of the collect/evaluate split (see health/types.ts's header comment) —
 * every domain's rules are pure functions over plain data, so a "fully healthy"
 * fixture plus targeted mutations exercises every required scenario deterministically.
 */

const CHECKED_AT = "2026-09-16T12:00:00.000Z";
const SCHEDULE_ID = "acab9ebc-dc92-5c3a-90d6-4d6f9ddb0a1b";
const RELEASE_ID = "5a2335b41d8fe525ff940a3bd86912c98dae68af";
const TASK_ID = "800b6ef2-6d9c-8a79-a83d-cabe51436dd6";
const DIGEST = "27255772beb1418e462fe262a2a747c53bf6a34973c3ad75907f7505a32f2b10";

function baseExpectations(): HealthExpectations {
  return {
    scheduleId: SCHEDULE_ID,
    scheduleState: "enabled",
    activeVersion: "v2",
    recipe: "claude_md_check/v1",
    approvedDigestSha256: DIGEST,
    armNext: true,
    releaseId: RELEASE_ID,
    services: ["ScheduleDriver", "KernelWorkflowV1", "TaskWorkflow", "CapabilityServiceV1"],
  };
}

function healthyProvenance() {
  return { activeEpoch: "1", activeReleaseId: RELEASE_ID, currentBindingCount: 1,
    mismatchedBindingCount: 0, missingProvenanceCount: 0, legacyBindingCount: 0 };
}

function healthySnapshot(): HealthSnapshot {
  return {
    checkedAt: CHECKED_AT,
    scheduler: {
      dbReachable: true,
      scheduleState: { scheduleId: SCHEDULE_ID, state: "enabled", activeVersion: "v2", updatedAt: CHECKED_AT },
      recipe: "claude_md_check/v1",
      fires: [
        {
          scheduleId: SCHEDULE_ID,
          scheduleVersion: "v2",
          fireWindowKey: "dailyAt/09:00|Europe/London|2026-09-16",
          fireAtUtc: "2026-09-16T08:00:00.000Z",
          state: "ADMITTED",
          admittedChildTaskId: TASK_ID,
          createdAt: "2026-09-16T08:00:00.300Z",
        },
      ],
      restateInvocations: [
        {
          id: "inv_completed",
          status: "completed",
          scheduledStartAt: "2026-09-16T08:00:00.000Z",
          invokedById: "inv_bootstrap",
          createdAt: "2026-09-15T08:00:00.000Z",
          completedAt: "2026-09-16T08:00:00.700Z",
        },
        {
          id: "inv_pending",
          status: "scheduled",
          scheduledStartAt: "2026-09-17T08:00:00.011Z",
          invokedById: "inv_completed",
          createdAt: "2026-09-16T08:00:00.780Z",
          completedAt: null,
        },
      ],
    },
    authority: {
      dbReachable: true,
      bindingProvenance: healthyProvenance(),
      admittedFireTaskIdsMissingAdmission: [],
      admittedFireTaskIdsUnmaterialised: [],
      boundReleaseRejectionSeen: false,
    },
    admission: { dbReachable: true, doorHealthy: true, humanOperatorPresent: true },
    execution: {
      registeredServices: ["ScheduleDriver", "KernelWorkflowV1", "TaskWorkflow", "CapabilityServiceV1"],
      workerRestartCount: 0,
      doorRestartCount: 0,
    },
    restate: {
      reachable: true,
      registeredServices: ["ScheduleDriver", "KernelWorkflowV1", "TaskWorkflow", "CapabilityServiceV1"],
      scheduleInvocations: [
        {
          id: "inv_pending",
          status: "scheduled",
          scheduledStartAt: "2026-09-17T08:00:00.011Z",
          invokedById: "inv_completed",
          createdAt: "2026-09-16T08:00:00.780Z",
          completedAt: null,
        },
      ],
    },
    database: { reachable: true, scheduleReadOk: true, taskReadOk: true },
    evidence: {
      dbReachable: true,
      mostRecentScheduledTaskId: TASK_ID,
      evidenceForTask: [
        {
          id: "ev1",
          taskId: TASK_ID,
          type: "TOOL_RECEIPT",
          source: "kerneljson:repository-read-local/v1",
          digest: DIGEST,
          capturedAt: "2026-09-16T08:00:01.000Z",
          metadata: { capability: "repository.read", target_path: "CLAUDE.md", mutations_detected: 0 },
        },
      ],
    },
    releaseParity: {
      dbReachable: true,
      selfReportedReleaseId: RELEASE_ID,
      bindingProvenance: healthyProvenance(),
      boundReleaseRejectionSeen: false,
    },
    productionConfig: {
      armNext: true,
      approvedDigestShapeValid: true,
      scheduleIdConfigured: SCHEDULE_ID,
      recipeConfigured: "claude_md_check/v1",
    },
    legacyAuthority: { b1FreezeObservable: { unavailable: true, reason: "cross-system, out of scope" } },
  };
}

describe("KJ-P1.1 health model — fully healthy state", () => {
  it("every checkable domain is HEALTHY; legacyAuthority is UNKNOWN by design (no Shared Brain wiring in this pass), which correctly caps overall at UNKNOWN rather than a false HEALTHY", () => {
    const report = evaluateHealthSnapshot(healthySnapshot(), baseExpectations());
    expect(report.criticalIssues).toBe(0);
    expect(report.degradedIssues).toBe(0);
    for (const [name, domain] of Object.entries(report.domains)) {
      if (name === "legacyAuthority") {
        expect(domain.status).toBe("UNKNOWN");
      } else {
        expect(domain.status, `${name} should be HEALTHY`).toBe("HEALTHY");
      }
    }
    // Overall correctly reflects the one genuinely-unknown domain rather than
    // pretending it's healthy — see docs/operations/HEALTH_MODEL.md "Known gaps".
    expect(report.overall).toBe("UNKNOWN");
    expect(report.lastFireAtUtc).toBe("2026-09-16T08:00:00.000Z");
    expect(report.nextWakeAtUtc).toBe("2026-09-17T08:00:00.011Z");
    expect(report.release).toBe(RELEASE_ID);
  });

  it("with legacyAuthority resolved to HEALTHY (a future wiring), overall genuinely reaches HEALTHY", () => {
    const snapshot = healthySnapshot();
    snapshot.legacyAuthority = { b1FreezeObservable: true };
    const report = evaluateHealthSnapshot(snapshot, baseExpectations());
    expect(report.overall).toBe("HEALTHY");
    expect(report.domains.legacyAuthority.status).toBe("HEALTHY");
  });
});

describe("release mismatch", () => {
  it("self-reported release differing from expected is CRITICAL and drags overall to CRITICAL", () => {
    const snapshot = healthySnapshot();
    snapshot.releaseParity.selfReportedReleaseId = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    snapshot.releaseParity.bindingProvenance!.activeReleaseId = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const report = evaluateHealthSnapshot(snapshot, baseExpectations());
    expect(report.domains.releaseParity.status).toBe("CRITICAL");
    expect(report.overall).toBe("CRITICAL");
    const failing = report.domains.releaseParity.checks.filter((c) => c.status === "CRITICAL").map((c) => c.id);
    expect(failing).toContain("releaseParity.matchesExpected");
  });

  it("a drift between recent bindings themselves (not just vs expected) is CRITICAL", () => {
    const snapshot = healthySnapshot();
    snapshot.releaseParity.bindingProvenance!.mismatchedBindingCount = 1;
    const report = evaluateHealthSnapshot(snapshot, baseExpectations());
    expect(report.domains.releaseParity.status).toBe("CRITICAL");
  });

  it("a live bound-worker-release rejection is CRITICAL in both authority and releaseParity", () => {
    const snapshot = healthySnapshot();
    snapshot.authority.boundReleaseRejectionSeen = true;
    snapshot.releaseParity.boundReleaseRejectionSeen = true;
    const report = evaluateHealthSnapshot(snapshot, baseExpectations());
    expect(report.domains.authority.status).toBe("CRITICAL");
    expect(report.domains.releaseParity.status).toBe("CRITICAL");
    expect(report.overall).toBe("CRITICAL");
  });
});

describe("admitted-fire materialisation vs authority corruption (KJ-P6 incident, 2026-09-24)", () => {
  // Reproduces the exact shape of the real incident: a schedule fire ADMITTED, a real
  // kernel_private.task_admissions row (KernelJSON's own admission authority succeeded),
  // but no public.tasks row because the worker holding a different release correctly
  // refused to write it (services/kernel/src/ledger.ts's "Task requires its bound worker
  // release" fail-closed guard). This must NEVER be classified the same as a fire with no
  // admission record at all — see scheduler/persistence.ts's ADMITTED doc-comment.
  const ORPHAN_TASK_ID = "71a00a16-24d9-8193-a64f-ec9c47c41ea0";

  it("a materialisation failure (admission record exists, task never created) is DEGRADED, not the P0 authority check", () => {
    const snapshot = healthySnapshot();
    snapshot.authority.admittedFireTaskIdsUnmaterialised = [ORPHAN_TASK_ID];
    const report = evaluateHealthSnapshot(snapshot, baseExpectations());
    const authorityCheck = report.domains.authority.checks.find((c) => c.id === "authority.admittedFiresHaveCanonicalTasks")!;
    const materialisedCheck = report.domains.authority.checks.find((c) => c.id === "authority.admittedFiresMaterialised")!;
    expect(authorityCheck.status).toBe("HEALTHY");
    expect(materialisedCheck.status).toBe("DEGRADED");
    expect(materialisedCheck.observed).toEqual([ORPHAN_TASK_ID]);
    expect(report.domains.authority.status).toBe("DEGRADED");
    expect(report.overall).toBe("DEGRADED");
  });

  it("a genuinely missing admission record (no task_admissions row) is still CRITICAL — the real P0 path", () => {
    const snapshot = healthySnapshot();
    snapshot.authority.admittedFireTaskIdsMissingAdmission = [ORPHAN_TASK_ID];
    const report = evaluateHealthSnapshot(snapshot, baseExpectations());
    const authorityCheck = report.domains.authority.checks.find((c) => c.id === "authority.admittedFiresHaveCanonicalTasks")!;
    const materialisedCheck = report.domains.authority.checks.find((c) => c.id === "authority.admittedFiresMaterialised")!;
    expect(authorityCheck.status).toBe("CRITICAL");
    expect(authorityCheck.observed).toEqual([ORPHAN_TASK_ID]);
    expect(materialisedCheck.status).toBe("HEALTHY"); // a future legitimate authority breach cannot hide behind this check
    expect(report.domains.authority.status).toBe("CRITICAL");
    expect(report.overall).toBe("CRITICAL");
  });

  it("both conditions can be observed independently at the same time, on different fires", () => {
    const snapshot = healthySnapshot();
    snapshot.authority.admittedFireTaskIdsMissingAdmission = ["11111111-1111-1111-1111-111111111111"];
    snapshot.authority.admittedFireTaskIdsUnmaterialised = [ORPHAN_TASK_ID];
    const report = evaluateHealthSnapshot(snapshot, baseExpectations());
    const authorityCheck = report.domains.authority.checks.find((c) => c.id === "authority.admittedFiresHaveCanonicalTasks")!;
    const materialisedCheck = report.domains.authority.checks.find((c) => c.id === "authority.admittedFiresMaterialised")!;
    expect(authorityCheck.status).toBe("CRITICAL");
    expect(materialisedCheck.status).toBe("DEGRADED");
    expect(report.overall).toBe("CRITICAL"); // the worse of the two still wins overall
  });
});

describe("schedule enabled but no future wake", () => {
  it("armNext=true with zero pending invocations is CRITICAL (chain has stopped)", () => {
    const snapshot = healthySnapshot();
    snapshot.scheduler.restateInvocations = [
      {
        id: "inv_completed",
        status: "completed",
        scheduledStartAt: "2026-09-16T08:00:00.000Z",
        invokedById: null,
        createdAt: "2026-09-16T07:59:00.000Z",
        completedAt: "2026-09-16T08:00:00.700Z",
      },
    ];
    snapshot.restate.scheduleInvocations = snapshot.scheduler.restateInvocations;
    const report = evaluateHealthSnapshot(snapshot, baseExpectations());
    const c = report.domains.scheduler.checks.find((x) => x.id === "scheduler.nextWakeArmedAndFuture")!;
    expect(c.status).toBe("CRITICAL");
    expect(report.overall).toBe("CRITICAL");
  });

  it("a pending wake stuck past its own scheduled_start_at beyond grace is CRITICAL, not merely about-to-run", () => {
    const snapshot = healthySnapshot();
    const staleScheduled = "2026-09-16T11:00:00.000Z"; // 1h before CHECKED_AT (12:00), grace is 5min
    snapshot.scheduler.restateInvocations = [
      {
        id: "inv_stuck",
        status: "scheduled",
        scheduledStartAt: staleScheduled,
        invokedById: "inv_prev",
        createdAt: "2026-09-15T08:00:00.000Z",
        completedAt: null,
      },
    ];
    snapshot.restate.scheduleInvocations = snapshot.scheduler.restateInvocations;
    const report = evaluateHealthSnapshot(snapshot, baseExpectations());
    expect(report.domains.scheduler.status).toBe("CRITICAL");
    expect(report.domains.restate.status).toBe("CRITICAL");
    const restateCheck = report.domains.restate.checks.find((x) => x.id === "restate.noStuckInvocation")!;
    expect(restateCheck.status).toBe("CRITICAL");
  });

  it("armNext=false does not require a pending wake (HEALTHY)", () => {
    const snapshot = healthySnapshot();
    snapshot.scheduler.restateInvocations = [];
    snapshot.restate.scheduleInvocations = [];
    snapshot.productionConfig.armNext = false;
    const exp = { ...baseExpectations(), armNext: false };
    const report = evaluateHealthSnapshot(snapshot, exp);
    const c = report.domains.scheduler.checks.find((x) => x.id === "scheduler.nextWakeArmedAndFuture")!;
    expect(c.status).toBe("HEALTHY");
  });
});

describe("duplicate window", () => {
  it("two fire rows for the same (schedule,version,window) is CRITICAL — the core double-admit invariant", () => {
    const snapshot = healthySnapshot();
    snapshot.scheduler.fires = [
      ...snapshot.scheduler.fires,
      { ...snapshot.scheduler.fires[0]!, createdAt: "2026-09-16T08:00:01.000Z" },
    ];
    const report = evaluateHealthSnapshot(snapshot, baseExpectations());
    const c = report.domains.scheduler.checks.find((x) => x.id === "scheduler.noDuplicateFireWindow")!;
    expect(c.status).toBe("CRITICAL");
    expect(report.overall).toBe("CRITICAL");
  });

  it("a zero-delay pair of completions under 60s apart is CRITICAL (self-rearm loop signature)", () => {
    const snapshot = healthySnapshot();
    snapshot.scheduler.restateInvocations = [
      {
        id: "inv_a",
        status: "completed",
        scheduledStartAt: "2026-09-16T08:00:00.000Z",
        invokedById: null,
        createdAt: "2026-09-16T07:59:59.000Z",
        completedAt: "2026-09-16T08:00:00.000Z",
      },
      {
        id: "inv_b",
        status: "completed",
        scheduledStartAt: "2026-09-16T08:00:00.010Z",
        invokedById: "inv_a",
        createdAt: "2026-09-16T08:00:00.020Z",
        completedAt: "2026-09-16T08:00:00.500Z",
      },
    ];
    const report = evaluateHealthSnapshot(snapshot, baseExpectations());
    const c = report.domains.scheduler.checks.find((x) => x.id === "scheduler.noZeroDelayLoop")!;
    expect(c.status).toBe("CRITICAL");
  });
});

describe("admission unavailable", () => {
  it("door unreachable check is UNKNOWN when KJ_ADMISSION_URL isn't configured, never a guessed HEALTHY", () => {
    const snapshot = healthySnapshot();
    snapshot.admission.doorHealthy = { unavailable: true, reason: "KJ_ADMISSION_URL not configured" };
    const report = evaluateHealthSnapshot(snapshot, baseExpectations());
    const c = report.domains.admission.checks.find((x) => x.id === "admission.doorReachable")!;
    expect(c.status).toBe("UNKNOWN");
    // domain overall should reflect the worst of its checks (humanOperatorPresent still HEALTHY)
    expect(report.domains.admission.status).toBe("UNKNOWN");
  });

  it("a door that responds unhealthy is CRITICAL, distinct from unavailable/UNKNOWN", () => {
    const snapshot = healthySnapshot();
    snapshot.admission.doorHealthy = false;
    const report = evaluateHealthSnapshot(snapshot, baseExpectations());
    const c = report.domains.admission.checks.find((x) => x.id === "admission.doorReachable")!;
    expect(c.status).toBe("CRITICAL");
  });
});

describe("Restate unavailable", () => {
  it("every Restate-dependent check across scheduler/execution/restate degrades to UNKNOWN, never fabricated HEALTHY", () => {
    const snapshot = healthySnapshot();
    const reason = "RESTATE_ADMIN_URL not configured";
    snapshot.scheduler.restateInvocations = { unavailable: true, reason };
    snapshot.execution.registeredServices = { unavailable: true, reason };
    snapshot.restate.reachable = { unavailable: true, reason };
    snapshot.restate.registeredServices = { unavailable: true, reason };
    snapshot.restate.scheduleInvocations = { unavailable: true, reason };
    const report = evaluateHealthSnapshot(snapshot, baseExpectations());
    expect(report.domains.restate.status).toBe("UNKNOWN");
    for (const c of report.domains.restate.checks) expect(c.status).toBe("UNKNOWN");
    const schedulerRestateChecks = report.domains.scheduler.checks.filter((c) =>
      ["scheduler.nextWakeArmedAndFuture", "scheduler.noZeroDelayLoop"].includes(c.id),
    );
    for (const c of schedulerRestateChecks) expect(c.status).toBe("UNKNOWN");
    // Non-Restate-dependent scheduler checks (e.g. noDuplicateFireWindow) must still
    // resolve normally — a missing telemetry source must not masquerade as a
    // scheduler-wide failure.
    const dup = report.domains.scheduler.checks.find((c) => c.id === "scheduler.noDuplicateFireWindow")!;
    expect(dup.status).toBe("HEALTHY");
    // And it must not leak into an unrelated domain like database or evidence.
    expect(report.domains.database.status).toBe("HEALTHY");
    expect(report.domains.evidence.status).toBe("HEALTHY");
  });
});

describe("evidence missing", () => {
  it("a scheduled task with zero evidence rows is CRITICAL", () => {
    const snapshot = healthySnapshot();
    snapshot.evidence.evidenceForTask = [];
    const report = evaluateHealthSnapshot(snapshot, baseExpectations());
    expect(report.domains.evidence.status).toBe("CRITICAL");
    const c = report.domains.evidence.checks.find((x) => x.id === "evidence.mostRecentCompletedTaskHasEvidence")!;
    expect(c.status).toBe("CRITICAL");
  });

  it("evidence present but missing a TOOL_RECEIPT is CRITICAL", () => {
    const snapshot = healthySnapshot();
    snapshot.evidence.evidenceForTask = [
      { ...snapshot.evidence.evidenceForTask[0]!, type: "DETERMINISTIC_RESULT" },
    ];
    const report = evaluateHealthSnapshot(snapshot, baseExpectations());
    const c = report.domains.evidence.checks.find((x) => x.id === "evidence.toolReceiptPresentWhereRequired")!;
    expect(c.status).toBe("CRITICAL");
  });

  it("a digest mismatch is CRITICAL", () => {
    const snapshot = healthySnapshot();
    snapshot.evidence.evidenceForTask[0]!.digest = "0".repeat(64);
    const report = evaluateHealthSnapshot(snapshot, baseExpectations());
    const c = report.domains.evidence.checks.find((x) => x.id === "evidence.digestMatchesApproved")!;
    expect(c.status).toBe("CRITICAL");
  });

  it("no scheduled task yet at all is UNKNOWN, not a false HEALTHY or false CRITICAL", () => {
    const snapshot = healthySnapshot();
    snapshot.evidence.mostRecentScheduledTaskId = null;
    snapshot.evidence.evidenceForTask = [];
    const report = evaluateHealthSnapshot(snapshot, baseExpectations());
    expect(report.domains.evidence.status).toBe("UNKNOWN");
  });
});

describe("unknown/unreachable source (database)", () => {
  it("database unreachable is CRITICAL for reachability and every dependent read", () => {
    const snapshot = healthySnapshot();
    snapshot.database = { reachable: false, scheduleReadOk: false, taskReadOk: false };
    const report = evaluateHealthSnapshot(snapshot, baseExpectations());
    expect(report.domains.database.status).toBe("CRITICAL");
    expect(report.overall).toBe("CRITICAL");
    // Only the reachability check should exist when unreachable — no fabricated
    // "reads succeed" verdict for a database we couldn't even connect to.
    expect(report.domains.database.checks).toHaveLength(1);
    expect(report.domains.database.checks[0]!.id).toBe("database.reachable");
  });

  it("a real bug found via manual smoke-testing before shipping: dbReachable=false must degrade dependent domains to UNKNOWN, never a fabricated confirmed-negative CRITICAL", () => {
    const snapshot = healthySnapshot();
    snapshot.database = { reachable: false, scheduleReadOk: false, taskReadOk: false };
    snapshot.scheduler.dbReachable = false;
    snapshot.authority.dbReachable = false;
    snapshot.admission.dbReachable = false;
    snapshot.evidence.dbReachable = false;
    snapshot.releaseParity.dbReachable = false;
    const report = evaluateHealthSnapshot(snapshot, baseExpectations());

    // Before the fix, these reported a false CRITICAL "no ACTIVE HUMAN operator
    // principal exists" / "no schedule_state row found" — a confirmed-absent claim
    // the tool never actually observed, because it couldn't reach the database at
    // all. They must be UNKNOWN, not a fabricated finding either way.
    const humanOperator = report.domains.admission.checks.find((c) => c.id === "admission.humanOperatorPresent")!;
    expect(humanOperator.status).toBe("UNKNOWN");
    const scheduleEnabled = report.domains.scheduler.checks.find((c) => c.id === "scheduler.scheduleEnabled")!;
    expect(scheduleEnabled.status).toBe("UNKNOWN");
    for (const id of [
      "scheduler.recentFireExists",
      "scheduler.noDuplicateFireWindow",
      "scheduler.noOrphanPlannedFire",
      "scheduler.admittedFiresBoundConsistently",
    ]) {
      expect(report.domains.scheduler.checks.find((c) => c.id === id)!.status).toBe("UNKNOWN");
    }
    for (const c of report.domains.authority.checks) expect(c.status).toBe("UNKNOWN");
    expect(report.domains.evidence.status).toBe("UNKNOWN");
    const recentBindings = report.domains.releaseParity.checks.find(
      (c) => c.id === "releaseParity.recentBindingsConsistent",
    )!;
    expect(recentBindings.status).toBe("UNKNOWN");
    const boundRejection = report.domains.releaseParity.checks.find(
      (c) => c.id === "releaseParity.noBoundReleaseRejection",
    )!;
    expect(boundRejection.status).toBe("UNKNOWN");
    // The admission door probe is independent of Postgres (a plain HTTP GET) and
    // must keep reporting its real, independently-observed status.
    const doorReachable = report.domains.admission.checks.find((c) => c.id === "admission.doorReachable")!;
    expect(doorReachable.status).toBe("HEALTHY");
    // Overall is still CRITICAL — but because the database itself is down, not
    // because of fabricated findings in unrelated domains.
    expect(report.overall).toBe("CRITICAL");
    expect(report.domains.database.status).toBe("CRITICAL");
  });
});

describe("aggregation rules", () => {
  it("a domain's status is the worst of its checks", () => {
    const checks: CheckResult[] = [
      { id: "a", status: "HEALTHY", evidence: "x", message: "x", checkedAt: CHECKED_AT },
      { id: "b", status: "DEGRADED", evidence: "x", message: "x", checkedAt: CHECKED_AT },
      { id: "c", status: "UNKNOWN", evidence: "x", message: "x", checkedAt: CHECKED_AT },
    ];
    expect(aggregateDomain(checks).status).toBe("DEGRADED");
  });

  it("CRITICAL always wins regardless of ordering or how many other checks are HEALTHY", () => {
    const many: CheckResult[] = Array.from({ length: 20 }, (_, i) => ({
      id: `h${i}`,
      status: "HEALTHY" as const,
      evidence: "x",
      message: "x",
      checkedAt: CHECKED_AT,
    }));
    const checks: CheckResult[] = [...many, { id: "z", status: "CRITICAL", evidence: "x", message: "x", checkedAt: CHECKED_AT }];
    expect(aggregateDomain(checks).status).toBe("CRITICAL");
  });

  it("an empty domain (nothing checked) is UNKNOWN, never HEALTHY — found nothing is not a pass", () => {
    expect(aggregateDomain([]).status).toBe("UNKNOWN");
  });

  it("overall is the worst of all domains — one CRITICAL domain among nine HEALTHY ones is still CRITICAL overall", () => {
    const domains: Record<string, DomainResult> = {};
    for (let i = 0; i < 9; i++) domains[`d${i}`] = { status: "HEALTHY", checks: [] };
    domains["bad"] = { status: "CRITICAL", checks: [] };
    expect(aggregateOverall(domains)).toBe("CRITICAL");
  });

  it("overall with no domains at all is UNKNOWN", () => {
    expect(aggregateOverall({})).toBe("UNKNOWN");
  });

  it("a non-critical telemetry gap (Restate unconfigured) does not escalate an otherwise-healthy report past DEGRADED", () => {
    const snapshot = healthySnapshot();
    const reason = "RESTATE_ADMIN_URL not configured";
    snapshot.scheduler.restateInvocations = { unavailable: true, reason };
    snapshot.execution.registeredServices = { unavailable: true, reason };
    snapshot.restate.reachable = { unavailable: true, reason };
    snapshot.restate.registeredServices = { unavailable: true, reason };
    snapshot.restate.scheduleInvocations = { unavailable: true, reason };
    const report = evaluateHealthSnapshot(snapshot, baseExpectations());
    // UNKNOWN, never CRITICAL — an unreachable optional telemetry source must not
    // masquerade as an execution failure.
    expect(report.overall).toBe("UNKNOWN");
    expect(report.criticalIssues).toBe(0);
  });
});
