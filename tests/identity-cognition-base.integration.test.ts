import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import pg from "pg";
import { DATABASE, compose, migrate, until, holdRuntime } from "./support/local.js";
import { assertBaseEnvironment, assertBaseTarget, baseMigrationFiles } from "../scripts/b1/base-guard.mjs";
import type { IdentityDocument } from "../packages/contracts/src/index.js";
import { identityCoreDigestV1 } from "../services/kernel/src/identity/canonical.js";
import { principal } from "../evals/fixtures/contracts.js";

const P7B_MIGRATION = "20260929120000_identity_cognition_binding.sql";
const corpus = JSON.parse(readFileSync("tests/fixtures/identity-core-v1.vectors.json", "utf8")) as {
  vectors: Array<{ name: string; inputJson: string; canonical?: string; sha256?: string; classASha256?: string; refuse?: string }>;
};
const KERNEL_V1 = JSON.parse(corpus.vectors.find((v) => v.name === "kernel-v1-activated")!.inputJson) as IdentityDocument;
const KERNEL_TENANT = KERNEL_V1.tenantId;
const KERNEL_VERSION_ROW = "08be5e20-2606-4809-b81f-11552bb67502";

const admin = new pg.Pool({ connectionString: DATABASE, max: 1 });
const databases: string[] = [];
let releaseRuntime = () => {};
async function freshDatabase(prefix: string): Promise<pg.Pool> {
  const name = `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await assertBaseTarget(admin);
  await admin.query(`create database ${name}`);
  databases.push(name);
  const pool = new pg.Pool({ connectionString: DATABASE.replace(/\/kerneljson$/, `/${name}`), max: 4 });
  pool.on("error", () => {});
  return pool;
}
async function ensureRoles(pool: pg.Pool) {
  await assertBaseTarget(pool);
  await pool.query(`do $$ begin
    if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
    if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
  end $$`);
}
/** Every migration before P7B, then (optionally) P7B, each in its own transaction exactly like `migrate`. */
async function migrateBefore(pool: pg.Pool): Promise<void> {
  await ensureRoles(pool);
  for (const file of baseMigrationFiles((await readdir("supabase/migrations")).filter(f=>f.endsWith(".sql"))).filter(f=>f<P7B_MIGRATION)) await applyFile(pool, file);
}
async function applyFile(pool: pg.Pool, file: string): Promise<void> {
  baseMigrationFiles((await readdir("supabase/migrations")).filter(f=>f.endsWith(".sql")),{only:[file]});
  await assertBaseTarget(pool);
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query(await readFile(`supabase/migrations/${file}`, "utf8"));
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    db.release();
  }
}

/** Seeds an activated identity with triggers bypassed (disposable test DBs only). Digests are always the true v1 ones
 *  unless `storedCore` overrides them, which is how a corrupt row is simulated. */
async function seedIdentity(pool: pg.Pool, doc: IdentityDocument, opts: { versionRowId?: string; storedCore?: string; profile?: boolean } = {}) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    if (opts.profile !== false)
      await c.query("insert into public.identity_profiles(id,tenant_id,owner_principal_id,name) values($1,$2,$3,'Kernel') on conflict do nothing", [doc.id, doc.tenantId, principal.id]);
    const candidate = randomUUID();
    const { version: _v, ...draft } = doc;
    await c.query(`insert into public.identity_candidates(id,identity_id,tenant_id,document,proposed_digest,origin,governance_class,state,base_version,base_identity_core_digest)
      values($1,$2,$3,$4,$5,'MODEL_PROPOSAL','C','HELD',1,$5)`, [candidate, doc.id, doc.tenantId, draft, identityCoreDigestV1(draft)]);
    await c.query(`insert into public.identity_versions(id,identity_id,tenant_id,version,document,identity_core_digest,class_a_digest,governance_class,candidate_id,created_by_task)
      values($1,$2,$3,$4,$5,$6,$7,'C',$8,$9)`, [opts.versionRowId ?? randomUUID(), doc.id, doc.tenantId, doc.version, doc,
      opts.storedCore ?? identityCoreDigestV1(doc), identityCoreDigestV1(doc.sections.classA), candidate, randomUUID()]);
    await c.query(`insert into public.identity_activations(id,identity_id,tenant_id,version,governance_class,candidate_id,request_task_id)
      values($1,$2,$3,$4,'C',$5,$6)`, [randomUUID(), doc.id, doc.tenantId, doc.version, candidate, randomUUID()]);
    await c.query("commit");
  } catch (error) {
    await c.query("rollback");
    throw error;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  assertBaseEnvironment();
  releaseRuntime = holdRuntime();
  compose("up", "-d", "db");
  await until(() => admin.query("select 1"), (r) => r.rowCount === 1);
});
afterAll(async () => {
  for (const name of databases) {
    await until(() => admin.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where datname=$1", [name]), (r) => r.rows[0]!.n === 0, 15_000).catch(() => undefined);
    await admin.query(`drop database if exists ${name} with (force)`);
  }
  await admin.end();
  releaseRuntime();
});

// ---------------------------------------------------------------------------------------------------------------
describe("the migration's pre-COMMIT qualification refuses bad production states (and applies on the true one)", () => {
  const outcome = async (seed: (pool: pg.Pool) => Promise<void>) => {
    const pool = await freshDatabase("p7b_pre");
    try {
      await migrateBefore(pool);
      await pool.query("insert into principals(id,kind) values($1,'HUMAN')", [principal.id]);
      await pool.query("insert into tenants(id,name) values($1,'kernel')", [KERNEL_TENANT]);
      await seed(pool);
      await applyFile(pool, P7B_MIGRATION);
      return "APPLIED";
    } catch (error) {
      return (error as Error).message;
    } finally {
      await pool.end();
    }
  };
  it("applies with the exact production Kernel v1 row present", async () => {
    expect(await outcome((p) => seedIdentity(p, KERNEL_V1, { versionRowId: KERNEL_VERSION_ROW }))).toBe("APPLIED");
  });
  it("refuses when the persisted Kernel v1 row is not the approved document, even with self-consistent digests", async () => {
    const tampered = structuredClone(KERNEL_V1);
    tampered.sections.classC.persona += " (tampered)";
    expect(await outcome((p) => seedIdentity(p, tampered, { versionRowId: KERNEL_VERSION_ROW }))).toContain("persisted Kernel v1 differs");
  });
  it("refuses when any existing version fails digest parity", async () => {
    const other = { ...structuredClone(KERNEL_V1), id: randomUUID() };
    expect(await outcome((p) => seedIdentity(p, other, { storedCore: "0".repeat(64) }))).toContain("fail digest parity");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("least privilege under a Supabase-style default ACL (PR #47 harness), including service_role", () => {
  let acl: pg.Pool;
  beforeAll(async () => {
    acl = await freshDatabase("p7b_acl");
    await ensureRoles(acl);
    await acl.query("alter default privileges in schema public grant all on tables to public, anon, authenticated, service_role");
    await acl.query("alter default privileges in schema public grant all on sequences to public, anon, authenticated, service_role");
    await acl.query("alter default privileges in schema public grant all on functions to public, anon, authenticated, service_role");
    await migrate(acl);
  });
  afterAll(async () => acl?.end());
  const has = async (role: string, rel: string, priv: string) =>
    (await acl.query<{ ok: boolean }>("select has_table_privilege($1, $2, $3) as ok", [role, rel, priv])).rows[0]!.ok;
  it("the reproduced default ACL is real (negative control)", async () => {
    const c = await acl.connect();
    try {
      await c.query("begin");
      await c.query("create function public.p7b_probe() returns int language sql as 'select 1'");
      expect((await c.query("select has_function_privilege('anon','public.p7b_probe()','EXECUTE') ok")).rows[0].ok).toBe(true);
    } finally { await c.query("rollback"); c.release(); }
  });
  it("latch: PUBLIC/anon/authenticated nothing; service_role SELECT+INSERT only", async () => {
    const rel = "kernel_private.identity_cognition_latches";
    for (const role of ["public", "anon", "authenticated"])
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) expect(await has(role, rel, priv), `${role} ${priv}`).toBe(false);
    expect(await has("service_role", rel, "SELECT")).toBe(true);
    expect(await has("service_role", rel, "INSERT")).toBe(true);
    for (const priv of ["UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) expect(await has("service_role", rel, priv), priv).toBe(false);
  });
  it("contract marker: service_role SELECT only; nobody else anything", async () => {
    const rel = "kernel_private.identity_cognition_contract_v1";
    for (const role of ["public", "anon", "authenticated"]) expect(await has(role, rel, "SELECT")).toBe(false);
    expect(await has("service_role", rel, "SELECT")).toBe(true);
    for (const priv of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) expect(await has("service_role", rel, priv), priv).toBe(false);
  });
  it("the new USAGE on kernel_private exposes no other private relation, sequence or function to service_role", async () => {
    const exposed = await acl.query(`
      select 'relation ' || c.relname as obj from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'kernel_private' and c.relkind in ('r','v','m','S','p','f')
          and c.relname not in ('identity_cognition_latches','identity_cognition_contract_v1')
          and has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      union all
      select 'function ' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'kernel_private' and has_function_privilege('service_role', p.oid, 'EXECUTE')`);
    expect(exposed.rows).toEqual([]);
    const inventory = await acl.query("select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='kernel_private'");
    expect(inventory.rows[0].n).toBeGreaterThan(15); // the inventory really ran over the whole private schema
  });
  it("no new function is EXECUTE-able by PUBLIC, anon, authenticated or service_role", async () => {
    const fns = ["kernel_private.identity_json_string_v1(text)", "kernel_private.identity_core_canonical_v1(jsonb)", "kernel_private.identity_core_digest_v1(jsonb)",
      "kernel_private.identity_cognition_source_v1(uuid,uuid,integer)", "public.identity_version_digest_parity_v1()", "public.identity_pin_guard_v1()"];
    for (const fn of fns) for (const role of ["public", "anon", "authenticated", "service_role"])
      expect((await acl.query("select has_function_privilege($1,$2,'EXECUTE') ok", [role, fn])).rows[0].ok, `${role} ${fn}`).toBe(false);
  });
});

