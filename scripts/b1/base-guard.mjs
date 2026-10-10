import { readFileSync } from "node:fs";
const manifest=JSON.parse(readFileSync(new URL("../../infrastructure/database/security-definer-stage-manifest.json",import.meta.url),"utf8"));
const baseFiles=manifest.baseMigrations.map(m=>m.file);
const B1="20261002090000_runtime_least_privilege_roles.sql";
export function assertBaseEnvironment(env=process.env){
  if(env.KJ_RUNTIME_ROLES!=="base" || ["KJ_B1_STAGE_T","KJ_B1_RUN_TOKEN","KJ_B1_RUN_DIR","KJ_B1_RUN_HEADER"].some(k=>env[k]!==undefined))
    throw Error("BASE_REFUSED: base mode without an active runner stage is required");
}
export function baseMigrationFiles(files,options={}){
  if(Object.keys(options).some(k=>k!=="only" && k!=="exclude")) throw Error("BASE_REFUSED: unknown migration option");
  if(baseFiles.length!==22 || new Set(baseFiles).size!==22 || baseFiles.some(f=>!/^2026[0-9]{10}_[a-z0-9_]+\.sql$/.test(f) || f>=B1))
    throw Error("BASE_REFUSED: invalid sealed base set");
  if(new Set(files).size!==files.length || files.some(f=>f!==B1 && !baseFiles.includes(f)) || baseFiles.some(f=>!files.includes(f)))
    throw Error("BASE_REFUSED: migration directory differs from the base set plus B1");
  if(options.only?.some(f=>!baseFiles.includes(f)) || options.exclude?.some(f=>f!==B1 && !baseFiles.includes(f)))
    throw Error("BASE_REFUSED: B1 or unknown migration requested");
  return baseFiles.filter(f=>!options.exclude?.includes(f) && (!options.only || options.only.includes(f))).sort();
}
export async function assertBaseTarget(db,env=process.env){
  assertBaseEnvironment(env);
  const row=(await db.query(`select current_setting('cluster_name') as cluster,
    exists(select 1 from pg_roles where rolname in ('kj_worker','kj_door')) as runtime,
    to_regclass('supabase_migrations.schema_migrations') is not null as ledger`)).rows[0];
  if(!row || row.cluster.startsWith("kj-eph-") || row.runtime) throw Error("BASE_REFUSED: runner cluster or runtime roles present");
  if(row.ledger && (await db.query("select 1 from supabase_migrations.schema_migrations where version='20261002090000'")).rows.length)
    throw Error("BASE_REFUSED: B1 is already recorded");
}
