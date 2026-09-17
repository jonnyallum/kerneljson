import type pg from "pg";
import { PgAlertStateStore } from "./pg-state-store.js";
import { PgNotificationOutboxStore } from "./pg-outbox-store.js";
import type { RunnerDeps } from "./runner.js";

// One deployment per database. Session lock requires DIRECT or session-pooled PG,
// never a transaction-mode pooler. The SAME connection owns lock AND state writes.
export const MONITOR_LOCK = [1263153235, 13] as const;
export function postgresMonitorExclusive(
  pool: pg.Pool,
): RunnerDeps["exclusive"] {
  return async (run) => {
    const client = await pool.connect();
    // Prevent idle connection errors becoming uncaught events. Queries still fail
    // closed on this dead connection; never reconnect state writes without the lock.
    const onError = () => {};
    client.on("error", onError);
    try {
      const lock = await client.query(
        "select pg_try_advisory_lock($1, $2) as acquired",
        [...MONITOR_LOCK],
      );
      if (!lock.rows[0]?.acquired) return false;
      const store = new PgAlertStateStore(client);
      await store.probe();
      // Same locked session — the delivery-worker phase for THIS run's
      // queued intents (and any prior run's orphaned ones) shares the
      // exclusive window; see runner.ts's RunnerDeps header.
      const outbox = new PgNotificationOutboxStore(client);
      await outbox.probe();
      await run(store, outbox);
      return true;
    } finally {
      // Destroy instead of returning a possibly locked/broken session to the pool.
      client.release(true);
      client.removeListener("error", onError);
    }
  };
}
