import type { HealthReport, HealthStatus } from "../health/types.js";
import { runAlertEngine } from "./engine.js";
import { runDeliveryWorker } from "./delivery-worker.js";
import type { AlertStateStore } from "./state-store.js";
import type { NotificationOutboxStore } from "./outbox-store.js";
import type { AlertSeverity } from "./types.js";
import type { DeliveryConfig, Notifier } from "./outbox-types.js";

export interface RunSummary {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  overall: HealthStatus | null;
  decisionCounts: Record<AlertSeverity, number>;
  /** Notify-worthy decisions this run turned into a NEW durable outbox
   *  intent (0 for a dedup/ONGOING run, or a run whose insert lost the
   *  `on conflict do nothing` race against an identical replay). */
  notificationsQueued: number;
  /** What the delivery-worker phase did THIS run — may include rows a PRIOR
   *  run queued but never delivered (that's the crash-recovery case this
   *  whole design exists for), not only rows queued in this same run. */
  delivery: {
    recovered: number;
    attempted: number;
    delivered: number;
    retried: number;
    poisoned: number;
  };
  result:
    | "OK"
    | "OVERLAP_SKIPPED"
    | "COLLECTION_FAILED"
    | "STATE_FAILED"
    | "DELIVERY_FAILED";
}

export interface RunnerDeps {
  collect: () => Promise<HealthReport>;
  // false means another invocation owns the database-wide monitor lock.
  // KJ-P2.1: the callback now also receives the outbox store bound to the
  // SAME locked session as `store` — delivery for THIS run's queued intents
  // (and any prior run's orphaned ones) happens inside the same exclusive
  // window, so there's still one lock / one Restate tick, not a second one.
  exclusive: (
    run: (store: AlertStateStore, outbox: NotificationOutboxStore) => Promise<void>,
  ) => Promise<boolean>;
  notifier: Notifier;
  /** Recorded on every delivery-events row this run writes — see
   *  delivery-worker.ts's `DeliveryWorkerDeps.transport`. */
  transport: string;
  canonicalScheduleId: string;
  deliveryConfig?: DeliveryConfig;
  now?: () => Date;
}

/**
 * One observational attempt: evaluate health, persist alert state + any new
 * notification intents atomically (see engine.ts), THEN drain the outbox
 * (see delivery-worker.ts). Errors are categories, never raw credential-bearing
 * text.
 *
 * KJ-P2.1: this function no longer calls a notifier inline per decision —
 * that coupling (state committed before delivery even attempted, with
 * nothing durable in between) was the bug. Delivery is now the second,
 * independently-recoverable phase below, run unconditionally after a
 * successful evaluation — even a run with zero new decisions still drains
 * the outbox, because a PRIOR run may have queued an intent it never got to
 * deliver (e.g. it crashed right after committing — see
 * tests/alert-runner.test.ts's crash-after-commit-replay test).
 */
export async function runMonitor(deps: RunnerDeps): Promise<RunSummary> {
  const now = deps.now ?? (() => new Date());
  const start = now();
  const summary: RunSummary = {
    startedAt: start.toISOString(),
    completedAt: start.toISOString(),
    durationMs: 0,
    overall: null,
    decisionCounts: { P0: 0, P1: 0, P2: 0, P3: 0 },
    notificationsQueued: 0,
    delivery: { recovered: 0, attempted: 0, delivered: 0, retried: 0, poisoned: 0 },
    result: "OK",
  };
  try {
    const acquired = await deps.exclusive(async (store, outbox) => {
      let report: HealthReport;
      try {
        report = await deps.collect();
      } catch {
        summary.result = "COLLECTION_FAILED";
        return;
      }
      summary.overall = report.overall;
      // Persist ALL decisions (state + outbox intents) atomically before ANY
      // delivery attempt, preserving P1.2's episode semantics while closing
      // the KJ-P2.1 seam.
      const { decisions } = await runAlertEngine(report, {
        store,
        canonicalScheduleId: deps.canonicalScheduleId,
        now,
      });
      for (const decision of decisions) {
        summary.decisionCounts[decision.severity]++;
        if (decision.notify) summary.notificationsQueued++;
      }
      const delivery = await runDeliveryWorker({
        outbox,
        notifier: deps.notifier,
        transport: deps.transport,
        now,
        ...(deps.deliveryConfig ? { config: deps.deliveryConfig } : {}),
      });
      summary.delivery = {
        recovered: delivery.recovered,
        attempted: delivery.attempted,
        delivered: delivery.delivered,
        retried: delivery.retried,
        poisoned: delivery.poisoned,
      };
      if (delivery.result !== "OK") summary.result = "DELIVERY_FAILED";
    });
    if (!acquired) summary.result = "OVERLAP_SKIPPED";
  } catch {
    summary.result = "STATE_FAILED";
  }
  const end = now();
  summary.completedAt = end.toISOString();
  summary.durationMs = Math.max(0, end.getTime() - start.getTime());
  return summary;
}
