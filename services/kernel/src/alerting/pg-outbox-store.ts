import type pg from "pg";
import type { NotificationOutboxStore } from "./outbox-store.js";
import type {
  DeliveryOutcome,
  NotificationIntent,
  NotificationOutboxRow,
} from "./outbox-types.js";

/** Same shape/contract as `AlertStateStoreUnavailableError` (pg-state-store.ts)
 *  — thrown by `probe()` specifically when `kernel_private.notification_outbox`
 *  is missing (the KJ-P2.1 migration not applied), never for any other
 *  failure. Callers must let this propagate, never substitute an in-memory
 *  fallback for it — see that file's header for the full rationale. */
export class NotificationOutboxUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      "kernel_private.notification_outbox is not available — the KJ-P2.1 migration " +
        "(supabase/migrations/20260917120000_notification_outbox.sql) has not been " +
        "applied to this database. Refusing to silently drop notification intents.",
      { cause },
    );
    this.name = "NotificationOutboxUnavailableError";
  }
}

/** Postgres-backed `NotificationOutboxStore`, against
 *  `kernel_private.notification_outbox` / `kernel_private.notification_delivery_events`
 *  (see `supabase/migrations/20260917120000_notification_outbox.sql`).
 *
 *  `enqueue` here is used directly only by callers that don't need
 *  transactional atomicity with an `alert_state` write (the delivery worker
 *  itself never enqueues). The production intent-persistence path
 *  (`PgAlertStateStore.putAll`) does NOT call this method — it inlines the
 *  identical insert inside its own `alert_state` transaction so the two
 *  commits are atomic. Keep the two insert statements in sync; see
 *  `pg-state-store.ts`'s `putAll` for the paired copy. */
export class PgNotificationOutboxStore implements NotificationOutboxStore {
  constructor(private readonly pool: pg.Pool | pg.PoolClient) {}

  async probe(): Promise<void> {
    try {
      await this.pool.query("select 1 from kernel_private.notification_outbox limit 1");
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === "42P01") throw new NotificationOutboxUnavailableError(err);
      throw err;
    }
  }

  async enqueue(intents: readonly NotificationIntent[]): Promise<void> {
    if (intents.length === 0) return;
    const owned = !("release" in this.pool);
    const client = owned ? await (this.pool as pg.Pool).connect() : (this.pool as pg.PoolClient);
    try {
      await client.query("begin");
      for (const intent of intents) await insertIntent(client, intent);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      if (owned) client.release();
    }
  }

  async listDue(now: string, limit: number): Promise<NotificationOutboxRow[]> {
    const res = await this.pool.query(
      `select * from kernel_private.notification_outbox
       where status = 'PENDING' and next_attempt_at <= $1
       order by created_at asc
       limit $2`,
      [now, limit],
    );
    return res.rows.map(rowToOutbox);
  }

  async markSending(notificationId: string, now: string): Promise<NotificationOutboxRow | null> {
    const res = await this.pool.query(
      `update kernel_private.notification_outbox
       set status = 'SENDING', attempt_count = attempt_count + 1, last_attempt_at = $2
       where notification_id = $1 and status = 'PENDING' and next_attempt_at <= $2
       returning *`,
      [notificationId, now],
    );
    return res.rows[0] ? rowToOutbox(res.rows[0]) : null;
  }

  async applyOutcome(
    row: NotificationOutboxRow,
    eventOutcome: DeliveryOutcome,
    errorClass: string | null,
    attemptNumber: number,
    now: string,
    transport: string,
  ): Promise<void> {
    const owned = !("release" in this.pool);
    const client = owned ? await (this.pool as pg.Pool).connect() : (this.pool as pg.PoolClient);
    try {
      await client.query("begin");
      await client.query(
        `update kernel_private.notification_outbox
         set status = $2, attempt_count = $3, last_attempt_at = $4, next_attempt_at = $5,
             delivered_at = $6, last_error = $7
         where notification_id = $1`,
        [row.notificationId, row.status, row.attemptCount, row.lastAttemptAt, row.nextAttemptAt, row.deliveredAt, row.lastError],
      );
      await client.query(
        `insert into kernel_private.notification_delivery_events
           (notification_id, attempt_number, attempted_at, outcome, error_class, transport)
         values ($1,$2,$3,$4,$5,$6)`,
        [row.notificationId, attemptNumber, now, eventOutcome, errorClass, transport],
      );
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      if (owned) client.release();
    }
  }

  async listStaleSending(now: string, staleSendingMs: number): Promise<NotificationOutboxRow[]> {
    const res = await this.pool.query(
      `select * from kernel_private.notification_outbox
       where status = 'SENDING' and last_attempt_at is not null
         and $1::timestamptz - last_attempt_at >= ($2 || ' milliseconds')::interval`,
      [now, staleSendingMs],
    );
    return res.rows.map(rowToOutbox);
  }
}

async function insertIntent(client: pg.PoolClient, intent: NotificationIntent): Promise<void> {
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

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

function rowToOutbox(r: Record<string, unknown>): NotificationOutboxRow {
  return {
    notificationId: String(r["notification_id"]),
    fingerprint: String(r["fingerprint"]),
    checkId: String(r["check_id"]),
    entityId: String(r["entity_id"]),
    firstSeenAt: iso(r["first_seen_at"]),
    lastSeenAt: iso(r["last_seen_at"]),
    kind: String(r["kind"]) as NotificationOutboxRow["kind"],
    occurrenceCount: Number(r["occurrence_count"]),
    severity: String(r["severity"]) as NotificationOutboxRow["severity"],
    message: String(r["message"]),
    durationMs: r["duration_ms"] === null || r["duration_ms"] === undefined ? null : Number(r["duration_ms"]),
    status: String(r["status"]) as NotificationOutboxRow["status"],
    attemptCount: Number(r["attempt_count"]),
    createdAt: iso(r["created_at"]),
    lastAttemptAt: isoOrNull(r["last_attempt_at"]),
    nextAttemptAt: iso(r["next_attempt_at"]),
    deliveredAt: isoOrNull(r["delivered_at"]),
    lastError: r["last_error"] === null || r["last_error"] === undefined ? null : String(r["last_error"]),
  };
}
