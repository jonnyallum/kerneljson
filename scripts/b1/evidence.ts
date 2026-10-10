import { lstatSync, readFileSync } from "node:fs";
import { z } from "zod";
import { DB_NAME, HASH, SYSTEM_ID, hash } from "../../services/kernel/src/database/co-resident.js";
import { strictJson } from "../../services/kernel/src/database/strict-json.js";
import { SEALED_BASE_VERSIONS } from "../../services/kernel/src/database/ledger-contract.js";
import { qualificationStatus } from "./run-status.js";
import { RegistrySchema } from "./hooks.js";
import { ledgerFixturePrecondition } from "./ephemeral-ledger-fixture.js";
import { B1_FILE, ENGINE_PINS_PATH, HOOKS_PATH, type Release } from "./release.js";
import { EnginePins } from "./engine.js";

const SHA=z.string().regex(/^[0-9a-f]{40}$/),RunId=z.string().regex(/^[0-9a-f]{32}$/),Version=z.string().regex(/^[0-9]{14}$/);
const Blob=z.strictObject({id:SHA,sha256:HASH});
const Plan=z.strictObject({sequence:z.number().int().positive(),database:DB_NAME,version:z.literal("20261002090000"),migrationBlob:Blob});
const EngineResult=z.strictObject({exitStatus:z.number().int().nullable(),signal:z.string().nullable(),error:z.string().nullable(),
  stdout:z.string().nullable(),stderr:z.string().nullable(),environmentNames:z.array(z.string())});
const Export=z.array(z.strictObject({file:z.string(),sha256:HASH,blob:SHA}));
const Removed=z.array(z.strictObject({kind:z.enum(["container","network"]),id:HASH}));
const FixtureFacts=z.strictObject({visible:z.array(z.strictObject({version:Version,name:z.string().nullable(),digest:HASH.nullable()})).nullable(),
  hidden:z.array(z.strictObject({version:Version,name:z.string().nullable(),digest:HASH.nullable()})).nullable(),
  stamp:z.array(z.strictObject({name:z.string(),definer:z.boolean()})),roles:z.array(z.strictObject({rolname:z.string()}))});
const Digests=z.strictObject({baseline:HASH,declaration:HASH});
const details={
  L1:z.strictObject({headerSha256:HASH}),
  L2:z.strictObject({containerId:HASH,networkId:HASH}),
  L3:z.strictObject({containerId:HASH,created:z.string(),port:z.number().int().positive(),networkId:HASH}),
  L4:z.strictObject({database:DB_NAME,host:z.literal("127.0.0.1"),port:z.number().int().positive(),user:z.literal("postgres")}),
  L5:z.strictObject({cluster:z.string(),sid:SYSTEM_ID,started:z.number(),version:z.string(),superuser:z.boolean(),database:DB_NAME}),
  L6:Removed,
  S1:z.strictObject({files:Export,engine:EngineResult,baseVersions:z.array(Version)}),
  S2:z.strictObject({profile:z.enum(["none","pinned-helper","platform-definer-fixture"]),hooks:z.array(z.string())}),
  S3:Digests,S4:Digests,S5:z.strictObject({hooks:z.array(z.string())}),
  S6:z.strictObject({before:z.strictObject({versions:z.array(Version),inventory:z.strictObject({missing:z.array(z.string()),extra:z.array(z.string()),mismatched:z.array(z.string())})}),
    after:z.array(Version),files:Export,engine:EngineResult,statementsDigest:HASH}),
  S7:z.strictObject({versions:z.array(Version),statementsDigest:HASH}),
};
const Event=z.strictObject({step:z.enum(["L1","L2","L3","L4","L5","L6","S1","S2","S3","S4","S5","S6","S7"]),
  outcome:z.enum(["passed","refused"]),application:z.number().int().positive().optional(),details:z.unknown()}).superRefine((event,ctx)=>{
    const schema=event.outcome==="passed"?details[event.step]:event.step==="L6"?z.strictObject({removed:Removed,error:z.string()}):z.string();
    if(!schema.safeParse(event.details).success || (event.step.startsWith("S")?event.application===undefined:event.application!==undefined))
      ctx.addIssue({code:"custom",message:`invalid ${event.step} evidence`});
  });
