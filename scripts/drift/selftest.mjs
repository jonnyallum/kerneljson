// KJ-P8 ledger drift adjudication: prove the footprint and the comparator on known-good and known-bad databases
// before either is trusted against production. CI only, disposable loopback server.
//
//   KJ_REFERENCE_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres node scripts/drift/selftest.mjs --reference <reference-steps.json>
//
// clean:  every canonical migration applied in one pass to a fresh database   -> all six EXACTLY_APPLIED, nothing unexpected
// broken: 20260920180000 never applied, and one deliberate defect per other audited migration except P6:
//   P4A  the telegram_operator_state seed row deleted                             -> PARTIALLY_APPLIED (seed)
//   P4B  telegram_approval_cards.attempt_count default dropped                    -> PARTIALLY_APPLIED (mismatch)
//   P4B1 not applied                                                              -> ABSENT_OR_DRIFTED
//   P5   trigger memory_relations_guard dropped, guard body replaced              -> PARTIALLY_APPLIED (missing + digest)
//   P6   untouched                                                                -> EXACTLY_APPLIED
//   P7A  SELECT on identity_profiles granted to anon                               -> PARTIALLY_APPLIED (privilege)
// The six versions are also left out of a synthetic ledger, which must report exactly them as missing.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";

const i = process.argv.indexOf("--reference");
const reference = process.argv[i + 1];
const base = process.env.KJ_REFERENCE_DATABASE_URL;
if (process.env.CI !== "true" || !["127.0.0.1", "localhost"].includes(new URL(base).hostname)) { console.error("SELFTEST_REFUSED"); process.exit(2); }
const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort();
const AUDITED = ["20260920120000", "20260920150000", "20260920180000", "20260921180000", "20260923150000", "20260925120000"];
const dir = mkdtempSync(join(tmpdir(), "kj-drift-"));
const admin = new pg.Client({ connectionString: base });
await admin.connect();

async function build(name, skip, defects) {
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  const u = new URL(base); u.pathname = `/${name}`;
  const db = new pg.Client({ connectionString: u.toString() });
  await db.connect();
  await db.query(`grant usage on schema public to anon, authenticated, service_role`);
  for (const kind of ["tables", "sequences", "functions"])
    await db.query(`alter default privileges for role postgres in schema public grant all on ${kind} to anon, authenticated, service_role`);
  for (const f of files) {
    if (skip.includes(f.slice(0, 14))) continue;
    await db.query("begin"); await db.query(readFileSync(`supabase/migrations/${f}`, "utf8")); await db.query("commit");
  }
  await db.query(`create schema supabase_migrations; create table supabase_migrations.schema_migrations (version text primary key, name text)`);
  for (const f of files) if (!AUDITED.includes(f.slice(0, 14))) await db.query(`insert into supabase_migrations.schema_migrations values ($1, $2)`, [f.slice(0, 14), f]);
  for (const sql of defects) await db.query(sql);
  await db.end();
  const urlFile = join(dir, `${name}.url`);
  writeFileSync(urlFile, u.toString() + "\n"); chmodSync(urlFile, 0o600);
  const out = join(dir, `${name}.json`);
  execFileSync("node", ["scripts/drift/production-footprint.mjs", "--database-url-file", urlFile, "--out", out], { stdio: "inherit" });
  execFileSync("node", ["scripts/drift/compare.mjs", "--reference", reference, "--production", out, "--out", join(dir, `${name}-report`)], { stdio: "inherit" });
  return JSON.parse(readFileSync(join(dir, `${name}-report.json`), "utf8"));
}

const failures = [];
const expect = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${label}`); if (!cond) failures.push(label); };
const cls = (r, v) => r.migrations.find((m) => m.migration.startsWith(v)).classification;

const clean = await build("drift_clean", [], []);
for (const v of AUDITED) expect(`clean ${v} EXACTLY_APPLIED`, cls(clean, v) === "EXACTLY_APPLIED");
expect("clean: no unexpected objects", clean.unexpectedObjects.length === 0);
expect("clean: no other missing or mismatched", clean.otherMissing.length === 0 && clean.otherMismatched.length === 0);
expect("clean: ledger missing exactly the six", JSON.stringify(clean.ledger.missing) === JSON.stringify(AUDITED));
expect("clean: no unexpected ledger versions", clean.ledger.unexpected.length === 0);

const broken = await build("drift_broken", ["20260920180000"], [
  "delete from kernel_private.telegram_operator_state",
  "alter table kernel_private.telegram_approval_cards alter column attempt_count drop default",
  "drop trigger memory_relations_guard on public.memory_relations",
  "create or replace function public.memory_version_guard() returns trigger language plpgsql as $$ begin return new; end $$",
  "grant select on public.identity_profiles to anon",
]);
expect("broken P4A PARTIALLY_APPLIED", cls(broken, "20260920120000") === "PARTIALLY_APPLIED");
expect("broken P4A seed mismatch", broken.migrations[0].seeds.some((s) => !s.ok));
expect("broken P4B PARTIALLY_APPLIED", cls(broken, "20260920150000") === "PARTIALLY_APPLIED");
expect("broken P4B names attempt_count default", broken.migrations[1].mismatched.some((m) => m.key === "col:kernel_private.telegram_approval_cards.attempt_count" && m.diff.some((d) => d.field === "default")));
expect("broken P4B1 ABSENT_OR_DRIFTED", cls(broken, "20260920180000") === "ABSENT_OR_DRIFTED");
expect("broken P5 PARTIALLY_APPLIED", cls(broken, "20260921180000") === "PARTIALLY_APPLIED");
expect("broken P5 names the dropped trigger", broken.migrations[3].missing.includes("trg:public.memory_relations.memory_relations_guard"));
expect("broken P5 digest differs", broken.migrations[3].functions.some((f) => f.key === "fn:public.memory_version_guard()" && !f.equal));
expect("broken P6 EXACTLY_APPLIED", cls(broken, "20260923150000") === "EXACTLY_APPLIED");
expect("broken P7A PARTIALLY_APPLIED", cls(broken, "20260925120000") === "PARTIALLY_APPLIED");
expect("broken P7A anon grant is privilege-only", broken.migrations[5].privilegeOnly.some((m) => m.key === "rel:public.identity_profiles"));
await admin.end();
if (failures.length) { console.error(`SELFTEST FAILED: ${failures.length}`); process.exit(1); }
console.log("SELFTEST PASSED");
