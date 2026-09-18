import type { AlertDecision } from "./types.js";
import type { NotificationPayload } from "./outbox-types.js";

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

export function fmtDuration(ms: number): string {
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

/**
 * KJ-P2.1: the delivery worker's formatter, over a durable `NotificationPayload`
 * (an outbox row snapshot) rather than a live `AlertDecision` — see
 * outbox-types.ts's header for why those diverge. Same layout as
 * `formatDecisionHuman`, minus the "Notification sent: yes/no" line (nothing
 * that isn't notify-worthy ever reaches a transport, so the line would always
 * read "yes" and add nothing).
 */
export function formatPayloadHuman(p: NotificationPayload): string {
  if (p.kind === "RECOVERED") {
    const lines = ["RECOVERED", `${domainLabel(p.checkId)}: ${p.message}`];
    if (p.durationMs !== null) lines.push(`Duration: ${fmtDuration(p.durationMs)}`);
    return lines.join("\n");
  }
  const header = p.kind === "ESCALATED" ? `${p.severity} ${domainLabel(p.checkId)} (escalated)` : `${p.severity} ${domainLabel(p.checkId)}`;
  return [header, p.message, `First seen: ${fmtTime(p.firstSeenAt)}`, `Last seen: ${fmtTime(p.lastSeenAt)}`, `Occurrences: ${p.occurrenceCount}`].join("\n");
}

/**
 * KJ-P2.2 — Telegram's MarkdownV2 parse mode requires every one of these
 * characters to be escaped with a preceding backslash outside of an
 * explicit entity (bold/code/etc), or `sendMessage` rejects the whole
 * request as a 400 (see Telegram Bot API docs, "MarkdownV2 style"). Applied
 * to every piece of check-derived text (`checkId`, `message`, timestamps)
 * before it's embedded in the message — none of those are user-authored,
 * but check IDs routinely contain `.` (e.g. `authority.bindingReleaseConsistent`)
 * and the synthetic message contains `(`/`)`, both special — so escaping is
 * required for correctness, not just defence.
 */
const TELEGRAM_MARKDOWN_V2_SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g;
export function escapeTelegramMarkdownV2(text: string): string {
  return text.replace(TELEGRAM_MARKDOWN_V2_SPECIAL, (ch) => `\\${ch}`);
}

const SEVERITY_ICON: Record<NotificationPayload["severity"], string> = {
  P0: "\u{1F534}", // red circle
  P1: "\u{1F7E0}", // orange circle
  P2: "\u{1F7E1}", // yellow circle
  P3: "\u{26AA}", // white circle
};

/**
 * KJ-P2.2 — compact, operational Telegram message. Deliberately minimal for
 * this first version: severity, kind, check id, the same safe synthetic
 * message every transport gets (see delivery-worker.ts's `rowToPayload` —
 * raw collector text never reaches here), occurrence count, a timestamp,
 * and a shortened notificationId for correlating with
 * `kernel_private.notification_outbox`/`notification_delivery_events`.
 * Never includes `observed`, a raw collector message, a URL, or anything
 * DB-connection-shaped — there is nothing in `NotificationPayload` that
 * could carry those (see outbox-types.ts's header), so this is a property
 * of the type, not just this formatter's discipline.
 */
export function formatTelegramMessage(p: NotificationPayload): string {
  const icon = SEVERITY_ICON[p.severity];
  const lines = [
    `${icon} *${escapeTelegramMarkdownV2(p.severity)} ${escapeTelegramMarkdownV2(p.kind)}*`,
    escapeTelegramMarkdownV2(p.checkId),
    escapeTelegramMarkdownV2(p.message),
  ];
  if (p.kind === "RECOVERED" && p.durationMs !== null) {
    lines.push(escapeTelegramMarkdownV2(`Duration: ${fmtDuration(p.durationMs)}`));
  }
  lines.push(`Occurrences: ${p.occurrenceCount}`);
  lines.push(escapeTelegramMarkdownV2(`At: ${p.lastSeenAt}`));
  lines.push(`ID: \`${escapeTelegramMarkdownV2(p.notificationId.slice(0, 8))}\``);
  return lines.join("\n");
}
