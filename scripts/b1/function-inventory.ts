import { readFileSync } from "node:fs";
import type pg from "pg";
import { z } from "zod";
import { strictJson } from "../../services/kernel/src/database/strict-json.js";
import { FUNCTION_IDENTITY_SQL, type RuntimeRole, type RuntimeRoleManifest } from "../../services/kernel/src/database/runtime-roles.js";

/**
 * KJ-P8 B1 function inventory (E2 experiment, R2.7.10 draft A10.7; not sealed). Every function of the two KernelJSON
 * schemas that the negative qualification (tests/runtime-roles-negative.integration.test.ts, "every function outside
 * the manifest is not executable") enumerates, by exact identity (27.11.3, FUNCTION_IDENTITY_SQL). B1 creates and drops
 * no function (CON-32), so the base chain's set is also the post-B1 set.
 *
 * ONE predicate and ONE identity expression are shared by:
 *   - the generator, scripts/b1/build-function-inventory.ts (base chain plus B1 on the pinned engine image);
 *   - the lane A regeneration check, tests/b1-relation-inventory.integration.test.ts (byte for byte, base chain);
 *   - the frozen negative test (its function selection, and its stage T catalogue-equality assertion);
 *   - G8 (scripts/b1/g8.ts), whose expected "function outside manifest" rows are this inventory minus each role's
 *     manifest functions.
 * Trigger and event-trigger functions are excluded by rule: they are not callable capabilities (27.11.1; 27.12.5
 * "Capability facts"). Ordering is COLLATE "C"; the read runs with an empty search_path.
 */
export const FUNCTION_INVENTORY_PATH="infrastructure/database/b1-function-inventory.json";
export const FUNCTION_INVENTORY_KIND="kerneljson:b1-function-inventory/v1";
/** The single function-selection predicate (aliases: p = pg_proc, n = pg_namespace). */
export const FUNCTION_INVENTORY_PREDICATE=(p:string,n:string):string=>
  `${n}.nspname in ('public','kernel_private') and ${p}.prorettype <> 'pg_catalog.trigger'::pg_catalog.regtype and ${p}.prorettype <> 'pg_catalog.event_trigger'::pg_catalog.regtype`;
export const FUNCTION_INVENTORY_SQL=`select f.name from (select ${FUNCTION_IDENTITY_SQL("p","n")} as name
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where ${FUNCTION_INVENTORY_PREDICATE("p","n")}) f order by f.name collate "C"`;
export const FunctionInventorySchema=z.strictObject({
  kind:z.literal(FUNCTION_INVENTORY_KIND),
  predicate:z.string(),
  functions:z.array(z.string().min(1)),
});
export type FunctionInventory=z.infer<typeof FunctionInventorySchema>;
/** Static contract (no database): schema, the current predicate, strictly ascending in "C" (byte) order, no duplicate. */
export function functionInventoryProblems(value:unknown):string[]{
  const r=FunctionInventorySchema.safeParse(value);
  if(!r.success) return [`function inventory malformed: ${r.error.issues.map(i=>`${i.path.join(".")} ${i.message}`).join("; ").slice(0,300)}`];
  const problems:string[]=[];
  if(r.data.predicate!==FUNCTION_INVENTORY_PREDICATE("p","n")) problems.push("function inventory predicate differs from the shared predicate");
  const f=r.data.functions;
  for(let i=1;i<f.length;i++){
    const c=Buffer.compare(Buffer.from(f[i-1]!,"utf8"),Buffer.from(f[i]!,"utf8"));
    if(c===0) problems.push(`function inventory duplicate ${f[i]}`);
    else if(c>0) problems.push(`function inventory not in "C" order at ${f[i]}`);
  }
  if(!f.length) problems.push("function inventory is empty");
  return problems;
}
export function parseFunctionInventory(value:unknown):FunctionInventory{
  const problems=functionInventoryProblems(value);
  if(problems.length) throw Error(problems.join("; "));
  return value as FunctionInventory;
}
/**
 * The committed inventory of this checkout, located from this module (not the working directory: stage T consumers
 * run in the run's working directory) and held to the static contract.
 */
export const committedFunctionInventory=():FunctionInventory=>
  parseFunctionInventory(strictJson(readFileSync(new URL("../../infrastructure/database/b1-function-inventory.json",import.meta.url),"utf8")));
/** The live catalogue under the shared predicate, read with an empty search_path. */
export async function readFunctionInventory(pool:Pick<pg.Pool,"connect">):Promise<FunctionInventory>{
  const db=await pool.connect();
  try{
    await db.query("begin read only");
    await db.query("set local search_path = ''");
    const functions=(await db.query<{name:string}>(FUNCTION_INVENTORY_SQL)).rows.map(r=>r.name);
    await db.query("commit");
    return {kind:FUNCTION_INVENTORY_KIND,predicate:FUNCTION_INVENTORY_PREDICATE("p","n"),functions};
  }catch(error){await db.query("rollback").catch(()=>undefined);throw error;}
  finally{db.release();}
}
/** The committed byte form: two-space JSON and a final newline. */
export const renderFunctionInventory=(inventory:FunctionInventory):string=>JSON.stringify(inventory,null,2)+"\n";
/** G8: the functions one role must find not executable, the inventory minus that role's manifest functions. */
export function functionsOutsideManifest(inventory:FunctionInventory,manifest:RuntimeRoleManifest,role:RuntimeRole):string[]{
  const granted=new Set(Object.keys(manifest.roles[role].functions));
  return inventory.functions.filter(f=>!granted.has(f));
}
