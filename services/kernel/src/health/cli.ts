import { pathToFileURL } from "node:url";
import pg from "pg";
import { collectHealthSnapshot } from "./collect.js";
import { loadConnectionConfig, loadHealthExpectations } from "./config.js";
import { exitCodeFor, formatHumanSummary } from "./report.js";
import { evaluateHealthSnapshot } from "./run.js";

/**
 * `kerneljson health` — a small, strictly READ-ONLY production health check.
 *
 * Safety: every query in `collect.ts` is a SELECT (or Restate's `/query`
 * introspection / a `/healthz` GET probe). Nothing in this module or anything it
 * imports can enable/disable a schedule, fire one, create a task, mutate a DB row,
 * restart a container, or touch legacy infrastructure. See
 * docs/operations/HEALTH_MODEL.md "Safety" for the full statement.
 *
 * Usage:
 *   DATABASE_URL=... [RESTATE_ADMIN_URL=... KJ_ADMISSION_URL=... ...] \
 *     tsx services/kernel/src/health/cli.ts [--json]
 *
 * Exit code: 0 HEALTHY, 1 DEGRADED, 2 CRITICAL, 3 UNKNOWN (see report.ts).
 */
async function main(): Promise<void> {
  const jsonOnly = process.argv.includes("--json");
  const connection = loadConnectionConfig(process.env);
  const expectations = loadHealthExpectations(process.env);
  const pool = new pg.Pool({ connectionString: connection.databaseUrl });
  try {
    const snapshot = await collectHealthSnapshot({ pool, connection, expectations, selfEnv: process.env });
    const report = evaluateHealthSnapshot(snapshot, expectations);
    if (jsonOnly) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else {
      process.stdout.write(formatHumanSummary(report) + "\n\n");
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    }
    process.exitCode = exitCodeFor(report);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`kerneljson health failed to run: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 4;
  });
}
