import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import pg from "pg";
import { DATABASE, compose, holdRuntime, migrate, until } from "./support/local.js";
import { FUNCTION_IDENTITY_SQL, RUNTIME_ROLES, actualFacts, loadManifest, type RuntimeRole } from "../services/kernel/src/database/runtime-roles.js";

/**
 * KJ-P8 B1 gate 7 - negative privilege qualification. Every forbidden power is ATTEMPTED on a genuine login session
 * of each runtime role and must be refused with the SQLSTATE pinned here. "Some error occurred" is not accepted:
 * a different code fails the probe. Nothing is inferred from the manifest.
 *
 *   42501 insufficient_privilege      0LP01 invalid_grant_operation      42809 wrong_object_type
 * A GRANT or REVOKE by a role that holds no grant option does not raise; Postgres emits a warning and changes
 * nothing. Those probes therefore assert "no effect" by re-reading the catalogue.
 */
const name = `kj_b1_neg_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const admin = new pg.Pool({ connectionString: DATABASE, max: 1 });
const url = (user: string) => { const u = new URL(DATABASE.replace(/\/kerneljson$/, `/${name}`)); u.username = user; return u.toString(); };
let owner: pg.Pool;
const session = {} as Record<RuntimeRole, pg.Client>;
let releaseRuntime = () => {};
const manifest = loadManifest();
const results: { role: string; probe: string; sql: string; expected: string; observed: string; pass: boolean }[] = [];

beforeAll(async () => {
  releaseRuntime = holdRuntime();
  compose("up", "-d", "db");
  await until(() => admin.query("select 1"), (r) => r.rowCount === 1);
  await admin.query(`create database ${name}`);
  owner = new pg.Pool({ connectionString: url("postgres"), max: 2 });
  owner.on("error", () => {});
  await migrate(owner);
  await owner.query(`create role kj_b1_probe_target nologin`).catch(() => undefined);
  // Section 27.9.5 binding probes: a tenant and a principal to bind against, and a canonical epoch distinct from the
  // column default so that a forged or defaulted value cannot pass for a stamped one.
  await owner.query(`insert into public.tenants(id, name) values ($1, 'kj-b1-probe')`, [TENANT]);
  await owner.query(`insert into public.principals(id, kind) values ($1, 'SERVICE')`, [PRINCIPAL]);
  await owner.query(`update kernel_private.release_epoch set epoch = 7`);
  for (const role of RUNTIME_ROLES) {
    session[role] = new pg.Client({ connectionString: url(role) });
    await session[role].connect();
  }
});
afterAll(async () => {
  for (const role of RUNTIME_ROLES) await session[role]?.end().catch(() => undefined);
  mkdirSync("artifacts/local", { recursive: true });
  writeFileSync("artifacts/local/b1-negative-probes.json", JSON.stringify({ contract: "kerneljson:b1-negative-probes/v1", results }, null, 2) + "\n");
  await owner?.query(`drop role if exists kj_b1_probe_target`).catch(() => undefined);
  await owner?.end();
  await until(() => admin.query("select count(*)::int as n from pg_stat_activity where datname = $1", [name]), (r) => r.rows[0].n === 0, 15000);
  await admin.query(`drop database if exists ${name}`);
  await admin.end();
  releaseRuntime();
});

/** Run one statement as the role and return the SQLSTATE, or "OK" when it did not raise. */
async function attempt(role: RuntimeRole, sql: string): Promise<string> {
  try { await session[role].query(sql); return "OK"; } catch (error) { return (error as { code?: string }).code ?? "NO_SQLSTATE"; }
}
const UUID = "00000000-0000-4000-8000-000000000001";
const TENANT = "00000000-0000-4000-8000-0000000000b1", PRINCIPAL = "00000000-0000-4000-8000-0000000000b2";

/** Powers no runtime role may hold. [probe name, statement, pinned SQLSTATE]. */
const FORBIDDEN: [string, string, string][] = [
  ["session is the role itself", `do $$ begin if current_user <> session_user then raise exception 'x'; end if; end $$`, "OK"],
  ["CREATE TABLE in public", `create table public.kj_b1_x (i int)`, "42501"],
  ["CREATE TABLE in kernel_private", `create table kernel_private.kj_b1_x (i int)`, "42501"],
  ["CREATE SCHEMA", `create schema kj_b1_x`, "42501"],
  ["CREATE TEMPORARY TABLE", `create temporary table kj_b1_x (i int)`, "42501"],
  ["CREATE VIEW", `create view public.kj_b1_v as select 1`, "42501"],
  ["CREATE FUNCTION", `create function public.kj_b1_f() returns int language sql as 'select 1'`, "42501"],
  ["replace a guard function", `create or replace function public.reject_ledger_mutation() returns trigger language plpgsql as $f$ begin return new; end $f$`, "42501"],
  ["ALTER TABLE add column", `alter table public.tasks add column kj_b1_x int`, "42501"],
  ["ALTER TABLE owner", `alter table public.tasks owner to current_user`, "42501"],
  ["DROP TABLE", `drop table public.tasks`, "42501"],
  ["DROP FUNCTION", `drop function public.reject_ledger_mutation()`, "42501"],
  ["TRUNCATE", `truncate public.task_events`, "42501"],
  ["DISABLE TRIGGER", `alter table public.task_events disable trigger all`, "42501"],
  ["CREATE TRIGGER", `create trigger kj_b1_t before insert on public.tasks for each row execute function public.reject_ledger_mutation()`, "42501"],
  ["DROP TRIGGER", `drop trigger identity_activation_guard on public.identity_activations`, "42501"],
  ["session_replication_role", `set session_replication_role = replica`, "42501"],
  ["DISABLE ROW LEVEL SECURITY", `alter table public.tasks disable row level security`, "42501"],
  ["FORCE ROW LEVEL SECURITY", `alter table public.tasks force row level security`, "42501"],
  ["CREATE POLICY", `create policy kj_b1_p on public.tasks for all using (true)`, "42501"],
  ["DROP POLICY", `drop policy kj_worker_select on public.tasks`, "42501"],
  ["ALTER POLICY", `alter policy kj_worker_select on public.tasks using (false)`, "42501"],
  ["row_security off does not bypass", `set row_security = off; select 1 from public.task_events limit 1`, "42501"],
  ["CREATE ROLE", `create role kj_b1_r`, "42501"],
  ["ALTER ROLE own attribute", `alter role current_user createdb`, "42501"],
  ["ALTER ROLE other", `alter role kj_b1_probe_target login`, "42501"],
  ["DROP ROLE", `drop role kj_b1_probe_target`, "42501"],
  ["SET ROLE postgres", `set role postgres`, "42501"],
  ["SET SESSION AUTHORIZATION postgres", `set session authorization postgres`, "42501"],
  ["GRANT membership to self", `grant postgres to current_user`, "42501"],
  ["ALTER SYSTEM", `alter system set log_statement = 'none'`, "42501"],
  ["COPY TO PROGRAM", `copy (select 1) to program 'true'`, "42501"],
  ["read password hashes", `select rolpassword from pg_authid limit 1`, "42501"],
  ["CREATE EXTENSION", `create extension if not exists pgcrypto`, "42501"],
  ["activate a release", `select kernel_private.activate_release('${UUID}', 'kj-b1-probe', 1, '{"probe":true}'::jsonb)`, "42501"],
  ["write release_activations", `insert into kernel_private.release_activations(epoch, request_id, release_id, activated_at, created_by, evidence) values (999999, '${UUID}', 'x', now(), 'x', '{"x":1}')`, "42501"],
  ["delete release history", `delete from kernel_private.release_activations`, "42501"],
  ["write the release epoch", `update kernel_private.release_epoch set epoch = epoch`, "42501"],
  ["advance the release epoch", `update kernel_private.release_epoch set epoch = epoch + 1`, "42501"],
  ["unfreeze identity", `select kernel_private.set_identity_freeze('${UUID}', false, 'kj-b1-probe')`, "42501"],
  ["write identity governance state", `insert into kernel_private.identity_governance_state(identity_id, frozen) values ('${UUID}', false)`, "42501"],
  ["rewrite history: task_events", `update public.task_events set type = type`, "42501"],
  ["erase history: task_events", `delete from public.task_events`, "42501"],
  ["erase history: evidence", `delete from public.evidence`, "42501"],
  ["rewrite an identity version", `update public.identity_versions set version = version`, "42501"],
  ["erase an identity activation", `delete from public.identity_activations`, "42501"],
  ["launder candidate origin", `update public.identity_candidates set origin = 'OPERATOR_INSTRUCTION'`, "42501"],
  ["rewrite faculty versions", `update public.faculty_versions set version = version`, "42501"],
  ["change tenant membership", `update public.tenant_memberships set role = 'owner'`, "42501"],
  ["create a principal", `insert into public.principals(id, kind) values ('${UUID}', 'HUMAN')`, "42501"],
  ["create a tenant", `insert into public.tenants(id) values ('${UUID}')`, "42501"],
];

/** The two roles are separate: neither holds the other's writes. [probe, role that must be refused, statement]. */
const SEPARATION: [string, RuntimeRole, string][] = [
  ["door cannot write the task ledger", "kj_door", `insert into public.task_events(id) values ('${UUID}')`],
  ["door cannot write evidence", "kj_door", `insert into public.evidence(id) values ('${UUID}')`],
  ["door cannot complete a task", "kj_door", `insert into public.outcomes(task_id) values ('${UUID}')`],
  ["door cannot touch identity", "kj_door", `insert into public.identity_activations(id) values ('${UUID}')`],
  ["door cannot read identity documents", "kj_door", `select 1 from public.identity_versions limit 1`],
  ["door cannot write approvals", "kj_door", `update public.approvals set status = 'GRANTED'`],
  ["worker cannot admit a task", "kj_worker", `insert into kernel_private.task_admissions(task_id) values ('${UUID}')`],
  ["worker cannot record a dispatch", "kj_worker", `insert into kernel_private.dispatch_events(id) values ('${UUID}')`],
];

describe.each(RUNTIME_ROLES)("B1 forbidden powers: %s", (role: RuntimeRole) => {
  it.each(FORBIDDEN)("%s", async (probe, sql, expected) => {
    const observed = await attempt(role, sql);
    await session[role].query("reset row_security").catch(() => undefined);
    results.push({ role, probe, sql, expected, observed, pass: observed === expected });
    expect(observed).toBe(expected);
  });

  it("GRANT without grant option changes nothing", async () => {
    const before = await actualFacts(owner, "kj_door"), beforeW = await actualFacts(owner, "kj_worker");
    for (const sql of [
      `grant select on public.identity_versions to kj_door`,
      `grant all on all tables in schema public to kj_b1_probe_target`,
      `grant execute on function kernel_private.set_identity_freeze(uuid, boolean, text) to ${role}`,
      `revoke select on public.tasks from kj_worker`,
    ]) {
      const observed = await attempt(role, sql);
      results.push({ role, probe: "grant/revoke has no effect", sql, expected: "OK|42501 and no change", observed, pass: observed === "OK" || observed === "42501" });
      expect(["OK", "42501"]).toContain(observed);
    }
    expect(await actualFacts(owner, "kj_door")).toEqual(before);
    expect(await actualFacts(owner, "kj_worker")).toEqual(beforeW);
    const target = await owner.query(`select count(*)::int as n from information_schema.role_table_grants where grantee = 'kj_b1_probe_target'`);
    expect(target.rows[0].n).toBe(0);
  });

  it("every relation outside the manifest is unreadable and unwritable", async () => {
    const granted = new Set(Object.keys(manifest.roles[role].relations));
    const { rows } = await owner.query<{ name: string }>(
      `select n.nspname || '.' || c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r','v') and n.nspname in ('public','kernel_private') order by 1`);
    const outside = rows.map((r) => r.name).filter((n) => !granted.has(n));
    expect(outside.length).toBeGreaterThan(0);
    for (const object of outside) {
      const observed = await attempt(role, `select 1 from ${object} limit 1`);
      results.push({ role, probe: "relation outside manifest", sql: `select 1 from ${object} limit 1`, expected: "42501", observed, pass: observed === "42501" });
      expect(observed, object).toBe("42501");
    }
  });

  it("every function outside the manifest is not executable", async () => {
    const granted = new Set(Object.keys(manifest.roles[role].functions));
    const { rows } = await owner.query<{ name: string; ok: boolean }>(
      `select ${FUNCTION_IDENTITY_SQL("p", "n")} as name, has_function_privilege($1, p.oid, 'EXECUTE') as ok
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public','kernel_private') and p.prorettype <> 'trigger'::regtype`, [role]);
    for (const f of rows.filter((r) => !granted.has(r.name))) {
      results.push({ role, probe: "function outside manifest", sql: `has_function_privilege(${f.name})`, expected: "false", observed: String(f.ok), pass: !f.ok });
      expect(f.ok, f.name).toBe(false);
    }
  });
});

