import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import pg from "pg";
import { DATABASE, compose, holdRuntime, migrate, until } from "./support/local.js";
import { RUNTIME_ROLES, actualFacts, loadManifest, type RuntimeRole } from "../services/kernel/src/database/runtime-roles.js";

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
      `select distinct n.nspname || '.' || p.proname as name, has_function_privilege($1, p.oid, 'EXECUTE') as ok
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
