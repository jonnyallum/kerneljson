import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { excludedSchemaSql } from "./security-definers.js";

/**
 * KJ-P8 B1 (ADR-0023 revision 2.5, section 27, sealed at 424f85c283a543ba00a650ecc2ecc3a4346623df) - least-privilege
 * runtime database roles. The SECURITY DEFINER inventory of section 27.10 lives in ./security-definers.ts.
 *
 * Two things live here, and nothing else:
 *   1. `assertRuntimeRole`: every runtime process proves, before it serves anything, that its database session is
 *      exactly its sealed role. There is no fallback: an owner or any other session refuses to start.
 *   2. the catalogue reader and the manifest comparison used by qualification and by the health check, so "the
 *      database grants equal the frozen manifest, in both directions" is one piece of code.
 */
export type RuntimeRole = "kj_worker" | "kj_door";
export const RUNTIME_ROLES: readonly RuntimeRole[] = ["kj_worker", "kj_door"];
type Db = Pick<pg.Pool | pg.PoolClient, "query">;

export class RuntimeRoleRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * Fail closed unless this session IS `expected`: logged in as it (session_user), acting as it (current_user), with
 * none of the powers the sealed contract forbids. The message carries a fixed code and the role names only - never a
 * connection string.
 */
export async function assertRuntimeRole(db: Db, expected: RuntimeRole): Promise<void> {
  const { rows } = await db.query<{
    current: string; session: string; ok: boolean; memberships: string; owned: string;
  }>(
    `select current_user::text as current, session_user::text as session,
            (r.rolcanlogin and not r.rolsuper and not r.rolcreatedb and not r.rolcreaterole and not r.rolreplication
             and not r.rolbypassrls and not r.rolinherit) as ok,
            (select count(*) from pg_auth_members m where m.member = r.oid or m.roleid = r.oid)::text as memberships,
            ((select count(*) from pg_class c where c.relowner = r.oid)
             + (select count(*) from pg_proc p where p.proowner = r.oid)
             + (select count(*) from pg_namespace n where n.nspowner = r.oid)
             + (select count(*) from pg_database d where d.datdba = r.oid))::text as owned
       from pg_roles r where r.rolname = current_user`,
  );
  const row = rows[0];
  if (!row || row.current !== expected || row.session !== expected)
    throw new RuntimeRoleRefusal(`RUNTIME_DATABASE_ROLE_REFUSED: this process must connect as ${expected}`);
  if (!row.ok || row.memberships !== "0" || row.owned !== "0")
    throw new RuntimeRoleRefusal(`RUNTIME_DATABASE_ROLE_REFUSED: ${expected} is not least-privilege as sealed`);
}

/**
 * The only way a runtime process obtains a database pool. Before the first statement on the pool, and again after any
 * refusal, it proves the session is exactly `role`. A pool that fails the proof never runs a statement: there is no
 * owner fallback, no alternate credential and no degraded mode. The proof is lazy (first use, not construction) so a
 * process can still be imported and inspected without a database, as the image and registration checks require.
 */
export function runtimePool(config: pg.PoolConfig, role: RuntimeRole): pg.Pool {
  const pool = new pg.Pool(config);
  const rawConnect = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;
  let verified: Promise<void> | undefined;
  const verify = (): Promise<void> =>
    (verified ??= (async () => {
      const client = await rawConnect();
      try {
        await assertRuntimeRole(client, role);
      } finally {
        client.release();
      }
    })().catch((error: unknown) => {
      verified = undefined; // a refusal is never remembered as a pass: the next use is checked again
      throw error;
    }));
  // `pool.query` obtains its client through `pool.connect`, so guarding connect guards every statement.
  type Callback = (error: Error | undefined, client: pg.PoolClient | undefined, done: (release?: boolean | Error) => void) => void;
  pool.connect = ((callback?: Callback) => {
    const client = verify().then(() => rawConnect());
    if (!callback) return client;
    client.then(
      (c) => callback(undefined, c, c.release.bind(c)),
      (error: unknown) => callback(error as Error, undefined, () => undefined),
    );
    return undefined;
  }) as unknown as pg.Pool["connect"];
  return pool;
}

