// KJ-P8 B1 - take the frozen platform SECURITY DEFINER baseline (ADR-0023 revision 2.5, section 27.10.4).
//
//   pnpm tsx scripts/b1/platform-baseline-snapshot.ts --environment <name> --database-url-file <path> --out <path>
//
// DEPLOYMENT AUTHORITY. Run by the deployment owner against the target environment BEFORE the B1 migration. It opens
// one READ ONLY transaction with search_path = '', reads the catalogue, and writes nothing to the database. It refuses
// if B1 is already applied or if any entry is ineligible.
//
// The connection string is read from a file (mode 600, delete it afterwards). It is never an argument, never printed,
// never logged and never written to the artefact; errors print only a fixed message and the PostgreSQL SQLSTATE.
import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { snapshotPlatformBaseline } from "../../services/kernel/src/database/platform-baseline-snapshot.js";
import { loadStageManifest } from "../../services/kernel/src/database/security-definers.js";

const arg = (name: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value || value.startsWith("--")) {
    console.error(`usage: --environment <name> --database-url-file <path> --out <path> (missing --${name})`);
    process.exit(2);
  }
  return value;
};
const environment = arg("environment"), urlFile = arg("database-url-file"), out = arg("out");
if (!/^[A-Za-z0-9._:-]{1,80}$/.test(environment)) {
  console.error("--environment must be 1 to 80 characters of [A-Za-z0-9._:-]");
  process.exit(2);
}
// Strip a UTF-8 BOM and surrounding whitespace; the value itself is never shown.
const connectionString = readFileSync(urlFile, "utf8").replace(/^﻿/, "").trim();
const client = new pg.Client({ connectionString, application_name: "kj-b1-platform-baseline-snapshot" });
try {
  await client.connect();
  const baseline = await snapshotPlatformBaseline(client, environment, loadStageManifest());
  writeFileSync(out, JSON.stringify(baseline, null, 2) + "\n");
  console.log(`platform baseline for ${environment}: ${baseline.entries.length} entries, entriesSha256 ${baseline.entriesSha256}, written to ${out}`);
} catch (error) {
  const e = error as { code?: string; message?: string };
  const refusal = typeof e.message === "string" && e.message.startsWith("PLATFORM_BASELINE_REFUSED") ? e.message.slice(0, 400) : "snapshot failed";
  console.error(`${refusal}${e.code ? ` (SQLSTATE ${e.code})` : ""}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
