import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import pg from "pg";
import { testDatabase, type TestDatabase } from "./support/database.js";
import { FUNCTION_IDENTITY_SQL, RUNTIME_ROLES, actualFacts, loadManifest, type RuntimeRole } from "../services/kernel/src/database/runtime-roles.js";
import { FORBIDDEN, PRINCIPAL, PROBES, SEPARATION, STAMP, TENANT, grantWithoutOption } from "./support/b1-probes.js";

/**
 * KJ-P8 B1 gate 7 - negative privilege qualification. Every forbidden power is ATTEMPTED on a genuine login session
 * of each runtime role and must be refused with the SQLSTATE pinned here. "Some error occurred" is not accepted:
 * a different code fails the probe. Nothing is inferred from the manifest.
 *
 *   42501 insufficient_privilege      0LP01 invalid_grant_operation      42809 wrong_object_type
 * A GRANT or REVOKE by a role that holds no grant option does not raise; Postgres emits a warning and changes
 * nothing. Those probes therefore assert "no effect" by re-reading the catalogue.
 *
 * ADR-0023 27.12.15: lane D, suite regression-probes. The database is this suite's plan database kj_b1_neg, to which
 * the runner applied B1 in this run; the test never creates, migrates or drops a database. Every probe's refusal is
 * declared in tests/b1-required.json and accounted by trace and by database log.
 */
let database: TestDatabase;
const url = (user: string) => { const u = new URL(database.url); u.username = user; return u.toString(); };
let owner: pg.Pool;
const session = {} as Record<RuntimeRole, pg.Client>;
const manifest = loadManifest();
const results: { role: string; probe: string; sql: string; expected: string; observed: string; pass: boolean }[] = [];

beforeAll(async () => {
  database = await testDatabase("kj_b1_neg");
  owner = database.pool;
  owner.on("error", () => {});
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
  await database?.close();
});

/** Run one statement as the role and return the SQLSTATE, or "OK" when it did not raise. */
async function attempt(role: RuntimeRole, sql: string): Promise<string> {
  try { await session[role].query(sql); return "OK"; } catch (error) { return (error as { code?: string }).code ?? "NO_SQLSTATE"; }
}



describe.each(RUNTIME_ROLES)("B1 forbidden powers: %s", (role: RuntimeRole) => {
  it.each(FORBIDDEN)("%s", async (probe, sql, expected) => {
    const observed = await attempt(role, sql);
    await session[role].query("reset row_security").catch(() => undefined);
    results.push({ role, probe, sql, expected, observed, pass: observed === expected });
    expect(observed).toBe(expected);
  });

  it("GRANT without grant option changes nothing", async () => {
    const before = await actualFacts(owner, "kj_door"), beforeW = await actualFacts(owner, "kj_worker");
    for (const sql of grantWithoutOption(role)) {
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
