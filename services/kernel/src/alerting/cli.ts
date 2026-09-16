import { pathToFileURL } from "node:url";
import pg from "pg";
import { collectHealthSnapshot } from "../health/collect.js";
import {
  loadConnectionConfig,
  loadHealthExpectations,
} from "../health/config.js";
import { evaluateHealthSnapshot } from "../health/run.js";
import { runAlertEngine } from "./engine.js";
import { formatDecisionsHuman } from "./format.js";
import { ConsoleNotifier } from "./notifier.js";
import { loadAlertStoreMode, selectAlertStateStore } from "./select-store.js";
import { postgresMonitorExclusive } from "./runner-postgres.js";
import type { AlertStateStore } from "./state-store.js";

/**
 * `kerneljson alerts` — runs the P1.1 health model, then the P1.2 alert engine
 * over its result, and prints every notify-worthy decision.
 *
 * State store: `ALERT_STATE_STORE=postgres|memory` (see `select-store.ts`).
 * Defaults to `postgres` — durable persistence is the production-safe default;
 * `memory` must be explicitly selected for local/dev/smoke work. `postgres`
 * mode PROBES `kernel_private.alert_state` before use: if the KJ-P1.2 migration
 * (`supabase/migrations/20260915220000_alert_state.sql`) hasn't been applied
 * yet, this throws and `main()` exits non-zero rather than silently falling
 * back to ephemeral state — a durable-mode caller getting silent memory
 * semantics would be worse than a clear failure.
 *
 * Exit code: 0 if the engine ran; non-zero (see the catch below) if store
 * selection or anything else failed. This mirrors `kerneljson health`'s
 * read-only nature — nothing here ever mutates production KernelJSON state,
 * only (when postgres mode is actually available) the alert_state bookkeeping
 * table.
 */
async function main(): Promise<void> {
  const jsonOnly = process.argv.includes("--json");
  const connection = loadConnectionConfig(process.env);
  const expectations = loadHealthExpectations(process.env);
  const pool = new pg.Pool({ connectionString: connection.databaseUrl });
  try {
    const execute = async (store: AlertStateStore) => {
      const snapshot = await collectHealthSnapshot({
        pool,
        connection,
        expectations,
        selfEnv: process.env,
      });
      const report = evaluateHealthSnapshot(snapshot, expectations);

      const { decisions } = await runAlertEngine(report, {
        store,
        ...(jsonOnly ? {} : { notifier: new ConsoleNotifier() }),
        canonicalScheduleId: expectations.scheduleId,
      });

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
      await execute(await selectAlertStateStore(mode, pool));
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
