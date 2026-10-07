// KJ-P8 ledger drift adjudication: the canonical expected footprint, migration by migration.
//
//   KJ_REFERENCE_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres node scripts/drift/reference-steps.mjs --out <path>
//
// DISPOSABLE DATABASES ONLY: refuses unless CI=true and the host is loopback. Creates the Supabase API roles and the
// Supabase-style default privileges in schema public (production Supabase has them, see the P7A record), then applies
// every canonical migration in supabase/migrations in order, each in its own transaction exactly as tests/support
// migrate() does, and records the footprint after each one. Step k's delta from step k-1 is migration k's footprint.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import pg from "pg";
import { footprint } from "./footprint-lib.mjs";

const i = process.argv.indexOf("--out");
const out = i >= 0 ? process.argv[i + 1] : undefined;
const url = process.env.KJ_REFERENCE_DATABASE_URL;
if (!out || !url) { console.error("usage: KJ_REFERENCE_DATABASE_URL=... reference-steps.mjs --out <path>"); process.exit(2); }
const host = new URL(url).hostname;
if (process.env.CI !== "true" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
  console.error("REFERENCE_REFUSED: only a disposable loopback database under CI=true");
  process.exit(2);
}
const client = new pg.Client({ connectionString: url });
await client.connect();
const [{ n }] = (await client.query(`select count(*)::int as n from pg_catalog.pg_class c join pg_catalog.pg_namespace s on s.oid = c.relnamespace where s.nspname in ('public','kernel_private')`)).rows;
if (n !== 0) { console.error("REFERENCE_REFUSED: the reference database is not empty"); process.exit(2); }

await client.query(`do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$`);
await client.query(`grant usage on schema public to anon, authenticated, service_role`);
for (const kind of ["tables", "sequences", "functions"])
  await client.query(`alter default privileges for role postgres in schema public grant all on ${kind} to anon, authenticated, service_role`);

const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort();
const steps = [{ file: null, ...(await footprint(client)) }];
for (const file of files) {
  const sql = readFileSync(`supabase/migrations/${file}`, "utf8");
  await client.query("begin");
  try { await client.query(sql); await client.query("commit"); }
  catch (error) { await client.query("rollback"); throw new Error(`${file}: ${error.message}`); }
  steps.push({ file, sqlSha256: createHash("sha256").update(sql).digest("hex"), ...(await footprint(client)) });
  console.log(`${file}: ${Object.keys(steps.at(-1).objects).length} objects`);
}
await client.end();
writeFileSync(out, JSON.stringify({ capturedAt: new Date().toISOString(), commit: process.env.GITHUB_SHA ?? null, steps }, null, 1) + "\n");
console.log(`reference: ${files.length} migrations, written to ${out}`);
