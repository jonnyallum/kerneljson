# KJ-P8 ADR-0023 revision 2.7.2: disposable PostgreSQL 17.6 evidence (08/10/2026)

Evidence for ADR-0023 sections 27.12.5, 27.12.11 and 27.12.12 (blockers R271-B1 and R271-B2). Everything here ran on a
disposable local database. No production system was contacted. No credential was used except a throwaway test role
created for one passfile test, whose password was generated into a mode-600 file and never printed.

## Environment

- Server: `PostgreSQL 17.6 on x86_64-windows, compiled by msvc-19.44.35213, 64-bit`. Embedded binaries `@embedded-postgres/windows-x64@17.6.0-beta.15`, `initdb -A trust -E UTF8
  --no-locale`, listening on 127.0.0.1 only, one fresh database per scenario.
- Docker Desktop was not running (`docker info` failed on both contexts), so the CI image `postgres:17.6` was not used.
  The server version matches CI; the build and platform (Windows, MSVC) do not.
- Supabase CLI `2.120.0` (npm package `supabase@2`), `migration up --workdir <dir> --db-url <url>`.
- Node `v25.2.1`, `pg@8`.

## 1. Function ACL (R271-B1)

Script `acl_experiment.mjs`. Fixture per scenario, in a fresh database, roles `kj_worker` and `kj_door` existing with no
grants: the helper `public.rls_auto_enable()` (definer, `search_path=pg_catalog`, returns `event_trigger`) with
`ensure_rls`; plain functions in `public` and `kernel_private`; a procedure; an aggregate with its state function; an
invoker event-trigger function. Every routine starts with `proacl` null.

```js
// R271-B1: function ACL behaviour on disposable PostgreSQL 17.6. Each scenario runs in a fresh database.
import pg from "pg";
const PORT = 55476;
const admin = new pg.Client(`postgresql://postgres@127.0.0.1:${PORT}/postgres`);
await admin.connect();
await admin.query(`do $$ begin
  if not exists (select 1 from pg_roles where rolname='kj_worker') then create role kj_worker nologin; end if;
  if not exists (select 1 from pg_roles where rolname='kj_door') then create role kj_door nologin; end if; end $$`);

const FIXTURE = `
create schema kernel_private;
create function public.rls_auto_enable() returns event_trigger language plpgsql security definer
  set search_path = pg_catalog as $f$ begin null; end; $f$;
create event trigger ensure_rls on ddl_command_end when tag in ('CREATE TABLE','CREATE TABLE AS','SELECT INTO')
  execute function public.rls_auto_enable();
create function public.plain_fn() returns int language sql as 'select 1';
create function kernel_private.private_fn() returns int language sql as 'select 2';
create procedure public.plain_proc() language sql as 'select 1';
create function public.sfunc(int, int) returns int language sql as 'select $1 + $2';
create aggregate public.agg_sum(int) (sfunc = public.sfunc, stype = int, initcond = '0');
create function public.inv_evt() returns event_trigger language plpgsql as $f$ begin null; end; $f$;
`;

const ACL_SQL = `select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn,
  p.prokind::text as kind, p.prorettype::regtype::text as rettype, p.proacl::text as acl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public','kernel_private') order by 1`;

// The proposed enumerated cleanup: one loop, both grantee sets, every prokind, skipping event_trigger return types.
const ENUMERATED = `do $$ declare r record; begin
  for r in select p.oid::regprocedure as ident, p.prokind
           from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('public','kernel_private') and p.prokind in ('f','a','w','p')
             and p.prorettype <> 'pg_catalog.event_trigger'::pg_catalog.regtype
           order by n.nspname, p.proname, p.oid
  loop
    execute pg_catalog.format('revoke all on routine %s from public, kj_worker, kj_door', r.ident);
  end loop; end $$`;

const SCENARIOS = {
  "A_old_role_revoke_all_functions": "revoke all on all functions in schema public, kernel_private from kj_worker, kj_door",
  "B_old_public_revoke_execute_all_functions": "revoke execute on all functions in schema public, kernel_private from public",
  "C_old_both_as_frozen_B1": "revoke execute on all functions in schema public, kernel_private from public; revoke all on all functions in schema public, kernel_private from kj_worker, kj_door",
  "D_all_routines_role_revoke": "revoke all on all routines in schema public, kernel_private from kj_worker, kj_door",
  "E_all_procedures_role_revoke": "revoke all on all procedures in schema public, kernel_private from kj_worker, kj_door",
  "F_enumerated_proposed": ENUMERATED,
  "G_revoke_on_function_for_aggregate": "revoke all on function public.agg_sum(int) from kj_worker",
  "H_revoke_on_function_for_procedure": "revoke all on function public.plain_proc() from kj_worker",
  "I_role_revoke_on_event_trigger_fn_only": "revoke all on function public.rls_auto_enable() from kj_worker, kj_door",
};

