import { decideNextOutboxState, recoverIfStaleSending } from "./outbox.js";
import type { NotificationOutboxStore } from "./outbox-store.js";
import {
  DEFAULT_DELIVERY_CONFIG,
  PermanentDeliveryError,
  type DeliveryAttemptResult,
  type DeliveryConfig,
  type DeliverySummary,
  type NotificationOutboxRow,
  type NotificationPayload,
  type Notifier,
} from "./outbox-types.js";

export interface DeliveryWorkerDeps {
  outbox: NotificationOutboxStore;
  notifier: Notifier;
  /** Recorded on every `notification_delivery_events` row this run writes —
   *  which concrete transport actually attempted delivery (e.g. "console"). */
  transport: string;
  config?: DeliveryConfig;
  now?: () => Date;
  /** Cap on PENDING-and-due rows drained in one call — this phase's scale
   *  (a few dozen checks) makes 50 generous, not a real limit in practice. */
  limit?: number;
}

/**
 * KJ-P2.1 — the delivery worker: the thin async shell around `outbox.ts`'s
 * pure core. Two phases, both idempotent and safe to re-run from any crash
 * point (that IS the point):
 *
 *  1. Recover abandoned SENDING rows (a prior run crashed between claiming a
 *     row and recording its outcome — see `recoverIfStaleSending`).
 *  2. Drain PENDING rows that are due, attempting delivery and persisting the
 *     outcome (DELIVERED / retry-later / POISON) via `decideNextOutboxState`.
 *
 * Deliberately NOT part of `runAlertEngine`'s transaction (see engine.ts) —
 * this is the whole fix: intent persistence and delivery are two separate,
 * independently-recoverable steps. `runner.ts`'s `runMonitor` calls this
 * immediately after the alert-engine phase, inside the SAME exclusive-lock
 * run (see runner-postgres.ts) so there is still only one Restate tick / one
 * lock / one scheduler-adjacent recurring service — not a second one.
 *
 * Guarantee: AT-LEAST-ONCE delivery with an idempotency key
 * (`NotificationPayload.notificationId`), NOT exactly-once. A crash between a
 * transport call succeeding and this worker recording DELIVERED is
 * genuinely ambiguous — this system cannot know whether the transport
 * received the message — so `recoverIfStaleSending` fails OPEN toward
 * re-delivery rather than silently losing it. `ConsoleNotifier` makes a
 * duplicate print harmless; a real paging transport (P2.2) that cares should
 * use `notificationId` as its own dedup key where the transport supports one.
 */
export async function runDeliveryWorker(deps: DeliveryWorkerDeps): Promise<DeliverySummary> {
  const now = deps.now ?? (() => new Date());
  const start = now();
  const config = deps.config ?? DEFAULT_DELIVERY_CONFIG;
  const summary: DeliverySummary = {
    startedAt: start.toISOString(),
    completedAt: start.toISOString(),
    durationMs: 0,
    recovered: 0,
    attempted: 0,
    delivered: 0,
    retried: 0,
    poisoned: 0,
    result: "OK",
  };
  try {
    const nowIso = start.toISOString();

    const stale = await deps.outbox.listStaleSending(nowIso, config.staleSendingMs);
    for (const row of stale) {
      const decision = recoverIfStaleSending(row, nowIso, config);
      // A `null` here means the row stopped being stale between the list
      // query and this loop (extremely unlikely under the exclusive lock
      // every caller holds, but not impossible with a borderline age) — a
      // safe no-op, not an error.
      if (!decision) continue;
      await deps.outbox.applyOutcome(decision.row, decision.eventOutcome, decision.errorClass, row.attemptCount, nowIso, deps.transport);
      summary.recovered++;
    }

    const due = await deps.outbox.listDue(nowIso, deps.limit ?? 50);
    for (const dueRow of due) {
      const claimed = await deps.outbox.markSending(dueRow.notificationId, nowIso);
      // `markSending` re-checks eligibility (status/next_attempt_at) at claim
      // time — `null` means another path already claimed or resolved it
      // since the list query; skip, never re-attempt what we didn't claim.
      if (!claimed) continue;
      summary.attempted++;
      const attempt = await attemptDelivery(deps.notifier, claimed);
      const decision = decideNextOutboxState(claimed, attempt, nowIso, config);
      await deps.outbox.applyOutcome(decision.row, decision.eventOutcome, decision.errorClass, claimed.attemptCount, nowIso, deps.transport);
      if (decision.row.status === "DELIVERED") summary.delivered++;
      else if (decision.row.status === "POISON") summary.poisoned++;
      else summary.retried++;
    }
  } catch {
    summary.result = "OUTBOX_FAILED";
  }
  const end = now();
  summary.completedAt = end.toISOString();
  summary.durationMs = Math.max(0, end.getTime() - start.getTime());
  return summary;
}

/** Never forward a check's raw message text to a transport — it can contain
 *  URLs or other observation data (the same discipline runner.ts's old
 *  inline notify loop applied: "Collector errors can contain URLs. Never
 *  pass raw observations/messages to stdout or future transports."). The
 *  REAL message stays durable on the outbox row (queryable for operator
 *  debugging — see `notification_outbox.message`); only this synthetic,
 *  safe summary is ever handed to `notifier.notify()`. */
function rowToPayload(row: NotificationOutboxRow): NotificationPayload {
  const {
    status: _status,
    attemptCount: _attemptCount,
    createdAt: _createdAt,
    lastAttemptAt: _lastAttemptAt,
    nextAttemptAt: _nextAttemptAt,
    deliveredAt: _deliveredAt,
    lastError: _lastError,
    ...payload
  } = row;
  return { ...payload, message: `${row.checkId}: ${row.kind} (${row.severity})` };
}

async function attemptDelivery(notifier: Notifier, row: NotificationOutboxRow): Promise<DeliveryAttemptResult> {
  try {
    await notifier.notify(rowToPayload(row));
    return { ok: true };
  } catch (err) {
    return { ok: false, permanent: err instanceof PermanentDeliveryError, errorClass: classifyError(err) };
  }
}

/** Never persist a raw error message/stack — same discipline as runner.ts's
 *  collection/notifier failure handling elsewhere in this module (a
 *  transport error can contain URLs/tokens). Only a stable class name is
 *  written to `notification_outbox.last_error` / `notification_delivery_events`. */
function classifyError(err: unknown): string {
  return err instanceof Error ? err.constructor.name : "UnknownError";
}
