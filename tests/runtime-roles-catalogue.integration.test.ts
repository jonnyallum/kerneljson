import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { testDatabase, type TestDatabase } from "./support/database.js";
import {
  RUNTIME_ROLES, TABLE_PRIVILEGES, actualFacts, compareRoleToManifest, diffFacts, expectedFacts, loadManifest, type RuntimeRole,
} from "../services/kernel/src/database/runtime-roles.js";

/**
 * KJ-P8 B1 gate 8 - catalogue equality. The frozen manifest and the live catalogue must agree in BOTH directions for
 * both runtime roles: EXPECTED - ACTUAL = empty and ACTUAL - EXPECTED = empty. An extra privilege fails exactly as a
 * missing one does. Effective privileges are read (has_*_privilege), so anything inherited through PUBLIC counts.
 * All catalogue reads run as the owner (this file is test code); the comparison itself is production code.
 */
// ADR-0023 27.12.15: the plan database kj_b1_cat, to which the runner applied B1 in this run (stage T), or in lane A
// the base adapter's database; this file never creates, migrates or drops a database.
let database: TestDatabase;
let pool: pg.Pool;
const manifest = loadManifest();
// Reads go through a plain owner client so the role harness never attributes them to a runtime role.
const owner = { query: (sql: string, args?: unknown[]) => pool.query(sql, args) } as unknown as pg.Pool;

beforeAll(async () => {
  database = await testDatabase("kj_b1_cat");
  pool = new pg.Pool({ connectionString: database.url, max: 4 });
  pool.on("error", () => {});
});
afterAll(async () => {
  await pool?.end();
  await database?.close();
});

describe("B1 frozen manifest and migration are generated, not hand-edited", () => {
  it("the committed manifest and migration equal what the inventory and decisions produce", () => {
    expect(execFileSync("node", ["scripts/b1/build-manifest.mjs", "--check"], { encoding: "utf8" })).toContain("match their inputs");
  });
});

