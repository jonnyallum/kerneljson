import type { DeliveryOutcome, NotificationIntent, NotificationOutboxRow } from "./outbox-types.js";

/** Persistence boundary for notification delivery — separate from
 *  `AlertStateStore` (episode identity) on purpose, see outbox-types.ts. */
export interface NotificationOutboxStore {
  /** Insert every intent not already present (by `notificationId`) — a
   *  replay of the same decision (Restate `ctx.run` retry, a manual CLI
   *  re-run against the same state) must never enqueue a duplicate. */
  enqueue(intents: readonly NotificationIntent[]): Promise<void>;
  /** PENDING rows due now, oldest first — bounded by `limit` so one worker
   *  tick can't be swamped if the outbox ever backs up. */
  listDue(now: string, limit: number): Promise<NotificationOutboxRow[]>;
  /** Atomically claim one PENDING, due row for delivery: increments
   *  `attemptCount`, sets `lastAttemptAt=now`, `status=SENDING`. Returns
   *  `null` if the row doesn't exist or isn't eligible (already SENDING/
   *  DELIVERED/POISON, or not yet due) — never re-claims a row a concurrent
   *  invocation already owns. */
  markSending(notificationId: string, now: string): Promise<NotificationOutboxRow | null>;
  /** Persist the row exactly as `decideNextOutboxState`/`recoverIfStaleSending`
   *  computed it, plus the append-only event for this attempt. */
  applyOutcome(
    row: NotificationOutboxRow,
    eventOutcome: DeliveryOutcome,
    errorClass: string | null,
    attemptNumber: number,
    now: string,
    transport: string,
  ): Promise<void>;
  /** SENDING rows whose `lastAttemptAt` is older than `staleSendingMs` — see
   *  `recoverIfStaleSending`'s header for why this is safe under the
   *  exclusive-lock invariant every caller here already holds. */
  listStaleSending(now: string, staleSendingMs: number): Promise<NotificationOutboxRow[]>;
}

interface LoggedEvent {
  notificationId: string;
  attemptNumber: number;
  attemptedAt: string;
  outcome: DeliveryOutcome;
  errorClass: string | null;
  transport: string;
}

/** In-memory implementation — pairs with `InMemoryAlertStateStore` exactly
 *  like `PgNotificationOutboxStore` pairs with `PgAlertStateStore`, so the
 *  full intent -> outbox -> delivery pipeline is deterministically testable
 *  (see tests/outbox-model.test.ts) without Postgres, matching the existing
 *  "the engine works completely without an external database" ethos. */
export class InMemoryNotificationOutboxStore implements NotificationOutboxStore {
  private readonly rows = new Map<string, NotificationOutboxRow>();
  readonly events: LoggedEvent[] = [];

  async enqueue(intents: readonly NotificationIntent[]): Promise<void> {
    for (const intent of intents) {
      if (this.rows.has(intent.notificationId)) continue;
      this.rows.set(intent.notificationId, {
        ...intent,
        status: "PENDING",
        attemptCount: 0,
        lastAttemptAt: null,
        nextAttemptAt: intent.createdAt,
        deliveredAt: null,
        lastError: null,
      });
    }
  }

  async listDue(now: string, limit: number): Promise<NotificationOutboxRow[]> {
    return [...this.rows.values()]
      .filter((r) => r.status === "PENDING" && r.nextAttemptAt <= now)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
  }

  async markSending(notificationId: string, now: string): Promise<NotificationOutboxRow | null> {
    const row = this.rows.get(notificationId);
    if (!row || row.status !== "PENDING" || row.nextAttemptAt > now) return null;
    const next: NotificationOutboxRow = {
      ...row,
      status: "SENDING",
      attemptCount: row.attemptCount + 1,
      lastAttemptAt: now,
    };
    this.rows.set(notificationId, next);
    return next;
  }

  async applyOutcome(
    row: NotificationOutboxRow,
    eventOutcome: DeliveryOutcome,
    errorClass: string | null,
    attemptNumber: number,
    now: string,
    transport: string,
  ): Promise<void> {
    this.rows.set(row.notificationId, row);
    this.events.push({ notificationId: row.notificationId, attemptNumber, attemptedAt: now, outcome: eventOutcome, errorClass, transport });
  }

  async listStaleSending(now: string, staleSendingMs: number): Promise<NotificationOutboxRow[]> {
    return [...this.rows.values()].filter(
      (r) => r.status === "SENDING" && r.lastAttemptAt !== null && Date.parse(now) - Date.parse(r.lastAttemptAt) >= staleSendingMs,
    );
  }

  async getAll(): Promise<NotificationOutboxRow[]> {
    return [...this.rows.values()];
  }
}
