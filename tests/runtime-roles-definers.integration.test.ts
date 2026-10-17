import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { testDatabase, testDatabaseArtifacts, type TestDatabase } from "./support/database.js";
import { fetchRuntimeRoles } from "../services/kernel/src/health/collect.js";
import { snapshotPlatformBaseline } from "../services/kernel/src/database/platform-baseline-snapshot.js";
import type { Declaration } from "../services/kernel/src/database/co-resident.js";
import {
  INVENTORY_SQL_SHA256, baselineBindingProblems, definerInventoryProblems, loadStageManifest, readStampFacts, stageFunctions, type PlatformBaseline,
} from "../services/kernel/src/database/security-definers.js";
import { evaluateDatabase } from "../services/kernel/src/health/evaluate.js";
import { resolvePolicy } from "../services/kernel/src/alerting/policy.js";

// 27.12.9 cases 31 to 35: health reads the declaration file through loadDeclaration(). Those cases point that one read
// at a scratch file; with no scratch file set the real loader and its committed path are used unchanged.
const declarationFile = vi.hoisted(() => ({ path: undefined as string | undefined }));
vi.mock("../services/kernel/src/database/security-definers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/kernel/src/database/security-definers.js")>();
  return { ...actual, loadDeclaration: (path?: string) => actual.loadDeclaration(path ?? declarationFile.path) };
});

/**
 * KJ-P8 B1 - the SECURITY DEFINER inventory and the section 27.9 exception against a real catalogue
 * (ADR-0023 revision 2.5, sections 27.9 and 27.10, sealed at 424f85c283a543ba00a650ecc2ecc3a4346623df).
 *
 * ADR-0023 27.12.15 lane D, suite regression-definers, setup profile platform-definer-fixture: the runner created the
 * plan database kj_b1_def, applied the base chain, ran the profile's four platform-style definers in schema auth at S2,
 * snapshotted it read-only at S3 (the run-bound baseline and declaration this file reads by digest), applied B1 through
 * the pinned engine and passed S7, all in this run. Every assertion is then made to fail on purpose and restored.
 * Derivation A of the source digest (before B1) is lane A, tests/runtime-roles-definers-base.integration.test.ts; the
 * frozen _acl, _tamper and _ledger blocks are the registered runner hooks stamp-foreign-grants, stamp-body-tamper and
 * the six ledger hooks (tests/b1-runner-lifecycle.test.ts and tests/b1-runner-ledger.test.ts). Observed catalogue values
 * are written to artifacts/local/b1-definers.json in the suite's working directory.
 */
const name = "kj_b1_def";
const tag = "def";
let database: TestDatabase;
const url = () => database.url;
const manifest = loadStageManifest();
const PIN = stageFunctions(manifest, "B1")[0]!.sourceDigest!;
const lf = (t: string) => t.replaceAll("\r\n", "\n");
const hex = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const STAMP = "kernel_private.stamp_binding_provenance()";
const DIGEST_SQL = `select encode(sha256(convert_to(replace(prosrc, E'\\r\\n', E'\\n'), 'UTF8')), 'hex') as digest, prosrc
  from pg_proc where oid = '${STAMP}'::regprocedure`;
let pool: pg.Pool;
// A genuine kj_worker LOGIN session on the same plan database: the health check is read as kj_worker in every harness
// mode. The harness never shadows, emulates or retries a pool that logs in as a runtime role (tests/support/runtime-roles.ts).
let worker: pg.Pool;
let baseline: PlatformBaseline;
let declaration: Declaration;
let run: Extract<Declaration, { mode: "EPHEMERAL_RUN_BOUND" }>["run"];
let owner = "";
const evidence: Record<string, unknown> = {
  contract: "kerneljson:b1-definer-qualification/v1",
  design: manifest.design.sha,
  testedCommit: process.env["GITHUB_SHA"] ?? process.env["KERNELJSON_RELEASE_ID"] ?? "local",
  environment: "qualification fixture (runner-created cluster of the pinned image); not the target environment",
};
const fixtures: { fixture: string; expected: string; observedProblems: string[]; failedOnPurpose: boolean; restored: boolean }[] = [];

// The platform definers a Supabase-shaped target holds before B1, one per source-digest rule of 27.10.4. The runner's
// profile created them from infrastructure/database/b1-fixture-platform-definers.sql; these texts restore them.
const PLATFORM = [
  `create function auth.kj_platform_uid() returns uuid language sql stable security definer as $f$ select '00000000-0000-4000-8000-000000000000'::uuid $f$`,
  `create function auth.kj_platform_guard() returns void language plpgsql security definer set search_path = '' as $f$ begin perform 1; end $f$`,
  `create function auth.kj_platform_atomic() returns integer language sql security definer begin atomic select 1; end`,
  `create function auth.kj_platform_len(text) returns integer language internal immutable strict security definer as 'textlen'`,
];

