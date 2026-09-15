import type pg from "pg";
import type { AlertSeverity, AlertStateRow } from "./types.js";

/**
 * Postgres-backed `AlertStateStore`, against `kernel_private.alert_state`
 * (see `supabase/migrations/20260915220000_alert_state.sql`).
 *
 * PREPARED, NOT DEPLOYED: this class is complete and typed against the real
 * schema, but the migration it depends on has not been applied to production in
 * this phase, and nothing in KJ-P1.2 constructs/uses this class against a live
 * database. It exists so the persistence design is concrete and reviewable now,
 * with no further code changes needed when applying the migration is later
 * explicitly authorised — only a config wire-up (`config.ts` picking this store
 * instead of `InMemoryAlertStateStore`).
 */
export class PgAlertStateStore {
  constructor(private readonly pool: pg.Pool) {}

  async getAll(): Promise<AlertStateRow[]> {
    const res = await this.pool.query(
      `select fingerprint, check_id, entity_id, severity, current_state,
              first_seen_at, last_seen_at, last_notified_at, occurrence_count, recovered_at
       from kernel_private.alert_state`,
    );
    return res.rows.map(rowToState);
  }

  async putAll(rows: readonly AlertStateRow[]): Promise<void> {
    if (rows.length === 0) return;
    const client = await this.pool.connect();
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
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
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
