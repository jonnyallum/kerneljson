import * as restate from "@restatedev/restate-sdk";
import pg from "pg";
import { createAlertMonitorService } from "../../services/kernel/src/alerting/runner-restate.js";
import { postgresMonitorExclusive } from "../../services/kernel/src/alerting/runner-postgres.js";
import { runMonitor } from "../../services/kernel/src/alerting/runner.js";
import { ConsoleNotifier } from "../../services/kernel/src/alerting/notifier.js";
import { monitorReport } from "./alert-runner-fixture.js";

// Only the collector and accelerated timer differ from production. No task APIs.
const pool = new pg.Pool({
  connectionString: process.env["KJ_MONITOR_TEST_DB"],
  connectionTimeoutMillis: 1000,
});
restate.serve({
  port: Number(process.env["PORT"]),
  services: [
    createAlertMonitorService({ enabled: true, cadenceMs: 2000 }, () =>
      runMonitor({
        collect: async () => monitorReport("CRITICAL"),
        exclusive: postgresMonitorExclusive(pool),
        notifier: new ConsoleNotifier(),
        canonicalScheduleId: "live-monitor-test",
      }),
    ),
  ],
});
