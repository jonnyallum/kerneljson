import { z } from "zod";
import { HASH } from "../../services/kernel/src/database/co-resident.js";

/**
 * ADR-0023 27.12.13.8, revision 2.7.8: the closed hook registry. Its schema is exact at every level. A hook is a
 * named, committed perturbation; its mechanics live in hook-definitions.ts and the registry blob at R must equal
 * what that file generates (scripts/b1/build-hook-registry.ts --check), so neither can drift from the other.
 * No point or effect can name L1, L5, L6, S7 or the qualification status.
 */
export const POINTS=["S2","S5","L2-target","L3-skip","S3-files","S4-skip","S6-gate-inventory-skip","S6-apply"] as const;
export const STEPS=["L1","L2","L3","L4","L5","L6","S1","S2","S3","S4","S5","S6","S7"] as const;
export const PROFILES=["none","pinned-helper","platform-definer-fixture"] as const;
export const POSTS=["catalogue-unchanged","no-b1-effect","helper-proacl-null","s7-passed","declaration-crlf-forensic","fixture-removed"] as const;
export const RUNNER_FACTS=["engine-settings","export-variant","run-files","skipped-check","target-substituted","record-altered"] as const;
export type Point=typeof POINTS[number];
export type Step=typeof STEPS[number];
export type Profile=typeof PROFILES[number];
export type Post=typeof POSTS[number];
const ID=/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const Forbidden=/\b(L1|L5|L6|S7|status|qualified)\b/i;
export const Refusal=z.strictObject({sqlstate:z.string().regex(/^[0-9A-Z]{5}$/).nullable(),message:z.string().min(1).nullable(),pattern:z.string().min(2).nullable()})
  .refine(r=>(r.message===null)!==(r.pattern===null),"exactly one of message or pattern")
  .refine(r=>r.pattern===null || (r.pattern.startsWith("^") && (()=>{try{new RegExp(r.pattern);return true;}catch{return false;}})()),"patterns are anchored and valid");
export const Expectation=z.strictObject({
  with:z.array(z.string().regex(ID)),
  profiles:z.array(z.enum(PROFILES)).min(1),
  end:z.strictObject({step:z.enum(STEPS),outcome:z.enum(["refused","completed"])}),
  refusal:Refusal.nullable(),
  b1EngineInvoked:z.boolean(),
  post:z.array(z.enum(POSTS)),
}).refine(e=>(e.end.outcome==="refused")===(e.refusal!==null),"a refusal is described exactly when the run ends refused")
  .refine(e=>e.end.outcome==="refused" || e.end.step==="L6","a completed run ends at L6")
  .refine(e=>JSON.stringify(e.with)===JSON.stringify([...e.with].sort()),"companions are sorted");
export type Expectation=z.infer<typeof Expectation>;
export const Precondition=z.discriminatedUnion("kind",[
  z.strictObject({kind:z.literal("sql"),sql:z.string().min(1),expected:z.array(z.record(z.string(),z.unknown())).min(1)}),
  z.strictObject({kind:z.literal("runner"),fact:z.enum(RUNNER_FACTS),expected:z.unknown()}),
]);
export type Precondition=z.infer<typeof Precondition>;
export const HookSchema=z.strictObject({
  id:z.string().regex(ID),
  point:z.enum(POINTS),
  effect:z.string().min(1).refine(s=>!Forbidden.test(s),"an effect may not name L1, L5, L6, S7 or the status"),
  callers:z.array(z.string().regex(/^tests\/b1-runner-[a-z-]+\.test\.ts$/)).min(1),
  expected:z.array(Expectation).min(1),
  precondition:Precondition,
  cases:z.array(z.string().min(1)).min(1),
});
export type Hook=z.infer<typeof HookSchema>;
export const SuiteSchema=z.strictObject({
  id:z.string().regex(ID),
  argv:z.array(z.string().min(1)).min(1),
  harness:z.enum(["enforce","discover"]),
  files:z.array(z.string().regex(/^tests\/[a-z0-9.-]+\.test\.ts$/)).min(1),
  databases:z.array(z.number().int().positive()).min(1),
  compose:z.string().nullable(),
  profile:z.enum(PROFILES),
  refusalPolicy:z.enum(["none","probes"]),
  timeoutSeconds:z.number().int().positive(),
});
export type Suite=z.infer<typeof SuiteSchema>;
export const RegistrySchema=z.strictObject({
  kind:z.literal("kerneljson:b1-runner-hook-registry/v1"),
  setupProfiles:z.array(z.strictObject({id:z.enum(PROFILES),sql:z.string().nullable(),sha256:HASH.nullable()})),
  hooks:z.array(HookSchema),
  regressionSuites:z.array(SuiteSchema),
}).superRefine((registry,ctx)=>{
  const ids=registry.hooks.map(h=>h.id),suites=registry.regressionSuites.map(s=>s.id);
  if(new Set(ids).size!==ids.length) ctx.addIssue({code:"custom",message:"hook ids are not unique"});
  if(new Set(suites).size!==suites.length) ctx.addIssue({code:"custom",message:"suite ids are not unique"});
  if(new Set(ids.map(i=>i.toLowerCase())).size!==ids.length) ctx.addIssue({code:"custom",message:"hook ids collide by case"});
  if(JSON.stringify(registry.setupProfiles.map(p=>p.id))!==JSON.stringify(PROFILES)) ctx.addIssue({code:"custom",message:"setup profile set differs"});
  for(const hook of registry.hooks) for(const e of hook.expected) for(const other of e.with)
    if(!ids.includes(other) || other===hook.id) ctx.addIssue({code:"custom",message:`${hook.id}: unknown companion ${other}`});
});
export type Registry=z.infer<typeof RegistrySchema>;

