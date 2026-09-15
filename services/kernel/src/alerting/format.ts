import type { AlertDecision } from "./types.js";

const DOMAIN_LABELS: Record<string, string> = {
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

function domainLabel(checkId: string): string {
  const domain = checkId.split(".")[0] ?? checkId;
  return DOMAIN_LABELS[domain] ?? domain;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
}

function fmtDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** Matches the KJ-P1.2 finish-line examples exactly:
 *
 *   P1 Scheduler
 *   Enabled production schedule has no future wake
 *   First seen: 10:03
 *   Last seen: 10:08
 *   Occurrences: 2
 *   Notification sent: yes
 *
 *   RECOVERED
 *   Scheduler future wake restored
 *   Duration: 9m 14s
 */
export function formatDecisionHuman(d: AlertDecision): string {
  if (d.kind === "RECOVERED") {
    const lines = ["RECOVERED", `${domainLabel(d.checkId)}: ${d.message}`];
    if (d.durationMs !== undefined) lines.push(`Duration: ${fmtDuration(d.durationMs)}`);
    return lines.join("\n");
  }
  const header = d.kind === "ESCALATED" ? `${d.severity} ${domainLabel(d.checkId)} (escalated)` : `${d.severity} ${domainLabel(d.checkId)}`;
  return [
    header,
    d.message,
    `First seen: ${fmtTime(d.firstSeenAt)}`,
    `Last seen: ${fmtTime(d.lastSeenAt)}`,
    `Occurrences: ${d.occurrenceCount}`,
    `Notification sent: ${d.notify ? "yes" : "no"}`,
  ].join("\n");
}

export function formatDecisionsHuman(decisions: readonly AlertDecision[]): string {
  if (decisions.length === 0) return "No alert-worthy changes.";
  return decisions.map(formatDecisionHuman).join("\n\n");
}
