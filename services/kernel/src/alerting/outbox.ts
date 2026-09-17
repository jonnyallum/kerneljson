import { createHash } from "node:crypto";
import type { AlertDecision } from "./types.js";
import type {
  DeliveryAttemptResult,
  DeliveryConfig,
  DeliveryOutcome,
  NotificationIntent,
  NotificationOutboxRow,
} from "./outbox-types.js";

/**
 * KJ-P2.1 PURE core. No I/O — mirrors reducer.ts's split: this file decides
 * WHAT a notification intent is and WHAT an outbox row's next state should be
 * after an attempt; `pg-outbox-store.ts`/`delivery-worker.ts` are the only
 * places any of this touches Postgres or a real transport.
 */

/** Deterministic identity for "this specific notification" — same hash style
 *  as fingerprint.ts's `fingerprintFor`, for the same reason: `\n`-separated
 *  fields, none of them user-controlled, hashed rather than concatenated
 *  raw so the primary key stays a fixed, opaque, greppable shape.
 *
 *  `fingerprint` alone is NOT enough (it identifies the *check*, and recurs
 *  across separate episodes after a recovery); `firstSeenAt` pins this to one
 *  specific episode; `kind` + `occurrenceCount` pin it to one specific moment
 *  within that episode. Together they are exactly "one specific thing worth
 *  telling someone about", computed the same way every time the same
 *  decision is reduced — so re-running the same evaluation (a Restate
 *  `ctx.run` replay, a manual CLI re-run, a crash-then-retry) always derives
 *  the SAME notification id and can never enqueue a duplicate intent for it
 *  (`on conflict (...) do nothing` at the DB — see the migration).
 */
export function deriveNotificationId(
  fingerprint: string,
  firstSeenAt: string,
  kind: AlertDecision["kind"],
  occurrenceCount: number,
): string {
  return createHash("sha256")
    .update(`${fingerprint}\n${firstSeenAt}\n${kind}\n${occurrenceCount}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

/** Every notify-worthy decision becomes exactly one intent. Decisions with
 *  `notify: false` (an explicit policy choice, e.g. legacyAuthority's B1 gap —
 *  see policy.ts) and `null` decisions (ONGOING dedup — see reducer.ts) never
 *  reach here; callers only ever pass `decisions.filter(d => d.notify)`. */
export function intentsFromDecisions(decisions: readonly AlertDecision[], now: string): NotificationIntent[] {
  return decisions
    .filter((d) => d.notify)
    .map((d) => ({
      notificationId: deriveNotificationId(d.fingerprint, d.firstSeenAt, d.kind, d.occurrenceCount),
      fingerprint: d.fingerprint,
      checkId: d.checkId,
      entityId: d.entityId,
      firstSeenAt: d.firstSeenAt,
      lastSeenAt: d.lastSeenAt,
      kind: d.kind,
      occurrenceCount: d.occurrenceCount,
      severity: d.severity,
      message: d.message,
      durationMs: d.durationMs ?? null,
      createdAt: now,
    }));
}

/** Bounded exponential backoff, deterministic (no jitter — this codebase
 *  favours pure, exactly-reproducible functions over jitter's marginal
 *  thundering-herd benefit at this scale: a few dozen checks, one operator).
 *  `attemptCount` is the attempt that JUST failed (1-based); the delay is how
 *  long to wait before the NEXT one. */
export function computeBackoffMs(attemptCount: number, config: DeliveryConfig): number {
  const doubled = config.baseDelayMs * 2 ** Math.max(0, attemptCount - 1);
  return Math.min(doubled, config.maxDelayMs);
}

export interface DeliveryDecision {
  row: NotificationOutboxRow;
  eventOutcome: DeliveryOutcome;
  errorClass: string | null;
}

/** Given the row that was just attempted (already marked SENDING with
 *  `attemptCount` incremented by the caller — see `pg-outbox-store.ts`'s
 *  `markSending`) and what the transport actually did, decide the row's next
 *  state and the event to log for THIS attempt.
 *
 *  A row that exhausts `config.maxAttempts` becomes POISON even though the
 *  underlying failure was transient — the event outcome still records
 *  `TRANSIENT_FAILURE` (that IS what happened on this attempt); POISON is the
 *  row's own status, a distinct, separately-queryable signal ("this needs a
 *  human"), not a different kind of attempt outcome. */
export function decideNextOutboxState(
  row: NotificationOutboxRow,
  attempt: DeliveryAttemptResult,
  now: string,
  config: DeliveryConfig,
): DeliveryDecision {
  const attemptCount = row.attemptCount;
  if (attempt.ok) {
    return {
      row: { ...row, status: "DELIVERED", lastAttemptAt: now, deliveredAt: now, lastError: null },
      eventOutcome: "DELIVERED",
      errorClass: null,
    };
  }
  if (attempt.permanent) {
    return {
      row: { ...row, status: "POISON", lastAttemptAt: now, lastError: attempt.errorClass },
      eventOutcome: "PERMANENT_FAILURE",
      errorClass: attempt.errorClass,
    };
  }
  if (attemptCount >= config.maxAttempts) {
    return {
      row: { ...row, status: "POISON", lastAttemptAt: now, lastError: attempt.errorClass },
      eventOutcome: "TRANSIENT_FAILURE",
      errorClass: attempt.errorClass,
    };
  }
  const delay = computeBackoffMs(attemptCount, config);
  const nextAttemptAt = new Date(Date.parse(now) + delay).toISOString();
  return {
    row: { ...row, status: "PENDING", lastAttemptAt: now, nextAttemptAt, lastError: attempt.errorClass },
    eventOutcome: "TRANSIENT_FAILURE",
    errorClass: attempt.errorClass,
  };
}

/** A SENDING row whose `lastAttemptAt` is old enough that the process which
 *  set it almost certainly crashed before recording DELIVERED/POISON/retry —
 *  "process crash after delivery but before acknowledgement", explicitly
 *  handled. Returns `null` for a row that isn't SENDING, or is SENDING but
 *  still within the in-flight window (a live attempt, not an abandoned one —
 *  the exclusive advisory lock this store is used under guarantees at most
 *  one worker instance runs at a time, so a truly live SENDING row can only
 *  belong to the CURRENT run, never a concurrent one).
 *
 *  Recovery does NOT re-increment `attemptCount` (the attempt that produced
 *  this SENDING row already counted it) and re-arms `nextAttemptAt = now` —
 *  retry immediately, not after another full backoff, since the ambiguity
 *  itself (not a transport failure) is what caused the delay. This is the
 *  point where the design is explicitly AT-LEAST-ONCE, not exactly-once: the
 *  original attempt may in fact have reached the transport and even
 *  succeeded there — this system cannot tell, so it fails open toward
 *  re-delivery rather than silently losing the notification. A future real
 *  transport that wants to avoid operator-visible duplicates should use
 *  `notificationId` as its own idempotency key where the transport supports
 *  one (see the KJ-P2.1 design doc). */
export function recoverIfStaleSending(
  row: NotificationOutboxRow,
  now: string,
  config: DeliveryConfig,
): DeliveryDecision | null {
  if (row.status !== "SENDING" || row.lastAttemptAt === null) return null;
  const ageMs = Date.parse(now) - Date.parse(row.lastAttemptAt);
  if (ageMs < config.staleSendingMs) return null;
  return {
    row: { ...row, status: "PENDING", nextAttemptAt: now },
    eventOutcome: "AMBIGUOUS_RECOVERED",
    errorClass: null,
  };
}