const out = { server: (await admin.query("select version() v")).rows[0].v, scenarios: {} };
for (const [name, sql] of Object.entries(SCENARIOS)) {
  const db = `acl_${name.toLowerCase().slice(0, 40)}`;
  await admin.query(`drop database if exists ${db}`);
  await admin.query(`create database ${db}`);
  const c = new pg.Client(`postgresql://postgres@127.0.0.1:${PORT}/${db}`);
  await c.connect();
  await c.query(FIXTURE);
  const before = (await c.query(ACL_SQL)).rows;
  let error = null;
  try { await c.query(sql); } catch (e) { error = `${e.code} ${e.message}`; }
  const after = (await c.query(ACL_SQL)).rows;
  out.scenarios[name] = {
    sql, error,
    changed: after.filter((a, i) => a.acl !== before[i].acl).map((a, i) => ({ fn: a.fn, kind: a.kind, rettype: a.rettype, before: before.find((b) => b.fn === a.fn).acl, after: a.acl })),
  };
  if (name === "A_old_role_revoke_all_functions") out.fixtureBefore = before;
  await c.end();
  await admin.query(`drop database ${db}`);
}
await admin.end();
console.log(JSON.stringify(out, null, 1));
```

Result (only routines whose `proacl` changed are listed):

- `A_old_role_revoke_all_functions`: error `None`
  - `kernel_private.private_fn()` kind `f` rettype `integer`: `None` -> `{=X/postgres,postgres=X/postgres}`
  - `public.agg_sum(integer)` kind `a` rettype `integer`: `None` -> `{=X/postgres,postgres=X/postgres}`
  - `public.inv_evt()` kind `f` rettype `event_trigger`: `None` -> `{=X/postgres,postgres=X/postgres}`
  - `public.plain_fn()` kind `f` rettype `integer`: `None` -> `{=X/postgres,postgres=X/postgres}`
  - `public.rls_auto_enable()` kind `f` rettype `event_trigger`: `None` -> `{=X/postgres,postgres=X/postgres}`
  - `public.sfunc(integer, integer)` kind `f` rettype `integer`: `None` -> `{=X/postgres,postgres=X/postgres}`
- `B_old_public_revoke_execute_all_functions`: error `None`
  - `kernel_private.private_fn()` kind `f` rettype `integer`: `None` -> `{postgres=X/postgres}`
  - `public.agg_sum(integer)` kind `a` rettype `integer`: `None` -> `{postgres=X/postgres}`
  - `public.inv_evt()` kind `f` rettype `event_trigger`: `None` -> `{postgres=X/postgres}`
  - `public.plain_fn()` kind `f` rettype `integer`: `None` -> `{postgres=X/postgres}`
  - `public.rls_auto_enable()` kind `f` rettype `event_trigger`: `None` -> `{postgres=X/postgres}`
  - `public.sfunc(integer, integer)` kind `f` rettype `integer`: `None` -> `{postgres=X/postgres}`
- `C_old_both_as_frozen_B1`: error `None`
  - `kernel_private.private_fn()` kind `f` rettype `integer`: `None` -> `{postgres=X/postgres}`
  - `public.agg_sum(integer)` kind `a` rettype `integer`: `None` -> `{postgres=X/postgres}`
  - `public.inv_evt()` kind `f` rettype `event_trigger`: `None` -> `{postgres=X/postgres}`
  - `public.plain_fn()` kind `f` rettype `integer`: `None` -> `{postgres=X/postgres}`
  - `public.rls_auto_enable()` kind `f` rettype `event_trigger`: `None` -> `{postgres=X/postgres}`
  - `public.sfunc(integer, integer)` kind `f` rettype `integer`: `None` -> `{postgres=X/postgres}`
- `D_all_routines_role_revoke`: error `None`
  - `kernel_private.private_fn()` kind `f` rettype `integer`: `None` -> `{=X/postgres,postgres=X/postgres}`
  - `public.agg_sum(integer)` kind `a` rettype `integer`: `None` -> `{=X/postgres,postgres=X/postgres}`
  - `public.inv_evt()` kind `f` rettype `event_trigger`: `None` -> `{=X/postgres,postgres=X/postgres}`
  - `public.plain_fn()` kind `f` rettype `integer`: `None` -> `{=X/postgres,postgres=X/postgres}`
  - `public.plain_proc()` kind `p` rettype `void`: `None` -> `{=X/postgres,postgres=X/postgres}`
  - `public.rls_auto_enable()` kind `f` rettype `event_trigger`: `None` -> `{=X/postgres,postgres=X/postgres}`
  - `public.sfunc(integer, integer)` kind `f` rettype `integer`: `None` -> `{=X/postgres,postgres=X/postgres}`
- `E_all_procedures_role_revoke`: error `None`
  - `public.plain_proc()` kind `p` rettype `void`: `None` -> `{=X/postgres,postgres=X/postgres}`
- `F_enumerated_proposed`: error `None`
  - `kernel_private.private_fn()` kind `f` rettype `integer`: `None` -> `{postgres=X/postgres}`
  - `public.agg_sum(integer)` kind `a` rettype `integer`: `None` -> `{postgres=X/postgres}`
  - `public.plain_fn()` kind `f` rettype `integer`: `None` -> `{postgres=X/postgres}`
  - `public.plain_proc()` kind `p` rettype `void`: `None` -> `{postgres=X/postgres}`
  - `public.sfunc(integer, integer)` kind `f` rettype `integer`: `None` -> `{postgres=X/postgres}`
- `G_revoke_on_function_for_aggregate`: error `None`
  - `public.agg_sum(integer)` kind `a` rettype `integer`: `None` -> `{=X/postgres,postgres=X/postgres}`
- `H_revoke_on_function_for_procedure`: error `42809 public.plain_proc() is not a function`
  - no `proacl` changed
- `I_role_revoke_on_event_trigger_fn_only`: error `None`
  - `public.rls_auto_enable()` kind `f` rettype `event_trigger`: `None` -> `{=X/postgres,postgres=X/postgres}`

Scenario `F_enumerated_proposed` was a first draft that also covered procedures and used `ON ROUTINE`. Because the
frozen statements never touch procedures (scenarios A to C), the design adopted the narrower form tested next, which
covers exactly `f`, `a` and `w` and uses `ON FUNCTION`.

Script `acl_experiment2.mjs` compares the frozen pair of statements with the proposed enumerated cleanup on one fixture
that also has a window function (`language internal`, `window_row_number`) and a function already granted to
`kj_door`:

```js
// R271-B1 part 2: window-function coverage, and exact equivalence of the proposed enumerated cleanup with the frozen
// B1 pair of schema-wide statements on every routine the cleanup does not skip.
import pg from "pg";
const PORT = 55476;
const admin = new pg.Client(`postgresql://postgres@127.0.0.1:${PORT}/postgres`);
await admin.connect();

