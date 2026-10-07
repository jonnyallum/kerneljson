// KJ-P8 ledger drift adjudication: the canonical expected footprint, migration by migration, in two privilege regimes.
//
//   KJ_REFERENCE_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres node scripts/drift/reference-steps.mjs --out <path>
//
// DISPOSABLE DATABASES ONLY: refuses unless CI=true and the host is loopback. Creates two fresh databases on that
// server (ZERO and MAX, see reference-lib.mjs) and applies every canonical migration in supabase/migrations to each,
// in order, each in its own transaction, recording the footprint after each one.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { buildSteps, mergeRegimes, pgDb } from "./reference-lib.mjs";
import { validateReference } from "./compare-lib.mjs";

const i = process.argv.indexOf("--out");
const out = i >= 0 ? process.argv[i + 1] : undefined;
const url = process.env.KJ_REFERENCE_DATABASE_URL;
if (!out || !url) { console.error("usage: KJ_REFERENCE_DATABASE_URL=... reference-steps.mjs --out <path>"); process.exit(2); }
if (process.env.CI !== "true" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(url).hostname)) {
  console.error("REFERENCE_REFUSED: only a disposable loopback database under CI=true");
  process.exit(2);
}
const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort()
  .map((name) => ({ name, sql: readFileSync(`supabase/migrations/${name}`, "utf8") }));

const admin = new pg.Client({ connectionString: url });
await admin.connect();
const built = {};
for (const regime of ["zero", "max"]) {
  const name = `drift_ref_${regime}`;
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  const u = new URL(url); u.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: u.toString() });
  await client.connect();
  built[regime] = await buildSteps(pgDb(client), files, regime, console.log);
  await client.end();
}
await admin.end();
const reference = { capturedAt: new Date().toISOString(), commit: process.env.GITHUB_SHA ?? null, steps: mergeRegimes(built.zero, built.max) };
validateReference(reference);
writeFileSync(out, JSON.stringify(reference) + "\n");
console.log(`reference: ${files.length} migrations x 2 regimes, written to ${out}`);
