import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { DATABASE, compose, holdRuntime, migrate, until } from "./support/local.js";
import { fetchRuntimeRoles } from "../services/kernel/src/health/collect.js";
import { snapshotPlatformBaseline } from "../services/kernel/src/database/platform-baseline-snapshot.js";
import {
  INVENTORY_SQL_SHA256, baselineBindingProblems, definerInventoryProblems, loadStageManifest, readStampFacts, stageFunctions, type PlatformBaseline,
} from "../services/kernel/src/database/security-definers.js";

/**
 * KJ-P8 B1 - the SECURITY DEFINER inventory and the section 27.9 exception against a real catalogue
 * (ADR-0023 revision 2.5, sections 27.9 and 27.10, sealed at 424f85c283a543ba00a650ecc2ecc3a4346623df).
 *
 * A fresh database is migrated from canonical main WITHOUT B1 (derivation A of the source digest is read here), given
 * representative platform definers in a platform-looking schema, snapshotted read-only by the sealed procedure, and
 * only then migrated with B1. Every assertion is then made to fail on purpose and restored. Observed catalogue values
 * are written to artifacts/local/b1-definers.json. This database is a qualification fixture: it is NOT the target
 * environment, and its baseline is never the target platform baseline.
 */
const B1 = "20261002090000_runtime_least_privilege_roles.sql";
const tag = randomUUID().replaceAll("-", "").slice(0, 12);
const name = `kj_b1_def_${tag}`;
const admin = new pg.Pool({ connectionString: DATABASE, max: 1 });
const url = (db = name) => DATABASE.replace(/\/kerneljson$/, `/${db}`);
const manifest = loadStageManifest();
const PIN = stageFunctions(manifest, "B1")[0]!.sourceDigest!;
const lf = (t: string) => t.replaceAll("\r\n", "\n");
const hex = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const STAMP = "kernel_private.stamp_binding_provenance()";
const DIGEST_SQL = `select encode(sha256(convert_to(replace(prosrc, E'\\r\\n', E'\\n'), 'UTF8')), 'hex') as digest, prosrc
  from pg_proc where oid = '${STAMP}'::regprocedure`;
let pool: pg.Pool;
let baseline: PlatformBaseline;
let owner = "";
let releaseRuntime = () => {};
const evidence: Record<string, unknown> = {
  contract: "kerneljson:b1-definer-qualification/v1",
  design: manifest.design.sha,
  testedCommit: process.env["GITHUB_SHA"] ?? process.env["KERNELJSON_RELEASE_ID"] ?? "local",
  environment: "qualification fixture (docker compose postgres); not the target environment",
};
const fixtures: { fixture: string; expected: string; observedProblems: string[]; failedOnPurpose: boolean; restored: boolean }[] = [];

// The platform definers a Supabase-shaped target holds before B1, one per source-digest rule of 27.10.4.
const PLATFORM = [
  `create function auth.kj_platform_uid() returns uuid language sql stable security definer as $f$ select '00000000-0000-4000-8000-000000000000'::uuid $f$`,
  `create function auth.kj_platform_guard() returns void language plpgsql security definer set search_path = '' as $f$ begin perform 1; end $f$`,
  `create function auth.kj_platform_atomic() returns integer language sql security definer begin atomic select 1; end`,
  `create function auth.kj_platform_len(text) returns integer language internal immutable strict security definer as 'textlen'`,
];

