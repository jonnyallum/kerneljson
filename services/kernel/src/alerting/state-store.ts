import type { AlertStateRow } from "./types.js";
import type { NotificationIntent } from "./outbox-types.js";
import type { NotificationOutboxStore } from "./outbox-store.js";

/** Persistence boundary for alert episodes. `getAll()` is enough for this phase's
 *  scale (a few dozen checks) — no pagination needed for one production instance. */
export interface AlertStateStore {
  getAll(): Promise<AlertStateRow[]>;
  /** Replace/insert every row in `rows` (keyed by fingerprint), AND (KJ-P2.1)
   *  durably enqueue `intents` in the SAME atomic unit — see
   *  `pg-state-store.ts`'s `putAll` for why this must be one commit, not two.
   *  `intents` defaults to `[]`: every pre-P2.1 call site is unaffected. Rows
   *  not present in `rows` are left untouched — callers always pass the full
   *  next-state set for every check they evaluated this run. */
  putAll(rows: readonly AlertStateRow[], intents?: readonly NotificationIntent[]): Promise<void>;
}

/** In-memory implementation — used by every deterministic test, and by the CLI
 *  when no persistent store is configured (so the engine always works without an
 *  external database, per the P1.2 requirement that alerting must not depend on
 *  wiring a notification/state backend to produce a correct decision).
 *
 *  `outbox` (KJ-P2.1, optional): when paired with an `InMemoryNotificationOutboxStore`
 *  (constructed by the caller, exactly like `PgAlertStateStore`/`PgNotificationOutboxStore`
 *  are paired against the same database), `putAll`'s intents land there — so the
 *  full intent -> outbox -> delivery pipeline is exercisable fully in-memory,
 *  no Postgres required (see tests/outbox-model.test.ts). Without a paired
 *  outbox, intents are silently accepted and dropped — correct for every
 *  caller that doesn't care about durable delivery (e.g. a test asserting
 *  only episode/state behaviour).
 */
export class InMemoryAlertStateStore implements AlertStateStore {
  private readonly rows = new Map<string, AlertStateRow>();

  constructor(private readonly outbox?: NotificationOutboxStore) {}

  async getAll(): Promise<AlertStateRow[]> {
    return [...this.rows.values()];
  }

  async putAll(rows: readonly AlertStateRow[], intents: readonly NotificationIntent[] = []): Promise<void> {
    for (const row of rows) this.rows.set(row.fingerprint, row);
    if (this.outbox) await this.outbox.enqueue(intents);
  }
}