const FIXTURE = `
create schema kernel_private;
create function public.rls_auto_enable() returns event_trigger language plpgsql security definer
  set search_path = pg_catalog as $f$ begin null; end; $f$;
create event trigger ensure_rls on ddl_command_end when tag in ('CREATE TABLE','CREATE TABLE AS','SELECT INTO')
  execute function public.rls_auto_enable();
create function public.plain_fn() returns int language sql as 'select 1';
create function kernel_private.private_fn() returns int language sql as 'select 2';
create function kernel_private.granted_fn() returns int language sql as 'select 3';
grant execute on function kernel_private.granted_fn() to kj_door;
create procedure public.plain_proc() language sql as 'select 1';
create function public.sfunc(int, int) returns int language sql as 'select $1 + $2';
create aggregate public.agg_sum(int) (sfunc = public.sfunc, stype = int, initcond = '0');
create function public.win_rn() returns bigint window language internal as 'window_row_number';
`;
const ACL_SQL = `select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn,
  p.prokind::text as kind, p.prorettype::regtype::text as rettype, p.proacl::text as acl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public','kernel_private') order by 1`;
const OLD = `revoke execute on all functions in schema public, kernel_private from public;
  revoke all on all functions in schema public, kernel_private from kj_worker, kj_door;`;
const NEW = `do $$ declare r record; begin
  for r in select p.oid::pg_catalog.regprocedure as ident
           from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('public', 'kernel_private') and p.prokind <> 'p'
             and p.prorettype <> 'pg_catalog.event_trigger'::pg_catalog.regtype
           order by 1::text
  loop
    execute pg_catalog.format('revoke execute on function %s from public', r.ident);
    execute pg_catalog.format('revoke all on function %s from kj_worker, kj_door', r.ident);
  end loop; end $$`;

