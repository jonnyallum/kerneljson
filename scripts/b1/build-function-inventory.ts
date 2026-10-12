import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
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
 *
 * Cleanup (E2-R1): the pool is closed and the container removed on every path, by the exact id `docker run` printed.
 * Removal counts as done only when `docker rm -f <id>` exits 0 with no spawn error or signal AND
 * `docker ps -a -q --no-trunc --filter id=<id>` then lists nothing. A cleanup failure makes the run fail; when the run
 * had already failed, both errors are reported, the original first (AggregateError).
 */
const B1="20261002090000_runtime_least_privilege_roles.sql";
/** One docker invocation's result, as spawnSync reports it. */
export interface DockerResult {status:number|null;signal:NodeJS.Signals|string|null;error?:Error|undefined;stdout:string;stderr:string}
/** The pool operations the generator uses. */
export type InventoryPool=Pick<pg.Pool,"query"|"connect"|"end"|"on">;
export interface InventoryDeps {
  docker:(args:readonly string[])=>DockerResult;
  pool:(url:string)=>InventoryPool;
  readFile:(path:string)=>string;
  writeFile:(path:string,text:string)=>void;
  stdout:(text:string)=>void;
  stderr:(text:string)=>void;
  sleep:(ms:number)=>Promise<void>;
  name:()=>string;
}
export const realInventoryDeps:InventoryDeps={
  docker:(args)=>{const r=spawnSync("docker",args,{encoding:"utf8"});return {status:r.status,signal:r.signal,error:r.error,stdout:r.stdout ?? "",stderr:r.stderr ?? ""};},
  pool:(url)=>new pg.Pool({connectionString:url,max:2}),
  readFile:(path)=>readFileSync(path,"utf8"),
  writeFile:(path,text)=>writeFileSync(path,text),
  stdout:(text)=>{process.stdout.write(text);},
  stderr:(text)=>{process.stderr.write(text);},
  sleep:(ms)=>new Promise(r=>setTimeout(r,ms)),
  name:()=>`kj-b1-fninv-${randomBytes(6).toString("hex")}`,
};
const failed=(r:DockerResult)=>r.error!==undefined || r.signal!==null || r.status!==0;
const describe=(r:DockerResult)=>r.error ? `spawn error ${r.error.message}` : r.signal!==null ? `signal ${r.signal}` : `exit ${String(r.status)}: ${r.stderr.slice(0,400)}`;
const asError=(e:unknown)=>e instanceof Error ? e : Error(String(e));
/** Removes exactly this container and verifies it is gone; returns the failure, or null. */
export function removeContainer(deps:Pick<InventoryDeps,"docker">,id:string):Error|null{
  const rm=deps.docker(["rm","-f",id]);
  if(failed(rm)) return Error(`docker rm -f ${id} failed (${describe(rm)})`);
  const ps=deps.docker(["ps","-a","-q","--no-trunc","--filter",`id=${id}`]);
  if(failed(ps)) return Error(`container removal of ${id} could not be verified (${describe(ps)})`);
  if(ps.stdout.trim()!=="") return Error(`container ${id} is still present after docker rm -f`);
  return null;
}
/** The generator. Returns the exit code (0 written or matches, 1 differs); throws on any failure, cleanup included. */
export async function generateFunctionInventory(check:boolean,deps:InventoryDeps=realInventoryDeps):Promise<number>{
  const pins=strictJson(deps.readFile("infrastructure/database/b1-engine-pins.json")) as {image:string;serverVersion:string};
  const stage=strictJson(deps.readFile(STAGE_MANIFEST_PATH)) as {baseMigrations:{file:string}[]};
  const base=stage.baseMigrations.map(m=>m.file).sort();
  if(!/^postgres@sha256:[0-9a-f]{64}$/.test(pins.image)) throw Error("engine image is not pinned by digest");
  if(base.length!==22 || new Set(base).size!==22 || base.some(f=>f>=B1)) throw Error("invalid sealed base set");
  const docker=(...args:string[])=>{
    const r=deps.docker(args);
    if(failed(r)) throw Error(`docker ${args[0]}: ${r.error ? r.error.message : r.signal!==null ? `signal ${r.signal}` : r.stderr.slice(0,400)}`);
    return r.stdout.trim();
  };
  const id=docker("run","-d","--rm","--name",deps.name(),"--label","kj.b1.function-inventory=1","--tmpfs","/var/lib/postgresql/data:rw",
    "-e","POSTGRES_HOST_AUTH_METHOD=trust","-p","127.0.0.1::5432",pins.image);
  // Only a full container id is acted on; anything else is refused before any further docker command.
  if(!/^[0-9a-f]{64}$/.test(id)) throw Error(`docker run printed no container id: ${id.slice(0,200)}`);
  let pool:InventoryPool|undefined,exitCode=0,original:Error|undefined;
  try{
    const port=docker("port",id,"5432/tcp").split("\n")[0]!.split(":").pop()!;
    const url=`postgresql://postgres@127.0.0.1:${port}/postgres`;
    for(let i=0;i<120;i++){
      // A fresh pinned image runs a temporary initdb server first; wait for the final server (two consecutive successes).
      const p=deps.pool(url);p.on("error",()=>{});
      try{await p.query("select 1");await deps.sleep(1500);await p.query("select 1");pool=p;break;}
      catch{await p.end().catch(()=>undefined);await deps.sleep(1000);}
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
      try{await db.query("begin");await db.query(deps.readFile(`supabase/migrations/${file}`));await db.query("commit");}
      catch(error){await db.query("rollback").catch(()=>undefined);throw Error(`${file}: ${error instanceof Error?error.message:String(error)}`,{cause:error});}
      finally{db.release();}
    }
    const text=renderFunctionInventory(await readFunctionInventory(pool));
    const p=pool;pool=undefined;await p.end();
    if(check){
      let committed="";try{committed=deps.readFile(FUNCTION_INVENTORY_PATH);}catch{/* missing */}
      if(committed!==text){deps.stderr(`${FUNCTION_INVENTORY_PATH} differs from the pinned engine's catalogue (base chain)\n`);exitCode=1;}
      else deps.stdout(`${FUNCTION_INVENTORY_PATH} matches (${pins.image}, ${version})\n`);
    } else {deps.writeFile(FUNCTION_INVENTORY_PATH,text);deps.stdout(`wrote ${FUNCTION_INVENTORY_PATH}\n`);}
  }catch(error){original=asError(error);}
  const cleanup:Error[]=[];
  if(pool){try{await pool.end();}catch(error){cleanup.push(Error(`pool close failed: ${asError(error).message}`,{cause:error}));}}
  const removal=removeContainer(deps,id);if(removal) cleanup.push(removal);
  if(original && cleanup.length)
    throw new AggregateError([original,...cleanup],`${original.message}; cleanup also failed: ${cleanup.map(e=>e.message).join("; ")}`);
  if(original) throw original;
  if(cleanup.length) throw cleanup.length===1 ? cleanup[0]! : new AggregateError(cleanup,cleanup.map(e=>e.message).join("; "));
  return exitCode;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)
  process.exit(await generateFunctionInventory(process.argv.includes("--check")));
