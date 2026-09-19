import { pathToFileURL } from "node:url";
import pg from "pg";
import { evaluateOutboxGate, readOutboxGateInput } from "./outbox-gate.js";

/**
 * `pnpm alerts:outbox-gate --baseline-poison <n>` (inside the worker container on
 * the VM: `node --import tsx services/kernel/src/alerting/outbox-gate-cli.ts ...`).
 *
 * Read-only POISON activation gate for KJ-P2.2A. Exit 0 = PASS, 1 = FAIL (STOP and
 * roll the transport back to console), 4 = could not run. Prints counts, ages and
 * failure reasons only: no message text, no credential.
 */
export class GateUsageError extends Error {}

export function parseArgs(argv: readonly string[]): { baselinePoison: number } {
  const at = argv.indexOf("--baseline-poison");
  const raw = at >= 0 ? argv[at + 1] : undefined;
  if (raw === undefined || !/^\d{1,6}$/.test(raw)) throw new GateUsageError("--baseline-poison <non-negative integer> is required");
  return { baselinePoison: Number(raw) };
}

async function main(): Promise<number> {
  const { baselinePoison } = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new GateUsageError("DATABASE_URL is required");
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const input = await readOutboxGateInput(pool);
    const verdict = evaluateOutboxGate(input, { baselinePoison });
    const counts = ["PENDING", "SENDING", "DELIVERED", "POISON"].map((s) => `${s}=${input.counts[s] ?? 0}`).join(" ");
    process.stdout.write(`outbox ${counts} duplicateDelivered=${input.duplicateDelivered}\n`);
    if (verdict.pass) {
      process.stdout.write(`OUTBOX GATE: PASS (POISON baseline ${baselinePoison})\n`);
      return 0;
    }
    for (const f of verdict.failures) process.stdout.write(`  - ${f}\n`);
    process.stdout.write("OUTBOX GATE: FAIL - STOP; roll the transport back to console\n");
    return 1;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      // Class name only: a driver error can carry a connection string.
      process.stderr.write(`outbox gate could not run: ${err instanceof Error ? err.constructor.name : "UnknownError"}\n`);
      process.exitCode = 4;
    },
  );
}
