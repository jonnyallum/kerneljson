import { pathToFileURL } from "node:url";
import pg from "pg";
import { collectHealthSnapshot } from "../health/collect.js";
import { loadConnectionConfig, loadHealthExpectations } from "../health/config.js";
import { evaluateHealthSnapshot } from "../health/run.js";
import { runAlertEngine } from "./engine.js";
import { formatDecisionsHuman } from "./format.js";
import { ConsoleNotifier } from "./notifier.js";
import { PgAlertStateStore } from "./pg-state-store.js";
import { InMemoryAlertStateStore } from "./state-store.js";

/**
 * `kerneljson alerts` — runs the P1.1 health model, then the P1.2 alert engine
 * over its result, and prints every notify-worthy decision.
 *
 * State store: `InMemoryAlertStateStore` by default (also the ONLY option today,
 * since `kernel_private.alert_state` — supabase/migrations/20260915220000_alert_state.sql
 * — has not been applied to production; see that migration's header). This means
 * every invocation currently starts from a clean slate: fine for observing
 * "what would fire right now", not yet a durable dedupe history across process
 * restarts. Pass `ALERT_STATE_PG=1` to use `PgAlertStateStore` once that
 * migration is applied in a future, separately-authorised change window.
 *
 * Exit code: 0 always if the engine ran; check stdout/JSON for what fired. This
 * mirrors `kerneljson health`'s read-only nature — nothing here ever mutates
 * production KernelJSON state, only (optionally) the alert_state bookkeeping
 * table.
 */
async function main(): Promise<void> {
  const jsonOnly = process.argv.includes("--json");
  const connection = loadConnectionConfig(process.env);
  const expectations = loadHealthExpectations(process.env);
  const pool = new pg.Pool({ connectionString: connection.databaseUrl });
  try {
    const snapshot = await collectHealthSnapshot({ pool, connection, expectations, selfEnv: process.env });
    const report = evaluateHealthSnapshot(snapshot, expectations);

    const store =
      process.env["ALERT_STATE_PG"] === "1" ? new PgAlertStateStore(pool) : new InMemoryAlertStateStore();
    const { decisions } = await runAlertEngine(report, {
      store,
      ...(jsonOnly ? {} : { notifier: new ConsoleNotifier() }),
      canonicalScheduleId: expectations.scheduleId,
    });

    if (jsonOnly) {
      process.stdout.write(JSON.stringify({ overall: report.overall, decisions }, null, 2) + "\n");
    } else if (decisions.length === 0) {
      process.stdout.write("No alert-worthy changes.\n");
    } else {
      process.stdout.write(formatDecisionsHuman(decisions) + "\n");
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`kerneljson alerts failed to run: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 4;
  });
}