/**
 * Exactly one registered expectation must describe a run's hook set: one hook whose `expected` lists the others as
 * its companions, for the run's profile. Any other combination is unregistered and refuses before L1.
 */
export function selectExpectation(registry:Registry,hookIds:readonly string[],profile:Profile):{primary:string;expectation:Expectation}{
  const hooks=hookIds.map(id=>registry.hooks.find(h=>h.id===id));
  if(hooks.some(h=>!h) || new Set(hookIds).size!==hookIds.length) throw Error("EPHEMERAL_REFUSED: unknown or repeated hook id");
  const matches:{primary:string;expectation:Expectation}[]=[];
  for(const hook of hooks as Hook[]){
    const others=hookIds.filter(id=>id!==hook.id).sort();
    for(const expectation of hook.expected)
      if(JSON.stringify(expectation.with)===JSON.stringify(others) && expectation.profiles.includes(profile)) matches.push({primary:hook.id,expectation});
  }
  if(matches.length!==1) throw Error("EPHEMERAL_REFUSED: hook combination or profile not registered");
  return matches[0]!;
}

/** What a run observably did, as the runner records it and any consumer re-reads it. */
export interface FixtureObservation {
  end:{step:Step;outcome:"refused"|"completed"};
  refusal:{sqlstate:string|null;message:string}|null;
  b1EngineInvoked:boolean;
  preconditions:{hook:string;result:unknown;effective:boolean}[];
  post:Partial<Record<Post,boolean>>;
  teardownPassed:boolean;
}
/** The one fixture evaluation, used by the runner and recomputed by every consumer from the record alone. */
export function fixtureProblems(expectation:Expectation,observed:FixtureObservation,hookIds:readonly string[]):string[]{
  const problems:string[]=[];
  for(const id of hookIds){
    const p=observed.preconditions.filter(x=>x.hook===id);
    if(p.length!==1 || !p[0]!.effective) problems.push(`${id}: not-effective`);
  }
  if(observed.end.step!==expectation.end.step || observed.end.outcome!==expectation.end.outcome)
    problems.push(`ended ${observed.end.outcome} at ${observed.end.step}, expected ${expectation.end.outcome} at ${expectation.end.step}`);
  if(expectation.refusal){
    const r=observed.refusal;
    if(!r) problems.push("no refusal recorded");
    else {
      if(r.sqlstate!==expectation.refusal.sqlstate) problems.push(`SQLSTATE ${String(r.sqlstate)}, expected ${String(expectation.refusal.sqlstate)}`);
      if(expectation.refusal.message!==null && r.message!==expectation.refusal.message) problems.push(`message ${JSON.stringify(r.message)} differs`);
      if(expectation.refusal.pattern!==null && !new RegExp(expectation.refusal.pattern).test(r.message)) problems.push(`message ${JSON.stringify(r.message)} does not match ${expectation.refusal.pattern}`);
    }
  } else if(observed.refusal) problems.push("unexpected refusal");
  if(observed.b1EngineInvoked!==expectation.b1EngineInvoked) problems.push(`B1 engine invoked ${observed.b1EngineInvoked}`);
  for(const post of expectation.post) if(observed.post[post]!==true) problems.push(`post-condition ${post} not observed`);
  if(!observed.teardownPassed) problems.push("teardown not recorded passed");
  return problems;
}
