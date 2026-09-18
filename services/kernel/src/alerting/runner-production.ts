import pg from "pg";
import { collectHealthSnapshot } from "../health/collect.js";
import {
  loadConnectionConfig,
  loadHealthExpectations,
} from "../health/config.js";
import { evaluateHealthSnapshot } from "../health/run.js";
import { loadMonitorConfig } from "./runner-config.js";
import { loadTransportConfig } from "./transport-config.js";
import { selectNotifier } from "./select-notifier.js";
import { postgresMonitorExclusive } from "./runner-postgres.js";
import { createAlertMonitorService } from "./runner-restate.js";
import { runMonitor } from "./runner.js";

export function productionAlertMonitor(env: NodeJS.ProcessEnv) {
  const config = loadMonitorConfig(env);
  if (!config.enabled) return undefined;
  const connection = loadConnectionConfig(env);
  const expectations = loadHealthExpectations(env);
  // KJ-P2.2: fails closed at startup (before any DB connection or Restate
  // registration) if ALERT_TRANSPORT=telegram is set without both required
  // values — never a silent console fallback for an explicit request.
  const { notifier, transport } = selectNotifier(loadTransportConfig(env));
  // Separate bounded pool: monitoring cannot consume the task worker's pool.
  const pool = new pg.Pool({
    connectionString: connection.databaseUrl,
    max: 3,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    query_timeout: 15000,
  });
  pool.on("error", () => console.error("alert_monitor_pool_error"));
  return createAlertMonitorService(config, () =>
    runMonitor({
      collect: async () =>
        evaluateHealthSnapshot(
          await collectHealthSnapshot({
            pool,
            connection,
            expectations,
            selfEnv: env,
          }),
          expectations,
        ),
      exclusive: postgresMonitorExclusive(pool),
      notifier,
      transport,
      canonicalScheduleId: expectations.scheduleId,
    }),
  );
}
