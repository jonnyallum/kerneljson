import { pathToFileURL } from "node:url";
import pg from "pg";
import { collectHealthSnapshot } from "../health/collect.js";
import {
  loadConnectionConfig,
  loadHealthExpectations,
} from "../health/config.js";
import { evaluateHealthSnapshot } from "../health/run.js";
import { runAlertEngine } from "./engine.js";
import { runDeliveryWorker } from "./delivery-worker.js";
import { formatDecisionsHuman } from "./format.js";
import { InMemoryNotificationOutboxStore } from "./outbox-store.js";
import { loadTransportConfig } from "./transport-config.js";
import { selectNotifier } from "./select-notifier.js";
import { loadAlertStoreMode, selectAlertStateStore } from "./select-store.js";
import { postgresMonitorExclusive } from "./runner-postgres.js";
import type { AlertStateStore } from "./state-store.js";
import type { NotificationOutboxStore } from "./outbox-store.js";

/**
 * `kerneljson alerts` — runs the P1.1 health model, then the P1.2 alert engine
 * over its result, then (KJ-P2.1) drains any due notification outbox rows,
 * and prints every notify-worthy decision.
 *
 * State store: `ALERT_STATE_STORE=postgres|memory` (see `select-store.ts`).
 * Defaults to `postgres` — durable persistence is the production-safe default;
 * `memory` must be explicitly selected for local/dev/smoke work. `postgres`
 * mode PROBES `kernel_private.alert_state`/`kernel_private.notification_outbox`
 * before use: if the relevant migration hasn't been applied yet, this throws
 * and `main()` exits non-zero rather than silently falling back to ephemeral
 * state — a durable-mode caller getting silent memory semantics would be
 * worse than a clear failure.
 *
 * `--json` is a read-style report (`{overall, decisions}` on stdout) and
 * deliberately does NOT run the delivery-worker phase — `ConsoleNotifier`
 * writes to the SAME stdout via `console.log`, which would interleave human
 * text into the JSON output for anything parsing it.
 *
 * Exit code: 0 if the engine ran; non-zero (see the catch below) if store
 * selection or anything else failed. This mirrors `kerneljson health`'s
 * read-only nature — nothing here ever mutates production KernelJSON state,
 * only (when postgres mode is actually available) the alert_state/
 * notification_outbox bookkeeping tables.
 */
async function main(): Promise<void> {
  const jsonOnly = process.argv.includes("--json");
  const connection = loadConnectionConfig(process.env);
  const expectations = loadHealthExpectations(process.env);
  const pool = new pg.Pool({ connectionString: connection.databaseUrl });
  try {
    const execute = async (store: AlertStateStore, outbox: NotificationOutboxStore) => {
      const snapshot = await collectHealthSnapshot({
        pool,
        connection,
        expectations,
        selfEnv: process.env,
      });
      const report = evaluateHealthSnapshot(snapshot, expectations);

      const { decisions } = await runAlertEngine(report, {
        store,
        canonicalScheduleId: expectations.scheduleId,
      });

      // Queueing (above) and delivery (below) are two separate,
      // independently-recoverable steps — see runner.ts's header. A manual
      // run still drains the outbox immediately after queueing so a human
      // running this sees the same delivery a recurring run would perform,
      // but durability no longer depends on this happening in one call.
      if (!jsonOnly) {
        const { notifier, transport } = selectNotifier(loadTransportConfig(process.env));
        await runDeliveryWorker({ outbox, notifier, transport });
      }

      if (jsonOnly) {
        process.stdout.write(
          JSON.stringify({ overall: report.overall, decisions }, null, 2) +
            "\n",
        );
      } else if (decisions.length === 0) {
        process.stdout.write("No alert-worthy changes.\n");
      } else {
        process.stdout.write(formatDecisionsHuman(decisions) + "\n");
      }
    };
    const mode = loadAlertStoreMode(process.env);
    if (mode === "postgres") {
      // Manual invocations and the recurring monitor share one exclusion boundary.
      if (!(await postgresMonitorExclusive(pool)(execute)))
        throw new Error(
          "Another alert invocation is already running; no work performed",
        );
    } else {
      const outbox = new InMemoryNotificationOutboxStore();
      await execute(await selectAlertStateStore(mode, pool, outbox), outbox);
    }
  } finally {
    await pool.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `kerneljson alerts failed to run: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 4;
  });
}
