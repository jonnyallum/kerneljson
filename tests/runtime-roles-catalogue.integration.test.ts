import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { DATABASE, compose, holdRuntime, migrate, until } from "./support/local.js";
import {
  RUNTIME_ROLES, actualFacts, compareRoleToManifest, diffFacts, expectedFacts, loadManifest, type RuntimeRole,
} from "../services/kernel/src/database/runtime-roles.js";

/**
 * KJ-P8 B1 gate 8 - catalogue equality. The frozen manifest and the live catalogue must agree in BOTH directions for
 * both runtime roles: EXPECTED - ACTUAL = empty and ACTUAL - EXPECTED = empty. An extra privilege fails exactly as a
 * missing one does. Effective privileges are read (has_*_privilege), so anything inherited through PUBLIC counts.
 * All catalogue reads run as the owner (this file is test code); the comparison itself is production code.
 */
const name = `kj_b1_cat_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const admin = new pg.Pool({ connectionString: DATABASE, max: 1 });
let pool: pg.Pool;
let releaseRuntime = () => {};
const manifest = loadManifest();
// Reads go through a plain owner client so the role harness never attributes them to a runtime role.
const owner = { query: (sql: string, args?: unknown[]) => pool.query(sql, args) } as unknown as pg.Pool;

beforeAll(async () => {
  releaseRuntime = holdRuntime();
  compose("up", "-d", "db");
  await until(() => admin.query("select 1"), (r) => r.rowCount === 1);
  await admin.query(`create database ${name}`);
  pool = new pg.Pool({ connectionString: DATABASE.replace(/\/kerneljson$/, `/${name}`), max: 4 });
  pool.on("error", () => {});
  await migrate(pool);
});
afterAll(async () => {
  await pool?.end();
  await until(() => admin.query("select count(*)::int as n from pg_stat_activity where datname = $1", [name]), (r) => r.rows[0].n === 0, 15000);
  await admin.query(`drop database if exists ${name}`);
  await admin.end();
  releaseRuntime();
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
      expect((await compareRoleToManifest(owner, manifest, role)).extra).toContain("function:kernel_private.set_identity_freeze:EXECUTE");
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
    await pool.query(`create policy ${role}_delete on public.task_events for delete to ${role} using (true)`);
    await pool.query(`alter role ${role} createdb`);
    try {
      const { extra, missing } = await compareRoleToManifest(owner, manifest, role);
      expect(extra).toContain("membership:kj_b1_probe_group");
      expect(extra).toContain("owns:relation kj_b1_probe_owned");
      expect(extra.some((f) => f.startsWith(`policy:public.task_events:${role}_delete:DELETE`))).toBe(true);
      expect(extra).toContain("attribute:createdb=true");
      expect(missing).toContain("attribute:createdb=false");
    } finally {
      await pool.query(`alter role ${role} nocreatedb`);
      await pool.query(`drop policy ${role}_delete on public.task_events`);
      await pool.query(`drop table public.kj_b1_probe_owned`);
      await pool.query(`revoke kj_b1_probe_group from ${role}`);
      await pool.query(`drop role kj_b1_probe_group`);
    }
    expect(await compareRoleToManifest(owner, manifest, role)).toEqual({ missing: [], extra: [] });
  });
});

// The SECURITY DEFINER inventory (ADR-0023 revision 2.5, section 27.10) and the health observation that includes it
// need a database snapshotted before B1, so they live in tests/runtime-roles-definers.integration.test.ts.

describe("B1 comparison is a pure set difference", () => {
  it("reports each side independently", () => {
    expect(diffFacts(["a", "b"], ["b", "c"])).toEqual({ missing: ["a"], extra: ["c"] });
  });
});
