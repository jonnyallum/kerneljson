import type pg from "pg";
import { coResidentProblems, readCoResidentObserved, setDigest, type Declaration } from "../../services/kernel/src/database/co-resident.js";
import { artifactPairProblems, baselineProblems, compareDefiners, definerInventoryProblems,
  expectedDefiners, readDefiners, readStampFacts, stampProblems, type PlatformBaseline, type StageManifest } from "../../services/kernel/src/database/security-definers.js";
import { expectedLedgerVersions, ledgerSetProblems } from "../../services/kernel/src/database/ledger-contract.js";
import { compareRoleToManifest, FUNCTION_IDENTITY_SQL, RUNTIME_ROLES, type RuntimeRoleManifest } from "../../services/kernel/src/database/runtime-roles.js";

type Client=pg.Client|pg.PoolClient;
/** Every gate refusal names the check that failed, so a negative case can require the right rule, not any error. */
const fail=(check:string,problems:readonly string[])=>{if(problems.length) throw Error(`LEDGER_GATE_REFUSED: ${check}: ${problems.join("; ")}`);};
export async function ledgerShape(client:Client,prefix="LEDGER_GATE_REFUSED"):Promise<void>{
  const present=(await client.query("select pg_catalog.to_regclass('supabase_migrations.schema_migrations') is not null as present")).rows[0].present;
  if(!present) throw Error(`${prefix}: ledger shape: ledger missing`);
  const columns=(await client.query(`select a.attname as name,t.typname as type,a.attnotnull as "notNull"
    from pg_catalog.pg_attribute a join pg_catalog.pg_type t on t.oid=a.atttypid
    where a.attrelid='supabase_migrations.schema_migrations'::pg_catalog.regclass and a.attnum>0 and not a.attisdropped order by a.attnum`)).rows;
  if(JSON.stringify(columns)!==JSON.stringify([{name:"version",type:"text",notNull:true},
    {name:"statements",type:"_text",notNull:false},{name:"name",type:"text",notNull:false}])) throw Error(`${prefix}: ledger shape: column contract differs`);
  const keys=(await client.query(`select array(select a.attname::text from unnest(c.conkey) with ordinality k(attnum,i)
    join pg_catalog.pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum order by k.i) as columns
    from pg_catalog.pg_constraint c where c.conrelid='supabase_migrations.schema_migrations'::pg_catalog.regclass and c.contype='p'`)).rows;
  if(JSON.stringify(keys)!==JSON.stringify([{columns:["version"]}])) throw Error(`${prefix}: ledger shape: primary key contract differs`);
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
/** ACL-A evidence: every member of the enumerated cleanup set C, with its ACL items, read without a search_path. */
export const CLEANUP_SET_SQL=`select ${FUNCTION_IDENTITY_SQL("p","n")} as identity,p.oid::pg_catalog.text as oid,
  pg_catalog.pg_get_userbyid(p.proowner) as owner,p.proacl::pg_catalog.text[] as acl
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where n.nspname in ('public','kernel_private') and p.prokind in ('f','a','w')
    and p.prorettype <> 'pg_catalog.event_trigger'::pg_catalog.regtype
  order by p.oid::pg_catalog.regprocedure::pg_catalog.text collate "C"`;
export interface CleanupMember {identity:string;oid:string;owner:string;acl:string[]|null}
export interface GateOptions {skipInventory?:boolean}
/**
 * 27.12.11 step 8, read-only. The inventory part (27.10 over every governed schema, E1 to E3 and name uniqueness, the
 * live co-resident set) is skipped only by the registered hook S6-gate-inventory-skip, which makes the run a negative
 * fixture. The target identity, ledger and stamp parts are never skipped.
 */
export async function preLedgerGate(client:Client,manifest:StageManifest,baseline:PlatformBaseline,declaration:Declaration,options:GateOptions={}){
  fail("artifacts",[...baselineProblems(baseline,manifest),...artifactPairProblems(baseline,declaration)]);
  return readOnly(client,async()=>{
    const live=(await client.query<{sid:string;db:string}>(
      "select (select system_identifier::text from pg_catalog.pg_control_system()) as sid,pg_catalog.current_database() as db")).rows[0]!;
    fail("target identity",[
      ...(live.sid!==declaration.provenance.systemIdentifier?[`live system identifier ${live.sid} is not the declaration's ${declaration.provenance.systemIdentifier}`]:[]),
      ...(live.db!==declaration.provenance.database?[`live database ${live.db} is not the declaration's ${declaration.provenance.database}`]:[])]);
    await ledgerShape(client);
    const versions=await readVersions(client),problem=ledgerSetProblems(versions,expectedLedgerVersions(manifest));
    fail("ledger set",problem?[problem]:[]);
    fail("artifact ledger",[baseline,declaration].some(a=>JSON.stringify(a.provenance.migrationLedger.versions)!==JSON.stringify(versions))?
      ["the artifacts' ledger versions differ from the live ledger"]:[]);
    const stamp=(await client.query(`select p.prosecdef from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname='kernel_private' and p.proname='stamp_binding_provenance' and p.pronargs=0`)).rows;
    fail("stamp",stamp.length!==1 || stamp[0].prosecdef!==false?["stamp absent or B1 already applied"]:[]);
    fail("stamp",stampProblems(await readStampFacts(client),manifest));
    const cleanup=(await client.query<CleanupMember>(CLEANUP_SET_SQL)).rows;
    if(options.skipInventory) return {versions,inventory:null,cleanup};
    const coResident=await readCoResidentObserved(client),coProblems=coResidentProblems(coResident);
    fail("co-resident surface",coProblems);
    fail("co-resident surface",setDigest(coResident)!==declaration.setSha256?["live co-resident set differs from the declaration"]:[]);
    const expected=expectedDefiners(manifest,baseline,"",manifest.declaredStage,declaration).filter(e=>e.source!=="kernel");
    const inventory=compareDefiners(await readDefiners(client),expected);
    fail("definer inventory",[...inventory.extra.map(k=>`extra ${k}`),...inventory.missing.map(k=>`missing ${k}`),...inventory.mismatched]);
    return {versions,inventory,cleanup};
  });
}

/**
 * ACL-A, OBSERVED rather than assumed: the frozen pair (`revoke execute ... from public`, then `revoke all ... from
 * kj_worker, kj_door`) applied to each member's pre-B1 ACL, then the runtime manifest's EXECUTE grants, must equal
 * the post-B1 ACL. A null ACL first materialises PostgreSQL's default for functions: PUBLIC and the owner.
 */
export function frozenPairAcl(member:CleanupMember,granted:readonly string[]):string[]{
  const items=member.acl ?? [`=X/${member.owner}`,`${member.owner}=X/${member.owner}`];
  const kept=items.flatMap(item=>{
    const match=/^("?)([^=]*)\1=([^/]*)\/(.+)$/.exec(item);
    if(!match) throw Error(`ACL item not understood: ${item}`);
    const grantee=match[2]!,privileges=match[3]!;
    if(grantee==="kj_worker" || grantee==="kj_door") return [];
    if(grantee==="") {const rest=privileges.replace("X","");return rest?[`=${rest}/${match[4]}`]:[];}
    return [item];
  });
  for(const role of granted) kept.push(`${role}=X/${member.owner}`);
  return [...kept].sort();
}
export async function postLedgerGate(client:Client,manifest:StageManifest,runtime:RuntimeRoleManifest,
  baseline:PlatformBaseline,declaration:Declaration,expectedStatementsDigest:string,cleanupBefore:readonly CleanupMember[]|null){
  if(!/^[0-9a-f]{64}$/.test(expectedStatementsDigest)) throw Error("POST_LEDGER_REFUSED: missing frozen statements digest");
  const refuse=(check:string,problems:readonly string[])=>{if(problems.length) throw Error(`POST_LEDGER_REFUSED: ${check}: ${problems.join("; ")}`);};
  return readOnly(client,async()=>{
    await ledgerShape(client,"POST_LEDGER_REFUSED");
    const versions=await readVersions(client),problem=ledgerSetProblems(versions,[...expectedLedgerVersions(manifest),"20261002090000"]);
    refuse("ledger set",problem?[problem]:[]);
    const rows=(await client.query(`select version,name,encode(sha256(convert_to(array_to_json(statements)::text,'UTF8')),'hex') as digest
      from supabase_migrations.schema_migrations where version='20261002090000'`)).rows;
    refuse("B1 ledger row",rows.length!==1 || rows[0].name!=="runtime_least_privilege_roles" || rows[0].digest!==expectedStatementsDigest?
      ["B1 row differs from the frozen engine contract"]:[]);
    refuse("inventory",await definerInventoryProblems(client,manifest,baseline,declaration));
    const live=await readCoResidentObserved(client);
    refuse("co-resident surface",JSON.stringify(live)!==JSON.stringify(declaration.entries)?["live co-resident entries differ from the declaration field by field"]:[]);
    for(const role of RUNTIME_ROLES){
      const diff=await compareRoleToManifest(client,runtime,role);
      refuse(`catalogue equality ${role}`,[...diff.extra.map(f=>`extra ${f}`),...diff.missing.map(f=>`missing ${f}`)]);
    }
    let aclEquivalence:{members:number}|null=null;
    if(cleanupBefore){
      const after=new Map((await client.query<CleanupMember>(CLEANUP_SET_SQL)).rows.map(m=>[m.oid,m]));
      const problems:string[]=[];
      if(after.size!==cleanupBefore.length) problems.push(`cleanup set changed size: ${cleanupBefore.length} before, ${after.size} after`);
      for(const member of cleanupBefore){
        const now=after.get(member.oid);
        if(!now){problems.push(`${member.identity} vanished`);continue;}
        const granted=RUNTIME_ROLES.filter(role=>Object.hasOwn(runtime.roles[role]?.functions ?? {},member.identity));
        const want=frozenPairAcl(member,granted),have=[...(now.acl ?? [])].sort();
        if(JSON.stringify(want)!==JSON.stringify(have)) problems.push(`${member.identity}: ${JSON.stringify(have)}, frozen pair gives ${JSON.stringify(want)}`);
      }
      refuse("ACL cleanup equivalence",problems);
      aclEquivalence={members:cleanupBefore.length};
    }
    return {versions,statementsDigest:rows[0].digest as string,aclEquivalence};
  });
}