describe("B1 role separation", () => {
  it.each(SEPARATION)("%s", async (probe, role, sql) => {
    const observed = await attempt(role, sql);
    results.push({ role, probe, sql, expected: "42501", observed, pass: observed === "42501" });
    expect(observed).toBe("42501");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// ADR-0023 revision 2.5, section 27.9.5: the release-provenance definer exception. "Refused" means both the SQLSTATE
// and an owner re-read showing nothing changed. The SQLSTATE is the one the sealed design requires; a different one
// (for the direct call, 0A000 "trigger functions can only be called as triggers") fails the probe and is a
// DESIGN_MISMATCH to adjudicate, never a reason to relax it. The ACL proof is the catalogue assertion of
// tests/runtime-roles-definers.integration.test.ts, not this probe.
const STAMP = "kernel_private.stamp_binding_provenance()";
const state = {
  stamp: async () => (await owner.query(
    `select p.prosecdef, p.proconfig, p.proacl::text[] as acl, pg_get_userbyid(p.proowner) as owner, md5(p.prosrc) as src
       from pg_proc p where p.oid = '${STAMP}'::regprocedure`)).rows,
  triggers: async () => (await owner.query(
    `select t.tgname, t.tgrelid::regclass::text as rel, t.tgenabled, t.tgtype, t.tgqual is null as noqual from pg_trigger t
      where t.tgfoid = '${STAMP}'::regprocedure order by 1, 2`)).rows,
  epoch: async () => (await owner.query(`select epoch::text from kernel_private.release_epoch`)).rows,
  activations: async () => (await owner.query(`select count(*)::int as n, coalesce(md5(string_agg(epoch::text || release_id, ',' order by epoch)), '') as h from kernel_private.release_activations`)).rows,
  names: async () => (await owner.query(
    `select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.proname = 'stamp_binding_provenance' order by 1`)).rows,
  shadows: async () => (await owner.query(
    `select n.nspname || '.' || c.relname as rel from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relname = 'release_epoch' order by 1`)).rows,
  schemas: async () => (await owner.query(`select nspname from pg_namespace where nspname like 'kj_b1_%' order by 1`)).rows,
};
type Probe = [number, string, string, string, (keyof typeof state)[]];
/** [sealed row, probe, statement, required SQLSTATE, state that must be unchanged]. `$ROLE` is the probing role. */
const PROBES: Probe[] = [
  [1, "call the stamp function directly", `select ${STAMP}`, "42501", ["stamp", "epoch"]],
  [2, "UPDATE release_epoch, no-op form", `update kernel_private.release_epoch set epoch = epoch`, "42501", ["epoch"]],
  [3, "UPDATE release_epoch, value-changing form", `update kernel_private.release_epoch set epoch = epoch + 1`, "42501", ["epoch"]],
  [4, "INSERT into release_epoch", `insert into kernel_private.release_epoch(singleton, epoch) values (true, 99)`, "42501", ["epoch"]],
  [5, "DELETE from release_epoch", `delete from kernel_private.release_epoch`, "42501", ["epoch"]],
  [6, "INSERT into release_activations",
    `insert into kernel_private.release_activations(epoch, request_id, release_id, activated_at, created_by, evidence) values (999999, '${UUID}', 'x', now(), 'x', '{"x":1}')`, "42501", ["activations"]],
  [7, "UPDATE release_activations", `update kernel_private.release_activations set release_id = release_id`, "42501", ["activations"]],
  [8, "DELETE from release_activations", `delete from kernel_private.release_activations`, "42501", ["activations"]],
  [9, "execute activate_release", `select kernel_private.activate_release('${UUID}', 'kj-b1-probe', 7, '{"probe":true}'::jsonb)`, "42501", ["epoch", "activations"]],
  [10, "CREATE OR REPLACE the stamp function",
    `create or replace function ${STAMP} returns trigger language plpgsql security invoker as $f$ begin return new; end $f$`, "42501", ["stamp"]],
  [11, "ALTER FUNCTION OWNER TO the probing role", `alter function ${STAMP} owner to $ROLE`, "42501", ["stamp"]],
  [12, "ALTER FUNCTION SECURITY INVOKER", `alter function ${STAMP} security invoker`, "42501", ["stamp"]],
  [13, "ALTER FUNCTION SET search_path = public", `alter function ${STAMP} set search_path = public`, "42501", ["stamp"]],
  [14, "ALTER FUNCTION RESET search_path", `alter function ${STAMP} reset search_path`, "42501", ["stamp"]],
  [15, "GRANT EXECUTE to the probing role", `grant execute on function ${STAMP} to $ROLE`, "42501", ["stamp"]],
  [15, "GRANT EXECUTE to PUBLIC", `grant execute on function ${STAMP} to public`, "42501", ["stamp"]],
  [16, "CREATE TRIGGER attaching it to another table",
    `create trigger kj_b1_attach before insert on kernel_private.dispatch_events for each row execute function ${STAMP}`, "42501", ["triggers"]],
  [17, "CREATE TRIGGER attaching it a second time to execution_bindings",
    `create trigger kj_b1_second before insert on kernel_private.execution_bindings for each row execute function ${STAMP}`, "42501", ["triggers"]],
  [18, "DROP TRIGGER execution_bindings_provenance", `drop trigger execution_bindings_provenance on kernel_private.execution_bindings`, "42501", ["triggers"]],
  [19, "ALTER TRIGGER ... RENAME", `alter trigger execution_bindings_provenance on kernel_private.execution_bindings rename to kj_b1_renamed`, "42501", ["triggers"]],
  [20, "DISABLE TRIGGER execution_bindings_provenance", `alter table kernel_private.execution_bindings disable trigger execution_bindings_provenance`, "42501", ["triggers"]],
  [20, "DISABLE TRIGGER ALL", `alter table kernel_private.execution_bindings disable trigger all`, "42501", ["triggers"]],
  [20, "ENABLE REPLICA TRIGGER", `alter table kernel_private.execution_bindings enable replica trigger execution_bindings_provenance`, "42501", ["triggers"]],
  [21, "CREATE FUNCTION public.stamp_binding_provenance()",
    `create function public.stamp_binding_provenance() returns trigger language plpgsql as $f$ begin return new; end $f$`, "42501", ["names"]],
  [21, "CREATE FUNCTION kernel_private.stamp_binding_provenance(integer)",
    `create function kernel_private.stamp_binding_provenance(integer) returns trigger language plpgsql as $f$ begin return new; end $f$`, "42501", ["names"]],
  [22, "CREATE SCHEMA (to hold a function)", `create schema kj_b1_escape`, "42501", ["schemas"]],
  [23, "a temporary table named release_epoch", `create temporary table release_epoch (singleton boolean, epoch bigint)`, "42501", ["shadows"]],
  [24, "a table in public named release_epoch", `create table public.release_epoch (singleton boolean, epoch bigint)`, "42501", ["shadows"]],
];
const probeResults: Record<string, unknown>[] = [];

describe.each(RUNTIME_ROLES)("ADR-0023 27.9.5 release-provenance probes: %s", (role: RuntimeRole) => {
  it.each(PROBES)("row %i: %s", async (row, probe, statement, expected, unchanged) => {
    const sql = statement.replaceAll("$ROLE", role);
    const before = await Promise.all(unchanged.map((k) => state[k]()));
    const observed = await attempt(role, sql);
    const after = await Promise.all(unchanged.map((k) => state[k]()));
    const stateUnchanged = JSON.stringify(after) === JSON.stringify(before);
    probeResults.push({ role, row, probe, sql, expected, observed, stateUnchanged, pass: observed === expected && stateUnchanged });
    results.push({ role, probe: `27.9.5 row ${row}: ${probe}`, sql, expected, observed, pass: observed === expected && stateUnchanged });
    expect(observed).toBe(expected);
    expect(after).toEqual(before);
  });

  const bind = async (extra: { epoch?: number; persistedAt?: string } = {}) => {
    const id = randomUUID();
    const contract = JSON.stringify({ taskId: id, tenantId: TENANT, principal: { id: PRINCIPAL } });
    const columns = ["task_id", "tenant_id", "principal_id", "contract", ...(extra.epoch !== undefined ? ["release_epoch"] : []), ...(extra.persistedAt ? ["persisted_at"] : [])];
    const values = [id, TENANT, PRINCIPAL, contract, ...(extra.epoch !== undefined ? [extra.epoch] : []), ...(extra.persistedAt ? [extra.persistedAt] : [])];
    await session[role].query(`insert into kernel_private.execution_bindings(${columns.join(", ")}) values (${values.map((_, i) => `$${i + 1}`).join(", ")})`, values);
    return (await owner.query<{ epoch: string; persisted: string | null; recent: boolean }>(
      `select release_epoch::text as epoch, persisted_at::text as persisted, persisted_at > now() - interval '5 minutes' as recent
         from kernel_private.execution_bindings where task_id = $1`, [id])).rows[0]!;
  };

  it("row 25: a changed session search_path does not affect the stamp", async () => {
    await session[role].query(`set search_path = public, pg_temp`);
    try {
      const stamped = await bind();
      probeResults.push({ role, row: 25, probe: "search_path manipulation then insert", observed: stamped, pass: stamped.epoch === "7" && stamped.recent });
      expect(stamped).toMatchObject({ epoch: "7", recent: true });
    } finally { await session[role].query(`reset search_path`); }
  });
  it("row 26: forged release_epoch and persisted_at are overwritten with the canonical epoch and a fresh timestamp", async () => {
    const stamped = await bind({ epoch: 999999, persistedAt: "2000-01-01T00:00:00Z" });
    probeResults.push({ role, row: 26, probe: "forged release_epoch / persisted_at", observed: stamped, pass: stamped.epoch === "7" && stamped.recent });
    expect(stamped).toMatchObject({ epoch: "7", recent: true });
  });
  it("row 27: repeated binding inserts do not change the release epoch's value", async () => {
    const before = await state.epoch();
    for (let i = 0; i < 3; i++) expect((await bind()).epoch).toBe("7");
    expect(await state.epoch()).toEqual(before);
    probeResults.push({ role, row: 27, probe: "repeated binding inserts", observed: await state.epoch(), pass: true });
  });
});

afterAll(() => {
  mkdirSync("artifacts/local", { recursive: true });
  writeFileSync("artifacts/local/b1-definer-probes.json", JSON.stringify({ contract: "kerneljson:b1-definer-probes/v1", design: "424f85c283a543ba00a650ecc2ecc3a4346623df", results: probeResults }, null, 2) + "\n");
});
