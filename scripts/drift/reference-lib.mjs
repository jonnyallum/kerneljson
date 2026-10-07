// KJ-P8 ledger drift adjudication: the canonical reference, built migration by migration in two privilege regimes.
//
// ZERO  objects are born with no privilege for anyone but their owner (the PUBLIC defaults on functions and types are
//       revoked by default privileges). Any non-owner privilege present after migration k was GRANTED by the chain.
// MAX   objects are born with every privilege for anon and authenticated in every schema, and for PUBLIC and
//       service_role in schema public; functions and types also keep PostgreSQL's built-in PUBLIC default everywhere.
//       That is the most a canonical migration tolerates: 20260929120000's pre-COMMIT qualification refuses any ambient
//       privilege service_role would hold in kernel_private, including through PUBLIC. Any covered privilege ABSENT
//       after migration k was REVOKED by the chain.
// Neither regime is a model of a hosted platform. Together they separate the privilege effects the migrations own
// (explicit grants and revokes) from everything a platform's default privileges decide. See compare-lib.mjs.
import { createHash } from "node:crypto";
import { footprint } from "./footprint-lib.mjs";

export const pgDb = (client) => ({ exec: (sql) => client.query(sql), query: (sql, params) => client.query(sql, params) });

export const ROLES_SQL = `do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$`;

export const REGIMES = {
  zero: [
    "alter default privileges for role postgres revoke all on functions from public",
    "alter default privileges for role postgres revoke all on types from public",
  ],
  max: [
    ...["tables", "sequences", "functions", "types", "schemas"].map((k) => `alter default privileges for role postgres grant all on ${k} to anon, authenticated`),
    ...["tables", "sequences", "functions", "types"].map((k) => `alter default privileges for role postgres in schema public grant all on ${k} to public, service_role`),
  ],
};
// Who MAX covers: the grantees an object of this pg_default_acl type in this schema is born with under MAX, so that
// their absence after a migration proves an explicit revoke. Must mirror REGIMES.max exactly. type: r S f T n.
export function maxCoverage(schema, type) {
  const g = ["anon", "authenticated"];
  if (type === "f" || type === "T") g.push("PUBLIC");                              // built-in default, every schema
  if (schema === "public" && type !== "n") g.push(...(g.includes("PUBLIC") ? [] : ["PUBLIC"]), "service_role");
  return g;
}
export const MAX_GRANTEES = Object.freeze(["PUBLIC", "anon", "authenticated", "service_role"]);

// db: { exec(sql) for multi-statement SQL, query(sql, params) -> { rows } }. files: [{ name, sql }] in order.
export async function buildSteps(db, files, regime, log = () => undefined) {
  await db.exec(ROLES_SQL);
  for (const sql of REGIMES[regime]) await db.exec(sql);
  const steps = [{ file: null, ...(await footprint(db)) }];
  for (const f of files) {
    await db.exec("begin");
    try { await db.exec(f.sql); await db.exec("commit"); }
    catch (error) { await db.exec("rollback"); throw new Error(`${regime} ${f.name}: ${error.message}`); }
    steps.push({ file: f.name, sqlSha256: createHash("sha256").update(f.sql).digest("hex"), ...(await footprint(db)) });
    log(`${regime} ${f.name}: ${Object.keys(steps.at(-1).objects).length} objects`);
  }
  return steps;
}

export function mergeRegimes(zero, max) {
  if (zero.length !== max.length) throw new Error("REFERENCE_REFUSED: regimes have different step counts");
  return zero.map((z, i) => ({ file: z.file, sqlSha256: z.sqlSha256 ?? null, zero: z, max: { meta: max[i].meta, objects: max[i].objects } }));
}
