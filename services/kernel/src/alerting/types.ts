import type { CheckResult, HealthStatus } from "../health/types.js";

/**
 * KJ-P1.2 — Production Alerting, shared types.
 *
 * Architecture mirrors P1.1's collect/evaluate split: a PURE reducer
 * (`reducer.ts`) turns (existing alert state row | null, a fresh CheckResult) into
 * (next state row, an AlertDecision | null) — no I/O, exhaustively unit-testable.
 * `engine.ts` is the thin async shell that reads/writes an `AlertStateStore`
 * around that pure core. (KJ-P2.1: `engine.ts` no longer calls a `Notifier`
 * directly — see outbox-types.ts/delivery-worker.ts for the durable
 * outbox/delivery layer that replaced the inline notify call.)
 */

/** P0 (most severe) .. P3 (least). Explicit per-check-id policy, never a blind
 *  1:1 mapping from HealthStatus — see policy.ts. */
export const ALERT_SEVERITIES = ["P0", "P1", "P2", "P3"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/** Lower number = more severe. Used to detect escalation/de-escalation while an
 *  alert stays open. */
export const SEVERITY_RANK: Record<AlertSeverity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export function isWorse(a: AlertSeverity, b: AlertSeverity): boolean {
  return SEVERITY_RANK[a] < SEVERITY_RANK[b];
}

/** Why a decision was made — distinguishes "first time we've seen this" from
 *  "still broken, don't renotify" from "got worse" from "fixed". Only NEW,
 *  ESCALATED, DEESCALATED and RECOVERED ever set `notify: true` by default; a
 *  policy can still force `notify: false` (see legacyAuthority.b1FreezeObservable). */
export type AlertEventKind = "NEW" | "ONGOING" | "ESCALATED" | "DEESCALATED" | "RECOVERED";

/** One row per (checkId, entityId) — the stable identity of "this specific
 *  problem". Persists across repeated failures; a RECOVERED row that fails again
 *  starts a fresh episode (see reducer.ts "recurrence after recovery"). */
export interface AlertStateRow {
  fingerprint: string;
  checkId: string;
  entityId: string;
  severity: AlertSeverity;
  /** OPEN = actively failing (unhealthy) right now. RECOVERED = closed; a fresh
   *  failure on the same fingerprint reopens it as a new episode. */
  currentState: "OPEN" | "RECOVERED";
  firstSeenAt: string;
  lastSeenAt: string;
  lastNotifiedAt: string | null;
  /** How many consecutive unhealthy evaluations this OPEN episode has seen.
   *  Resets to 1 when an episode reopens after recovery. */
  occurrenceCount: number;
  recoveredAt: string | null;
}

export interface AlertDecision {
  kind: AlertEventKind;
  severity: AlertSeverity;
  fingerprint: string;
  checkId: string;
  entityId: string;
  message: string;
  /** Whether this decision should actually be sent to a notifier right now. */
  notify: boolean;
  observed?: unknown;
  firstSeenAt: string;
  lastSeenAt: string;
  lastNotifiedAt: string | null;
  occurrenceCount: number;
  /** Only set for a RECOVERED decision: how long the episode was open. */
  durationMs?: number;
}

/** One entry in the explicit policy table. `severityFor` returning `null` means
 *  "this status does not alert" (e.g. HEALTHY, or a DEGRADED the policy treats as
 *  informational-only for this particular check). */
export interface AlertPolicyEntry {
  checkId: string;
  severityFor: (status: HealthStatus) => AlertSeverity | null;
  /** false = this checkId is tracked (state row still maintained, for
   *  visibility/audit) but NEVER sent to a notifier — a policy decision, not a
   *  bug. Only legacyAuthority.b1FreezeObservable uses this today. Default true. */
  notify?: boolean;
  /** Overrides the check's own CheckResult.message for the alert text, when the
   *  required human-facing wording differs (e.g. matching the P1.2 finish-line
   *  example exactly). Falls back to the CheckResult's own message. */
  alertMessage?: (check: CheckResult) => string;
  /** WHY this mapping — shown in docs/operations/ALERTING.md's policy table and
   *  asserted by tests, so a future change has to justify itself, not just edit a
   *  number. */
  rationale: string;
}

// `Notifier` moved to outbox-types.ts (KJ-P2.1) — it's called only by
// delivery-worker.ts now, against a durable NotificationPayload, not
// directly against a live AlertDecision. See that file's header.