export const RunRecordSchema=z.strictObject({
  header:z.strictObject({kind:z.literal("kerneljson:b1-ephemeral-run/v1"),runId:RunId,clusterNonce:RunId,R:SHA,runnerBlob:SHA,registryBlob:SHA,
    profile:z.enum(["none","pinned-helper","platform-definer-fixture"]),hookIds:z.array(z.string()),negativeFixture:z.boolean(),
    planId:z.literal("base"),regressionSuite:z.null(),plannedApplications:z.array(Plan).min(1),hostTime:z.string()}),
  negativeFixture:z.boolean(),hookIds:z.array(z.string()),migrationBlob:Blob,baseVersions:z.array(Version),plannedApplications:z.array(Plan).min(1),events:z.array(Event),
  applications:z.array(z.strictObject({sequence:z.number().int().positive(),database:DB_NAME,migrationBlob:Blob,engineExitStatus:z.number().int().nullable(),
    ledgerAfter:z.array(Version),postLedgerCompared:z.boolean(),postLedgerPassed:z.boolean()})),
  observed:z.strictObject({engine:z.strictObject({version:z.literal("2.120.0"),platform:z.enum(["windows-x64","linux-x64"]),hashes:z.record(z.string(),HASH)}),
    S6Engine:EngineResult.optional(),statementsDigest:HASH.optional(),fixtureBefore:FixtureFacts.optional(),fixtureAfter:FixtureFacts.optional()}),
  failure:z.string().nullable(),status:z.enum(["REPOSITORY_QUALIFIED","NEGATIVE_FIXTURE_RESULT","NOT_QUALIFIED"]),
  fixtureOutcome:z.enum(["not-run","passed","failed"]),regressionOutcome:z.literal("not-run"),
});
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export function validateRunRecord(input:unknown,release:Release){
  const record=RunRecordSchema.parse(input),header=record.header;
  const refuse=(condition:boolean,message:string)=>{if(!condition) throw Error(`EVIDENCE_REFUSED: ${message}`);};
  const registry=RegistrySchema.parse(release.json(HOOKS_PATH));
  const enginePins=EnginePins.parse(release.json(ENGINE_PINS_PATH));
  refuse(same(record.observed.engine.hashes,enginePins.platforms[record.observed.engine.platform].executables),"engine hashes differ");
  const hooks=header.hookIds.map(id=>registry.hooks.find(h=>h.id===id));
  refuse(hooks.every(Boolean) && hooks.length<=1,"unregistered hook set");
  refuse(header.R===release.R && header.runnerBlob===release.blob("scripts/b1/ephemeral.ts").id && header.registryBlob===release.blob(HOOKS_PATH).id,"release binding differs");
  const migration=release.blob(`supabase/migrations/${B1_FILE}`),blob={id:migration.id,sha256:migration.sha256};
  const planned=[{sequence:1,database:"kj_b1",version:"20261002090000",migrationBlob:blob}];
  refuse(same(header.plannedApplications,planned) && same(record.plannedApplications,planned) && same(record.migrationBlob,blob),"plan differs");
  refuse(same(record.baseVersions,SEALED_BASE_VERSIONS),"base versions differ");
  refuse(header.negativeFixture===(hooks.length>0) && record.negativeFixture===header.negativeFixture && same(record.hookIds,header.hookIds),"negative-fixture binding differs");
  refuse(!hooks.length || header.profile==="none","hook profile differs");
  refuse(record.events[0]?.step==="L1" && record.events[0]?.outcome==="passed" &&
    same(record.events[0].details,{headerSha256:hash(JSON.stringify(header,null,2)+"\n")}),"header hash differs");
  const events=record.events.map(({application,...event})=>({...event,...(application===undefined?{}:{application})}));
  refuse(qualificationStatus({...record,events})===record.status,"status differs from recomputation");
  const {files}=release.migrations();
  const exported=[...files].map(([file,blob])=>({file,sha256:blob.sha256,blob:blob.id}));
  for(const event of record.events.filter(e=>e.outcome==="passed")){
    if(event.step==="S1"){
      const value=details.S1.parse(event.details);
      refuse(same(value.files,exported.filter(f=>f.file!==B1_FILE)) && same(value.baseVersions,SEALED_BASE_VERSIONS) && value.engine.exitStatus===0,"S1 export or engine differs");
    }
    if(event.step==="S2"){
      const value=details.S2.parse(event.details);refuse(value.profile===header.profile && same(value.hooks,header.hookIds),"S2 profile/hook binding differs");
    }
    if(event.step==="S6"){
      const value=details.S6.parse(event.details);
      refuse(same(value.files,exported) && same(value.engine,record.observed.S6Engine) && value.engine.exitStatus===0,"S6 export or engine differs");
    }
  }
  if(record.status==="REPOSITORY_QUALIFIED") refuse(record.failure===null,"qualified record has failure");
  const hook=hooks[0];
  let expectedFixture:"not-run"|"passed"|"failed"="not-run";
  if(hook){
    const before=record.observed.fixtureBefore,after=record.observed.fixtureAfter;
    expectedFixture=before && after && ledgerFixturePrecondition(hook.effect,before) && same(before,after) && record.failure===hook.expected.message &&
      !record.observed.S6Engine && record.applications.length===0 &&
      record.events.some(e=>e.step===hook.expected.stage && e.outcome==="refused" && e.details===hook.expected.message) &&
      record.events.at(-1)?.step==="L6" && record.events.at(-1)?.outcome==="passed" ? "passed":"failed";
  }
  refuse(record.fixtureOutcome===expectedFixture,"fixture outcome differs from recomputation");
  return record;
}
export function readRunRecord(path:string,emittedSha256:string,release:Release){
  const stat=lstatSync(path);
  if(!stat.isFile() || stat.isSymbolicLink()) throw Error("EVIDENCE_REFUSED: record is not a regular file");
  const bytes=readFileSync(path);
  if(!HASH.safeParse(emittedSha256).success || hash(bytes)!==emittedSha256) throw Error("EVIDENCE_REFUSED: emitted record hash differs");
  return validateRunRecord(strictJson(bytes.toString("utf8")),release);
}