// ---------------------------------------------------------------------------------------------------------------
// Manifest
export type UpdateGrant = true | string[] | { lockOnly: true; column: string };
export interface RoleManifest {
  attributes: { login: boolean; superuser: boolean; createdb: boolean; createrole: boolean; replication: boolean; bypassrls: boolean; inherit: boolean; connectionLimit: number };
  memberOf: string[];
  owns: string[];
  schemas: Record<string, string[]>;
  database: string[];
  relations: Record<string, { kind: "table" | "view"; verbs: Record<string, UpdateGrant>; evidence: Record<string, string[]> }>;
  functions: Record<string, string[]>;
  sequences: Record<string, string[]>;
}
export interface RuntimeRoleManifest {
  contract: "kerneljson:runtime-role-manifest/v1";
  roles: Record<RuntimeRole, RoleManifest>;
  /** The section 27.9 exception, with its reason. The full inventory rule is the stage manifest of section 27.10. */
  securityDefinerTriggers: Record<string, string>;
}
export const MANIFEST_PATH = "infrastructure/database/runtime-role-manifest.json";
export function loadManifest(path?: string): RuntimeRoleManifest {
  const file = path ?? fileURLToPath(new URL(`../../../../${MANIFEST_PATH}`, import.meta.url));
  const manifest = JSON.parse(readFileSync(file, "utf8")) as RuntimeRoleManifest;
  if (manifest.contract !== "kerneljson:runtime-role-manifest/v1") throw new Error("Unknown runtime role manifest contract");
  return manifest;
}
export const policyName = (role: RuntimeRole, verb: string, lockOnly: boolean): string =>
  `${role}_${lockOnly ? "rowlock" : verb.toLowerCase()}`;

/** The complete expected capability set of one role, as flat comparable facts. */
export function expectedFacts(manifest: RuntimeRoleManifest, role: RuntimeRole): string[] {
  const r = manifest.roles[role];
  const facts: string[] = [];
  for (const [k, v] of Object.entries(r.attributes)) facts.push(`attribute:${k}=${String(v)}`);
  for (const m of r.memberOf) facts.push(`membership:${m}`);
  for (const o of r.owns) facts.push(`owns:${o}`);
  for (const [schema, privs] of Object.entries(r.schemas)) for (const p of privs) facts.push(`schema:${schema}:${p}`);
  for (const p of r.database) facts.push(`database:${p}`);
  for (const [object, rel] of Object.entries(r.relations)) {
    for (const [verb, grant] of Object.entries(rel.verbs)) {
      const lockOnly = typeof grant === "object" && !Array.isArray(grant);
      if (verb === "UPDATE" && grant !== true) {
        const columns = lockOnly ? [(grant as { column: string }).column] : (grant as string[]);
        for (const c of columns) facts.push(`column:${object}.${c}:UPDATE`);
      } else facts.push(`relation:${object}:${verb}`);
      if (rel.kind === "table")
        facts.push(
          `policy:${object}:${policyName(role, verb, lockOnly)}:${verb}:` +
            (verb === "INSERT" ? "using=-:check=true" : verb === "UPDATE" ? `using=true:check=${lockOnly ? "false" : "true"}` : "using=true:check=-"),
        );
    }
  }
  for (const fn of Object.keys(r.functions)) facts.push(`function:${fn}:EXECUTE`);
  for (const [seq, privs] of Object.entries(r.sequences)) for (const p of privs) facts.push(`sequence:${seq}:${p}`);
  return [...new Set(facts)].sort();
}

