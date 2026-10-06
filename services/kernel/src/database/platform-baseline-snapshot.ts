import type pg from "pg";
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
 */
export async function snapshotPlatformBaseline(client: pg.Client | pg.PoolClient, environment: string, manifest: StageManifest): Promise<PlatformBaseline> {
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
    let head: string | null = null, b1Recorded = false;
    if (ledgerPresent) {
      const l = (await client.query<{ head: string | null; b1: boolean }>(
        `select max(version)::text as head, bool_or(version::text = $1) as b1 from supabase_migrations.schema_migrations`, [B1_MIGRATION_VERSION])).rows[0]!;
      head = l.head;
      b1Recorded = l.b1 === true;
    }
    const stamp = (await client.query<{ d: boolean | null }>(
      `select p.prosecdef as d from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'kernel_private' and p.proname = 'stamp_binding_provenance' and p.pronargs = 0`)).rows[0]?.d ?? false;
    const entries = sortEntries((await client.query<DefinerEntry>(INVENTORY_SQL)).rows).map(baselineEntry);
    await client.query("commit");
    if (tx.ro !== "on" || (tx.sp !== '""' && tx.sp !== "")) throw new Error(`snapshot transaction was not READ ONLY with an empty search_path (${tx.ro}, ${tx.sp})`);
    if (b1Recorded || stamp) throw new Error("PLATFORM_BASELINE_REFUSED: B1 is already applied to this database; a baseline must be taken before B1");
    const ineligible = baselineEligibilityProblems(entries, manifest);
    if (ineligible.length) throw new Error(`PLATFORM_BASELINE_REFUSED: ${ineligible.join("; ")}`);
    return {
      contract: "kerneljson:security-definer-platform-baseline/v1",
      design: SEALED_DESIGN,
      environment,
      provenance: {
        systemIdentifier: p.sid, database: p.db, serverVersion: p.v, snapshotAt: p.at, snapshotUser: p.who,
        transaction: { readOnly: true, searchPath: tx.sp },
        migrationLedger: { table: "supabase_migrations.schema_migrations", present: ledgerPresent, head, b1Recorded },
        stampSecurityDefiner: stamp,
        querySha256: INVENTORY_SQL_SHA256,
      },
      entries,
      entriesSha256: sha256(canonicalJson(entries)),
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

