import type pg from "pg";
import { readCoResident, setDigest, type Declaration } from "../../services/kernel/src/database/co-resident.js";
import { artifactPairProblems, baselineBindingProblems, baselineProblems, compareDefiners, definerInventoryProblems,
  expectedDefiners, readDefiners, readStampFacts, stampProblems, type PlatformBaseline, type StageManifest } from "../../services/kernel/src/database/security-definers.js";
import { expectedLedgerVersions, ledgerSetProblems } from "../../services/kernel/src/database/ledger-contract.js";
import { compareRoleToManifest, RUNTIME_ROLES, type RuntimeRoleManifest } from "../../services/kernel/src/database/runtime-roles.js";

type Client=pg.Client|pg.PoolClient;
const fail=(problems:string[])=>{if(problems.length) throw Error(`LEDGER_GATE_REFUSED: ${problems.join("; ")}`);};
export async function ledgerShape(client:Client):Promise<void>{
  const present=(await client.query("select pg_catalog.to_regclass('supabase_migrations.schema_migrations') is not null as present")).rows[0].present;
  if(!present) throw Error("LEDGER_GATE_REFUSED: ledger missing");
  const columns=(await client.query(`select a.attname as name,t.typname as type,a.attnotnull as "notNull"
    from pg_catalog.pg_attribute a join pg_catalog.pg_type t on t.oid=a.atttypid
    where a.attrelid='supabase_migrations.schema_migrations'::pg_catalog.regclass and a.attnum>0 and not a.attisdropped order by a.attnum`)).rows;
  if(JSON.stringify(columns)!==JSON.stringify([{name:"version",type:"text",notNull:true},
    {name:"statements",type:"_text",notNull:false},{name:"name",type:"text",notNull:false}])) throw Error("LEDGER_GATE_REFUSED: column contract differs");
  const keys=(await client.query(`select array(select a.attname::text from unnest(c.conkey) with ordinality k(attnum,i)
    join pg_catalog.pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum order by k.i) as columns
    from pg_catalog.pg_constraint c where c.conrelid='supabase_migrations.schema_migrations'::pg_catalog.regclass and c.contype='p'`)).rows;
  if(JSON.stringify(keys)!==JSON.stringify([{columns:["version"]}])) throw Error(`LEDGER_GATE_REFUSED: primary key contract differs: ${JSON.stringify(keys)}`);
}
async function readVersions(client:Client):Promise<string[]>{
  return (await client.query<{version:string}>("select version from supabase_migrations.schema_migrations order by version collate \"C\" ")).rows.map(r=>r.version);
}
async function readOnly<T>(client:Client,operation:()=>Promise<T>):Promise<T>{
  await client.query("begin transaction isolation level repeatable read read only");
  try {
    await client.query("set local search_path = ''");
    const value=await operation();await client.query("commit");return value;
  }catch(error){await client.query("rollback").catch(()=>undefined);throw error;}
}
export async function preLedgerGate(client:Client,manifest:StageManifest,baseline:PlatformBaseline,declaration:Declaration){
  fail([...baselineProblems(baseline,manifest),...artifactPairProblems(baseline,declaration)]);
  return readOnly(client,async()=>{
    await ledgerShape(client);
    const versions=await readVersions(client),problem=ledgerSetProblems(versions,expectedLedgerVersions(manifest));
    if(problem) fail([problem]);
    for(const artifact of [baseline,declaration]) if(JSON.stringify(artifact.provenance.migrationLedger.versions)!==JSON.stringify(versions)) fail(["artifact ledger differs"]);
    fail(await baselineBindingProblems(client,baseline));
    const stamp=(await client.query(`select p.prosecdef from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname='kernel_private' and p.proname='stamp_binding_provenance' and p.pronargs=0`)).rows;
    if(stamp.length!==1 || stamp[0].prosecdef!==false) fail(["stamp absent or B1 already applied"]);
    fail(stampProblems(await readStampFacts(client),manifest));
    const coResident=await readCoResident(client);
    if(setDigest(coResident)!==declaration.setSha256) fail(["live co-resident set differs"]);
    const expected=expectedDefiners(manifest,baseline,"",manifest.declaredStage,declaration).filter(e=>e.source!=="kernel");
    const inventory=compareDefiners(await readDefiners(client),expected);
    fail([...inventory.extra,...inventory.missing,...inventory.mismatched]);
    return {versions,inventory};
  });
}
export async function postLedgerGate(client:Client,manifest:StageManifest,runtime:RuntimeRoleManifest,
  baseline:PlatformBaseline,declaration:Declaration,expectedStatementsDigest:string){
  if(!/^[0-9a-f]{64}$/.test(expectedStatementsDigest)) throw Error("POST_LEDGER_REFUSED: missing frozen statements digest");
  return readOnly(client,async()=>{
    await ledgerShape(client);
    const versions=await readVersions(client),problem=ledgerSetProblems(versions,[...expectedLedgerVersions(manifest),"20261002090000"]);
    if(problem) fail([problem]);
    const rows=(await client.query(`select version,name,encode(sha256(convert_to(array_to_json(statements)::text,'UTF8')),'hex') as digest
      from supabase_migrations.schema_migrations where version='20261002090000'`)).rows;
    if(rows.length!==1 || rows[0].name!=="runtime_least_privilege_roles" || rows[0].digest!==expectedStatementsDigest)
      throw Error("POST_LEDGER_REFUSED: B1 row differs from frozen engine contract");
    fail(await definerInventoryProblems(client,manifest,baseline,declaration));
    for(const role of RUNTIME_ROLES){
      const diff=await compareRoleToManifest(client,runtime,role);fail([...diff.extra,...diff.missing]);
    }
    return {versions,statementsDigest:rows[0].digest as string};
  });
}
