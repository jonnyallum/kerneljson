import type { CheckResult } from "../health/types.js";
import { fingerprintFor, resolveEntityId } from "./fingerprint.js";
import { resolvePolicy } from "./policy.js";
import { isWorse, type AlertDecision, type AlertPolicyEntry, type AlertStateRow } from "./types.js";

/**
 * PURE core of KJ-P1.2. No I/O: takes the existing state row for one
 * (checkId, entityId) fingerprint — or `null` if none exists yet — plus a fresh
 * CheckResult, and returns the next state row plus (at most) one AlertDecision.
 * `engine.ts` is the only place this gets wired to a real store/notifier.
 *
 * Episode model:
 *  - No row, HEALTHY            -> no row, no decision (nothing to track).
 *  - No row, unhealthy          -> NEW: open a row, notify per policy.
 *  - OPEN row, still unhealthy,
 *    same severity              -> ONGOING: bump lastSeenAt/occurrenceCount, do NOT notify (dedup).
 *  - OPEN row, still unhealthy,
 *    severity got worse         -> ESCALATED: notify per policy.
 *  - OPEN row, still unhealthy,
 *    severity got better        -> DEESCALATED: notify per policy (still open, but worth knowing).
 *  - OPEN row, now HEALTHY      -> RECOVERED: close the row, notify per policy, report duration.
 *  - RECOVERED row, HEALTHY     -> no decision (already closed; do not spam recovery).
 *  - RECOVERED row, unhealthy   -> a NEW episode: reset firstSeenAt/occurrenceCount, reopen, notify
 *                                   per policy ("recurrence after recovery alerts again").
 */
export function reduceCheck(
  existing: AlertStateRow | null,
  check: CheckResult,
  canonicalScheduleId: string,
  now: string,
): { nextRow: AlertStateRow | null; decision: AlertDecision | null } {
  const policy = resolvePolicy(check.id);
  const entityId = resolveEntityId(check.id, canonicalScheduleId);
  const fingerprint = fingerprintFor(check.id, entityId);
  const severity = policy.severityFor(check.status);

  // HEALTHY (or a status this policy doesn't alert on at all).
  if (severity === null) {
    if (!existing || existing.currentState === "RECOVERED") {
      // Nothing open, nothing to do — including "repeated healthy state does
      // not spam recovery" once an episode has already been closed.
      return { nextRow: existing, decision: null };
    }
    // OPEN -> RECOVERED.
    const recoveredRow: AlertStateRow = {
      ...existing,
      currentState: "RECOVERED",
      lastSeenAt: now,
      recoveredAt: now,
    };
    const notify = policy.notify !== false;
    const decision: AlertDecision = {
      kind: "RECOVERED",
      severity: existing.severity,
      fingerprint,
      checkId: check.id,
      entityId,
      message: recoveredMessage(check),
      notify,
      firstSeenAt: existing.firstSeenAt,
      lastSeenAt: now,
      lastNotifiedAt: notify ? now : existing.lastNotifiedAt,
      occurrenceCount: existing.occurrenceCount,
      durationMs: Date.parse(now) - Date.parse(existing.firstSeenAt),
    };
    return {
      nextRow: { ...recoveredRow, lastNotifiedAt: decision.lastNotifiedAt },
      decision,
    };
  }

  // Unhealthy, and no row yet, or the prior episode already recovered: open a
  // fresh episode. This is exactly "first detection" AND "recurrence after
  // recovery" — both are "no currently-open episode", so both behave the same.
  if (!existing || existing.currentState === "RECOVERED") {
    const notify = policy.notify !== false;
    const row: AlertStateRow = {
      fingerprint,
      checkId: check.id,
      entityId,
      severity,
      currentState: "OPEN",
      firstSeenAt: now,
      lastSeenAt: now,
      lastNotifiedAt: notify ? now : null,
      occurrenceCount: 1,
      recoveredAt: null,
    };
    const decision: AlertDecision = {
      kind: "NEW",
      severity,
      fingerprint,
      checkId: check.id,
      entityId,
      message: alertMessage(policy, check),
      notify,
      observed: check.observed,
      firstSeenAt: now,
      lastSeenAt: now,
      lastNotifiedAt: row.lastNotifiedAt,
      occurrenceCount: 1,
    };
    return { nextRow: row, decision };
  }

  // Still unhealthy, episode already OPEN.
  const kind: "ONGOING" | "ESCALATED" | "DEESCALATED" =
    severity === existing.severity ? "ONGOING" : isWorse(severity, existing.severity) ? "ESCALATED" : "DEESCALATED";
  const notify = kind !== "ONGOING" && policy.notify !== false;
  const nextRow: AlertStateRow = {
    ...existing,
    severity,
    lastSeenAt: now,
    occurrenceCount: existing.occurrenceCount + 1,
    lastNotifiedAt: notify ? now : existing.lastNotifiedAt,
  };
  if (kind === "ONGOING") {
    // Dedup: still failing, unchanged severity — tracked, but not a decision to
    // hand to a notifier. Return null so callers never even see a suppressed one.
    return { nextRow, decision: null };
  }
  const decision: AlertDecision = {
    kind,
    severity,
    fingerprint,
    checkId: check.id,
    entityId,
    message: alertMessage(policy, check),
    notify,
    observed: check.observed,
    firstSeenAt: existing.firstSeenAt,
    lastSeenAt: now,
    lastNotifiedAt: nextRow.lastNotifiedAt,
    occurrenceCount: nextRow.occurrenceCount,
  };
  return { nextRow, decision };
}

function alertMessage(policy: AlertPolicyEntry, check: CheckResult): string {
  return policy.alertMessage ? policy.alertMessage(check) : check.message;
}

function recoveredMessage(check: CheckResult): string {
  return `${check.id} recovered — ${check.message}`;
}

/**
 * Reduce a full set of CheckResults (from a HealthReport) against a lookup of
 * existing rows by fingerprint. Returns every next row (to persist) and every
 * non-null decision (to notify on, per `decision.notify`). Order-independent:
 * each check is reduced against its own fingerprint only.
 */
export function reduceChecks(
  checks: readonly CheckResult[],
  existingByFingerprint: ReadonlyMap<string, AlertStateRow>,
  canonicalScheduleId: string,
  now: string,
): { nextRows: AlertStateRow[]; decisions: AlertDecision[] } {
  const nextRows: AlertStateRow[] = [];
  const decisions: AlertDecision[] = [];
  for (const check of checks) {
    const entityId = resolveEntityId(check.id, canonicalScheduleId);
    const fingerprint = fingerprintFor(check.id, entityId);
    const existing = existingByFingerprint.get(fingerprint) ?? null;
    const { nextRow, decision } = reduceCheck(existing, check, canonicalScheduleId, now);
    if (nextRow) nextRows.push(nextRow);
    if (decision) decisions.push(decision);
  }
  return { nextRows, decisions };
}
