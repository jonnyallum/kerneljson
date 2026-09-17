import type pg from "pg";
import { PgAlertStateStore } from "./pg-state-store.js";
import { PgNotificationOutboxStore } from "./pg-outbox-store.js";
import { InMemoryAlertStateStore } from "./state-store.js";
import { InMemoryNotificationOutboxStore } from "./outbox-store.js";
import type { AlertStateStore } from "./state-store.js";
import type { NotificationOutboxStore } from "./outbox-store.js";

export const ALERT_STORE_MODES = ["postgres", "memory"] as const;
export type AlertStoreMode = (typeof ALERT_STORE_MODES)[number];

/**
 * `ALERT_STATE_STORE=postgres|memory`. Fails closed on anything else — same
 * discipline as `SCHED_ARM_NEXT`/`parseArmNext` in services/kernel/src/index.ts:
 * never guess on an ambiguous value.
 *
 * Unset defaults to `"postgres"` — durable persistence is the production-safe
 * default; `memory` must be explicitly selected (local/dev/smoke work), not
 * silently assumed. This is the opposite default from before this fix, which
 * defaulted to memory and required an opt-in flag to reach Postgres at all —
 * exactly backwards for a store that's supposed to survive process restarts.
 */
export function loadAlertStoreMode(env: NodeJS.ProcessEnv): AlertStoreMode {
  const raw = env["ALERT_STATE_STORE"];
  if (raw === undefined || raw === "") return "postgres";
  if (raw === "postgres") return "postgres";
  if (raw === "memory") return "memory";
  throw new Error(
    `ALERT_STATE_STORE must be exactly "postgres" or "memory" when set (got ${JSON.stringify(raw)}) ` +
      "— refusing to guess the persistence mode",
  );
}

/**
 * Construct the store for `mode`, never silently substituting one for the
 * other. `mode === "postgres"` PROBES the table before returning — if
 * `kernel_private.alert_state` doesn't exist (migration not applied) or the
 * probe fails for any other reason, this THROWS (`AlertStateStoreUnavailableError`
 * or the original error) rather than falling back to `InMemoryAlertStateStore`.
 * A caller that wants memory must ask for it explicitly via `mode`.
 *
 * `outbox` (KJ-P2.1, memory mode only): pair with an `InMemoryNotificationOutboxStore`
 * so intents this store's `putAll` receives actually land somewhere a
 * delivery worker can drain from — see `state-store.ts`'s constructor
 * header. Postgres mode ignores this param: `PgAlertStateStore.putAll`
 * inserts intents inline in its own transaction, never via a paired object.
 */
export async function selectAlertStateStore(
  mode: AlertStoreMode,
  pool: pg.Pool,
  outbox?: NotificationOutboxStore,
): Promise<AlertStateStore> {
  if (mode === "memory") return new InMemoryAlertStateStore(outbox);
  const store = new PgAlertStateStore(pool);
  await store.probe();
  return store;
}

/** Sibling of `selectAlertStateStore` for the KJ-P2.1 outbox — same
 *  never-silently-substitute discipline: `postgres` PROBES
 *  `kernel_private.notification_outbox` before returning. */
export async function selectNotificationOutboxStore(mode: AlertStoreMode, pool: pg.Pool): Promise<NotificationOutboxStore> {
  if (mode === "memory") return new InMemoryNotificationOutboxStore();
  const store = new PgNotificationOutboxStore(pool);
  await store.probe();
  return store;
}