describe.each(RUNTIME_ROLES)("B1 catalogue equality for %s", (role: RuntimeRole) => {
  it("EXPECTED - ACTUAL and ACTUAL - EXPECTED are both empty", async () => {
    expect(await compareRoleToManifest(owner, manifest, role)).toEqual({ missing: [], extra: [] });
  });

  it("role attributes are exactly as sealed", async () => {
    const { rows } = await pool.query(
      `select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit from pg_roles where rolname = $1`, [role]);
    expect(rows).toEqual([{ rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, rolinherit: false }]);
  });

  it("owns nothing and has no membership in either direction", async () => {
    const facts = await actualFacts(owner, role);
    expect(facts.filter((f) => f.startsWith("owns:") || f.startsWith("membership:"))).toEqual([]);
  });

  it("has no password in the migration and none set by it", async () => {
    const { rows } = await pool.query(`select rolpassword is null as none from pg_authid where rolname = $1`, [role]);
    expect(rows).toEqual([{ none: true }]);
  });

  // Negative cases: the check must be seen to fail, in both directions.
  it("an extra table privilege is reported as extra", async () => {
    await pool.query(`grant delete on public.task_events to ${role}`);
    try {
      expect((await compareRoleToManifest(owner, manifest, role)).extra).toContain("relation:public.task_events:DELETE");
    } finally { await pool.query(`revoke delete on public.task_events from ${role}`); }
  });
  it("a privilege granted to PUBLIC is reported as extra for the role", async () => {
    await pool.query(`grant execute on function kernel_private.set_identity_freeze(uuid, boolean, text) to public`);
    try {
      expect((await compareRoleToManifest(owner, manifest, role)).extra).toContain(
        "function:kernel_private.set_identity_freeze(pg_catalog.uuid, pg_catalog.bool, pg_catalog.text):EXECUTE");
    } finally { await pool.query(`revoke execute on function kernel_private.set_identity_freeze(uuid, boolean, text) from public`); }
  });
  it("a missing privilege is reported as missing", async () => {
    const select = expectedFacts(manifest, role).find((f) => /^relation:.*:SELECT$/.test(f))!;
    const object = select.split(":")[1]!;
    await pool.query(`revoke select on ${object} from ${role}`);
    try {
      expect((await compareRoleToManifest(owner, manifest, role)).missing).toContain(select);
    } finally { await pool.query(`grant select on ${object} to ${role}`); }
  });
  it("a membership, an ownership, an extra policy and a changed attribute are each reported", async () => {
    await pool.query(`create role kj_b1_probe_group nologin`);
    await pool.query(`grant kj_b1_probe_group to ${role}`);
    await pool.query(`create table public.kj_b1_probe_owned (i int)`);
    await pool.query(`alter table public.kj_b1_probe_owned owner to ${role}`);
    // A policy for an operation the role holds, on a reachable relation, that the manifest does not list (27.11.3).
    await pool.query(`create policy ${role}_extra on public.task_events for select to ${role} using (true)`);
    await pool.query(`alter role ${role} createdb`);
    try {
      const { extra, missing } = await compareRoleToManifest(owner, manifest, role);
      expect(extra).toContain("membership:kj_b1_probe_group");
      expect(extra).toContain("owns:relation kj_b1_probe_owned");
      expect(extra.some((f) => f.startsWith(`policy:public.task_events:${role}_extra:SELECT`))).toBe(true);
      expect(extra).toContain("attribute:createdb=true");
      expect(missing).toContain("attribute:createdb=false");
    } finally {
      await pool.query(`alter role ${role} nocreatedb`);
      await pool.query(`drop policy ${role}_extra on public.task_events`);
      await pool.query(`drop table public.kj_b1_probe_owned`);
      await pool.query(`revoke kj_b1_probe_group from ${role}`);
      await pool.query(`drop role kj_b1_probe_group`);
    }
    expect(await compareRoleToManifest(owner, manifest, role)).toEqual({ missing: [], extra: [] });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// ADR-0023 revision 2.6, section 27.11: the runtime capability fact model. Every case fails on purpose and is restored.
describe("27.11 runtime capability facts need effective schema USAGE", () => {
  const plat = "kj_b1_plat";
  const facts = async (role: RuntimeRole) => (await compareRoleToManifest(owner, manifest, role)).extra;
  beforeAll(async () => {
    await pool.query(`create schema ${plat}`);
    await pool.query(`create table ${plat}.t (i int, j int)`);
    await pool.query(`alter table ${plat}.t enable row level security`);
    await pool.query(`grant select, insert, update, delete, truncate, references, trigger on ${plat}.t to public`);
    await pool.query(`grant update (j) on ${plat}.t to public`);
    await pool.query(`create sequence ${plat}.s`);
    await pool.query(`grant usage, select, update on sequence ${plat}.s to public`);
    await pool.query(`create function ${plat}.f() returns int language sql as 'select 1'`); // EXECUTE to PUBLIC by default
    await pool.query(`create policy ${plat}_any on ${plat}.t for select to public using (true)`);
  });
  afterAll(async () => { await pool.query(`drop schema ${plat} cascade`); });

  it.each(RUNTIME_ROLES)("PUBLIC object grants and a PUBLIC policy in a governed schema without USAGE are not facts for %s", async (role) => {
    const usage = (await pool.query(`select has_schema_privilege($1, $2, 'USAGE') as u`, [role, plat])).rows[0].u;
    expect(usage).toBe(false);
    expect((await facts(role)).filter((f) => f.includes(plat))).toEqual([]);
    expect(await compareRoleToManifest(owner, manifest, role)).toEqual({ missing: [], extra: [] });
  });

  it.each(RUNTIME_ROLES)("USAGE on that schema is an unexpected schema fact and exposes the object, sequence, function and policy facts for %s", async (role) => {
    await pool.query(`grant usage on schema ${plat} to public`);
    try {
      const extra = (await facts(role)).filter((f) => f.includes(plat));
      expect(extra).toEqual(expect.arrayContaining([
        `schema:${plat}:USAGE`,
        ...TABLE_PRIVILEGES.map((p) => `relation:${plat}.t:${p}`),
        `sequence:${plat}.s:USAGE`, `sequence:${plat}.s:SELECT`, `sequence:${plat}.s:UPDATE`,
        `function:${plat}.f():EXECUTE`,
        `policy:${plat}.t:${plat}_any:SELECT:using=true:check=-`,
      ]));
    } finally { await pool.query(`revoke usage on schema ${plat} from public`); }
    expect((await facts(role)).filter((f) => f.includes(plat))).toEqual([]);
  });

  it("the table privilege vocabulary is exactly the seven PostgreSQL defines, and each one is read", async () => {
    expect([...TABLE_PRIVILEGES]).toEqual(["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]);
    await pool.query(`create table public.kj_b1_vocab (i int)`);
    await pool.query(`grant ${TABLE_PRIVILEGES.join(", ")} on public.kj_b1_vocab to kj_door`);
    try {
      const extra = await facts("kj_door");
      for (const p of TABLE_PRIVILEGES) expect(extra, p).toContain(`relation:public.kj_b1_vocab:${p}`);
    } finally { await pool.query(`drop table public.kj_b1_vocab`); }
  });

  it("an overload of a manifest function is a separate, unexpected fact", async () => {
    const listed = Object.keys(manifest.roles.kj_worker.functions).find((f) => f.startsWith("kernel_private.identity_core_digest_v1("))!;
    expect(listed).toBe("kernel_private.identity_core_digest_v1(pg_catalog.jsonb)");
    await pool.query(`create function kernel_private.identity_core_digest_v1(text) returns text language sql as $f$ select 'x' $f$`);
    try {
      const extra = await facts("kj_worker");
      expect(extra).toContain("function:kernel_private.identity_core_digest_v1(pg_catalog.text):EXECUTE");
      expect(extra).not.toContain(`function:${listed}:EXECUTE`);
      expect((await compareRoleToManifest(owner, manifest, "kj_worker")).missing).toEqual([]);
    } finally { await pool.query(`drop function kernel_private.identity_core_digest_v1(text)`); }
  });

  it("a PUBLIC policy is a fact only where the role holds the operation on a reachable relation", async () => {
    await pool.query(`create table public.kj_b1_pol (i int)`);
    await pool.query(`alter table public.kj_b1_pol enable row level security`);
    await pool.query(`create policy kj_b1_pol_read on public.kj_b1_pol for select to public using (true)`);
    await pool.query(`create policy kj_b1_pol_erase on public.kj_b1_pol for delete to public using (true)`);
    try {
      // No privilege on the relation: both policies are inert for both roles.
      for (const role of RUNTIME_ROLES) expect((await facts(role)).filter((f) => f.includes("kj_b1_pol")), role).toEqual([]);
      await pool.query(`grant select on public.kj_b1_pol to kj_worker`);
      const worker = (await facts("kj_worker")).filter((f) => f.includes("kj_b1_pol"));
      expect(worker).toEqual(["policy:public.kj_b1_pol:kj_b1_pol_read:SELECT:using=true:check=-", "relation:public.kj_b1_pol:SELECT"]);
      expect((await facts("kj_door")).filter((f) => f.includes("kj_b1_pol"))).toEqual([]);
    } finally { await pool.query(`drop table public.kj_b1_pol`); }
  });

  it("every KernelJSON-generated policy is still under exact equality", async () => {
    for (const role of RUNTIME_ROLES) {
      const expected = expectedFacts(manifest, role).filter((f) => f.startsWith("policy:"));
      const actual = (await actualFacts(owner, role)).filter((f) => f.startsWith("policy:"));
      expect(actual, role).toEqual(expected);
      expect(expected.length, role).toBeGreaterThan(0);
    }
  });
});

// The SECURITY DEFINER inventory (ADR-0023 revision 2.5, section 27.10) and the health observation that includes it
// need a database snapshotted before B1, so they live in tests/runtime-roles-definers.integration.test.ts.

describe("B1 comparison is a pure set difference", () => {
  it("reports each side independently", () => {
    expect(diffFacts(["a", "b"], ["b", "c"])).toEqual({ missing: ["a"], extra: ["c"] });
  });
});
