import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { strictJson } from "../../services/kernel/src/database/strict-json.js";
import { STAGE_MANIFEST_PATH } from "../../services/kernel/src/database/security-definers.js";
import { FUNCTION_INVENTORY_PATH, readFunctionInventory, renderFunctionInventory } from "./function-inventory.js";

/**
 * Generator of infrastructure/database/b1-function-inventory.json (E2 experiment, draft A10.7; not sealed). It starts
 * one disposable container of the pinned engine image (infrastructure/database/b1-engine-pins.json "image", the stage T
 * digest), applies the 22 sealed base migrations of the stage manifest, each in one transaction, reads the catalogue
 * under the shared predicate (scripts/b1/function-inventory.ts) and writes the inventory, or with --check refuses a
 * committed file that differs byte for byte. The container is labelled, never published beyond 127.0.0.1, keeps its
 * data on tmpfs, and is removed by its own id. No other container, volume or network is touched.
 *
 * B1 is NOT applied here. B1 refuses to run without the governed runner's run-bound declaration settings (P3 step 1),
 * and 27.12.15 allows no B1 application outside the governed ephemeral entry point. B1 creates and drops no function
 * (CON-32), so the base chain's set is the post-B1 set; that claim is not assumed but checked in every governed run:
 * the negative test (regression-probes and its discover twin, on the B1-applied plan database of the same pinned
 * image) fails unless the live set under the same predicate equals this inventory. The lane A test
 * (tests/b1-relation-inventory.integration.test.ts) regenerates the same bytes from the base chain in every CI run.
 * This is a developer and review tool, not a CI job.
 */
const B1="20261002090000_runtime_least_privilege_roles.sql";
const check=process.argv.includes("--check");
const pins=strictJson(readFileSync("infrastructure/database/b1-engine-pins.json","utf8")) as {image:string;serverVersion:string};
const stage=strictJson(readFileSync(STAGE_MANIFEST_PATH,"utf8")) as {baseMigrations:{file:string}[]};
const base=stage.baseMigrations.map(m=>m.file).sort();
if(!/^postgres@sha256:[0-9a-f]{64}$/.test(pins.image)) throw Error("engine image is not pinned by digest");
if(base.length!==22 || new Set(base).size!==22 || base.some(f=>f>=B1)) throw Error("invalid sealed base set");
const docker=(...args:string[])=>{
  const r=spawnSync("docker",args,{encoding:"utf8"});
  if(r.status!==0) throw Error(`docker ${args[0]}: ${(r.stderr ?? "").slice(0,400)}`);
  return r.stdout.trim();
};
const name=`kj-b1-fninv-${randomBytes(6).toString("hex")}`;
const id=docker("run","-d","--rm","--name",name,"--label","kj.b1.function-inventory=1","--tmpfs","/var/lib/postgresql/data:rw",
  "-e","POSTGRES_HOST_AUTH_METHOD=trust","-p","127.0.0.1::5432",pins.image);
let exitCode=0;
try{
  const port=docker("port",id,"5432/tcp").split("\n")[0]!.split(":").pop()!;
  const url=`postgresql://postgres@127.0.0.1:${port}/postgres`;
  let pool:pg.Pool|undefined;
  for(let i=0;i<120;i++){
    // A fresh pinned image runs a temporary initdb server first; wait for the final server (two consecutive successes).
    const p=new pg.Pool({connectionString:url,max:2});p.on("error",()=>{});
    try{await p.query("select 1");await new Promise(r=>setTimeout(r,1500));await p.query("select 1");pool=p;break;}
    catch{await p.end().catch(()=>undefined);await new Promise(r=>setTimeout(r,1000));}
  }
  if(!pool) throw Error("pinned engine did not become ready");
  const version=(await pool.query<{v:string}>("select version() as v")).rows[0]!.v;
  if(version!==pins.serverVersion) throw Error(`server version differs from the pin: ${version}`);
  // The platform roles the base chain grants to, as the base harness creates them (tests/support/local.ts migrate()).
  await pool.query(`do $$ begin
    if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
    if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
  end $$`);
  for(const file of base){
    const db=await pool.connect();
    try{await db.query("begin");await db.query(readFileSync(`supabase/migrations/${file}`,"utf8"));await db.query("commit");}
    catch(error){await db.query("rollback").catch(()=>undefined);throw Error(`${file}: ${error instanceof Error?error.message:String(error)}`,{cause:error});}
    finally{db.release();}
  }
  const text=renderFunctionInventory(await readFunctionInventory(pool));
  await pool.end();
  if(check){
    let committed="";try{committed=readFileSync(FUNCTION_INVENTORY_PATH,"utf8");}catch{/* missing */}
    if(committed!==text){process.stderr.write(`${FUNCTION_INVENTORY_PATH} differs from the pinned engine's catalogue (base chain)\n`);exitCode=1;}
    else process.stdout.write(`${FUNCTION_INVENTORY_PATH} matches (${pins.image}, ${version})\n`);
  } else {writeFileSync(FUNCTION_INVENTORY_PATH,text);process.stdout.write(`wrote ${FUNCTION_INVENTORY_PATH}\n`);}
}finally{spawnSync("docker",["rm","-f",id],{encoding:"utf8"});}
process.exit(exitCode);
