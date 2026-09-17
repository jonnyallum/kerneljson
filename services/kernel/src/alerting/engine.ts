import { reduceChecks } from "./reducer.js";
import { fingerprintFor, resolveEntityId } from "./fingerprint.js";
import { intentsFromDecisions } from "./outbox.js";
import type { AlertStateStore } from "./state-store.js";
import type { AlertDecision, AlertStateRow } from "./types.js";
import type { CheckResult, DomainResult, HealthReport } from "../health/types.js";

export interface AlertEngineOptions {
  store: AlertStateStore;
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
 * existing state, and persist the next state PLUS every notify-worthy
 * decision's durable intent, atomically, in one call to `store.putAll` (see
 * that method's own header on `PgAlertStateStore`/`InMemoryAlertStateStore`
 * for why this must be one commit). Works with `InMemoryAlertStateStore` and
 * no external backend at all — alerting never depends on wiring one to
 * produce a correct decision.
 *
 * KJ-P2.1: this function no longer calls a `Notifier` directly. Actually
 * delivering a queued intent is a separate, later, idempotent step — see
 * `delivery-worker.ts` — deliberately decoupled from this transaction, since
 * coupling "committed state" to "attempted delivery" in one place was
 * exactly the bug (a crash or transport failure between the two could lose
 * the notification silently). `runner.ts`'s `runMonitor` and `cli.ts` both
 * call the delivery worker as their own explicit next step after this.
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
  const intents = intentsFromDecisions(decisions, now);
  await options.store.putAll(nextRows, intents);
  return { decisions, nextRows };
}