async function run(sql) {
  await admin.query("drop database if exists acl2"); await admin.query("create database acl2");
  const c = new pg.Client(`postgresql://postgres@127.0.0.1:${PORT}/acl2`); await c.connect();
  await c.query(FIXTURE);
  const before = (await c.query(ACL_SQL)).rows;
  await c.query(sql);
  const after = (await c.query(ACL_SQL)).rows;
  await c.end(); await admin.query("drop database acl2");
  return { before, after };
}
const old = await run(OLD), neu = await run(NEW);
const rows = old.after.map((o) => {
  const n = neu.after.find((x) => x.fn === o.fn);
  const b = old.before.find((x) => x.fn === o.fn);
  return { fn: o.fn, kind: o.kind, rettype: o.rettype, before: b.acl, old_after: o.acl, new_after: n.acl, equal: o.acl === n.acl };
});
const skipped = rows.filter((r) => r.rettype === "event_trigger" || r.kind === "p");
const covered = rows.filter((r) => !(r.rettype === "event_trigger" || r.kind === "p"));
console.log(JSON.stringify({
  rows,
  coveredAllEqual: covered.every((r) => r.equal),
  oldTouchedProcedure: rows.find((r) => r.kind === "p").old_after !== rows.find((r) => r.kind === "p").before,
  oldTouchedWindow: rows.find((r) => r.kind === "w").old_after !== rows.find((r) => r.kind === "w").before,
  rlsAfterNew: rows.find((r) => r.fn === "public.rls_auto_enable()").new_after,
  skipped: skipped.map((r) => r.fn),
}, null, 1));
await admin.end();
```

| routine | kind | returns | before | frozen pair | enumerated | equal |
|---|---|---|---|---|---|---|
| `kernel_private.granted_fn()` | `f` | `integer` | `{=X/postgres,postgres=X/postgres,kj_door=X/postgres}` | `{postgres=X/postgres}` | `{postgres=X/postgres}` | yes |
| `kernel_private.private_fn()` | `f` | `integer` | `None` | `{postgres=X/postgres}` | `{postgres=X/postgres}` | yes |
| `public.agg_sum(integer)` | `a` | `integer` | `None` | `{postgres=X/postgres}` | `{postgres=X/postgres}` | yes |
| `public.plain_fn()` | `f` | `integer` | `None` | `{postgres=X/postgres}` | `{postgres=X/postgres}` | yes |
| `public.plain_proc()` | `p` | `void` | `None` | `None` | `None` | yes |
| `public.rls_auto_enable()` | `f` | `event_trigger` | `None` | `{postgres=X/postgres}` | `None` | no |
| `public.sfunc(integer, integer)` | `f` | `integer` | `None` | `{postgres=X/postgres}` | `{postgres=X/postgres}` | yes |
| `public.win_rn()` | `w` | `bigint` | `None` | `{postgres=X/postgres}` | `{postgres=X/postgres}` | yes |

Summary: `coveredAllEqual` = `True`, the frozen pair touched the procedure = `False`,
touched the window function = `True`, helper `proacl` after the enumerated cleanup = `None`.

## 2. Migration ledger (R271-B2)

### 2.1 Test migrations

Project directory with `supabase/config.toml` containing only `project_id = "ledgerexp"`, and:

`20990101000000_base_a.sql`:

```sql
create table public.base_a (id int);
```

`20990101000001_base_b.sql`:

```sql
create table public.base_b (id int);
-- a second statement with a comment
insert into public.base_b values (1);
```

`20990101000002_settings_probe.sql`:

```sql
create table public.probe as
  select pg_catalog.current_setting('kj.b1.probe', true) as probe,
         pg_catalog.current_setting('transaction_isolation') as iso,
         pg_catalog.txid_current()::text as txid,
         pg_catalog.current_setting('search_path') as sp;
