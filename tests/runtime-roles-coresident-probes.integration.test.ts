import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { testDatabase, type TestDatabase } from "./support/database.js";
import { RUNTIME_ROLES, type RuntimeRole } from "../services/kernel/src/database/runtime-roles.js";
import { COPROBES } from "./support/b1-probes.js";

/**
 * ADR-0023 27.12.9 cases 21 and 22, on a database holding the pinned helper and ensure_rls (suite
 * regression-helper-probes, setup profile pinned-helper, plan database kj_b1_helper). Each statement runs on a genuine
 * login session of each runtime role and must fail with the pinned SQLSTATE; any other SQLSTATE fails the probe, and
 * an owner re-read must show the helper and its binding unchanged. The SQLSTATEs are the design's INFERENCE (section
 * 26): if PostgreSQL returns another, the case fails and the design is revised; it is never relaxed to "any error".
 */
let database: TestDatabase;
const session = {} as Record<RuntimeRole, pg.Client>;
const facts = async () => (await database.pool.query(`select p.prosrc,p.prosecdef,p.proconfig,p.proacl::text,pg_catalog.pg_get_userbyid(p.proowner) as owner,
  (select pg_catalog.json_agg(pg_catalog.json_build_object('name',e.evtname,'enabled',e.evtenabled,'tags',e.evttags,'owner',pg_catalog.pg_get_userbyid(e.evtowner)) order by e.evtname)
     from pg_catalog.pg_event_trigger e) as triggers
  from pg_catalog.pg_proc p where p.oid='public.rls_auto_enable()'::pg_catalog.regprocedure`)).rows;
beforeAll(async () => {
  database = await testDatabase("kj_b1_helper");
  for (const role of RUNTIME_ROLES) {
    const url = new URL(database.url); url.username = role;
    session[role] = new pg.Client({ connectionString: url.toString() });
    await session[role].connect();
  }
});
afterAll(async () => {
  for (const role of RUNTIME_ROLES) await session[role]?.end().catch(() => undefined);
  await database?.close();
});
describe.each(RUNTIME_ROLES)("27.12.9 co-resident probes: %s", (role: RuntimeRole) => {
  it.each(COPROBES)("case %i: %s", async (_case, _probe, sql, expected) => {
    const before = await facts();
    let observed = "OK";
    try { await session[role].query(sql); } catch (error) { observed = (error as { code?: string }).code ?? "NO_SQLSTATE"; }
    expect(observed).toBe(expected);
    expect(await facts()).toEqual(before);
  });
});
