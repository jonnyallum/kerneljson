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

/** Stage T suites (27.12.15). Each suite's `databases` equal its plan's sequence numbers (static test). */
export const REGRESSION_SUITES:readonly Suite[]=Object.freeze([]);
export const SUITE_PLANS:Readonly<Record<string,Plan>>=Object.freeze({});

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
