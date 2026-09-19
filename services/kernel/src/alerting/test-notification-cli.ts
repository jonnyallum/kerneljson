import { pathToFileURL } from "node:url";
import pg from "pg";
import { PgNotificationOutboxStore } from "./pg-outbox-store.js";
import { loadTransportConfig } from "./transport-config.js";
import { assertValidTestLabel, enqueueTestNotification } from "./test-notification.js";

/**
 * `kerneljson alerts:test-notification` — queue exactly ONE clearly-labelled
 * P3 test notification through the durable outbox (see test-notification.ts).
 *
 * Never runs on its own: it needs an explicit `--label <id>` AND the exact
 * confirmation flag, and refuses unless the invoking environment is already
 * configured for `ALERT_TRANSPORT=telegram` (which also re-runs
 * `loadTransportConfig`'s fail-closed token/chat presence check without ever
 * printing either value). It only queues. The running monitor's next tick
 * delivers it, so what gets proven is the production delivery path.
 *
 * Output is the notification id and a fixed sentence. No transport detail,
 * no URL, no credential ever reaches stdout or stderr.
 */
export const CONFIRM_FLAG = "--confirm-queue-one-test-notification";

/** Fixed, value-free messages only, so these are safe to print verbatim. */
export class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): { label: string } {
  if (!argv.includes(CONFIRM_FLAG)) {
    throw new UsageError(`refusing to run without ${CONFIRM_FLAG}`);
  }
  const at = argv.indexOf("--label");
  const label = at >= 0 ? argv[at + 1] : undefined;
  if (label === undefined) throw new UsageError("--label <id> is required");
  try {
    assertValidTestLabel(label);
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  return { label };
}

async function main(): Promise<void> {
  const { label } = parseArgs(process.argv.slice(2));
  let mode: string;
  try {
    mode = loadTransportConfig(process.env).mode;
  } catch (err) {
    // loadTransportConfig's messages never contain a value (tests/transport-config.test.ts).
    throw new UsageError((err as Error).message);
  }
  if (mode !== "telegram") throw new UsageError("ALERT_TRANSPORT must be telegram to queue a Telegram test notification");
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new UsageError("DATABASE_URL is required");
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const outbox = new PgNotificationOutboxStore(pool);
    await outbox.probe();
    const { notificationId } = await enqueueTestNotification(outbox, label);
    process.stdout.write(
      `queued test notification ${notificationId}; the next monitor tick delivers it. Re-running with the same label queues nothing further.\n`,
    );
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    // Only the class name: a driver error can carry a connection string.
    process.stderr.write(`test notification failed: ${err instanceof Error ? err.constructor.name : "UnknownError"}\n`);
    process.exitCode = 4;
  });
}