/** Section 27.10.2: the one exact predicate for schemas outside the catalogue comparisons. */
const GOVERNED = (column: string): string => `not ${excludedSchemaSql(column)}`;
/** The complete actual capability set of one role, read from the catalogues. Effective privileges, PUBLIC included. */
export async function actualFacts(db: Db, role: RuntimeRole): Promise<string[]> {
  const facts: string[] = [];
  const q = async <T extends Record<string, unknown>>(sql: string): Promise<T[]> => (await db.query<T>(sql, [role])).rows;
  for (const a of await q<Record<string, unknown>>(
    `select rolcanlogin as login, rolsuper as superuser, rolcreatedb as createdb, rolcreaterole as createrole,
            rolreplication as replication, rolbypassrls as bypassrls, rolinherit as inherit, rolconnlimit as "connectionLimit"
       from pg_roles where rolname = $1`,
  ))
    for (const [k, v] of Object.entries(a)) facts.push(`attribute:${k}=${String(v)}`);
  for (const m of await q<{ other: string }>(
    `select case when m.member = r.oid then m.roleid::regrole::text else 'member:' || m.member::regrole::text end as other
       from pg_auth_members m join pg_roles r on r.rolname = $1 where m.member = r.oid or m.roleid = r.oid`,
  ))
    facts.push(`membership:${m.other}`);
  for (const o of await q<{ what: string }>(
    `select 'relation ' || c.oid::regclass::text as what from pg_class c join pg_roles r on r.oid = c.relowner where r.rolname = $1
      union all select 'function ' || p.oid::regprocedure::text from pg_proc p join pg_roles r on r.oid = p.proowner where r.rolname = $1
      union all select 'schema ' || n.nspname from pg_namespace n join pg_roles r on r.oid = n.nspowner where r.rolname = $1
      union all select 'type ' || t.oid::regtype::text from pg_type t join pg_roles r on r.oid = t.typowner where r.rolname = $1
      union all select 'database ' || d.datname from pg_database d join pg_roles r on r.oid = d.datdba where r.rolname = $1`,
  ))
    facts.push(`owns:${o.what}`);
  for (const s of await q<{ nspname: string; p: string }>(
    `select n.nspname, p from pg_namespace n, unnest(array['USAGE','CREATE']) p
      where ${GOVERNED("n.nspname")} and has_schema_privilege($1, n.oid, p)`,
  ))
    facts.push(`schema:${s.nspname}:${s.p}`);
  for (const d of await q<{ p: string }>(
    `select p from unnest(array['CONNECT','CREATE','TEMPORARY']) p where has_database_privilege($1, current_database(), p)`,
  ))
    facts.push(`database:${d.p}`);
  for (const t of await q<{ name: string; p: string }>(
    `select n.nspname || '.' || c.relname as name, p
       from pg_class c join pg_namespace n on n.oid = c.relnamespace,
            unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
      where c.relkind in ('r','v','m','p','f') and ${GOVERNED("n.nspname")} and has_table_privilege($1, c.oid, p)`,
  ))
    facts.push(`relation:${t.name}:${t.p}`);
  for (const c of await q<{ name: string; p: string }>(
    `select n.nspname || '.' || c.relname || '.' || a.attname as name, p
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped,
            unnest(array['SELECT','INSERT','UPDATE','REFERENCES']) p
      where c.relkind in ('r','v','m','p','f') and ${GOVERNED("n.nspname")}
        and not has_table_privilege($1, c.oid, p) and has_column_privilege($1, c.oid, a.attnum, p)`,
  ))
    facts.push(`column:${c.name}:${c.p}`);
  for (const s of await q<{ name: string; p: string }>(
    `select n.nspname || '.' || c.relname as name, p
       from pg_class c join pg_namespace n on n.oid = c.relnamespace, unnest(array['USAGE','SELECT','UPDATE']) p
      where c.relkind = 'S' and ${GOVERNED("n.nspname")} and has_sequence_privilege($1, c.oid, p)`,
  ))
    facts.push(`sequence:${s.name}:${s.p}`);
  for (const f of await q<{ name: string }>(
    `select distinct n.nspname || '.' || p.proname as name
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where ${GOVERNED("n.nspname")} and p.prorettype <> 'trigger'::regtype and has_function_privilege($1, p.oid, 'EXECUTE')`,
  ))
    facts.push(`function:${f.name}:EXECUTE`);
  for (const p of await q<{ name: string; policyname: string; cmd: string; qual: string | null; with_check: string | null; permissive: string }>(
    `select schemaname || '.' || tablename as name, policyname, cmd, qual, with_check, permissive
       from pg_policies where $1 = any(roles) or 'public' = any(roles)`,
  ))
    facts.push(
      `policy:${p.name}:${p.policyname}:${p.cmd}:using=${p.qual ?? "-"}:check=${p.with_check ?? "-"}` +
        (p.permissive === "PERMISSIVE" ? "" : ":restrictive"),
    );
  return [...new Set(facts)].sort();
}

export interface CatalogueDiff { missing: string[]; extra: string[] }
/** EXPECTED - ACTUAL and ACTUAL - EXPECTED. Both must be empty. */
export function diffFacts(expected: readonly string[], actual: readonly string[]): CatalogueDiff {
  const e = new Set(expected), a = new Set(actual);
  return { missing: expected.filter((f) => !a.has(f)), extra: actual.filter((f) => !e.has(f)) };
}
export async function compareRoleToManifest(db: Db, manifest: RuntimeRoleManifest, role: RuntimeRole): Promise<CatalogueDiff> {
  return diffFacts(expectedFacts(manifest, role), await actualFacts(db, role));
}