beforeAll(async () => {
  releaseRuntime = holdRuntime();
  compose("up", "-d", "db");
  await until(() => admin.query("select 1"), (r) => r.rowCount === 1);
  await admin.query(`create database ${name}`);
  pool = new pg.Pool({ connectionString: url(), max: 4 });
  pool.on("error", () => {});
  await migrate(pool, { exclude: [B1] });
  owner = (await pool.query<{ o: string }>(`select pg_get_userbyid(nspowner) as o from pg_namespace where nspname = 'kernel_private'`)).rows[0]!.o;
  // Derivation A: pg_proc.prosrc of a database migrated from main without B1, hashed in SQL and again in Node.
  const a = (await pool.query<{ digest: string; prosrc: string }>(DIGEST_SQL)).rows[0]!;
  const pre = (await pool.query(`select prosecdef, proconfig, proacl::text[] as acl from pg_proc where oid = '${STAMP}'::regprocedure`)).rows[0];
  evidence["preB1"] = { derivationA: { sql: a.digest, node: hex(lf(a.prosrc)) }, stamp: pre };
  // The Supabase migration ledger, as the target holds it before B1 (ADR-0023 27.11.6 item 3 requires it).
  await createLedger(pool, manifest.baseMigrations.map((m) => m.file));
  await pool.query(`create schema auth`);
  for (const sql of PLATFORM) await pool.query(sql);
  // A platform grants its definers to its own roles, not to PUBLIC. A PUBLIC-executable platform function would be a
  // runtime-role grant outside the frozen manifest; that case is proved red below and is a cutover precondition.
  await pool.query(`revoke execute on all functions in schema auth from public`);
  const client = new pg.Client({ connectionString: url() });
  await client.connect();
  try {
    baseline = await snapshotPlatformBaseline(client, "qualification-fixture", manifest);
  } finally { await client.end(); }
  await migrate(pool, { only: [B1] });
});
afterAll(async () => {
  mkdirSync("artifacts/local", { recursive: true });
  writeFileSync("artifacts/local/b1-definers.json", JSON.stringify({ ...evidence, fixtures }, null, 2) + "\n");
  await pool?.end();
  for (const db of [name, `${name}_acl`, `${name}_tamper`, `${name}_ledger`]) {
    await until(() => admin.query("select count(*)::int as n from pg_stat_activity where datname = $1", [db]), (r) => r.rows[0].n === 0, 15000);
    await admin.query(`drop database if exists ${db}`);
  }
  await admin.end();
  releaseRuntime();
});

const problems = () => definerInventoryProblems(pool, manifest, baseline);
async function createLedger(db: pg.Pool, files: readonly string[]): Promise<void> {
  await db.query(`create schema supabase_migrations`);
  await db.query(`create table supabase_migrations.schema_migrations (version text primary key, name text)`);
  for (const f of files) await db.query(`insert into supabase_migrations.schema_migrations values ($1, $2)`, [f.slice(0, 14), f.slice(15, -4)]);
}

describe("27.9.3 source digest: two independent derivations", () => {
  it("derivation A (catalogue of main without B1) equals derivation B (migration text) and the reviewed pin", () => {
    const text = lf(readFileSync("supabase/migrations/20260916205049_release_provenance.sql", "utf8"));
    const open = text.indexOf("create function kernel_private.stamp_binding_provenance()");
    const start = text.indexOf("$$", open) + 2;
    const derivationB = hex(text.slice(start, text.indexOf("$$", start)));
    const a = (evidence["preB1"] as { derivationA: { sql: string; node: string } }).derivationA;
    evidence["sourceDigest"] = { pin: PIN, derivationA: a, derivationB };
    expect(a.sql).toBe(a.node);
    expect(a.sql).toBe(derivationB);
    expect(PIN).toBe(derivationB);
  });
  it("after B1 the catalogue source still equals the pin", async () => {
    const after = (await pool.query<{ digest: string }>(DIGEST_SQL)).rows[0]!.digest;
    (evidence["sourceDigest"] as Record<string, unknown>)["afterB1"] = after;
    expect(after).toBe(PIN);
  });
});

