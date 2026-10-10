import { lstatSync, readFileSync } from "node:fs";
import { z } from "zod";
import { DB_NAME, HASH, hash } from "../../services/kernel/src/database/co-resident.js";
import { canonicalJson } from "../../services/kernel/src/database/security-definers.js";
import { strictJson } from "../../services/kernel/src/database/strict-json.js";
import { SEALED_BASE_VERSIONS } from "../../services/kernel/src/database/ledger-contract.js";
import { qualificationStatus } from "./run-status.js";
import { fixtureProblems, PROFILES, RegistrySchema, selectExpectation, STEPS, type FixtureObservation } from "./hooks.js";
import { B1_FILE, ENGINE_PINS_PATH, HOOKS_PATH, type Release } from "./release.js";
import { EnginePins } from "./engine.js";
import { planFor } from "./plans.js";

const SHA=z.string().regex(/^[0-9a-f]{40}$/),RunId=z.string().regex(/^[0-9a-f]{32}$/),Version=z.string().regex(/^[0-9]{14}$/);
const Blob=z.strictObject({id:SHA,sha256:HASH});
const Plan=z.strictObject({sequence:z.number().int().positive(),database:DB_NAME,version:z.literal("20261002090000"),migrationBlob:Blob});
const Export=z.array(z.strictObject({file:z.string(),sha256:HASH,blob:SHA}));
const Event=z.strictObject({step:z.enum(STEPS),outcome:z.enum(["passed","refused","skipped"]),application:z.number().int().positive().optional(),details:z.unknown()})
  .superRefine((event,ctx)=>{
    if(event.step.startsWith("S")!==(event.application!==undefined)) ctx.addIssue({code:"custom",message:`invalid ${event.step} binding`});
    if(event.outcome==="refused" && !event.step.startsWith("L") && typeof event.details!=="string") ctx.addIssue({code:"custom",message:"a refusal records its message"});
  });
const Observation=z.strictObject({
  end:z.strictObject({step:z.enum(STEPS),outcome:z.enum(["refused","completed"])}),
  refusal:z.strictObject({sqlstate:z.string().nullable(),message:z.string()}).nullable(),
  b1EngineInvoked:z.boolean(),
  preconditions:z.array(z.strictObject({hook:z.string(),result:z.unknown(),effective:z.boolean()})),
  post:z.record(z.string(),z.boolean()),
  teardownPassed:z.boolean(),
});
export const RunRecordSchema=z.strictObject({
  header:z.strictObject({kind:z.literal("kerneljson:b1-ephemeral-run/v2"),runId:RunId,clusterNonce:RunId,R:SHA,runnerBlob:SHA,registryBlob:SHA,
    profile:z.enum(PROFILES),hookIds:z.array(z.string()),negativeFixture:z.boolean(),planId:z.string(),regressionSuite:z.string().nullable(),
    plannedApplications:z.array(Plan).min(1),hostTime:z.string()}),
  negativeFixture:z.boolean(),hookIds:z.array(z.string()),migrationBlob:Blob,baseVersions:z.array(Version),plannedApplications:z.array(Plan).min(1),events:z.array(Event),
  applications:z.array(z.strictObject({sequence:z.number().int().positive(),database:DB_NAME,migrationBlob:Blob,engineExitStatus:z.number().int().nullable(),
    ledgerAfter:z.array(Version),postLedgerCompared:z.boolean(),postLedgerPassed:z.boolean()})),
  observed:z.record(z.string(),z.unknown()),
  fixture:z.strictObject({primary:z.string(),observation:Observation,problems:z.array(z.string())}).nullable(),
  failure:z.string().nullable(),status:z.enum(["REPOSITORY_QUALIFIED","NEGATIVE_FIXTURE_RESULT","NOT_QUALIFIED"]),
  fixtureOutcome:z.enum(["not-run","passed","failed"]),regressionOutcome:z.enum(["not-run","passed","failed"]),
  stageT:z.record(z.string(),z.unknown()),
});
export type RunRecord=z.infer<typeof RunRecordSchema>;
const same=(a:unknown,b:unknown)=>canonicalJson(a ?? null)===canonicalJson(b ?? null);
/**
 * 27.12.13.6: any consumer recomputes the status and the fixture outcome from the record alone, against the release
 * at R, and refuses the record if either differs from what the runner wrote, or if the record is bound to another
 * release, runner, registry or plan.
 */