beforeAll(async () => {
  database = await testDatabase("kj_b1_def");
  pool = database.pool;
  pool.on("error", () => {});
  const workerUrl = new URL(database.url);
  workerUrl.username = "kj_worker";
  worker = new pg.Pool({ connectionString: workerUrl.toString(), max: 2 });
  worker.on("error", () => {});
  ({ baseline, declaration } = testDatabaseArtifacts("kj_b1_def"));
  if (declaration.mode !== "EPHEMERAL_RUN_BOUND") throw new Error("a run-bound declaration is required");
  run = declaration.run;
  owner = (await pool.query<{ o: string }>(`select pg_get_userbyid(nspowner) as o from pg_namespace where nspname = 'kernel_private'`)).rows[0]!.o;
});
afterAll(async () => {
  mkdirSync("artifacts/local", { recursive: true });
  writeFileSync("artifacts/local/b1-definers.json", JSON.stringify({ ...evidence, fixtures }, null, 2) + "\n");
  await worker?.end().catch(() => undefined);
  await database?.close();
});

const problems = () => definerInventoryProblems(pool, manifest, baseline, declaration);

describe("27.9.3 source digest: two independent derivations", () => {
  it("after B1 the catalogue source still equals the pin", async () => {
    const after = (await pool.query<{ digest: string }>(DIGEST_SQL)).rows[0]!.digest;
    evidence["sourceDigest"] = { pin: PIN, afterB1: after };
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
  it("database.runtimeRolesLeastPrivilege is green, read as kj_worker", async () => {
    expect(await fetchRuntimeRoles(worker, { baseline, declaration, run })).toEqual({ available: true, problems: [] });
  });
  it("without a frozen baseline the health check stays red with TARGET_PLATFORM_BASELINE_PENDING", async () => {
    const observed = await fetchRuntimeRoles(pool, { baseline: null, declaration, run });
    expect(observed.available && observed.problems).toContain("TARGET_PLATFORM_BASELINE_PENDING: no frozen platform SECURITY DEFINER baseline for this environment");
  });
  // Like the green check above, this needs a genuine kj_worker session, which the worker pool gives in every mode.
  it("27.11: a platform function executable by PUBLIC in a schema the roles cannot USAGE is not a runtime fact", async () => {
    await pool.query(`grant execute on function auth.kj_platform_uid() to public`);
    try {
      expect(await fetchRuntimeRoles(worker, { baseline, declaration, run })).toEqual({ available: true, problems: [] });
    } finally { await pool.query(`revoke execute on function auth.kj_platform_uid() from public`); }
  });
  it("27.11: once that schema has USAGE, the schema grant and the function grant are both unexpected facts and the check goes red", async () => {
    await pool.query(`grant execute on function auth.kj_platform_uid() to public`);
    await pool.query(`grant usage on schema auth to public`);
    try {
      const observed = await fetchRuntimeRoles(pool, { baseline, declaration, run });
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
    expect(await definerInventoryProblems(pool, manifest, otherSystem, declaration)).toEqual([
      expect.stringMatching(/^platform baseline belongs to system 1, not this database's [0-9]+$/), "baseline and declaration provenance differ"]);
  });
  it("the health check reports an unlisted privilege and an unlisted definer function together", async () => {
    await pool.query(`grant truncate on public.task_events to kj_door`);
    await pool.query(`create function public.kj_b1_probe_definer2() returns int language sql security definer as 'select 1'`);
    try {
      const observed = await fetchRuntimeRoles(pool, { baseline, declaration, run });
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

// ---------------------------------------------------------------------------------------------------------------
// 27.12.9 cases 31 to 35 (rule: for health, failure means a named problem and P0). Each fault is written to the
// declaration file that database.runtimeRolesLeastPrivilege reads, health is read as kj_worker exactly as the green check
// above, and the result is evaluated by the health model and the alert policy. The control row is the same run-bound
// declaration, unchanged, read from that file.
type DeclarationCase = [label: string, text: () => string | null, named: (problem: string) => boolean];
const declarationText = (edit: (o: Record<string, unknown>) => void = () => undefined) => {
  const o = JSON.parse(JSON.stringify(declaration)) as Record<string, unknown>;
  edit(o);
  return JSON.stringify(o, null, 2) + "\n";
};
const provenanceOf = (o: Record<string, unknown>) => o["provenance"] as Record<string, unknown>;
const refused = (fragment: RegExp) => (p: string) => p.startsWith("runtime role qualification failed: ") && fragment.test(p);
const zodPath = (...path: string[]) => new RegExp(`"path": \\[\\s*${path.map((k) => `"${k}"`).join(",\\s*")}\\s*\\]`);
const REQUIRED_FIELDS = ["kind", "environment", "provenance", "pinsSha256", "setSha256", "entries", "mode", "run"] as const;
const DECLARATION_CASES: DeclarationCase[] = [
  ["control: the run-bound declaration, unchanged, read from the file is green", () => declarationText(), () => false],
  ["case 31: declaration file missing", () => null, (p) => p === "TARGET_CO_RESIDENT_DECLARATION_PENDING: no frozen co-resident declaration"],
  ["case 32: declaration not valid JSON", () => "{not json\n", refused(/^runtime role qualification failed: INVALID_JSON at byte offset [0-9]+$/)],
  ["case 32: truncated file", () => { const t = declarationText(); return t.slice(0, Math.floor(t.length / 2)); },
    refused(/^runtime role qualification failed: INVALID_JSON at byte offset [0-9]+$/)],
  ["case 32: a byte-order mark before the JSON", () => "\uFEFF" + declarationText(), refused(/^runtime role qualification failed: INVALID_JSON at byte offset 0$/)],
  ["case 33: wrong kind", () => declarationText((o) => { o["kind"] = "kerneljson:security-definer-platform-baseline/v1"; }), refused(zodPath("kind"))],
  ["case 33: kind /v2", () => declarationText((o) => { o["kind"] = "kerneljson:co-resident-platform-exceptions/v2"; }), refused(zodPath("kind"))],
  ["case 33: kind missing", () => declarationText((o) => { delete o["kind"]; }), refused(zodPath("kind"))],
  ...REQUIRED_FIELDS.map((field): DeclarationCase => [`case 34: required field ${field} removed`, () => declarationText((o) => { delete o[field]; }),
    refused(field === "mode" ? /"discriminator": "mode"/ : zodPath(field))]),
  ["case 34: one unknown field added", () => declarationText((o) => { o["exceptions"] = []; }), refused(/Unrecognized key: \\"exceptions\\"/)],
  ["case 35: pinsSha256 one character changed", () => declarationText((o) => { const v = o["pinsSha256"] as string; o["pinsSha256"] = (v[0] === "0" ? "1" : "0") + v.slice(1); }),
    (p) => p === "runtime role qualification failed: co-resident pinsSha256 mismatch"],
  ["case 35: setSha256 malformed (uppercase)", () => declarationText((o) => { o["setSha256"] = (o["setSha256"] as string).toUpperCase(); }), refused(zodPath("setSha256"))],
  ["case 35: setSha256 malformed (63 characters)", () => declarationText((o) => { o["setSha256"] = (o["setSha256"] as string).slice(1); }), refused(zodPath("setSha256"))],
  ["case 35: declared database not the live value", () => declarationText((o) => { provenanceOf(o)["database"] = "kj_b1_other"; }),
    (p) => p === `platform baseline belongs to database kj_b1_other, not ${name}`],
  ["case 35: declared systemIdentifier not the live value", () => declarationText((o) => { provenanceOf(o)["systemIdentifier"] = "1"; }),
    (p) => /^platform baseline belongs to system 1, not this database's [0-9]+$/.test(p)],
  ["case 35: systemIdentifier malformed", () => declarationText((o) => { provenanceOf(o)["systemIdentifier"] = "0x6ad"; }), refused(zodPath("provenance", "systemIdentifier"))],
];
describe("27.12.9 cases 31 to 35: a missing or faulty declaration is a named problem and P0", () => {
  let dir = "";
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "kj-b1-declaration-")); });
  afterAll(() => { declarationFile.path = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });
  it.each(DECLARATION_CASES)("%s", async (label, text, named) => {
    const file = join(dir, `${DECLARATION_CASES.findIndex((c) => c[0] === label)}.json`);
    const body = text();
    if (body !== null) writeFileSync(file, body);
    declarationFile.path = file;
    let observed: Awaited<ReturnType<typeof fetchRuntimeRoles>>;
    try { observed = await fetchRuntimeRoles(worker, { baseline, run }); } finally { declarationFile.path = undefined; }
    const check = evaluateDatabase({ reachable: true, scheduleReadOk: true, taskReadOk: true, runtimeRoles: observed }, new Date().toISOString())
      .checks.find((c) => c.id === "database.runtimeRolesLeastPrivilege")!;
    const severity = resolvePolicy(check.id).severityFor(check.status);
    if (label.startsWith("control:")) {
      expect(observed).toEqual({ available: true, problems: [] });
      expect(severity).toBeNull();
      return;
    }
    expect(observed.available, JSON.stringify(observed)).toBe(true);
    const problems = observed.available ? observed.problems : [];
    expect(problems.some(named), JSON.stringify(problems)).toBe(true);
    expect(check.status).toBe("CRITICAL");
    expect(severity).toBe("P0");
  });
});