describe("27.9.4 the exception's exact catalogue values (observed and recorded)", () => {
  it("identity, security, owner and proconfig", async () => {
    const r = (await pool.query(
      `select n.nspname as schema, p.proname as name, p.pronargs, format_type(p.prorettype, null) as returns, p.proretset, p.prokind::text as prokind,
              p.prosecdef, pg_get_userbyid(p.proowner) as owner, p.proconfig, l.lanname
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang where p.oid = '${STAMP}'::regprocedure`)).rows[0];
    evidence["stampCatalogue"] = r;
    expect(r).toEqual({
      schema: "kernel_private", name: "stamp_binding_provenance", pronargs: 0, returns: "trigger", proretset: false, prokind: "f",
      prosecdef: true, owner, proconfig: ['search_path=""'], lanname: "plpgsql",
    });
  });
  it("ACL is exactly the owner's EXECUTE: proacl, aclexplode and effective privilege agree", async () => {
    const acl = (await pool.query<{ acl: string[] | null }>(`select proacl::text[] as acl from pg_proc where oid = '${STAMP}'::regprocedure`)).rows[0]!.acl;
    const items = (await pool.query(
      `select pg_get_userbyid(a.grantor) as grantor, case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee, a.privilege_type, a.is_grantable
         from pg_proc p, aclexplode(p.proacl) a where p.oid = '${STAMP}'::regprocedure`)).rows;
    const effective = (await pool.query(
      `select r as role, has_function_privilege(r, '${STAMP}'::regprocedure, 'EXECUTE') as execute from unnest(array['kj_worker','kj_door','anon','authenticated','service_role']) r`)).rows;
    evidence["stampAcl"] = { proacl: acl, aclexplode: items, effective };
    expect(acl).toEqual([`${owner}=X/${owner}`]);
    expect(items).toEqual([{ grantor: owner, grantee: owner, privilege_type: "EXECUTE", is_grantable: false }]);
    expect(effective.every((e: { execute: boolean }) => !e.execute)).toBe(true);
  });
  it("trigger topology is exactly one execution_bindings_provenance, BEFORE INSERT FOR EACH ROW, enabled, no WHEN", async () => {
    const facts = await readStampFacts(pool);
    evidence["stampTrigger"] = facts.triggers;
    expect(facts.triggers).toEqual([manifest.stampTrigger]);
  });
  it("exactly one function in all governed schemas is named stamp_binding_provenance", async () => {
    const facts = await readStampFacts(pool);
    evidence["stampNameUniqueness"] = facts.sameName.map((f) => `${f.schema}.${f.name}(${f.args.join(", ")}) -> ${f.returns}`);
    expect(evidence["stampNameUniqueness"]).toEqual(["kernel_private.stamp_binding_provenance() -> pg_catalog.trigger"]);
  });
});

describe("27.10.4 the read-only platform snapshot", () => {
  it("was taken before B1 in a READ ONLY transaction with an empty search_path, and holds exactly the platform definers", async () => {
    evidence["baseline"] = baseline;
    expect(baseline.provenance.transaction.readOnly).toBe(true);
    expect(['""', ""]).toContain(baseline.provenance.transaction.searchPath);
    expect(baseline.provenance).toMatchObject({ stampSecurityDefiner: false, querySha256: INVENTORY_SQL_SHA256, migrationLedger: { b1Recorded: false } });
    expect(baseline.provenance.systemIdentifier).toMatch(/^[0-9]+$/);
    expect(baseline.entries.map((e) => `${e.schema}.${e.name}(${e.args.join(", ")})`)).toEqual([
      "auth.kj_platform_atomic()", "auth.kj_platform_guard()", "auth.kj_platform_len(pg_catalog.text)", "auth.kj_platform_uid()"]);
  });
  it("applies each source-digest rule: internal, SQL-standard body, and prosrc", async () => {
    const by = Object.fromEntries(baseline.entries.map((e) => [e.name, e]));
    const body = (await pool.query<{ b: string }>(`select pg_get_function_sqlbody('auth.kj_platform_atomic()'::regprocedure) as b`)).rows[0]!.b;
    const src = (await pool.query<{ s: string }>(`select prosrc as s from pg_proc where oid = 'auth.kj_platform_guard()'::regprocedure`)).rows[0]!.s;
    expect(by["kj_platform_len"]!.sourceDigest).toBe(hex("internal\n\ntextlen"));
    expect(by["kj_platform_atomic"]!.sourceDigest).toBe(hex(lf(body)));
    expect(by["kj_platform_guard"]!.sourceDigest).toBe(hex(lf(src)));
    expect(by["kj_platform_guard"]!.config).toEqual(['search_path=""']);
    expect(by["kj_platform_uid"]!.config).toBeNull();
  });
  it("refuses to snapshot a database where B1 is already applied", async () => {
    const client = new pg.Client({ connectionString: url() });
    await client.connect();
    try {
      await expect(snapshotPlatformBaseline(client, "after-b1", manifest)).rejects.toThrow(/PLATFORM_BASELINE_REFUSED: B1 is already applied/);
    } finally { await client.end(); }
  });
});

