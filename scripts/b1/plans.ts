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
  {id:"regression-enforce",files:["tests/authority.test.ts","tests/control-signing-store.integration.test.ts","tests/controls.test.ts","tests/database.test.ts","tests/evaluation-db.test.ts","tests/execution-binding.test.ts","tests/gateway.test.ts","tests/health-collect-postgres.integration.test.ts","tests/identity-cognition.integration.test.ts","tests/identity-migration.integration.test.ts","tests/memory-canonical.integration.test.ts","tests/memory.test.ts","tests/mission-control.test.ts","tests/mission-workflow.integration.test.ts","tests/release-provenance-postgres.test.ts","tests/runtime-roles-catalogue.integration.test.ts","tests/runtime-roles-connection.integration.test.ts","tests/schedule-db.test.ts","tests/telegram-approvals-store.integration.test.ts","tests/telegram-channel.integration.test.ts","tests/telegram-memory.integration.test.ts","tests/terminal-hardening.test.ts","tests/test-notification.integration.test.ts","tests/world.test.ts"],
    databases:["kj_authority","kj_control_signing_store","kj_controls","kj_database","kj_evaluation_db","kj_execution_binding","kj_gateway","kj_health_collect","kj_identity_cognition","kj_identity_migration_integration","kj_memory_canonical_integration","kj_memory","kj_mission_control","kj_mission_workflow","kj_release_provenance_01","kj_release_provenance_02","kj_release_provenance_03","kj_release_provenance_04","kj_release_provenance_05","kj_release_provenance_06","kj_release_provenance_07","kj_release_provenance_08","kj_release_provenance_09","kj_release_provenance_10","kj_release_provenance_11","kj_release_provenance_12","kj_b1_cat","kj_b1_con","kj_schedule_db","kj_telegram_approvals_store","kj_telegram_channel","kj_telegram_memory","kj_terminal_hardening","kj_test_notification","kj_world"],profile:"none",refusalPolicy:"none",compose:null,timeoutSeconds:5400,roles:["kj_worker","kj_door"]},
  {id:"regression-stack",files:["tests/alert-runner.integration.test.ts","tests/identity-cognition-restate.integration.test.ts","tests/identity-workflow.integration.test.ts","tests/recovery.test.ts","tests/telegram-approvals.integration.test.ts"],
    databases:["kj_alert_runner","kj_identity_cognition_restate","kj_identity_workflow","kj_recovery","kj_telegram_approvals"],profile:"none",refusalPolicy:"none",compose:"infrastructure/docker/regression.compose.yaml",timeoutSeconds:5400,
    roles:["kj_worker","kj_door"]},
  {id:"regression-probes",files:["tests/runtime-roles-log-fixture.integration.test.ts","tests/runtime-roles-negative.integration.test.ts"],
    databases:["kj_b1_log","kj_b1_neg"],profile:"none",refusalPolicy:"probes",compose:null,timeoutSeconds:1800,roles:["kj_worker","kj_door"]},
  {id:"regression-definers",files:["tests/runtime-roles-definers.integration.test.ts"],
    databases:["kj_b1_def"],profile:"platform-definer-fixture",refusalPolicy:"none",compose:null,timeoutSeconds:1200,roles:["kj_worker"]},
  {id:"regression-gated",files:["tests/alerting-postgres.integration.test.ts","tests/canary-tooling.integration.test.ts",
    "tests/gateway-bootstrap.integration.test.ts","tests/outbox-postgres.integration.test.ts","tests/schedule-fencing.integration.test.ts",
    "tests/schedule-postgres.integration.test.ts"],databases:["kj_gated"],profile:"none",refusalPolicy:"none",compose:null,timeoutSeconds:1800,
    roles:["kj_worker","kj_door"]},
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
