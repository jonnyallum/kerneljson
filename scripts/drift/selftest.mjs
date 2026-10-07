// KJ-P8 ledger drift adjudication: prove the footprint and the comparator on known-good and known-bad databases
// before either is trusted against production. Every case runs the real comparator (compare-lib.mjs); the clean case
// also runs the real CLIs (production-footprint.mjs reading a mode-600 URL file, then compare.mjs).
//
// CI:    KJ_REFERENCE_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres node scripts/drift/selftest.mjs --reference <reference-steps.json>
//        (disposable loopback server only)
// Local: node scripts/drift/selftest.mjs --pglite   (builds the reference itself in PGlite; for development only, CI is
//        the qualifying run)
//
// Databases are built like a Supabase project: the API roles, and default privileges in schema public granting all on
// tables, sequences and functions to anon, authenticated and service_role. The ledger records every canonical version
// except the six audited ones (the observed production drift).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { footprint } from "./footprint-lib.mjs";
import { AUDITED, OBSERVED_MISSING, compareFootprints, eq, canonical, LABELS, HISTORICAL } from "./compare-lib.mjs";
import { ROLES_SQL, buildSteps, mergeRegimes, pgDb } from "./reference-lib.mjs";

const usePglite = process.argv.includes("--pglite");
const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort()
  .map((name) => ({ name, sql: readFileSync(`supabase/migrations/${name}`, "utf8") }));
const [P4A, P4B, P4B1, P5, P6, P7A] = AUDITED;
const SUPABASE_LIKE = ["tables", "sequences", "functions"].map((k) =>
  `alter default privileges for role postgres in schema public grant all on ${k} to anon, authenticated, service_role`);
const LEDGER_SQL = `create schema supabase_migrations;
  create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text);`;

// ---- drivers -------------------------------------------------------------------------------------------------------
async function pgDriver() {
  const { default: pg } = await import("pg");
  const base = process.env.KJ_REFERENCE_DATABASE_URL;
  if (process.env.CI !== "true" || !["127.0.0.1", "localhost"].includes(new URL(base).hostname)) { console.error("SELFTEST_REFUSED"); process.exit(2); }
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  const urlOf = (name) => { const u = new URL(base); u.pathname = `/${name}`; return u.toString(); };
  const open = async (name) => { const c = new pg.Client({ connectionString: urlOf(name) }); await c.connect(); return { db: pgDb(c), close: () => c.end(), url: urlOf(name) }; };
  return {
    async fresh(name) { await admin.query(`drop database if exists ${name}`); await admin.query(`create database ${name}`); return open(name); },
    async clone(name, template) { await admin.query(`drop database if exists ${name}`); await admin.query(`create database ${name} template ${template}`); return open(name); },
    reference: () => JSON.parse(readFileSync(process.argv[process.argv.indexOf("--reference") + 1], "utf8")),
    end: () => admin.end(),
  };
}
async function pgliteDriver() {
  const { PGlite } = await import("@electric-sql/pglite");
  const made = new Map();
  const wrap = (p) => ({ db: { exec: (sql) => p.exec(sql), query: (sql, params) => p.query(sql, params) }, close: async () => undefined, pg: p });
  return {
    async fresh(name) { const p = new PGlite(); await p.waitReady; made.set(name, p); return wrap(p); },
    async clone(name, template) { const p = await made.get(template).clone(); made.set(name, p); return wrap(p); },
    async reference() {
      const built = {};
      for (const regime of ["zero", "max"]) { const p = new PGlite(); built[regime] = await buildSteps(wrap(p).db, files, regime); }
      return { capturedAt: new Date().toISOString(), commit: "local-pglite", steps: mergeRegimes(built.zero, built.max) };
    },
    end: async () => undefined,
  };
}
const driver = usePglite ? await pgliteDriver() : await pgDriver();

async function build(name, { skip = [] } = {}) {
  const h = await driver.fresh(name);
  await h.db.exec(ROLES_SQL);
  for (const sql of SUPABASE_LIKE) await h.db.exec(sql);
  for (const f of files) {
    if (skip.includes(f.name.slice(0, 14))) continue;
    await h.db.exec("begin"); await h.db.exec(f.sql); await h.db.exec("commit");
  }
  await h.db.exec(LEDGER_SQL);
  for (const f of files) if (!AUDITED.includes(f.name.slice(0, 14)))
    await h.db.query(`insert into supabase_migrations.schema_migrations(version, name) values ($1, $2)`, [f.name.slice(0, 14), f.name]);
  return h;
}
async function withDefects(h, defects) { for (const sql of defects) await h.db.exec(sql); const fp = await footprint(h.db); await h.close(); return fp; }