describe("27.10.1 ACTUAL equals EXPECTED(B1) = PLATFORM_BASELINE UNION { stamp_binding_provenance() }", () => {
  it("holds on the migrated database", async () => {
    expect(await problems()).toEqual([]);
  });
  it.skipIf(process.env["KJ_RUNTIME_ROLES"] === "discover")("database.runtimeRolesLeastPrivilege is green, read as kj_worker", async () => {
    expect(await fetchRuntimeRoles(pool, { baseline })).toEqual({ available: true, problems: [] });
  });
  it("without a frozen baseline the health check stays red with TARGET_PLATFORM_BASELINE_PENDING", async () => {
    const observed = await fetchRuntimeRoles(pool, { baseline: null });
    expect(observed.available && observed.problems).toContain("TARGET_PLATFORM_BASELINE_PENDING: no frozen platform SECURITY DEFINER baseline for this environment");
  });
  // Like the green check above, this needs a genuine kj_worker session, so it runs in the enforce run only.
  it.skipIf(process.env["KJ_RUNTIME_ROLES"] === "discover")("27.11: a platform function executable by PUBLIC in a schema the roles cannot USAGE is not a runtime fact", async () => {
    await pool.query(`grant execute on function auth.kj_platform_uid() to public`);
    try {
      expect(await fetchRuntimeRoles(pool, { baseline })).toEqual({ available: true, problems: [] });
    } finally { await pool.query(`revoke execute on function auth.kj_platform_uid() from public`); }
  });
  it("27.11: once that schema has USAGE, the schema grant and the function grant are both unexpected facts and the check goes red", async () => {
    await pool.query(`grant execute on function auth.kj_platform_uid() to public`);
    await pool.query(`grant usage on schema auth to public`);
    try {
      const observed = await fetchRuntimeRoles(pool, { baseline });
      expect(observed.available && observed.problems).toEqual(expect.arrayContaining([
        "kj_worker holds unlisted schema:auth:USAGE", "kj_door holds unlisted schema:auth:USAGE",
        "kj_worker holds unlisted function:auth.kj_platform_uid():EXECUTE", "kj_door holds unlisted function:auth.kj_platform_uid():EXECUTE"]));
    } finally {
      await pool.query(`revoke usage on schema auth from public`);
      await pool.query(`revoke execute on function auth.kj_platform_uid() from public`);
    }
  });
  it("27.11.4: a definer in a schema with no runtime USAGE is still inventoried by 27.10", async () => {
    await pool.query(`create schema kj_b1_nousage`);
    await pool.query(`create function kj_b1_nousage.kj_probe() returns int language sql security definer as 'select 1'`);
    try {
      const usage = (await pool.query(`select has_schema_privilege('kj_worker', 'kj_b1_nousage', 'USAGE') as w, has_schema_privilege('kj_door', 'kj_b1_nousage', 'USAGE') as d`)).rows[0];
      expect(usage).toEqual({ w: false, d: false });
      expect(await problems()).toContain("unlisted SECURITY DEFINER function kj_b1_nousage.kj_probe()");
    } finally { await pool.query(`drop schema kj_b1_nousage cascade`); }
    expect(await problems()).toEqual([]);
  });
  it("27.11.6 item 4: the baseline is bound to this database's system identifier and name", async () => {
    expect(await baselineBindingProblems(pool, baseline)).toEqual([]);
    const otherSystem = { ...baseline, provenance: { ...baseline.provenance, systemIdentifier: "1" } };
    expect(await baselineBindingProblems(pool, otherSystem)).toEqual([expect.stringMatching(/^platform baseline belongs to system 1, not this database's [0-9]+$/)]);
    const otherDatabase = { ...baseline, provenance: { ...baseline.provenance, database: "some_other_db" } };
    expect(await baselineBindingProblems(pool, otherDatabase)).toEqual([`platform baseline belongs to database some_other_db, not ${name}`]);
    expect(await definerInventoryProblems(pool, manifest, otherSystem)).toEqual([expect.stringContaining("platform baseline belongs to system 1")]);
  });
  it("the health check reports an unlisted privilege and an unlisted definer function together", async () => {
    await pool.query(`grant truncate on public.task_events to kj_door`);
    await pool.query(`create function public.kj_b1_probe_definer2() returns int language sql security definer as 'select 1'`);
    try {
      const observed = await fetchRuntimeRoles(pool, { baseline });
      expect(observed.available && observed.problems).toEqual(expect.arrayContaining([
        "kj_door holds unlisted relation:public.task_events:TRUNCATE", "unlisted SECURITY DEFINER function public.kj_b1_probe_definer2()"]));
    } finally {
      await pool.query(`drop function public.kj_b1_probe_definer2()`);
      await pool.query(`revoke truncate on public.task_events from kj_door`);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Every assertion fails on purpose. [fixture, apply, restore, expected problem fragment]
const probeOwner = `kj_b1_probe_owner_${tag}`;
const q = (...sql: string[]) => async () => { for (const s of sql) await pool.query(s); };
let originalSrc = "";
const FIXTURES: [string, () => Promise<void>, () => Promise<void>, string][] = [
  ["platform definer added after the snapshot", q(`create function auth.kj_platform_late() returns int language sql security definer as 'select 1'`),
    q(`drop function auth.kj_platform_late()`), "unlisted SECURITY DEFINER function auth.kj_platform_late()"],
  ["platform definer missing", q(`drop function auth.kj_platform_guard()`), q(PLATFORM[1]!, `revoke execute on function auth.kj_platform_guard() from public`),
    "missing SECURITY DEFINER function auth.kj_platform_guard()"],
  ["platform definer with a changed owner", q(`create role ${probeOwner} nologin`, `alter function auth.kj_platform_uid() owner to ${probeOwner}`),
    async () => { await q(`alter function auth.kj_platform_uid() owner to ${owner}`, `drop role ${probeOwner}`)(); }, "auth.kj_platform_uid() owner:"],
  ["platform definer with a changed return type", q(`drop function auth.kj_platform_uid()`, `create function auth.kj_platform_uid() returns text language sql stable security definer as $f$ select 'x' $f$`),
    q(`drop function auth.kj_platform_uid()`, PLATFORM[0]!, `revoke execute on function auth.kj_platform_uid() from public`), "auth.kj_platform_uid() returns:"],
  ["platform definer with a changed proconfig", q(`alter function auth.kj_platform_guard() reset search_path`),
    q(`alter function auth.kj_platform_guard() set search_path = ''`), "auth.kj_platform_guard() config:"],
  ["platform definer with a changed source digest", q(`create or replace function auth.kj_platform_guard() returns void language plpgsql security definer set search_path = '' as $f$ begin perform 2; end $f$`),
    q(`create or replace function auth.kj_platform_guard() returns void language plpgsql security definer set search_path = '' as $f$ begin perform 1; end $f$`), "auth.kj_platform_guard() sourceDigest:"],
  ["a platform-looking schema is not excluded", q(`create schema storage`, `create function storage.kj_probe() returns int language sql security definer as 'select 1'`),
    q(`drop schema storage cascade`), "unlisted SECURITY DEFINER function storage.kj_probe()"],
  ["a new application schema is no escape hatch", q(`create schema kj_b1_app`, `create function kj_b1_app.kj_probe() returns int language sql security definer as 'select 1'`),
    q(`drop schema kj_b1_app cascade`), "unlisted SECURITY DEFINER function kj_b1_app.kj_probe()"],
  ["a moved function is missing and extra", q(`create schema storage`, `alter function auth.kj_platform_uid() set schema storage`),
    q(`alter function storage.kj_platform_uid() set schema auth`, `drop schema storage`), "unlisted SECURITY DEFINER function storage.kj_platform_uid()"],
  ["an unlisted definer in public", q(`create function public.kj_b1_probe_definer() returns int language sql security definer as 'select 1'`),
    q(`drop function public.kj_b1_probe_definer()`), "unlisted SECURITY DEFINER function public.kj_b1_probe_definer()"],
  ["a later-stage function present at B1", q(`create function kernel_private.freeze_reflection(uuid) returns void language plpgsql security definer set search_path = '' as $f$ begin end $f$`),
    q(`drop function kernel_private.freeze_reflection(uuid)`), "unlisted SECURITY DEFINER function kernel_private.freeze_reflection(pg_catalog.uuid)"],
  ["a second stamp_binding_provenance in public", q(`create function public.stamp_binding_provenance() returns trigger language plpgsql as $f$ begin return new; end $f$`),
    q(`drop function public.stamp_binding_provenance()`), "exactly one function named stamp_binding_provenance must exist"],
  ["a stamp_binding_provenance overload", q(`create function kernel_private.stamp_binding_provenance(integer) returns integer language sql as 'select 1'`),
    q(`drop function kernel_private.stamp_binding_provenance(integer)`), "exactly one function named stamp_binding_provenance must exist"],
  ["the stamp function back to SECURITY INVOKER", q(`alter function ${STAMP} security invoker`), q(`alter function ${STAMP} security definer`),
    `missing SECURITY DEFINER function ${STAMP}`],
  ["the stamp function executable by kj_worker", q(`grant execute on function ${STAMP} to kj_worker`), q(`revoke execute on function ${STAMP} from kj_worker`), `${STAMP} acl:`],
  ["the stamp function executable by PUBLIC", q(`grant execute on function ${STAMP} to public`), q(`revoke execute on function ${STAMP} from public`), `${STAMP} acl:`],
  ["the stamp function with a null proacl (the PUBLIC default)", q(`update pg_proc set proacl = null where oid = '${STAMP}'::regprocedure`),
    q(`revoke all on function ${STAMP} from public`), `${STAMP} acl:`],
  ["the stamp function with a widened search_path", q(`alter function ${STAMP} set search_path = public`), q(`alter function ${STAMP} set search_path = ''`), `${STAMP} config:`],
  ["the stamp function with no search_path", q(`alter function ${STAMP} reset search_path`), q(`alter function ${STAMP} set search_path = ''`), `${STAMP} config:`],
  ["the stamp function with another owner", q(`create role ${probeOwner} nologin`, `alter function ${STAMP} owner to ${probeOwner}`),
    async () => { await q(`alter function ${STAMP} owner to ${owner}`, `drop role ${probeOwner}`)(); }, `${STAMP} owner:`],
  ["the stamp function with a changed body", async () => {
    originalSrc = (await pool.query<{ s: string }>(`select prosrc as s from pg_proc where oid = '${STAMP}'::regprocedure`)).rows[0]!.s;
    await pool.query(`update pg_proc set prosrc = prosrc || ' ' where oid = '${STAMP}'::regprocedure`);
  }, async () => { await pool.query(`update pg_proc set prosrc = $1 where oid = '${STAMP}'::regprocedure`, [originalSrc]); }, `${STAMP} sourceDigest:`],
  ["the trigger disabled", q(`alter table kernel_private.execution_bindings disable trigger execution_bindings_provenance`),
    q(`alter table kernel_private.execution_bindings enable trigger execution_bindings_provenance`), "trigger topology"],
  ["the trigger set to fire only on replicas", q(`alter table kernel_private.execution_bindings enable replica trigger execution_bindings_provenance`),
    q(`alter table kernel_private.execution_bindings enable trigger execution_bindings_provenance`), "trigger topology"],
  ["the trigger set to fire always", q(`alter table kernel_private.execution_bindings enable always trigger execution_bindings_provenance`),
    q(`alter table kernel_private.execution_bindings enable trigger execution_bindings_provenance`), "trigger topology"],
  ["a second attachment on execution_bindings", q(`create trigger kj_b1_second before insert on kernel_private.execution_bindings for each row execute function ${STAMP}`),
    q(`drop trigger kj_b1_second on kernel_private.execution_bindings`), "must be attached to exactly one trigger; found 2"],
  ["an attachment on another table", q(`create trigger kj_b1_elsewhere before insert on kernel_private.dispatch_events for each row execute function ${STAMP}`),
    q(`drop trigger kj_b1_elsewhere on kernel_private.dispatch_events`), "must be attached to exactly one trigger; found 2"],
  ["a WHEN condition on the trigger", q(`drop trigger execution_bindings_provenance on kernel_private.execution_bindings`,
    `create trigger execution_bindings_provenance before insert on kernel_private.execution_bindings for each row when (new.release_epoch >= 0) execute function ${STAMP}`),
    q(`drop trigger execution_bindings_provenance on kernel_private.execution_bindings`,
      `create trigger execution_bindings_provenance before insert on kernel_private.execution_bindings for each row execute function ${STAMP}`), "trigger topology"],
  ["the trigger renamed", q(`alter trigger execution_bindings_provenance on kernel_private.execution_bindings rename to kj_b1_renamed`),
    q(`alter trigger kj_b1_renamed on kernel_private.execution_bindings rename to execution_bindings_provenance`), "trigger topology"],
];

describe("27.9.4 and 27.10: every assertion fails on purpose", () => {
  it.each(FIXTURES)("%s", async (fixture, apply, restore, fragment) => {
    await apply();
    const observed = await problems().finally(restore);
    const after = await problems();
    const failedOnPurpose = observed.some((p) => p.includes(fragment));
    fixtures.push({ fixture, expected: fragment, observedProblems: observed, failedOnPurpose, restored: after.length === 0 });
    expect(observed.some((p) => p.includes(fragment)), JSON.stringify(observed)).toBe(true);
    expect(after).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("27.10.2 the excluded-schema predicate, observed", () => {
  it("temporary schemas are named pg_temp_<n> and pg_toast_temp_<n>", async () => {
    const client = new pg.Client({ connectionString: url() });
    await client.connect();
    try {
      await client.query(`create temporary table kj_b1_tmp (i int, t text)`);
      const t = (await client.query<{ temp: string; toast: string | null }>(
        `select n.nspname as temp, (select nspname from pg_namespace where nspname = 'pg_toast_temp_' || substr(n.nspname, 9)) as toast
           from pg_namespace n where n.oid = pg_my_temp_schema()`)).rows[0]!;
      evidence["tempSchemaNames"] = t;
      expect(t.temp).toMatch(/^pg_temp_[0-9]+$/);
      expect(t.toast).toMatch(/^pg_toast_temp_[0-9]+$/);
    } finally { await client.end(); }
  });
  it("PostgreSQL refuses a schema named with the reserved pg_ prefix (42939), even for the owner", async () => {
    const code = await pool.query(`create schema pg_kj_probe`).then(() => "OK", (e: { code?: string }) => e.code ?? "NO_SQLSTATE");
    evidence["reservedPrefix"] = { statement: "create schema pg_kj_probe", sqlstate: code };
    if (code === "OK") await pool.query(`drop schema pg_kj_probe`);
    expect(code).toBe("42939");
  });
});

describe("the B1 migration's pre-COMMIT self-check", () => {
  it("removes any foreign EXECUTE grant so the ACL is exactly the owner's", async () => {
    await admin.query(`create database ${name}_acl`);
    const db = new pg.Pool({ connectionString: url(`${name}_acl`), max: 2 });
    db.on("error", () => {});
    try {
      await migrate(db, { exclude: [B1] });
      await db.query(`grant execute on function ${STAMP} to anon, authenticated`);
      await migrate(db, { only: [B1] });
      const acl = (await db.query<{ acl: string[] }>(`select proacl::text[] as acl from pg_proc where oid = '${STAMP}'::regprocedure`)).rows[0]!.acl;
      const o = (await db.query<{ o: string }>(`select pg_get_userbyid(proowner) as o from pg_proc where oid = '${STAMP}'::regprocedure`)).rows[0]!.o;
      expect(acl).toEqual([`${o}=X/${o}`]);
    } finally { await db.end(); }
  });
  it("refuses to commit B1 when the stamp body differs from the pin (23514)", async () => {
    await admin.query(`create database ${name}_tamper`);
    const db = new pg.Pool({ connectionString: url(`${name}_tamper`), max: 2 });
    db.on("error", () => {});
    try {
      await migrate(db, { exclude: [B1] });
      await db.query(`update pg_proc set prosrc = prosrc || ' ' where oid = '${STAMP}'::regprocedure`);
      const failure = await migrate(db, { only: [B1] }).then(() => null, (e: { code?: string; message?: string }) => e);
      evidence["migrationRefusesTamperedBody"] = { sqlstate: failure?.code, message: failure?.message?.slice(0, 200) };
      expect(failure?.code).toBe("23514");
      expect(failure?.message).toMatch(/source digest of kernel_private\.stamp_binding_provenance\(\)/);
      const roles = (await db.query<{ n: number }>(`select count(*)::int as n from pg_proc where oid = '${STAMP}'::regprocedure and prosecdef`)).rows[0]!.n;
      expect(roles).toBe(0); // the whole B1 transaction rolled back
    } finally { await db.end(); }
  });
});

describe("27.11.6 item 3: the snapshot needs the ledger at the expected head and the stamp function", () => {
  it("refuses with no ledger, with the wrong head, and without the stamp function; succeeds once all hold", async () => {
    await admin.query(`create database ${name}_ledger`);
    const db = new pg.Pool({ connectionString: url(`${name}_ledger`), max: 2 });
    db.on("error", () => {});
    const snap = async () => {
      const client = new pg.Client({ connectionString: url(`${name}_ledger`) });
      await client.connect();
      try { return await snapshotPlatformBaseline(client, "ledger-fixture", manifest); } finally { await client.end(); }
    };
    try {
      await migrate(db, { exclude: [B1] });
      await expect(snap()).rejects.toThrow("PLATFORM_BASELINE_REFUSED: the migration ledger supabase_migrations.schema_migrations does not exist");
      const files = manifest.baseMigrations.map((m) => m.file);
      await createLedger(db, files.slice(0, -1));
      await expect(snap()).rejects.toThrow(/PLATFORM_BASELINE_REFUSED: the migration ledger head is [0-9]{14}, not [0-9]{14}, the final base migration before B1/);
      await db.query(`insert into supabase_migrations.schema_migrations values ($1, $2)`, [files.at(-1)!.slice(0, 14), "last"]);
      await db.query(`alter function ${STAMP} rename to stamp_binding_provenance_moved`);
      await expect(snap()).rejects.toThrow("PLATFORM_BASELINE_REFUSED: kernel_private.stamp_binding_provenance() does not exist");
      await db.query(`alter function kernel_private.stamp_binding_provenance_moved() rename to stamp_binding_provenance`);
      const ok = await snap();
      expect(ok.provenance.migrationLedger).toEqual({ table: "supabase_migrations.schema_migrations", present: true, head: files.at(-1)!.slice(0, 14), b1Recorded: false });
    } finally { await db.end(); }
  });
});
