import { worseOf, type CheckResult, type DomainResult, type HealthStatus } from "./types.js";

/** A domain's status is the worst of its own checks. An empty domain (nothing to
 *  check — e.g. a wholly unconfigured optional source) is UNKNOWN, never HEALTHY:
 *  "found nothing" is not a pass. */
export function aggregateDomain(checks: CheckResult[]): DomainResult {
  if (checks.length === 0) return { status: "UNKNOWN", checks };
  const status = checks.reduce<HealthStatus>((acc, c) => worseOf(acc, c.status), "HEALTHY");
  return { status, checks };
}

/** Overall = the worst of all domain statuses. A single CRITICAL domain makes the
 *  whole report CRITICAL regardless of how many other domains are HEALTHY — health
 *  is not an average. */
export function aggregateOverall(domains: Record<string, DomainResult>): HealthStatus {
  const statuses = Object.values(domains).map((d) => d.status);
  if (statuses.length === 0) return "UNKNOWN";
  return statuses.reduce<HealthStatus>((acc, s) => worseOf(acc, s), "HEALTHY");
}

export function countByStatus(domains: Record<string, DomainResult>): {
  criticalIssues: number;
  degradedIssues: number;
  unknownChecks: number;
} {
  let criticalIssues = 0;
  let degradedIssues = 0;
  let unknownChecks = 0;
  for (const domain of Object.values(domains)) {
    for (const check of domain.checks) {
      if (check.status === "CRITICAL") criticalIssues++;
      else if (check.status === "DEGRADED") degradedIssues++;
      else if (check.status === "UNKNOWN") unknownChecks++;
    }
  }
  return { criticalIssues, degradedIssues, unknownChecks };
}
