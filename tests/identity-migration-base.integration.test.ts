import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { DATABASE, compose, holdRuntime, migrate, until } from "./support/local.js";
import { assertBaseEnvironment, assertBaseTarget } from "../scripts/b1/base-guard.mjs";

const P7A_RELATIONS = [
  "identity_profiles",
  "identity_versions",
  "identity_candidates",
  "identity_activations",
  "identity_pins",
  "identity_head",
  "identity_current",
];

describe("least privilege under a Supabase-style default ACL: PUBLIC, anon and authenticated hold NO privilege on any P7A relation", () => {
  const name = `identity_acl_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: DATABASE, max: 1 });
  let acl: pg.Pool;
  let releaseRuntime=()=>{};

  beforeAll(async () => {
    assertBaseEnvironment();
    releaseRuntime=holdRuntime();
    compose("up","-d","db");
    await until(()=>admin.query("select 1"),r=>r.rowCount===1);
    await assertBaseTarget(admin);
    await admin.query(`create database ${name}`);
    acl = new pg.Pool({ connectionString: DATABASE.replace(/\/kerneljson$/, `/${name}`), max: 2 });
    await acl.query(`do $$ begin
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
      if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
    end $$`);
    // Database-scoped (pg_default_acl lives in this database only), for objects the migration role
    // creates in `public` - the production condition, widened to ALL privileges, for all three default
    // classes a migration can create objects in: relations (tables AND views), sequences, functions.
    await acl.query("alter default privileges in schema public grant all on tables to public, anon, authenticated");
    await acl.query("alter default privileges in schema public grant all on sequences to public, anon, authenticated");
    await acl.query("alter default privileges in schema public grant all on functions to public, anon, authenticated");
    await migrate(acl);
  });
  afterAll(async () => {
    await acl?.end();
    // Same end()-then-forced-drop race as tests/health-collect-postgres.integration.test.ts.
    await until(
      () => admin.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where datname=$1", [name]),
      (r) => r.rows[0]!.n === 0,
      10_000,
    );
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.end();
    releaseRuntime();
  });

  it("the reproduced default ACL is real: a relation created without a revoke is born with PUBLIC/anon/authenticated privileges", async () => {
    // The negative control for the assertion below: if the default ACL were not in effect, "zero rows"
    // would be meaningless.
    const client = await acl.connect();
    try {
      await client.query("begin");
      await client.query("create table public.acl_probe(x int)");
      const probe = await client.query(
        `select count(*)::int as n from pg_class c cross join lateral aclexplode(c.relacl) a
          where c.oid = 'public.acl_probe'::regclass and a.grantee in (0, 'anon'::regrole, 'authenticated'::regrole)`,
      );
      expect(probe.rows[0].n).toBeGreaterThan(0);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("the reproduced sequence default ACL is real: a sequence created without a revoke is born with PUBLIC/anon/authenticated privileges", async () => {
    const client = await acl.connect();
    try {
      await client.query("begin");
      await client.query("create sequence public.acl_probe_seq");
      const probe = await client.query(
        `select count(*)::int as n from pg_class c cross join lateral aclexplode(c.relacl) a
          where c.oid = 'public.acl_probe_seq'::regclass and a.grantee in (0, 'anon'::regrole, 'authenticated'::regrole)`,
      );
      expect(probe.rows[0].n).toBeGreaterThan(0);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("the reproduced function default ACL is real: a function created without a revoke is EXECUTE-able by anon and authenticated", async () => {
    const client = await acl.connect();
    try {
      await client.query("begin");
      await client.query("create function public.acl_probe_fn() returns int language sql as 'select 1'");
      const probe = await client.query(
        `select count(*)::int as n from pg_proc p cross join lateral aclexplode(p.proacl) a
          where p.oid = 'public.acl_probe_fn()'::regprocedure and a.grantee in (0, 'anon'::regrole, 'authenticated'::regrole)`,
      );
      expect(probe.rows[0].n).toBeGreaterThan(0);
      const can = await client.query("select has_function_privilege('anon', 'public.acl_probe_fn()', 'EXECUTE') as anon");
      expect(can.rows[0].anon).toBe(true);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("all seven P7A relations exist, and the ACL catalog shows zero privileges of any kind for PUBLIC, anon and authenticated", async () => {
    const present = await acl.query("select relname, relkind from pg_class where relnamespace='public'::regnamespace and relname = any($1::text[]) order by relname", [P7A_RELATIONS]);
    expect(present.rows.map((r) => r.relname).sort()).toEqual([...P7A_RELATIONS].sort());
    expect(present.rows.filter((r) => r.relkind === "v").map((r) => r.relname).sort()).toEqual(["identity_current", "identity_head"]);
    const leaked = await acl.query(
      `select c.relname, case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee, a.privilege_type
         from pg_class c cross join lateral aclexplode(c.relacl) a
        where c.relnamespace = 'public'::regnamespace and c.relname = any($1::text[])
          and a.grantee in (0, 'anon'::regrole, 'authenticated'::regrole)
        order by 1, 2, 3`,
      [P7A_RELATIONS],
    );
    expect(leaked.rows).toEqual([]);
  });

  it("the identity_activations.seq identity sequence (found via pg_get_serial_sequence) grants PUBLIC, anon and authenticated nothing", async () => {
    const found = await acl.query("select pg_get_serial_sequence('public.identity_activations', 'seq') as seq");
    const seq = found.rows[0].seq as string | null;
    expect(seq).toBe("public.identity_activations_seq_seq");
    const kind = await acl.query("select relkind from pg_class where oid = $1::regclass", [seq]);
    expect(kind.rows[0].relkind).toBe("S");
    const leaked = await acl.query(
      `select case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee, a.privilege_type
         from pg_class c cross join lateral aclexplode(c.relacl) a
        where c.oid = $1::regclass and a.grantee in (0, 'anon'::regrole, 'authenticated'::regrole)
        order by 1, 2`,
      [seq],
    );
    expect(leaked.rows).toEqual([]);
    for (const role of ["anon", "authenticated"])
      for (const privilege of ["USAGE", "SELECT", "UPDATE"]) {
        const has = await acl.query("select has_sequence_privilege($1, $2, $3) as ok", [role, seq, privilege]);
        expect(has.rows[0].ok, `${role} ${privilege}`).toBe(false);
      }
  });

  it("the five P7A trigger functions exist in public and grant EXECUTE to none of PUBLIC, anon and authenticated", async () => {
    const functions = [
      "public.identity_owner_guard()",
      "public.identity_version_guard()",
      "public.identity_candidate_classify()",
      "public.identity_candidate_transition_guard()",
      "public.identity_activation_guard()",
    ];
    const exist = await acl.query("select to_regprocedure(f) is not null as ok, f from unnest($1::text[]) f", [functions]);
    expect(exist.rows.filter((r) => !r.ok).map((r) => r.f)).toEqual([]);
    const leaked = await acl.query(
      `select p.proname, case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee, a.privilege_type
         from pg_proc p cross join lateral aclexplode(p.proacl) a
        where p.oid = any(select to_regprocedure(f) from unnest($1::text[]) f)
          and a.grantee in (0, 'anon'::regrole, 'authenticated'::regrole)
        order by 1, 2`,
      [functions],
    );
    expect(leaked.rows).toEqual([]);
    for (const f of functions)
      for (const role of ["anon", "authenticated"]) {
        const has = await acl.query("select has_function_privilege($1, $2, 'EXECUTE') as ok", [role, f]);
        expect(has.rows[0].ok, `${role} EXECUTE ${f}`).toBe(false);
      }
  });

  it("both views keep security_invoker=true", async () => {
    const views = await acl.query("select relname, reloptions from pg_class where relnamespace='public'::regnamespace and relname in ('identity_head','identity_current') order by relname");
    for (const v of views.rows) expect(v.reloptions).toContain("security_invoker=true");
    expect(views.rowCount).toBe(2);
  });
});
