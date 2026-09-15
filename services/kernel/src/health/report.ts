import { aggregateOverall, countByStatus } from "./aggregate.js";
import { HEALTH_DOMAINS, type DomainName, type DomainResult, type HealthReport } from "./types.js";

export function buildReport(
  domains: Record<DomainName, DomainResult>,
  opts: { checkedAt: string; release: string | null; lastFireAtUtc: string | null; nextWakeAtUtc: string | null },
): HealthReport {
  const overall = aggregateOverall(domains);
  const { criticalIssues, degradedIssues, unknownChecks } = countByStatus(domains);
  return {
    overall,
    checkedAt: opts.checkedAt,
    release: opts.release,
    domains,
    criticalIssues,
    degradedIssues,
    unknownChecks,
    lastFireAtUtc: opts.lastFireAtUtc,
    nextWakeAtUtc: opts.nextWakeAtUtc,
  };
}

const DOMAIN_LABELS: Record<DomainName, string> = {
  authority: "Authority",
  admission: "Admission",
  scheduler: "Scheduler",
  execution: "Execution",
  restate: "Restate",
  database: "Database",
  evidence: "Evidence",
  releaseParity: "Release parity",
  productionConfig: "Production config",
  legacyAuthority: "Legacy authority",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

/** The finish-line view: `KernelJSON Production` table + headline facts. */
export function formatHumanSummary(report: HealthReport): string {
  const lines: string[] = [];
  lines.push("KernelJSON Production");
  lines.push("");
  lines.push(`${"Overall".padEnd(20)}${report.overall}`);
  for (const name of HEALTH_DOMAINS) {
    lines.push(`${DOMAIN_LABELS[name].padEnd(20)}${report.domains[name].status}`);
  }
  lines.push("");
  lines.push(`${"Last fire".padEnd(20)}${fmtDate(report.lastFireAtUtc)}`);
  lines.push(`${"Next wake".padEnd(20)}${fmtDate(report.nextWakeAtUtc)}`);
  lines.push(`${"Release".padEnd(20)}${report.release ?? "unknown"}`);
  lines.push(`${"Critical issues".padEnd(20)}${report.criticalIssues}`);
  if (report.degradedIssues > 0) lines.push(`${"Degraded issues".padEnd(20)}${report.degradedIssues}`);
  if (report.unknownChecks > 0) lines.push(`${"Unknown checks".padEnd(20)}${report.unknownChecks}`);
  return lines.join("\n");
}

/** Exit code convention: 0 HEALTHY, 1 DEGRADED, 2 CRITICAL, 3 UNKNOWN overall. Lets
 *  monitoring treat this like any other health-check process without parsing JSON. */
export function exitCodeFor(report: HealthReport): number {
  switch (report.overall) {
    case "HEALTHY":
      return 0;
    case "DEGRADED":
      return 1;
    case "CRITICAL":
      return 2;
    case "UNKNOWN":
      return 3;
  }
}
