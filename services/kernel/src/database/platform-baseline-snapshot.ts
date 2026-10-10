import type pg from "pg";
import { expectedLedgerVersions, expectedLedgerHead, ledgerSetProblems } from "./ledger-contract.js";
export { expectedLedgerVersions, expectedLedgerHead, ledgerSetProblems } from "./ledger-contract.js";
import { CO_RESIDENT_SQL, coResidentProblems, hash, pinText, readCoResidentObserved, setDigest, parseDeclaration, type Declaration } from "./co-resident.js";
import {
  B1_MIGRATION_VERSION, INVENTORY_SQL, INVENTORY_SQL_SHA256, SEALED_DESIGN, baselineEligibilityProblems, baselineEntry, canonicalJson, sha256,
  sortEntries, type DefinerEntry, type PlatformBaseline, type StageManifest,
} from "./security-definers.js";

/**
 * KJ-P8 B1 - DEPLOYMENT AUTHORITY, not runtime (scripts/b1/runtime-graph.mjs DEPLOYMENT_MODULES). The sealed read-only
 * snapshot of the platform SECURITY DEFINER baseline (ADR-0023 revision 2.5, section 27.10.4), run by the deployment
 * owner against the target environment before the B1 migration. No runtime entry point imports this file.
 */
/**
 * The sealed snapshot procedure, read-only: one READ ONLY transaction with search_path = '' on the target before B1.
 * It refuses, and returns nothing, if B1 is already applied or an entry is ineligible. It never writes.
 * ADR-0023 revision 2.6 section 27.11.6 item 3: it also refuses unless the migration ledger exists, its head is the
 * final base migration of canonical main expected before B1, and kernel_private.stamp_binding_provenance() exists.
 * Fail-closed hardening of the same requirement: the ledger must record EXACTLY the base migration versions of the
 * stage manifest, no more and no fewer. A correct head over a ledger with missing rows (migrations applied manually
 * and never recorded) is refused, as is any extra row; the head check is therefore implied, never relied on alone.
 */
export async function snapshotPlatformBaseline(client: pg.Client | pg.PoolClient, environment: string, manifest: StageManifest): Promise<PlatformBaseline> {
  return (await snapshotArtifacts(client,environment,manifest)).baseline;
}

