import type { AlertDecision, AlertSeverity } from "./types.js";

/**
 * KJ-P2.1 — reliable notification delivery, shared types.
 *
 * Mirrors the P1.2 split (pure reducer / thin async shell): `outbox.ts` is the
 * PURE core (no I/O) that turns notify-worthy `AlertDecision`s into durable
 * `NotificationIntent`s, and later turns a delivery attempt's outcome into the
 * outbox row's next state. `pg-outbox-store.ts`/`delivery-worker.ts` are the
 * only places any of this touches Postgres or a real transport.
 *
 * The outbox row's identity (`notificationId`) is deliberately NOT the alert
 * episode's fingerprint: a single open episode can produce several distinct
 * notifications over its lifetime (NEW, ESCALATED, DEESCALATED, RECOVERED),
 * each of which is a separate thing worth telling someone about, and the SAME
 * fingerprint recurs across episodes (recurrence after recovery resets
 * `firstSeenAt`/`occurrenceCount` — see reducer.ts). `firstSeenAt` pins the
 * notification to one specific episode; `kind`+`occurrenceCount` pin it to one
 * specific moment within that episode.
 */

export const OUTBOX_STATUSES = ["PENDING", "SENDING", "DELIVERED", "POISON"] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const DELIVERY_OUTCOMES = [
  "DELIVERED",
  "TRANSIENT_FAILURE",
  "PERMANENT_FAILURE",
  "AMBIGUOUS_RECOVERED",
] as const;
export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number];

/**
 * Everything a transport needs to render a human-facing notification, frozen
 * at the moment the intent was queued. Deliberately a durable SNAPSHOT, not a
 * live reference to the `AlertDecision` that produced it — by the time
 * delivery actually runs (a separate, later, possibly-retried step), that
 * decision object no longer exists; only what was persisted does. Carries
 * `checkId`/`entityId`/`lastSeenAt`/`durationMs` (absent from `AlertStateRow`
 * itself) specifically so `format.ts`'s formatter can reproduce the exact
 * same message a live decision would have, from durable data alone.
 */
export interface NotificationPayload {
  notificationId: string;
  fingerprint: string;
  checkId: string;
  entityId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  kind: AlertDecision["kind"];
  occurrenceCount: number;
  severity: AlertSeverity;
  message: string;
  /** Only meaningful for `kind: "RECOVERED"`; `null` otherwise. */
  durationMs: number | null;
}

/** The durable, replay-safe unit of "we decided this is worth telling someone
 *  about" — derived once from a notify-worthy `AlertDecision`, never mutated. */
export interface NotificationIntent extends NotificationPayload {
  /** Stamped by `intentsFromDecisions` using the SAME injectable `now` the
   *  caller already threads through the alert engine (see engine.ts) — never
   *  computed fresh inside a store, so a test with a fixed clock produces a
   *  fully deterministic outbox row, exactly like every other timestamp in
   *  this module. */
  createdAt: string;
}

/**
 * A delivery transport. Moved here from `types.ts` (KJ-P2.1): a notifier is
 * now called only by `delivery-worker.ts`, against a durable
 * `NotificationPayload` reconstructed from an outbox row — never directly
 * against a live `AlertDecision` (see engine.ts's header for why that
 * coupling was the bug). `ConsoleNotifier`/`RecordingNotifier`
 * (notifier.ts) are unchanged in spirit — "console notifier remains
 * supported" — only their input type narrowed to what's actually durable.
 */
export interface Notifier {
  notify(payload: NotificationPayload): Promise<void>;
}

/** A transport throws this to signal a failure it KNOWS is unrecoverable
 *  (e.g. a future real transport rejecting a malformed/unknown recipient) —
 *  `delivery-worker.ts` classifies it as `permanent: true` and the row goes
 *  straight to POISON without burning through the retry budget. Any other
 *  thrown error is treated as transient (retried with backoff until
 *  `maxAttempts`). Nothing in KJ-P2.1 throws this yet — `ConsoleNotifier`
 *  never fails — but the hook exists now so a real transport (P2.2) can
 *  signal permanence without another `Notifier` interface change. */
export class PermanentDeliveryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PermanentDeliveryError";
  }
}

/** One row per `NotificationIntent`. Mutable (status/attempt bookkeeping is
 *  upserted as delivery progresses), unlike `notification_delivery_events`. */
export interface NotificationOutboxRow extends NotificationIntent {
  status: OutboxStatus;
  attemptCount: number;
  createdAt: string;
  lastAttemptAt: string | null;
  nextAttemptAt: string;
  deliveredAt: string | null;
  lastError: string | null;
}

/** What actually happened when a transport was called. `RecordingNotifier`/
 *  `ConsoleNotifier` (the only wired transports today) never fail, so `ok` is
 *  the common case in practice — this shape exists for the transports P2.2
 *  will add, and is exercised directly by the pure `decideNextOutboxState`
 *  tests without needing a flaky real transport. */
export type DeliveryAttemptResult =
  | { ok: true }
  | { ok: false; permanent: boolean; errorClass: string };

/** One row per delivery ATTEMPT (not one row per outbox intent) — the
 *  append-only audit trail `notification_delivery_events` persists. */
export interface DeliveryEvent {
  notificationId: string;
  attemptNumber: number;
  attemptedAt: string;
  outcome: DeliveryOutcome;
  errorClass: string | null;
  transport: string;
}

export interface DeliveryConfig {
  /** First retry delay after a transient failure. */
  baseDelayMs: number;
  /** Backoff never exceeds this, however many attempts have failed. */
  maxDelayMs: number;
  /** attemptCount reaching this without a DELIVERED outcome -> POISON. */
  maxAttempts: number;
  /** A SENDING row with `lastAttemptAt` older than this is treated as an
   *  abandoned attempt (the process that set SENDING almost certainly
   *  crashed before it could record DELIVERED/POISON/retry) and is recovered
   *  back to PENDING — see "process crash after delivery but before
   *  acknowledgement" in the KJ-P2.1 design doc. */
  staleSendingMs: number;
}

export const DEFAULT_DELIVERY_CONFIG: DeliveryConfig = {
  baseDelayMs: 5_000,
  maxDelayMs: 300_000,
  maxAttempts: 8,
  staleSendingMs: 120_000,
};

export interface DeliverySummary {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  recovered: number;
  attempted: number;
  delivered: number;
  retried: number;
  poisoned: number;
  result: "OK" | "OVERLAP_SKIPPED" | "OUTBOX_FAILED";
}
