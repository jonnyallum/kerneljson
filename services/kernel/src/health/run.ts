import {
  evaluateAdmission,
  evaluateAuthority,
  evaluateDatabase,
  evaluateEvidence,
  evaluateExecution,
  evaluateLegacyAuthority,
  evaluateProductionConfig,
  evaluateReleaseParity,
  evaluateRestate,
  evaluateScheduler,
} from "./evaluate.js";
import { buildReport } from "./report.js";
import type { HealthExpectations, HealthSnapshot } from "./snapshot.js";
import type { HealthReport } from "./types.js";

/** Pure: snapshot + expectations -> the full report. Nothing in this file performs
 *  I/O, which is what makes it (and everything it calls) exhaustively unit-testable
 *  with synthetic snapshots — see `tests/health-*.test.ts`. */
export function evaluateHealthSnapshot(
  snapshot: HealthSnapshot,
  expectations: HealthExpectations,
): HealthReport {
  const checkedAt = snapshot.checkedAt;

  const domains = {
    authority: evaluateAuthority(snapshot.authority, checkedAt),
    admission: evaluateAdmission(snapshot.admission, checkedAt),
    scheduler: evaluateScheduler(snapshot.scheduler, expectations, checkedAt),
    execution: evaluateExecution(snapshot.execution, expectations, checkedAt),
    restate: evaluateRestate(snapshot.restate, expectations, checkedAt),
    database: evaluateDatabase(snapshot.database, checkedAt),
    evidence: evaluateEvidence(snapshot.evidence, expectations, checkedAt),
    releaseParity: evaluateReleaseParity(snapshot.releaseParity, expectations, checkedAt),
    productionConfig: evaluateProductionConfig(snapshot.productionConfig, expectations, checkedAt),
    legacyAuthority: evaluateLegacyAuthority(snapshot.legacyAuthority, checkedAt),
  } as const;

  const sortedFires = [...snapshot.scheduler.fires].sort(
    (a, b) => Date.parse(b.fireAtUtc) - Date.parse(a.fireAtUtc),
  );
  const lastFireAtUtc = sortedFires[0]?.fireAtUtc ?? null;

  const invocations = snapshot.restate.scheduleInvocations;
  const nextWakeAtUtc =
    !Array.isArray(invocations)
      ? null
      : invocations
          .filter((i) => i.status === "scheduled" && i.scheduledStartAt)
          .map((i) => i.scheduledStartAt!)
          .sort()[0] ?? null;

  return buildReport(domains, {
    checkedAt,
    release: snapshot.releaseParity.selfReportedReleaseId,
    lastFireAtUtc,
    nextWakeAtUtc,
  });
}