export async function snapshotArtifacts(client: pg.Client | pg.PoolClient, environment:string, manifest:StageManifest,
  mode: Pick<PlatformBaseline,"mode"|"run"> = {mode:"HOSTED_COMMITTED"}): Promise<{baseline:PlatformBaseline;declaration:Declaration}> {
  await client.query("begin transaction isolation level repeatable read read only");
  try {
    await client.query("set local search_path = ''");
    const tx = (await client.query<{ ro: string; sp: string }>(`select current_setting('transaction_read_only') as ro, current_setting('search_path') as sp`)).rows[0]!;
    const p = (await client.query<{ sid: string; db: string; v: string; at: string; who: string }>(
      `select (select system_identifier::text from pg_catalog.pg_control_system()) as sid, pg_catalog.current_database() as db,
              pg_catalog.version() as v, to_char(pg_catalog.clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at,
              current_user::text as who`,
    )).rows[0]!;
    const ledgerPresent = (await client.query<{ ok: boolean }>(`select pg_catalog.to_regclass('supabase_migrations.schema_migrations') is not null as ok`)).rows[0]!.ok;
    let head: string | null = null, b1Recorded = false, versions: string[] = [];
    if (ledgerPresent) {
      const l = (await client.query<{ head: string | null; b1: boolean }>(
        `select max(version)::text as head, bool_or(version::text = $1) as b1 from supabase_migrations.schema_migrations`, [B1_MIGRATION_VERSION])).rows[0]!;
      versions = (await client.query<{ v: string }>(`select version::text as v from supabase_migrations.schema_migrations order by 1`)).rows.map((r) => r.v);
      head = l.head;
      b1Recorded = l.b1 === true;
    }
    const stampRow = (await client.query<{ d: boolean }>(
      `select p.prosecdef as d from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'kernel_private' and p.proname = 'stamp_binding_provenance' and p.pronargs = 0`)).rows;
    const stamp = stampRow[0]?.d ?? false;
    if (tx.ro !== "on" || (tx.sp !== '""' && tx.sp !== "")) throw new Error(`snapshot transaction was not READ ONLY with an empty search_path (${tx.ro}, ${tx.sp})`);
    if (b1Recorded || stamp) throw new Error("PLATFORM_BASELINE_REFUSED: B1 is already applied to this database; a baseline must be taken before B1");
    if (!ledgerPresent) throw new Error("PLATFORM_BASELINE_REFUSED: the migration ledger supabase_migrations.schema_migrations does not exist");
    const expectedHead = expectedLedgerHead(manifest);
    if (head !== expectedHead) throw new Error(`PLATFORM_BASELINE_REFUSED: the migration ledger head is ${String(head)}, not ${expectedHead}, the final base migration before B1`);
    const set = ledgerSetProblems(versions, expectedLedgerVersions(manifest));
    if (set) throw new Error(`PLATFORM_BASELINE_REFUSED: ${set}`);
    if (stampRow.length !== 1) throw new Error("PLATFORM_BASELINE_REFUSED: kernel_private.stamp_binding_provenance() does not exist");
    // 27.12.6: an entry is written only for an object equal to a sealed pin; anything else in the two KernelJSON schemas
    // that is a definer, returns event_trigger or carries an event trigger, or the pinned name anywhere, refuses.
    const coResident=await readCoResidentObserved(client),notAdmitted=coResidentProblems(coResident);
    if (notAdmitted.length) throw new Error(`PLATFORM_BASELINE_REFUSED: co-resident surface not admitted: ${notAdmitted.join("; ")}`);
    const entries = sortEntries((await client.query<DefinerEntry>(INVENTORY_SQL)).rows)
      .filter(e=>!(e.schema==="public" && e.name==="rls_auto_enable" && e.args.length===0)).map(baselineEntry);
    const ineligible = baselineEligibilityProblems(entries, manifest);
    if (ineligible.length) throw new Error(`PLATFORM_BASELINE_REFUSED: ${ineligible.join("; ")}`);
    const baseline:PlatformBaseline = {
      ...mode,
      contract: "kerneljson:security-definer-platform-baseline/v1",
      design: SEALED_DESIGN,
      environment,
      provenance: {
        systemIdentifier: p.sid, database: p.db, serverVersion: p.v, snapshotAt: p.at, snapshotUser: p.who,
        transaction: { readOnly: true, searchPath: tx.sp },
        migrationLedger: { table: "supabase_migrations.schema_migrations", present: ledgerPresent, head, b1Recorded, versions },
        stampSecurityDefiner: stamp,
        querySha256: INVENTORY_SQL_SHA256,
      },
      entries,
      entriesSha256: sha256(canonicalJson(entries)),
    };
    const declaration=parseDeclaration(JSON.stringify({kind:"kerneljson:co-resident-platform-exceptions/v1",...mode,environment,
      provenance:{...baseline.provenance,querySha256:hash(CO_RESIDENT_SQL)},pinsSha256:hash(pinText),
      setSha256:setDigest(coResident),entries:coResident}));
    await client.query("commit");
    return {baseline,declaration};
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

/**
 * ADR-0023 revision 2.6 section 27.11.6 item 2: the connection-string file must hold exactly one explicit PostgreSQL URL.
 * An empty, whitespace-only, NUL-containing or multi-line file is refused, and so is a URL without an explicit host,
 * user or database, so the client can never fall back to PG* environment variables or a local default. The messages
 * are fixed and never contain the file's content.
 */
export function parseConnectionFile(raw: string): pg.ClientConfig {
  const text = raw.replace(/^\uFEFF/, "");
  if (text.includes("\0")) throw new Error("CONNECTION_FILE_REFUSED: the file contains a NUL byte");
  const value = text.replace(/\r?\n$/, "");
  if (value.trim() === "") throw new Error("CONNECTION_FILE_REFUSED: the file is empty or whitespace only");
  if (/[\r\n]/.test(value)) throw new Error("CONNECTION_FILE_REFUSED: the file holds more than one line");
  if (value !== value.trim()) throw new Error("CONNECTION_FILE_REFUSED: the URL has leading or trailing whitespace");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("CONNECTION_FILE_REFUSED: the file does not hold a URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("CONNECTION_FILE_REFUSED: not a postgres URL");
  if (!url.hostname || !url.username || url.pathname.length < 2)
    throw new Error("CONNECTION_FILE_REFUSED: the URL must name the host, the user and the database explicitly");
  return { connectionString: value };
}

/** Remove every PG* variable from an environment so that libpq-style defaults cannot supply a missing parameter. */
export function scrubPgEnvironment(env: NodeJS.ProcessEnv): string[] {
  const removed = Object.keys(env).filter((k) => /^PG[A-Z_]*$/.test(k)).sort();
  for (const k of removed) delete env[k];
  return removed;
}
