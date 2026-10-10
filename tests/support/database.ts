import { readFileSync } from "node:fs";
import pg from "pg";
import { z } from "zod";
import { hash, HASH, parseDeclaration, RunBinding, type Declaration } from "../../services/kernel/src/database/co-resident.js";
import { BaselineSchema, artifactPairProblems, type PlatformBaseline } from "../../services/kernel/src/database/security-definers.js";
import { strictJson } from "../../services/kernel/src/database/strict-json.js";

const Copy=z.strictObject({path:z.string().min(1),sha256:HASH});
const Context=z.strictObject({kind:z.literal("kerneljson:b1-consumer-context/v1"),runId:z.string().regex(/^[0-9a-f]{32}$/),
  databases:z.array(z.strictObject({name:z.string().regex(/^kj_[a-z0-9_]+$/),sequence:z.number().int().positive(),
    ownerUrl:z.string().url(),networkOwnerUrl:z.string().url(),run:RunBinding,baseline:Copy,declaration:Copy})).min(1)});
export interface TestDatabase {pool:pg.Pool;url:string;close:()=>Promise<void>}
type Factory=(name:string)=>Promise<TestDatabase>;
let baseFactory:Factory|undefined;
const stageT=process.env.KJ_B1_STAGE_T==="1";
export function installBaseDatabaseFactory(factory:Factory):void{
  if(stageT || process.env.KJ_RUNTIME_ROLES!=="base" || baseFactory) throw Error("DATABASE_REFUSED: base adapter is unavailable");
  baseFactory=factory;
}
function context(){
  if(!stageT || !["enforce","discover"].includes(process.env.KJ_RUNTIME_ROLES ?? "")) throw Error("DATABASE_REFUSED: no active stage T");
  const value=Context.parse(strictJson(process.env.KJ_B1_CONSUMER_CONTEXT ?? ""));
  if(new Set(value.databases.map(d=>d.name)).size!==value.databases.length || new Set(value.databases.map(d=>d.sequence)).size!==value.databases.length)
    throw Error("DATABASE_REFUSED: duplicate planned database");
  for(const db of value.databases){
    if(db.run.runId!==value.runId || db.run.application!==db.sequence) throw Error("DATABASE_REFUSED: run binding differs");
    for(const [text,host] of [[db.ownerUrl,"127.0.0.1"],[db.networkOwnerUrl,"kj-eph-db"]] as const){
      const url=new URL(text);
      if(url.protocol!=="postgresql:" || url.hostname!==host || decodeURIComponent(url.username)!=="postgres" || url.password ||
        !url.port || decodeURIComponent(url.pathname)!==`/${db.name}` || url.hash ||
        [...url.searchParams].some(([key,val])=>key!=="sslmode" || val!=="disable")) throw Error("DATABASE_REFUSED: derived address differs");
    }
  }
  return value;
}
function planned(name:string){
  const value=context(),entry=value.databases.find(d=>d.name===name);
  if(!entry) throw Error("DATABASE_REFUSED: database is not in this suite plan");
  return entry;
}
/**
 * ADR-0023 27.12.15 suite regression-gated: the six formerly KJ_TEST_PG_URL-gated files share their plan database
 * kj_gated inside stage T, as the frozen CI shared kj_gated. Outside stage T the explicit KJ_TEST_PG_URL still gates
 * them (the pinned collection sets it to a placeholder that is never connected to).
 */
export function gatedDatabaseUrl():string|undefined{
  return stageT?planned("kj_gated").ownerUrl:process.env["KJ_TEST_PG_URL"];
}
/** The caller names its committed plan database literally. No consumer creates or drops a database. */
export async function testDatabase(name:string):Promise<TestDatabase>{
  if(!stageT){
    if(!baseFactory) throw Error("DATABASE_REFUSED: no registered base adapter");
    return baseFactory(name);
  }
  const entry=planned(name),pool=new pg.Pool({connectionString:entry.ownerUrl,max:4});
  return {pool,url:entry.ownerUrl,close:()=>pool.end()};
}
export function testDatabaseArtifacts(name:string):{baseline:PlatformBaseline;declaration:Declaration}{
  const entry=planned(name);
  const read=(copy:z.infer<typeof Copy>)=>{
    const bytes=readFileSync(copy.path);if(hash(bytes)!==copy.sha256) throw Error("DATABASE_REFUSED: authority copy hash differs");
    return bytes.toString("utf8");
  };
  const baseline=BaselineSchema.parse(strictJson(read(entry.baseline))),declaration=parseDeclaration(read(entry.declaration));
  if(baseline.mode!=="EPHEMERAL_RUN_BOUND" || declaration.mode!=="EPHEMERAL_RUN_BOUND" ||
    JSON.stringify(baseline.run)!==JSON.stringify(entry.run) || JSON.stringify(declaration.run)!==JSON.stringify(entry.run) ||
    baseline.provenance.database!==name || artifactPairProblems(baseline,declaration).length)
    throw Error("DATABASE_REFUSED: authority copies are not bound to this application");
  return {baseline,declaration};
}