export function validateRunRecord(input:unknown,release:Release):RunRecord{
  const record=RunRecordSchema.parse(input),header=record.header;
  const refuse=(condition:boolean,message:string)=>{if(!condition) throw Error(`EVIDENCE_REFUSED: ${message}`);};
  const registry=RegistrySchema.parse(release.json(HOOKS_PATH));
  const enginePins=EnginePins.parse(release.json(ENGINE_PINS_PATH));
  const engine=record.observed.engine as {platform?:"windows-x64"|"linux-x64";hashes?:unknown}|undefined;
  refuse(Boolean(engine?.platform) && same(engine!.hashes,enginePins.platforms[engine!.platform!].executables),"engine hashes differ");
  refuse(header.R===release.R && header.runnerBlob===release.git(["rev-parse",`${release.R}:scripts/b1`]).toString().trim() &&
    header.registryBlob===release.blob(HOOKS_PATH).id,"release binding differs");
  const migration=release.blob(`supabase/migrations/${B1_FILE}`),blob={id:migration.id,sha256:migration.sha256};
  const plan=planFor(header.regressionSuite);
  refuse(header.planId===plan.id,"plan id differs from the committed plan of the recorded suite");
  const planned=plan.entries.map(e=>({sequence:e.sequence,database:e.database,version:"20261002090000",migrationBlob:blob}));
  refuse(same(header.plannedApplications,planned) && same(record.plannedApplications,planned) && same(record.migrationBlob,blob),"plan differs");
  refuse(!(header.hookIds.length && header.regressionSuite!==null),"hooked run with a regression suite");
  refuse(same(record.baseVersions,SEALED_BASE_VERSIONS),"base versions differ");
  refuse(header.negativeFixture===(header.hookIds.length>0) && record.negativeFixture===header.negativeFixture && same(record.hookIds,header.hookIds),"negative-fixture binding differs");
  refuse(record.events[0]?.step==="L1" && record.events[0]?.outcome==="passed" &&
    same(record.events[0].details,{headerSha256:hash(JSON.stringify(header,null,2)+"\n")}),"header hash differs");
  refuse(qualificationStatus(record)===record.status,"status differs from recomputation");
  if(record.status==="REPOSITORY_QUALIFIED") refuse(record.failure===null,"qualified record has failure");
  const {files}=release.migrations();
  const exported=[...files].map(([file,b])=>({file,sha256:b.sha256,blob:b.id}));
  for(const event of record.events.filter(e=>e.outcome==="passed")){
    if(event.step==="S1"){
      const value=z.object({files:Export,baseVersions:z.array(Version),engine:z.object({exitStatus:z.number()})}).parse(event.details);
      refuse(same(value.files,exported.filter(f=>f.file!==B1_FILE)) && same(value.baseVersions,SEALED_BASE_VERSIONS) && value.engine.exitStatus===0,"S1 export or engine differs");
    }
    if(event.step==="S6" && !header.negativeFixture){
      const value=z.object({files:Export,engine:z.object({exitStatus:z.number()})}).parse(event.details);
      refuse(same(value.files,exported) && value.engine.exitStatus===0,"S6 export or engine differs");
    }
  }
  if(header.hookIds.length){
    refuse(record.fixture!==null,"hooked record without a fixture observation");
    const selected=selectExpectation(registry,header.hookIds,header.profile);
    const observation=record.fixture!.observation as FixtureObservation;
    refuse(record.fixture!.primary===selected.primary,"primary hook differs");
    for(const p of observation.preconditions){
      const hook=registry.hooks.find(h=>h.id===p.hook);
      refuse(Boolean(hook) && p.effective===same(p.result,hook!.precondition.expected),"precondition effectiveness differs from recomputation");
    }
    const lastRefused=[...record.events].reverse().find(e=>e.outcome==="refused");
    if(observation.end.outcome==="refused"){
      refuse(lastRefused?.step===observation.end.step,"recorded end differs from the events");
      if(typeof lastRefused?.details==="string") refuse(observation.refusal?.message===lastRefused.details,"recorded refusal differs from the event");
    } else refuse(!lastRefused && observation.end.step==="L6","a completed run carries a refusal");
    refuse(observation.b1EngineInvoked===((record.observed.applications as unknown[] | undefined)?.length ?? 0)>0,"engine invocation differs from the record");
    refuse(observation.teardownPassed===record.events.some(e=>e.step==="L6" && e.outcome==="passed"),"teardown differs from the events");
    const problems=fixtureProblems(selected.expectation,observation,header.hookIds);
    refuse(same(problems,record.fixture!.problems),"fixture problems differ from recomputation");
    refuse(record.fixtureOutcome===(problems.length?"failed":"passed"),"fixture outcome differs from recomputation");
  } else refuse(record.fixture===null && record.fixtureOutcome==="not-run","unhooked record carries a fixture outcome");
  return record;
}
export function readRunRecord(path:string,emittedSha256:string,release:Release){
  const stat=lstatSync(path);
  if(!stat.isFile() || stat.isSymbolicLink()) throw Error("EVIDENCE_REFUSED: record is not a regular file");
  const bytes=readFileSync(path);
  if(!HASH.safeParse(emittedSha256).success || hash(bytes)!==emittedSha256) throw Error("EVIDENCE_REFUSED: emitted record hash differs");
  return validateRunRecord(strictJson(bytes.toString("utf8")),release);
}