// ---- assertions ----------------------------------------------------------------------------------------------------
const failures = [];
let passed = 0;
const expect = (label, cond, detail) => {
  if (cond) passed++; else failures.push(label);
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${!cond && detail !== undefined ? ` :: ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
};
const m = (r, v) => r.migrations.find((x) => x.version === v);
const cls = (r, v) => m(r, v).classification;
const failingKeys = (r, v) => m(r, v).failing.map((x) => `${x.key}|${x.field ?? x.entry}|${x.result}`);

const ref = await driver.reference();
const final = ref.steps.at(-1).zero.objects;

// ---- C0: clean -----------------------------------------------------------------------------------------------------
const clean = await build("drift_clean");
const cleanFp = await footprint(clean.db);
await clean.close();
const c0 = compareFootprints(ref, cleanFp);
for (const v of AUDITED) expect(`C0 clean ${v} CURRENT_STATE_EQUIVALENT`, cls(c0, v) === "CURRENT_STATE_EQUIVALENT", m(c0, v).failing.slice(0, 5));
for (const v of AUDITED) expect(`C0 clean ${v} HISTORICAL_APPLICATION UNPROVEN`, m(c0, v).historicalApplication === "UNPROVEN");
for (const v of AUDITED) expect(`C0 clean ${v} structural PASS and privilege PASS`, m(c0, v).structuralEquivalence === "PASS" && m(c0, v).privilegeEquivalence === "PASS");
expect("C0 clean overall LEDGER_ONLY_DRIFT", c0.overall.verdict === "LEDGER_ONLY_DRIFT", c0.overall.reasons);
expect("C0 clean ledger missing exactly the six", eq(c0.ledger.missing, [...OBSERVED_MISSING]));
expect("C0 clean no drift outside the audited migrations", c0.outside.every((x) => x.result === "match"), c0.outside.filter((x) => x.result !== "match").slice(0, 5));
expect("C0 clean platform privileges reported on an audited object", c0.platformPrivileges.some((p) => p.key === "rel:public.faculty_versions" && p.entry.startsWith("service_role=")), c0.platformPrivileges.slice(0, 5));
expect("C0 ledger repair never authorised", c0.ledgerRepairAuthorised === "NO" && /does NOT authorise ledger repair/.test(c0.notice));
expect("C0 labels are current-state labels", c0.migrations.every((x) => LABELS.includes(x.classification)) && !JSON.stringify(c0).includes("EXACTLY_APPLIED"));
expect("C0 historical values within the model, never PROVEN", c0.migrations.every((x) => HISTORICAL.includes(x.historicalApplication) && x.historicalApplication !== "PROVEN") && !HISTORICAL.includes("PROVEN"));

// The real CLIs, CI only: production-footprint.mjs over a mode-600 URL file, then compare.mjs.
if (!usePglite) {
  const dir = mkdtempSync(join(tmpdir(), "kj-drift-"));
  const urlFile = join(dir, "clean.url");
  writeFileSync(urlFile, clean.url + "\n"); chmodSync(urlFile, 0o600);
  const refFile = join(dir, "ref.json"); writeFileSync(refFile, JSON.stringify(ref));
  execFileSync("node", ["scripts/drift/production-footprint.mjs", "--database-url-file", urlFile, "--out", join(dir, "clean.json")], { stdio: "inherit" });
  let refused = false;
  try { execFileSync("node", ["scripts/drift/production-footprint.mjs", "--database-url-file", urlFile, "--out", join(dir, "clean.json")], { stdio: "pipe" }); } catch { refused = true; }
  expect("CLI refuses to overwrite an existing output", refused);
  execFileSync("node", ["scripts/drift/compare.mjs", "--reference", refFile, "--production", join(dir, "clean.json"), "--out", join(dir, "clean-report")], { stdio: "inherit" });
  const cli = JSON.parse(readFileSync(join(dir, "clean-report.json"), "utf8"));
  expect("CLI clean overall LEDGER_ONLY_DRIFT", cli.overall.verdict === "LEDGER_ONLY_DRIFT");
  expect("CLI output written mode 600", (await import("node:fs")).statSync(join(dir, "clean.json")).mode % 0o1000 === 0o600);
}

// ---- C1: the original known-bad database ----------------------------------------------------------------------------
const c1 = compareFootprints(ref, await withDefects(await build("drift_broken", { skip: [P4B1] }), [
  "delete from kernel_private.telegram_operator_state",
  "alter table kernel_private.telegram_approval_cards alter column attempt_count drop default",
  "drop trigger memory_relations_guard on public.memory_relations",
  "create or replace function public.memory_version_guard() returns trigger language plpgsql as $$ begin return new; end $$",
  "grant select on public.identity_profiles to anon",
]));
expect("C1 P4A PARTIAL_CURRENT_STATE (seed)", cls(c1, P4A) === "PARTIAL_CURRENT_STATE" && m(c1, P4A).failing.some((x) => x.surface === "seed"));
expect("C1 P4B PARTIAL_CURRENT_STATE (default)", cls(c1, P4B) === "PARTIAL_CURRENT_STATE" && failingKeys(c1, P4B).includes("col:kernel_private.telegram_approval_cards.attempt_count|default|mismatch"));
expect("C1 P4B.1 ABSENT_OR_DRIFTED", cls(c1, P4B1) === "ABSENT_OR_DRIFTED");
expect("C1 P5 PARTIAL_CURRENT_STATE (trigger missing, digest differs)", cls(c1, P5) === "PARTIAL_CURRENT_STATE"
  && failingKeys(c1, P5).includes("trg:public.memory_relations.memory_relations_guard|@exists|missing")
  && failingKeys(c1, P5).includes("fn:public.memory_version_guard()|srcSha256|mismatch"), failingKeys(c1, P5));
expect("C1 P6 CURRENT_STATE_EQUIVALENT", cls(c1, P6) === "CURRENT_STATE_EQUIVALENT", m(c1, P6).failing.slice(0, 5));
expect("C1 P7A PARTIAL_CURRENT_STATE, privilege FAIL", cls(c1, P7A) === "PARTIAL_CURRENT_STATE" && m(c1, P7A).privilegeEquivalence === "FAIL" && m(c1, P7A).structuralEquivalence === "PASS");
expect("C1 overall NOT_LEDGER_ONLY", c1.overall.verdict === "NOT_LEDGER_ONLY");

// ---- hostile cases on clones of the clean database ------------------------------------------------------------------
const hostile = async (name, defects) => compareFootprints(ref, await withDefects(await driver.clone(name, "drift_clean"), defects));

// H1: a superseded value. P4A created telegram_inbox_command_check; P5 redefined it. Restore P4A's definition.
const h1 = await hostile("drift_h1", [
  "alter table kernel_private.telegram_inbox drop constraint telegram_inbox_command_check",
  "alter table kernel_private.telegram_inbox add constraint telegram_inbox_command_check check (command in ('STATUS','MISSION','TASK','MALFORMED'))",
]);
expect("H1 superseded value compared against FINAL, charged to its owner P5", cls(h1, P5) === "PARTIAL_CURRENT_STATE"
  && failingKeys(h1, P5).includes("con:kernel_private.telegram_inbox.telegram_inbox_command_check|def|mismatch"), failingKeys(h1, P5));
expect("H1 P4A keeps the fields it still owns", cls(h1, P4A) === "CURRENT_STATE_EQUIVALENT", m(h1, P4A).failing);
expect("H1 overall not LEDGER_ONLY_DRIFT", h1.overall.verdict === "NOT_LEDGER_ONLY");

// H2: unexpected trigger on an audited relation.
const h2 = await hostile("drift_h2", ["create trigger extra_trg before insert on kernel_private.control_assertions for each row execute function public.reject_ledger_mutation()"]);
expect("H2 unexpected trigger blocks P4B.1 equivalence", cls(h2, P4B1) === "PARTIAL_CURRENT_STATE" && failingKeys(h2, P4B1).includes("trg:kernel_private.control_assertions.extra_trg|@unexpected|unexpected"), failingKeys(h2, P4B1));
expect("H2 overall NOT_LEDGER_ONLY", h2.overall.verdict === "NOT_LEDGER_ONLY");

// H3: unexpected policy on an audited relation.
const h3 = await hostile("drift_h3", ["create policy extra_pol on public.faculty_versions for select using (true)"]);
expect("H3 unexpected policy blocks P6 equivalence", cls(h3, P6) === "PARTIAL_CURRENT_STATE" && failingKeys(h3, P6).includes("pol:public.faculty_versions.extra_pol|@unexpected|unexpected"), failingKeys(h3, P6));

// H4: unexpected column and index on audited relations.
const h4 = await hostile("drift_h4", [
  "alter table kernel_private.telegram_callback_inbox add column extra text",
  "create index extra_idx on public.memory_candidates(created_at)",
]);
expect("H4 unexpected column blocks P4B equivalence", cls(h4, P4B) === "PARTIAL_CURRENT_STATE" && failingKeys(h4, P4B).includes("col:kernel_private.telegram_callback_inbox.extra|@unexpected|unexpected"), failingKeys(h4, P4B));
expect("H4 unexpected index blocks P5 equivalence", cls(h4, P5) === "PARTIAL_CURRENT_STATE" && failingKeys(h4, P5).includes("idx:public.memory_candidates.extra_idx|@unexpected|unexpected"), failingKeys(h4, P5));

// H5: one critical guard missing while everything else matches.
const h5fp = await withDefects(await driver.clone("drift_h5", "drift_clean"), ["drop trigger identity_version_sequence on public.identity_versions"]);
const h5 = compareFootprints(ref, h5fp);
expect("H5 one missing guard prevents P7A equivalence", cls(h5, P7A) === "PARTIAL_CURRENT_STATE" && m(h5, P7A).counts.match > 100
  && failingKeys(h5, P7A).includes("trg:public.identity_versions.identity_version_sequence|@exists|missing"), m(h5, P7A).counts);

// H6: explicit migration-owned privilege effects violated.
const h6 = await hostile("drift_h6", [
  "grant update on public.faculty_pins to service_role",            // P6: revoke update,delete,truncate ... from service_role
  "grant select on kernel_private.telegram_inbox to anon",          // P4A: revoke all ... from public, anon, authenticated
  "grant execute on function public.memory_version_guard() to public", // P5: revoke execute ... from public
  "grant select on kernel_private.identity_governance_state to service_role", // P7A: revoke all ... from service_role
]);
expect("H6 P6 service_role revoke violated", cls(h6, P6) === "PARTIAL_CURRENT_STATE" && m(h6, P6).privilegeEquivalence === "FAIL" && failingKeys(h6, P6).includes("rel:public.faculty_pins|service_role=UPDATE|violation"), failingKeys(h6, P6));
expect("H6 P4A anon revoke violated", m(h6, P4A).privilegeEquivalence === "FAIL" && failingKeys(h6, P4A).includes("rel:kernel_private.telegram_inbox|anon=SELECT|violation"), failingKeys(h6, P4A));
expect("H6 P5 function EXECUTE revoke violated", m(h6, P5).privilegeEquivalence === "FAIL" && failingKeys(h6, P5).includes("fn:public.memory_version_guard()|PUBLIC=EXECUTE|violation"), failingKeys(h6, P5));
expect("H6 P7A kernel_private service_role revoke violated", m(h6, P7A).privilegeEquivalence === "FAIL" && failingKeys(h6, P7A).includes("rel:kernel_private.identity_governance_state|service_role=SELECT|violation"), failingKeys(h6, P7A));

// H7: platform default ACL noise unrelated to any migration-owned privilege.
const h7 = await hostile("drift_h7", [
  "do $$ begin if not exists (select 1 from pg_roles where rolname = 'platform_reader') then create role platform_reader nologin; end if; end $$",
  "alter default privileges for role postgres in schema kernel_private grant select on tables to platform_reader",
  "alter default privileges for role postgres in schema public grant usage on types to authenticated",
]);
for (const v of AUDITED) expect(`H7 platform noise leaves ${v} CURRENT_STATE_EQUIVALENT`, cls(h7, v) === "CURRENT_STATE_EQUIVALENT", m(h7, v).failing.slice(0, 3));
expect("H7 overall LEDGER_ONLY_DRIFT with the noise reported", h7.overall.verdict === "LEDGER_ONLY_DRIFT" && h7.platform.defaultAcl.some((d) => d.acl.some((e) => e.startsWith("platform_reader="))));

// H8: major-version mismatch fails closed, while stable facts still find real drift.
const h8 = compareFootprints(ref, { ...cleanFp, meta: { ...cleanFp.meta, serverVersionNum: "160009" } });
expect("H8 major mismatch overall INSUFFICIENT_EVIDENCE", h8.overall.verdict === "INSUFFICIENT_EVIDENCE" && !h8.versionPolicy.sameMajor);
expect("H8 no migration CURRENT_STATE_EQUIVALENT", h8.migrations.every((x) => x.classification === "INSUFFICIENT_EVIDENCE"), h8.migrations.map((x) => x.classification));
expect("H8 deparse fields and privileges INSUFFICIENT", m(h8, P5).failing.some((x) => x.field === "def" && x.result === "insufficient") && m(h8, P5).privilegeEquivalence === "INSUFFICIENT_EVIDENCE");
const h8b = compareFootprints(ref, { ...h5fp, meta: { ...h5fp.meta, serverVersionNum: "160009" } });
expect("H8 stable facts still report a missing guard under mismatch", cls(h8b, P7A) === "PARTIAL_CURRENT_STATE" && h8b.overall.verdict === "INSUFFICIENT_EVIDENCE");

// H9: canonical drift outside the six prevents LEDGER_ONLY_DRIFT.
const files14 = files.map((f) => f.name.slice(0, 14));
const ownerOf = (key) => { let o = null; for (let i = 1; i < ref.steps.length; i++) { const a = ref.steps[i - 1].zero.objects[key], b = ref.steps[i].zero.objects[key]; if (!eq(a ?? null, b ?? null)) o = files14[i - 1]; } return o; };
const foreignIdx = Object.keys(final).find((k) => k.startsWith("idx:") && !/_pkey$|_key$/.test(k) && !final[k].def.includes("UNIQUE") && !AUDITED.includes(ownerOf(k)));
const [, idxSchema, , idxName] = /^idx:([^.]+)\.([^.]+)\.(.+)$/.exec(foreignIdx);
const h9 = await hostile("drift_h9", [`drop index ${idxSchema}.${idxName}`]);
for (const v of AUDITED) expect(`H9 ${v} still CURRENT_STATE_EQUIVALENT`, cls(h9, v) === "CURRENT_STATE_EQUIVALENT");
expect(`H9 dropping ${foreignIdx} (outside the six) makes the overall NOT_LEDGER_ONLY`, h9.overall.verdict === "NOT_LEDGER_ONLY" && h9.outside.some((x) => x.key === foreignIdx && x.result === "missing"), h9.overall);

// H10: a migration with no observable catalogue footprint.
const noop = { file: "20260920160000_noop.sql", sqlSha256: null, zero: ref.steps[files14.indexOf(P4B) + 1].zero, max: ref.steps[files14.indexOf(P4B) + 1].max };
const refNoop = { ...ref, steps: [...ref.steps.slice(0, files14.indexOf(P4B) + 2), noop, ...ref.steps.slice(files14.indexOf(P4B) + 2)] };
const h10 = compareFootprints(refNoop, { ...cleanFp, ledger: [...cleanFp.ledger] }, { audited: [...AUDITED, "20260920160000"], observedMissing: [...OBSERVED_MISSING, "20260920160000"].sort() });
expect("H10 no footprint is NO_OBSERVABLE_FOOTPRINT", cls(h10, "20260920160000") === "NO_OBSERVABLE_FOOTPRINT");
expect("H10 overall INSUFFICIENT_EVIDENCE", h10.overall.verdict === "INSUFFICIENT_EVIDENCE", h10.overall);

// H11: ledger conditions.
expect("H11 unexpected ledger version", compareFootprints(ref, { ...cleanFp, ledger: [...cleanFp.ledger, "20991231000000"].sort() }).overall.verdict === "NOT_LEDGER_ONLY");
expect("H11 a seventh missing version", compareFootprints(ref, { ...cleanFp, ledger: cleanFp.ledger.slice(1) }).overall.verdict === "NOT_LEDGER_ONLY");
expect("H11 duplicate ledger version", compareFootprints(ref, { ...cleanFp, ledger: [...cleanFp.ledger, cleanFp.ledger[0]].sort() }).overall.verdict === "NOT_LEDGER_ONLY");
expect("H11 no ledger", compareFootprints(ref, { ...cleanFp, ledger: null }).overall.verdict === "INSUFFICIENT_EVIDENCE");

// H12: a seed hidden by RLS cannot be evaluated.
const h12 = compareFootprints(ref, { ...cleanFp, seeds: { "kernel_private.telegram_operator_state": { ...cleanFp.seeds["kernel_private.telegram_operator_state"], rlsVisible: false } } });
expect("H12 RLS-hidden seed is INSUFFICIENT_EVIDENCE", cls(h12, P4A) === "INSUFFICIENT_EVIDENCE" && h12.overall.verdict === "INSUFFICIENT_EVIDENCE");

// H13: recursive canonical equality.
expect("H13 nested key order is irrelevant", eq({ a: { b: 1, c: { d: 2, e: 3 } } }, { a: { c: { e: 3, d: 2 }, b: 1 } }));
expect("H13 nested value differences are seen", !eq({ a: { b: 1, c: { d: 2 } } }, { a: { b: 1, c: { d: 3 } } }) && canonical([{ b: 1, a: 2 }]) === '[{"a":2,"b":1}]');

await driver.end();
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) { console.error(`SELFTEST FAILED: ${failures.join("; ")}`); process.exit(1); }
console.log("SELFTEST PASSED");
process.exit(0); // open PGlite instances would otherwise keep the process alive
