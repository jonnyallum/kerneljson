import type { RuntimeRole } from "../../services/kernel/src/database/runtime-roles.js";

/**
 * The probe tables of tests/runtime-roles-negative.integration.test.ts (27.6 item 4 and 27.9.5), unchanged, in a
 * module of their own so that scripts/b1/build-required.ts derives each probe's declared refusal from the same source
 * the test runs. Moving them changed no row, statement or pinned SQLSTATE.
 */
export const UUID = "00000000-0000-4000-8000-000000000001";
export const TENANT = "00000000-0000-4000-8000-0000000000b1", PRINCIPAL = "00000000-0000-4000-8000-0000000000b2";

/** Powers no runtime role may hold. [probe name, statement, pinned SQLSTATE]. */
export const FORBIDDEN: [string, string, string][] = [
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
export const SEPARATION: [string, RuntimeRole, string][] = [
  ["door cannot write the task ledger", "kj_door", `insert into public.task_events(id) values ('${UUID}')`],
  ["door cannot write evidence", "kj_door", `insert into public.evidence(id) values ('${UUID}')`],
  ["door cannot complete a task", "kj_door", `insert into public.outcomes(task_id) values ('${UUID}')`],
  ["door cannot touch identity", "kj_door", `insert into public.identity_activations(id) values ('${UUID}')`],
  ["door cannot read identity documents", "kj_door", `select 1 from public.identity_versions limit 1`],
  ["door cannot write approvals", "kj_door", `update public.approvals set status = 'GRANTED'`],
  ["worker cannot admit a task", "kj_worker", `insert into kernel_private.task_admissions(task_id) values ('${UUID}')`],
  ["worker cannot record a dispatch", "kj_worker", `insert into kernel_private.dispatch_events(id) values ('${UUID}')`],
];

export const STAMP = "kernel_private.stamp_binding_provenance()";
/** The state a probe must leave unchanged, by name; the test reads each through the owner. */
export type ProbeState = "stamp" | "triggers" | "epoch" | "activations" | "names" | "shadows" | "schemas";
/** [sealed row, probe, statement, required SQLSTATE, state that must be unchanged]. `$ROLE` is the probing role. */
export type Probe = [number, string, string, string, ProbeState[]];
/** [sealed row, probe, statement, required SQLSTATE, state that must be unchanged]. `$ROLE` is the probing role. */
export const PROBES: Probe[] = [
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

/** "GRANT without grant option changes nothing": the four statements, for the probing role. */
export const grantWithoutOption = (role: RuntimeRole): string[] => [
  `grant select on public.identity_versions to kj_door`,
  `grant all on all tables in schema public to kj_b1_probe_target`,
  `grant execute on function kernel_private.set_identity_freeze(uuid, boolean, text) to ${role}`,
  `revoke select on public.tasks from kj_worker`,
];

/** ADR-0023 27.12.9 cases 21 and 22 on the helper target: [case, probe, statement, pinned SQLSTATE]. */
export const COPROBES: [number, string, string, string][] = [
  [21, "call the helper directly", `select public.rls_auto_enable()`, "0A000"],
  [22, "CREATE EVENT TRIGGER on the helper", `create event trigger kj_b1_probe_evt on ddl_command_end execute function public.rls_auto_enable()`, "42501"],
  [22, "ALTER EVENT TRIGGER ensure_rls DISABLE", `alter event trigger ensure_rls disable`, "42501"],
  [22, "DROP EVENT TRIGGER ensure_rls", `drop event trigger ensure_rls`, "42501"],
  [22, "CREATE OR REPLACE FUNCTION public.rls_auto_enable()", `create or replace function public.rls_auto_enable() returns event_trigger language plpgsql as $f$ begin end $f$`, "42501"],
  [22, "ALTER FUNCTION public.rls_auto_enable() SECURITY INVOKER", `alter function public.rls_auto_enable() security invoker`, "42501"],
];
