import { reduceChecks } from "./reducer.js";
import { fingerprintFor, resolveEntityId } from "./fingerprint.js";
import type { AlertStateStore } from "./state-store.js";
import type { AlertDecision, AlertStateRow, Notifier } from "./types.js";
import type { CheckResult, DomainResult, HealthReport } from "../health/types.js";

export interface AlertEngineOptions {
  store: AlertStateStore;
  /** Optional — the engine produces correct decisions with no notifier at all;
   *  this is purely "also send these somewhere". */
  notifier?: Notifier;
  canonicalScheduleId: string;
  now?: () => Date;
}

function allChecks(report: HealthReport): CheckResult[] {
  const out: CheckResult[] = [];
  for (const domain of Object.values(report.domains) as DomainResult[]) out.push(...domain.checks);
  return out;
}

/**
 * Run the alert engine for one health report: reduce every check against
 * existing state, persist the next state, and notify for every decision with
 * `notify: true`. Works with `InMemoryAlertStateStore` and no notifier at all —
 * alerting never depends on an external backend to produce a correct decision.
 */
export async function runAlertEngine(
  report: HealthReport,
  options: AlertEngineOptions,
): Promise<{ decisions: AlertDecision[]; nextRows: AlertStateRow[] }> {
  const now = (options.now?.() ?? new Date()).toISOString();
  const checks = allChecks(report);
  const existingRows = await options.store.getAll();
  const existingByFingerprint = new Map(
    existingRows.map((row) => [
      // Re-derive the fingerprint from the row's own (checkId, entityId) rather
      // than trusting a possibly-stale stored fingerprint column, so a
      // fingerprinting-scheme change is self-healing rather than silently stale.
      fingerprintFor(row.checkId, resolveEntityId(row.checkId, options.canonicalScheduleId)),
      row,
    ]),
  );
  const { nextRows, decisions } = reduceChecks(checks, existingByFingerprint, options.canonicalScheduleId, now);
  await options.store.putAll(nextRows);
  if (options.notifier) {
    for (const decision of decisions) {
      if (decision.notify) await options.notifier.notify(decision);
    }
  }
  return { decisions, nextRows };
}
