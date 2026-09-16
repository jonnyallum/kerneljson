import type { HealthReport, HealthStatus } from "../health/types.js";
import { runAlertEngine } from "./engine.js";
import type { AlertStateStore } from "./state-store.js";
import type { AlertSeverity, Notifier } from "./types.js";

export interface RunSummary {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  overall: HealthStatus | null;
  decisionCounts: Record<AlertSeverity, number>;
  notificationsAttempted: number;
  notificationsFailed: number;
  result:
    | "OK"
    | "OVERLAP_SKIPPED"
    | "COLLECTION_FAILED"
    | "STATE_FAILED"
    | "NOTIFIER_FAILED";
}

export interface RunnerDeps {
  collect: () => Promise<HealthReport>;
  // false means another invocation owns the database-wide monitor lock.
  exclusive: (
    run: (store: AlertStateStore) => Promise<void>,
  ) => Promise<boolean>;
  notifier: Notifier;
  canonicalScheduleId: string;
  now?: () => Date;
}

/** One observational attempt. Errors are categories, never raw credential-bearing text. */
export async function runMonitor(deps: RunnerDeps): Promise<RunSummary> {
  const now = deps.now ?? (() => new Date());
  const start = now();
  const summary: RunSummary = {
    startedAt: start.toISOString(),
    completedAt: start.toISOString(),
    durationMs: 0,
    overall: null,
    decisionCounts: { P0: 0, P1: 0, P2: 0, P3: 0 },
    notificationsAttempted: 0,
    notificationsFailed: 0,
    result: "OK",
  };
  try {
    const acquired = await deps.exclusive(async (store) => {
      let report: HealthReport;
      try {
        report = await deps.collect();
      } catch {
        summary.result = "COLLECTION_FAILED";
        return;
      }
      summary.overall = report.overall;
      // Persist ALL decisions before ANY notification, preserving P1.2 semantics.
      const { decisions } = await runAlertEngine(report, {
        store,
        canonicalScheduleId: deps.canonicalScheduleId,
        now,
      });
      for (const decision of decisions) {
        summary.decisionCounts[decision.severity]++;
        if (!decision.notify) continue;
        summary.notificationsAttempted++;
        try {
          // Collector errors can contain URLs. Never pass raw observations/messages
          // to stdout or future transports. Keep the policy identity and lifecycle.
          await deps.notifier.notify({
            ...decision,
            observed: undefined,
            message: `${decision.checkId}: ${decision.kind} (${decision.severity})`,
          });
        } catch {
          summary.notificationsFailed++;
        }
      }
      if (summary.notificationsFailed) summary.result = "NOTIFIER_FAILED";
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
