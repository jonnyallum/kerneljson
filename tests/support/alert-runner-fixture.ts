import {
  HEALTH_DOMAINS,
  type DomainResult,
  type HealthReport,
  type HealthStatus,
} from "../../services/kernel/src/health/types.js";

export function monitorReport(status: HealthStatus = "HEALTHY"): HealthReport {
  const checkedAt = "2026-09-16T12:00:00.000Z";
  const domains = Object.fromEntries(
    HEALTH_DOMAINS.map((name): [string, DomainResult] => [
      name,
      { status, checks: [] },
    ]),
  ) as HealthReport["domains"];
  domains.scheduler.checks = [
    "scheduler.noDuplicateFireWindow",
    "scheduler.scheduleEnabled",
  ].map((id) => ({
    id,
    status,
    evidence: "synthetic qualification fixture",
    message: "sensitive raw observation must not escape",
    observed: "credential-like-test-marker",
    checkedAt,
  }));
  return {
    overall: status,
    checkedAt,
    release: null,
    domains,
    criticalIssues: status === "CRITICAL" ? 2 : 0,
    degradedIssues: 0,
    unknownChecks: 0,
    lastFireAtUtc: null,
    nextWakeAtUtc: null,
  };
}
