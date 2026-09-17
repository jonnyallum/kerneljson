import type pg from "pg";
import type { AlertSeverity, AlertStateRow } from "./types.js";
import type { NotificationIntent } from "./outbox-types.js";

/**
 * Thrown by `probe()` specifically when `kernel_private.alert_state` does not
 * exist (Postgres `42P01 undefined_table`) — i.e. the KJ-P1.2 migration
 * (`supabase/migrations/20260915220000_alert_state.sql`) has not been applied to
 * this database. Any OTHER failure (a genuine connectivity/auth problem) is
 * deliberately left as its original error, not relabelled as this — conflating
 * "wrong problem" with "migration missing" would make a real outage harder to
 * diagnose. Callers (see `select-store.ts`) MUST let this propagate, never catch
 * it to silently substitute `InMemoryAlertStateStore` — see that file's header.
 */
export class AlertStateStoreUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      "kernel_private.alert_state is not available — the KJ-P1.2 migration " +
        "(supabase/migrations/20260915220000_alert_state.sql) has not been applied " +
        "to this database. Refusing to silently fall back to ephemeral state; pass " +
        'ALERT_STATE_STORE=memory explicitly if that is genuinely what you want ' +
        "(local/dev/smoke work only — never production).",
      { cause },
    );
    this.name = "AlertStateStoreUnavailableError";
  }
}

/**
 * Postgres-backed `AlertStateStore`, against `kernel_private.alert_state`
 * (see `supabase/migrations/20260915220000_alert_state.sql`).
 *
 * This IS the canonical store `kerneljson alerts` wires when
 * `ALERT_STATE_STORE=postgres` (the default — see `select-store.ts`). The
 * production migration was activated in KJ-P1.2A (2026-09-16). `probe()` still
 * rejects missing tables in any target instead of degrading to in-memory state.
 * A supplied PoolClient remains caller-owned, allowing the runner to hold its
 * advisory lock and perform all alert-state I/O on the same session.
 */
export class PgAlertStateStore {
  constructor(private readonly pool: pg.Pool | pg.PoolClient) {}

  /** Cheap existence check. Throws `AlertStateStoreUnavailableError` if the
   *  table doesn't exist; rethrows any other error unchanged. Never swallows,
   *  never returns a "maybe it's fine" result — callers act on success/throw only. */
  async probe(): Promise<void> {
    try {
      await this.pool.query("select 1 from kernel_private.alert_state limit 1");
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === "42P01") throw new AlertStateStoreUnavailableError(err);
      throw err;
    }
  }

  async getAll(): Promise<AlertStateRow[]> {
    const res = await this.pool.query(
      `select fingerprint, check_id, entity_id, severity, current_state,
              first_seen_at, last_seen_at, last_notified_at, occurrence_count, recovered_at
       from kernel_private.alert_state`,
    );
    return res.rows.map(rowToState);
  }

  /**
   * `intents` (KJ-P2.1): notification intents derived from THIS SAME batch of
   * decisions (see engine.ts), inserted into `kernel_private.notification_outbox`
   * inside the identical transaction as the `alert_state` upsert below. This
   * is the fix for the seam KJ-P2.1 closes: before this, `lastNotifiedAt` on
   * the state row was committed with nothing durable recording that a
   * notification was actually owed, so a crash or transport failure between
   * that commit and delivery could lose the notification silently (the
   * reducer's own dedup then refuses to re-emit a decision for the
   * still-open episode — see reducer.ts). Now the outbox row commits
   * atomically with the state row: a crash right after this function returns
   * can never leave "state says notified" without a durable, replayable
   * intent behind it. Delivery itself is a separate, later, idempotent step
   * (see delivery-worker.ts) — deliberately NOT part of this transaction,
   * since that's the exact coupling being removed.
   *
   * Defaults to `[]` so every pre-existing call site (`store.putAll(rows)`)
   * is byte-identical in behaviour — this is an additive capability, not a
   * changed contract for callers that don't use it.
   *
   * Keep the insert below in sync with `pg-outbox-store.ts`'s `insertIntent`
   * (same statement, duplicated deliberately so this transaction doesn't
   * need to reach across pool-bound objects — see that file's header).
   */
  async putAll(rows: readonly AlertStateRow[], intents: readonly NotificationIntent[] = []): Promise<void> {
    if (rows.length === 0 && intents.length === 0) return;
    const owned = !("release" in this.pool);
    const client = owned ? await (this.pool as pg.Pool).connect() : this.pool as pg.PoolClient;
    try {
      await client.query("begin");
      for (const row of rows) {
        await client.query(
          `insert into kernel_private.alert_state
             (fingerprint, check_id, entity_id, severity, current_state,
              first_seen_at, last_seen_at, last_notified_at, occurrence_count, recovered_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           on conflict (fingerprint) do update set
             severity = excluded.severity,
             current_state = excluded.current_state,
             last_seen_at = excluded.last_seen_at,
             last_notified_at = excluded.last_notified_at,
             occurrence_count = excluded.occurrence_count,
             recovered_at = excluded.recovered_at,
             first_seen_at = excluded.first_seen_at`,
          [
            row.fingerprint,
            row.checkId,
            row.entityId,
            row.severity,
            row.currentState,
            row.firstSeenAt,
            row.lastSeenAt,
            row.lastNotifiedAt,
            row.occurrenceCount,
            row.recoveredAt,
          ],
        );
      }
      for (const intent of intents) {
        await client.query(
          `insert into kernel_private.notification_outbox
             (notification_id, fingerprint, check_id, entity_id, first_seen_at, last_seen_at,
              kind, occurrence_count, severity, message, duration_ms,
              status, attempt_count, created_at, last_attempt_at, next_attempt_at, delivered_at, last_error)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PENDING',0,$12,null,$12,null,null)
           on conflict (notification_id) do nothing`,
          [
            intent.notificationId,
            intent.fingerprint,
            intent.checkId,
            intent.entityId,
            intent.firstSeenAt,
            intent.lastSeenAt,
            intent.kind,
            intent.occurrenceCount,
            intent.severity,
            intent.message,
            intent.durationMs,
            intent.createdAt,
          ],
        );
      }
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      if (owned) client.release();
    }
  }
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

function rowToState(r: Record<string, unknown>): AlertStateRow {
  return {
    fingerprint: String(r["fingerprint"]),
    checkId: String(r["check_id"]),
    entityId: String(r["entity_id"]),
    severity: String(r["severity"]) as AlertSeverity,
    currentState: String(r["current_state"]) as AlertStateRow["currentState"],
    firstSeenAt: iso(r["first_seen_at"]),
    lastSeenAt: iso(r["last_seen_at"]),
    lastNotifiedAt: r["last_notified_at"] ? iso(r["last_notified_at"]) : null,
    occurrenceCount: Number(r["occurrence_count"]),
    recoveredAt: r["recovered_at"] ? iso(r["recovered_at"]) : null,
  };
}
