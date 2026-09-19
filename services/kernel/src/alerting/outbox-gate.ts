import type pg from "pg";

/**
 * KJ-P2.2B — the POISON activation gate.
 *
 * KJ-P2.1 deliberately has no automatic POISON health check, and this phase does
 * not build one. For the Telegram activation window ONLY, this read-only gate is
 * run at fixed points (pre-window baseline, after the test delivery, after each
 * natural tick). Any failure means STOP and roll the transport back to console.
 *
 * Read-only by construction: it issues SELECTs against
 * `kernel_private.notification_outbox` / `notification_delivery_events` and nothing else.
 * It reads no message text and no credential: statuses, counts, ages and the
 * stable `last_error` class names only.
 */
export interface OutboxGateInput {
  counts: Record<string, number>;
  oldestPendingAgeMs: number | null;
  oldestSendingAgeMs: number | null;
  /** Notifications with more than one DELIVERED event: a duplicate send. */
  duplicateDelivered: number;
  poisonErrorClasses: Record<string, number>;
}

export interface OutboxGateOptions {
  baselinePoison: number;
  /** A SENDING row older than this was abandoned mid-attempt. */
  maxSendingAgeMs?: number;
  /** A PENDING row older than this was not picked up by a natural tick. */
  maxPendingAgeMs?: number;
}

export interface OutboxGateVerdict {
  pass: boolean;
  failures: string[];
}

export const DEFAULT_MAX_SENDING_AGE_MS = 120_000;
/** Two 300s ticks plus a minute of slack. */
export const DEFAULT_MAX_PENDING_AGE_MS = 660_000;

export function evaluateOutboxGate(input: OutboxGateInput, options: OutboxGateOptions): OutboxGateVerdict {
  const failures: string[] = [];
  const poison = input.counts["POISON"] ?? 0;
  if (poison > options.baselinePoison) {
    const classes = Object.entries(input.poisonErrorClasses).map(([k, v]) => `${k}=${v}`).join(",") || "unknown";
    failures.push(`POISON rose from baseline ${options.baselinePoison} to ${poison} (error classes: ${classes})`);
  }
  const maxSending = options.maxSendingAgeMs ?? DEFAULT_MAX_SENDING_AGE_MS;
  if (input.oldestSendingAgeMs !== null && input.oldestSendingAgeMs > maxSending) {
    failures.push(`SENDING row stuck for ${Math.round(input.oldestSendingAgeMs / 1000)}s (limit ${maxSending / 1000}s)`);
  }
  const maxPending = options.maxPendingAgeMs ?? DEFAULT_MAX_PENDING_AGE_MS;
  if (input.oldestPendingAgeMs !== null && input.oldestPendingAgeMs > maxPending) {
    failures.push(`PENDING row not delivered for ${Math.round(input.oldestPendingAgeMs / 1000)}s (limit ${maxPending / 1000}s)`);
  }
  if (input.duplicateDelivered > 0) {
    failures.push(`${input.duplicateDelivered} notification(s) have more than one DELIVERED event (duplicate send)`);
  }
  return { pass: failures.length === 0, failures };
}

export async function readOutboxGateInput(pool: pg.Pool, now: Date = new Date()): Promise<OutboxGateInput> {
  const counts: Record<string, number> = {};
  const byStatus = await pool.query<{ status: string; n: number }>(
    "select status, count(*)::int as n from kernel_private.notification_outbox group by status",
  );
  for (const r of byStatus.rows) counts[r.status] = r.n;
  const ages = await pool.query<{ pending: Date | null; sending: Date | null }>(
    `select min(created_at) filter (where status = 'PENDING') as pending,
            min(last_attempt_at) filter (where status = 'SENDING') as sending
     from kernel_private.notification_outbox`,
  );
  const age = (d: Date | null | undefined): number | null => (d ? Math.max(0, now.getTime() - new Date(d).getTime()) : null);
  const dup = await pool.query<{ n: number }>(
    `select count(*)::int as n from (
       select notification_id from kernel_private.notification_delivery_events
       where outcome = 'DELIVERED' group by notification_id having count(*) > 1) d`,
  );
  const classes = await pool.query<{ last_error: string | null; n: number }>(
    "select last_error, count(*)::int as n from kernel_private.notification_outbox where status = 'POISON' group by last_error",
  );
  return {
    counts,
    oldestPendingAgeMs: age(ages.rows[0]?.pending),
    oldestSendingAgeMs: age(ages.rows[0]?.sending),
    duplicateDelivered: dup.rows[0]?.n ?? 0,
    poisonErrorClasses: Object.fromEntries(classes.rows.map((r) => [r.last_error ?? "unknown", r.n])),
  };
}