```

`20990101000003_fail.sql`:

```sql
create table public.fail_t (id int);
select 1/0;
```

Run: `supabase migration up --workdir . --db-url 'postgresql://postgres@127.0.0.1:55476/ledgerexp?sslmode=disable&options=-c%20kj.b1.probe%3Dhello' --debug --agent no`.
Output: applied `base_a`, `base_b`, `settings_probe`, then `ERROR: division by zero (SQLSTATE 22012)` at statement 1 of
`20990101000003_fail.sql`.

Script `ledger_inspect.mjs`:

```js
// Inspect what the Supabase CLI wrote to the disposable ledger database.
import pg from "pg";
const c = new pg.Client(`postgresql://postgres@127.0.0.1:55476/${process.argv[2] ?? "ledgerexp"}`);
await c.connect();
const q = async (s) => (await c.query(s)).rows;
console.log(JSON.stringify({
  ledgerTables: await q(`select table_schema, table_name from information_schema.tables where table_schema = 'supabase_migrations' order by 2`),
  columns: await q(`select table_name, ordinal_position, column_name, data_type, udt_name, is_nullable, column_default
    from information_schema.columns where table_schema = 'supabase_migrations' order by table_name, ordinal_position`),
  constraints: await q(`select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def from pg_constraint
    where connamespace = 'supabase_migrations'::regnamespace order by 1, 2`),
  rows: await q(`select version, name, statements, xmin::text as xmin from supabase_migrations.schema_migrations order by version`),
  probe: await q(`select probe, iso, txid, sp, xmin::text as row_xmin from public.probe`).catch((e) => e.message),
  base_b_rows: await q(`select id, xmin::text from public.base_b`).catch((e) => e.message),
  base_a_xmin: await q(`select xmin::text from pg_class where oid = 'public.base_a'::regclass`).catch((e) => e.message),
  base_b_xmin: await q(`select xmin::text from pg_class where oid = 'public.base_b'::regclass`).catch((e) => e.message),
  fail_t_exists: (await q(`select to_regclass('public.fail_t') is not null as e`))[0].e,
}, null, 1));
await c.end();
```

Output:

```json
{
 "ledgerTables": [
  {
   "table_schema": "supabase_migrations",
   "table_name": "schema_migrations"
  }
 ],
 "columns": [
  {
   "table_name": "schema_migrations",
   "ordinal_position": 1,
   "column_name": "version",
   "data_type": "text",
   "udt_name": "text",
   "is_nullable": "NO",
   "column_default": null
  },
  {
   "table_name": "schema_migrations",
   "ordinal_position": 2,
   "column_name": "statements",
   "data_type": "ARRAY",
   "udt_name": "_text",
   "is_nullable": "YES",
   "column_default": null
  },
  {
   "table_name": "schema_migrations",
   "ordinal_position": 3,
   "column_name": "name",
   "data_type": "text",
   "udt_name": "text",
   "is_nullable": "YES",
   "column_default": null
  }
 ],
 "constraints": [
  {
   "tbl": "supabase_migrations.schema_migrations",
   "conname": "schema_migrations_pkey",
   "def": "PRIMARY KEY (version)"
  }
 ],
 "rows": [
  {
   "version": "20990101000000",
   "name": "base_a",
   "statements": [
    "create table public.base_a (id int)"
   ],
   "xmin": "795"
  },
  {
   "version": "20990101000001",
   "name": "base_b",
   "statements": [
    "create table public.base_b (id int)",
    "-- a second statement with a comment\ninsert into public.base_b values (1)"
   ],
   "xmin": "796"
  },
  {
   "version": "20990101000002",
   "name": "settings_probe",
   "statements": [
    "create table public.probe as\n  select pg_catalog.current_setting('kj.b1.probe', true) as probe,\n         pg_catalog.current_setting('transaction_isolation') as iso,\n         pg_catalog.txid_current()::text as txid,\n         pg_catalog.current_setting('search_path') as sp"
   ],
   "xmin": "797"
  }
 ],
 "probe": [
  {
   "probe": "hello",
   "iso": "read committed",
   "txid": "797",
   "sp": "\"$user\", public",
   "row_xmin": "797"
  }
 ],
 "base_b_rows": [
  {
   "id": 1,
   "xmin": "796"
  }
 ],
 "base_a_xmin": [
  {
   "xmin": "795"
  }
 ],
 "base_b_xmin": [
  {
   "xmin": "796"
  }
 ],
 "fail_t_exists": false
}
```

Reading: the table has three columns; each row's `xmin` equals the `xmin` of its migration's objects and the migration's
own `txid_current()` (797); the failed migration left neither `fail_t` nor a row; the startup option reached the
migration (`probe = hello`).

### 2.2 Version already recorded, and gaps

Same database, continuing:

| Test | Action | CLI result | Ledger afterwards |
|---|---|---|---|
| T1 version recorded | insert row `20990101000003` (the failing file), run `migration up` | `Local database is up to date.`; file not executed; `fail_t` absent | unchanged |
| T2 gap behind head | delete row `20990101000001` (objects remain), run `migration up` | `Found local migration files to be inserted before the last migration on remote database. Rerun the command with --include-all flag` | unchanged |
| T2b same, with `--include-all` | | `Applying migration 20990101000001_base_b.sql...` then `ERROR: relation "base_b" already exists (SQLSTATE 42P07)` | row still absent |
| T3 extra recorded version | insert rows `20990101000001` and `20990101000009` (no file), run `migration up` | `Remote migration versions not found in local migrations directory.` | unchanged |
| T4 gap after head | delete rows `20990101000009`, `20990101000002`, `20990101000003`, run `migration up` | `Applying migration 20990101000002_settings_probe.sql...` then `ERROR: relation "probe" already exists (SQLSTATE 42P07)` | `20990101000000`, `20990101000001` |

### 2.3 Passfile authentication

A login role `pwuser` with a generated password and a `pg_hba.conf` line `host all pwuser 127.0.0.1/32 scram-sha-256`.
A connection without a password was refused. `PGPASSFILE=<mode-600 file> supabase migration up --workdir . --db-url
'postgresql://pwuser@127.0.0.1:55476/ledgerexp2?sslmode=disable&options=-c%20kj.b1.probe%3Dfrom-startup'` applied three
migrations; `probe` read `from-startup`; the objects were owned by `pwuser`. The password was never on a command line
or printed.

### 2.4 Ledger write order and COMMIT-time failure

On `ledgerexp2`: an `AFTER INSERT` trigger on the ledger logging whether the migration's object already existed, and a
`DEFERRABLE INITIALLY DEFERRED` constraint trigger raising `23514` for version `20990101000005`. Migrations
`20990101000004_m4.sql` (`create table public.m4_obj (id int);`) and `20990101000005_m5.sql`
(`create table public.m5_obj (id int);`).

CLI output: `Applying migration 20990101000004_m4.sql...`, `Applying migration 20990101000005_m5.sql...`,
`ERROR: injected failure at COMMIT after ledger insert (SQLSTATE 23514)`, `At statement: 2`,
`INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES($1, $2, $3)`.

Afterwards: log `[{"version":"20990101000004","obj_exists":true,"txid":"810"}]`; ledger
`20990101000000,20990101000001,20990101000002,20990101000004`; `m5_obj` absent; `m4_obj` `xmin` 810. So the ledger
insert follows the migration's statements in the same transaction, and a failure at COMMIT after it removes both.

### 2.5 Frozen B1 through the CLI

The 23 files of `0ff2919:supabase/migrations/` were exported with `git cat-file blob` into a fresh directory; every
file's SHA-256 equalled its blob's and no file contained CR. B1's blob SHA-256 is
`5cbb8b54fdb64d5546bf5acce78a86de23fc5dadfb73a664b252549f7589c8a5`. On a fresh database with `anon`, `authenticated` and
`service_role` created as `tests/support/local.ts` does, the 22 base migrations were applied by the CLI, then B1 alone,
with a startup option. Result:

```json
{"count":23,"b1":{"version":"20261002090000","name":"runtime_least_privilege_roles","nStatements":293,
"statementsSha256":"1b19276eb6a861ea1b63f713a69fa3126a4fc2ade3e387a2c487129bf2fb84d1"},
"stampDefiner":{"prosecdef":true},"b1_xmin":"837","stamp_xmin":"837"}
```

`statementsSha256` is the SHA-256 of `JSON.stringify` of the `statements` array. The frozen B1 was not modified and was
applied only to this disposable database. No migration in `0ff2919:supabase/migrations/` contains a top-level
transaction-control statement.

## 3. Not established here

- Hosted Supabase behaviour: the production `schema_migrations` columns, whether startup parameters survive the
  production connection path, and the CLI's behaviour there. The runner's gate checks the column contract and P3
  step 1 fails closed on lost settings.
- The INFERENCE items of ADR section 26 other than item 3's startup-parameter part.
- The golden vector of ADR 27.12.7 was computed from the specification, not from a catalogue.
