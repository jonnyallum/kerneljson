import type { Suite } from "./hooks.js";

/**
 * ADR-0023 27.12.13.3 L1 and 27.12.15: the closed set of committed plans. A plan is selected only by a registered
 * regression suite id; with no suite the base plan applies. No option, variable, file, profile or hook can add,
 * remove or reorder an entry. Every entry names the B1 migration of the stage manifest (filled in by the runner from
 * the blob at R, so a plan cannot name another migration).
 */
export interface PlanEntry {sequence:number;database:string}
export interface Plan {id:string;entries:readonly PlanEntry[]}
export const BASE_PLAN:Plan=Object.freeze({id:"base",entries:Object.freeze([{sequence:1,database:"kj_b1"}])});

/**
 * Stage T suites (27.12.15). Each suite's `databases` equal its plan's sequence numbers (static test). `argv` is run by
 * the runner with node, in a fresh working directory; `${checkout}` is the clean checkout of R and `${report}` the
 * report path the runner chose. Every primary stage T suite has a discover twin with the same files and profile.
 */
const vitest=(files:readonly string[])=>["${checkout}/node_modules/vitest/vitest.mjs","run","--root","${checkout}","--reporter=default",
  "--reporter=json","--outputFile.json=${report}","--includeTaskLocation",...files];
interface SuiteSpec {id:string;files:readonly string[];databases:readonly string[];profile:Suite["profile"];refusalPolicy:Suite["refusalPolicy"];
  compose:string|null;timeoutSeconds:number;roles:Suite["roles"]}
const SPECS:readonly SuiteSpec[]=[
  {id:"regression-probes",files:["tests/runtime-roles-log-fixture.integration.test.ts","tests/runtime-roles-negative.integration.test.ts"],
    databases:["kj_b1_log","kj_b1_neg"],profile:"none",refusalPolicy:"probes",compose:null,timeoutSeconds:1800,roles:["kj_worker","kj_door"]},
  {id:"regression-definers",files:["tests/runtime-roles-definers.integration.test.ts"],
    databases:["kj_b1_def"],profile:"platform-definer-fixture",refusalPolicy:"none",compose:null,timeoutSeconds:1200,roles:["kj_worker"]},
  {id:"regression-helper-probes",files:["tests/runtime-roles-coresident-probes.integration.test.ts"],
    databases:["kj_b1_helper"],profile:"pinned-helper",refusalPolicy:"probes",compose:null,timeoutSeconds:900,roles:["kj_worker","kj_door"]},
];
const suites:Suite[]=[],plans:Record<string,Plan>={};
for(const spec of SPECS) for(const harness of ["enforce","discover"] as const){
  const id=harness==="enforce"?spec.id:`${spec.id}-discover`;
  suites.push({id,argv:vitest(spec.files),harness,files:[...spec.files],databases:spec.databases.map((_,i)=>i+1),compose:spec.compose,
    profile:spec.profile,refusalPolicy:spec.refusalPolicy,timeoutSeconds:spec.timeoutSeconds,roles:[...spec.roles]});
  plans[id]=Object.freeze({id,entries:Object.freeze(spec.databases.map((database,i)=>({sequence:i+1,database})))});
}
export const REGRESSION_SUITES:readonly Suite[]=Object.freeze(suites);
export const SUITE_PLANS:Readonly<Record<string,Plan>>=Object.freeze(plans);

export function planFor(suite:string|null):Plan{
  if(suite===null) return BASE_PLAN;
  const plan=Object.hasOwn(SUITE_PLANS,suite)?SUITE_PLANS[suite]:undefined;
  if(!plan) throw Error("EPHEMERAL_REFUSED: no committed plan for the regression suite");
  return plan;
}
export function planProblems(plan:Plan):string[]{
  const problems:string[]=[];
  if(!plan.entries.length) problems.push(`${plan.id}: empty plan`);
  plan.entries.forEach((e,i)=>{
    if(e.sequence!==i+1) problems.push(`${plan.id}: sequence ${e.sequence} out of order`);
    if(!/^kj_[a-z0-9_]{1,40}$/.test(e.database)) problems.push(`${plan.id}: invalid database ${e.database}`);
  });
  if(new Set(plan.entries.map(e=>e.database)).size!==plan.entries.length) problems.push(`${plan.id}: duplicate database`);
  return problems;
}
