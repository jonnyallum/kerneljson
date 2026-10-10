import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { hash, HASH, pins, PINS_PATH, type Declaration } from "../../services/kernel/src/database/co-resident.js";
import { snapshotArtifacts } from "../../services/kernel/src/database/platform-baseline-snapshot.js";
import { canonicalJson } from "../../services/kernel/src/database/security-definers.js";
import { MANIFEST_PATH, type RuntimeRoleManifest } from "../../services/kernel/src/database/runtime-roles.js";
import { SEALED_BASE_VERSIONS } from "../../services/kernel/src/database/ledger-contract.js";
import { strictJson } from "../../services/kernel/src/database/strict-json.js";
import { Release, B1_FILE, HOOKS_PATH } from "./release.js";
import { engineRefusal, prepareEngine, startupUrl, startupUrlWith, type StartupSettings } from "./engine.js";
import { EphemeralCluster } from "./ephemeral-cluster.js";
import { freezeArtifacts, type FrozenArtifacts } from "./run-artifacts.js";
import { preLedgerGate, postLedgerGate, type CleanupMember } from "./ledger.js";
import { qualificationStatus, type RunEvidence, type Step } from "./run-status.js";
import { fixtureProblems, PROFILES, RegistrySchema, selectExpectation, type FixtureObservation, type Hook, type Post, type Profile } from "./hooks.js";
import { definition, type FileTransform, type HookDefinition, type Settings } from "./hook-definitions.js";
import { generatedRegistry, registryText } from "./build-hook-registry.js";
import { planFor, planProblems } from "./plans.js";
import { catalogueFacts, noB1Effect, type CatalogueFacts } from "./fixture-facts.js";
import { validateRunRecord } from "./evidence.js";

const Contract=z.strictObject({kind:z.literal("kerneljson:b1-ledger-contract/v1"),migrationSha256:HASH,statementsSha256:HASH,engineVersion:z.literal("2.120.0")});
export interface EphemeralInput {R:string;profile:Profile;hooks:string[];suite:string|null}
const refuse=(message:string):never=>{throw Error(`EPHEMERAL_REFUSED: ${message}`);};
/**
 * 27.12.13.3: the only inputs are the release commit, one setup profile, zero or more hook ids and zero or one
 * regression suite id. Anything else, including any target, path or status, refuses before L1.
 */
export function ephemeralArguments(argv:readonly string[]):EphemeralInput{
  if(argv[0]!=="--release" || !/^[0-9a-f]{40}$/.test(argv[1] ?? "") || argv[2]!=="--profile" || !(PROFILES as readonly string[]).includes(argv[3] ?? ""))
    refuse("expected --release <SHA> --profile <registered profile>");
  const hooks:string[]=[];let suite:string|null=null;
  for(let i=4;i<argv.length;i+=2){
    const flag=argv[i],value=argv[i+1];
    if(value===undefined || !/^[a-z][a-z0-9-]*$/.test(value)) refuse("malformed option value");
    if(flag==="--hook") hooks.push(value!);
    else if(flag==="--regression-suite" && suite===null) suite=value!;
    else refuse(`option not accepted: ${String(flag)}`);
  }
  return {R:argv[1]!,profile:argv[3] as Profile,hooks,suite};
}
/** EPH-21, EPH-25, CON-2: nothing reaches the runner through its environment either. */
export function environmentProblems(env:NodeJS.ProcessEnv):string[]{
  return Object.keys(env).filter(k=>/^KJ_B1_/i.test(k) || /^KJ_(EPHEMERAL|RUNNER|HOOK|STATUS|SUITE)/i.test(k)).sort();
}
class EngineRefusal extends Error {constructor(readonly sqlstate:string|null,message:string){super(message);}}
const same=(a:unknown,b:unknown)=>canonicalJson(a ?? null)===canonicalJson(b ?? null);
function resolveSettings(spec:Settings,d:Declaration):StartupSettings{
  const value=(v:Settings[keyof Settings],fromDeclaration:string)=>"from" in v?fromDeclaration:"omit" in v?undefined:v.value;
  return {digest:value(spec.digest,d.setSha256),sysid:value(spec.sysid,d.provenance.systemIdentifier),database:value(spec.database,d.provenance.database)};
}
function transform(text:string,t:FileTransform):string|null{
  if(t==="delete") return null;
  if(t==="invalid-json") return "{"+text;
  if(t==="bom") return "﻿"+text;
  const o=JSON.parse(text);
  const foreign={runId:randomBytes(16).toString("hex"),clusterNonce:randomBytes(16).toString("hex"),containerId:randomBytes(32).toString("hex"),
    containerCreated:"2026-01-01T00:00:00.000000000Z",application:1};
  switch(t){
    case "edit-environment":o.environment=`${o.environment}-edited`;break;
    case "drop-mode":case "baseline-drop-mode":delete o.mode;break;
    case "hosted-with-run":case "baseline-mode-hosted":o.mode="HOSTED_COMMITTED";break;
    case "ephemeral-without-run":delete o.run;break;
    case "run-unknown-field":o.run.unknown="x";break;
    case "run-runId":o.run.runId=foreign.runId;break;
    case "run-clusterNonce":o.run.clusterNonce=foreign.clusterNonce;break;
    case "run-containerId":o.run.containerId=foreign.containerId;break;
    case "run-containerCreated":o.run.containerCreated=foreign.containerCreated;break;
    case "run-application":o.run.application=o.run.application+1;break;
    case "foreign-run":case "foreign-baseline":o.run={...foreign,application:o.run.application};o.provenance.systemIdentifier="7678069749886157684";break;
    case "sysid":o.provenance.systemIdentifier="7678069749886157684";break;
    case "entry-digest":o.entries[0].sourceDigest="0".repeat(64);break;
    case "set-sha":o.setSha256="0".repeat(64);break;
  }
  return JSON.stringify(o,null,2)+"\n";
}

export async function runEphemeral(argv:string[],root=process.cwd()):Promise<void>{
  const input=ephemeralArguments(argv);
  const envProblems=environmentProblems(process.env);
  if(envProblems.length) refuse(`runner variables in the environment: ${envProblems.join(", ")}`);
  const release=new Release(root,input.R);
  const {manifest,files}=release.migrations(),migration=files.get(B1_FILE)!;
  const registryBlob=release.blob(HOOKS_PATH);
  const registry=RegistrySchema.parse(strictJson(registryBlob.bytes.toString("utf8")));
  if(registryBlob.bytes.toString("utf8")!==registryText(generatedRegistry())) refuse("hook registry at R differs from the committed hook definitions");
  for(const profile of registry.setupProfiles){
    if(profile.id==="none"){if(profile.sql!==null || profile.sha256!==null) refuse("none profile mutated");}
    else if(!profile.sql || !profile.sha256 || release.blob(profile.sql).sha256!==profile.sha256) refuse("fixture hash differs");
  }
  const profile=registry.setupProfiles.find(p=>p.id===input.profile)!;
  const defs:HookDefinition[]=input.hooks.map(id=>{
    const hook=registry.hooks.find(h=>h.id===id),def=definition(id);
    if(!hook || !def || !same(hook,def.hook)) return refuse(`unknown hook id: ${id}`);
    return def;
  });
  const selected=input.hooks.length?selectExpectation(registry,input.hooks,input.profile):null;
  let suite=null;
  if(input.suite!==null){
    if(input.hooks.length) refuse("a regression suite cannot be combined with a hook");
    suite=registry.regressionSuites.find(s=>s.id===input.suite) ?? refuse("unknown regression suite id");
    if(suite.profile!==input.profile) refuse("regression suite profile differs");
  }
  const plan=planFor(input.suite);
  if(planProblems(plan).length) refuse(`plan invalid: ${planProblems(plan).join("; ")}`);
  if(!migration.bytes.toString("utf8").includes(`-- Sealed pins: ${JSON.stringify(release.json(PINS_PATH))}`) ||
    JSON.stringify(release.json(PINS_PATH))!==JSON.stringify(pins)) refuse("migration or checkout pins differ");
  const contractPath="infrastructure/database/b1-ledger-contract.json";
  const hasContract=release.git(["ls-tree","--name-only",input.R,"--",contractPath]).toString().trim()===contractPath;
  const contract=hasContract ? Contract.parse(release.json(contractPath)) : null;
  if(contract && contract.migrationSha256!==migration.sha256) refuse("ledger contract belongs to another migration blob");
  const preflight=mkdtempSync(join(tmpdir(),"kj-b1-engine-"));
  const engine=await prepareEngine(release,join(preflight,"verified"));
  const runId=randomBytes(16).toString("hex"),clusterNonce=randomBytes(16).toString("hex");
  const directory=mkdtempSync(join(tmpdir(),`kj-b1-${runId}-`));
  const migrationBlob={id:migration.id,sha256:migration.sha256};
  const negativeFixture=input.hooks.length>0;
  const plannedApplications=plan.entries.map(e=>({sequence:e.sequence,database:e.database,version:"20261002090000" as const,migrationBlob}));
  const evidence:RunEvidence={negativeFixture,hookIds:[...input.hooks],migrationBlob,baseVersions:[...SEALED_BASE_VERSIONS],plannedApplications,events:[],applications:[]};
  const header={kind:"kerneljson:b1-ephemeral-run/v2",runId,clusterNonce,R:input.R,runnerBlob:release.git(["rev-parse",`${input.R}:scripts/b1`]).toString().trim(),
    registryBlob:registryBlob.id,profile:input.profile,hookIds:[...input.hooks],negativeFixture,planId:plan.id,regressionSuite:input.suite,
    plannedApplications,hostTime:new Date().toISOString()};
  const headerText=JSON.stringify(header,null,2)+"\n";
  writeFileSync(join(directory,"header.json"),headerText,{flag:"wx",mode:0o600});
  evidence.events.push({step:"L1",outcome:"passed",details:{headerSha256:hash(headerText)}});
  const hostedIds:string[]=[];
  for(const path of ["infrastructure/database/co-resident-platform-exceptions.json","infrastructure/database/security-definer-platform-baseline.json"]){
    if(release.git(["ls-tree","--name-only",input.R,"--",path]).toString().trim()===path){
      const value=release.json(path) as {mode?:string;provenance?:{systemIdentifier?:string}};
      if(value.mode==="HOSTED_COMMITTED" && value.provenance?.systemIdentifier) hostedIds.push(value.provenance.systemIdentifier);
    }
  }
  const cluster=new EphemeralCluster(runId,clusterNonce,engine.pins.image,engine.pins.serverVersion,plan.entries.map(e=>e.database),hostedIds,
    event=>evidence.events.push(event));
  const byPoint=(point:Hook["point"])=>defs.filter(d=>d.hook.point===point);
  const preconditions:FixtureObservation["preconditions"]=[];
  const observed:Record<string,unknown>={engine:{version:engine.pins.version,platform:engine.platform,hashes:engine.executableHashes},applications:[]};
  let active:Step="L2",failure:string|null=null,refusal:{sqlstate:string|null;message:string}|null=null,b1EngineInvoked=false;
  let lastFacts:CatalogueFacts|null=null,afterFacts:CatalogueFacts|null=null,lastDeclaration:Declaration|null=null,factsAt:string|null=null;
  const facts=async(database:string)=>{const c=await cluster.connect(database);try{return await catalogueFacts(c);}finally{await c.end();}};
  const runnerPrecondition=(def:HookDefinition,result:unknown)=>{
    if(def.hook.precondition.kind!=="runner") throw Error("PRECONDITION_REFUSED: runner fact for a SQL precondition");
    preconditions.push({hook:def.hook.id,result,effective:same(result,def.hook.precondition.expected)});
  };
  const sqlPrecondition=async(def:HookDefinition,database:string)=>{
    if(def.hook.precondition.kind!=="sql") throw Error("PRECONDITION_REFUSED: SQL precondition missing");
    const c=await cluster.connect(database);
    try{
      const result=(await c.query(def.hook.precondition.sql)).rows;
      preconditions.push({hook:def.hook.id,result,effective:same(result,def.hook.precondition.expected)});
    }finally{await c.end();}
  };
  const ownerSql=async(database:string,sql:string)=>{const c=await cluster.connect(database);try{await c.query(sql);}finally{await c.end();}};
  const passed=(step:Step,application:number,details:unknown)=>{evidence.events.push({step,outcome:"passed",application,details});};
  let cleanupBefore:CleanupMember[]|null=null;
  try{
    const target=byPoint("L2-target")[0];
    const {substituted}=await cluster.create(target?.mechanics.kind==="target"?target.mechanics.fixture:undefined);
    if(target) runnerPrecondition(target,{fixture:substituted?.fixture});
    observed.substituted=substituted;
    const l3=byPoint("L3-skip")[0];
    if(l3){cluster.skipAttestationOnce();runnerPrecondition(l3,{check:"L3"});}
    active="S1";
    const bootstrap=await cluster.connect("postgres");
    try{await bootstrap.query("create role anon nologin; create role authenticated nologin; create role service_role nologin");}
    finally{await bootstrap.end();}
    for(const entry of plannedApplications){
      const seq=entry.sequence,db=entry.database;
      active="S1";
      const creator=await cluster.connect("postgres");
      try{await creator.query(`create database ${db} template template0`);}finally{await creator.end();}
      const baseExport=join(directory,`${seq}-base-export`),baseFiles=release.exportMigrations(baseExport,true);
      const baseResult=engine.apply(baseExport,await cluster.engineTarget(db));
      if(baseResult.exitStatus!==0) throw Error(`S1: engine failed: ${engineRefusal(baseResult.stdout+baseResult.stderr).message}`);
      const baseClient=await cluster.connect(db);let baseVersions:string[];
      try{baseVersions=(await baseClient.query<{version:string}>("select version from supabase_migrations.schema_migrations order by version")).rows.map(r=>r.version);}
      finally{await baseClient.end();}
      if(JSON.stringify(baseVersions)!==JSON.stringify(SEALED_BASE_VERSIONS)) throw Error("S1: base ledger differs");
      passed("S1",seq,{database:db,files:baseFiles,engine:{exitStatus:baseResult.exitStatus,environmentNames:baseResult.environmentNames},baseVersions});
      active="S2";
      if(profile.sql) await ownerSql(db,release.blob(profile.sql).bytes.toString("utf8"));
      for(const def of byPoint("S2")){
        if(def.mechanics.kind!=="sql") throw Error("S2: mechanics differ");
        await ownerSql(db,def.mechanics.sql);await sqlPrecondition(def,db);
      }
      passed("S2",seq,{profile:profile.id,hooks:byPoint("S2").map(d=>d.hook.id)});
      lastFacts=await facts(db);factsAt="before-S3";
      active="S3";
      const snapshotClient=await cluster.connect(db);let pair;
      try{pair=await snapshotArtifacts(snapshotClient,"ephemeral",manifest,{mode:"EPHEMERAL_RUN_BOUND",
        run:{runId,clusterNonce,containerId:cluster.genuineContainerId,containerCreated:cluster.created,application:seq}});}
      finally{await snapshotClient.end();}
      const artifacts=freezeArtifacts(directory,seq,pair,manifest);
      passed("S3",seq,artifacts.digests());
      const fileHooks=(when:"after-S3"|"after-S4"|"after-S6",store:FrozenArtifacts)=>{
        for(const def of byPoint("S3-files")){
          const m=def.mechanics;
          if(m.kind!=="files" || m.when!==when) continue;
          for(const key of m.target==="both"?["baseline","declaration"] as const:[m.target]){
            const path=store.files[key],next=transform(readFileSync(path,"utf8"),m.transform);
            if(next===null) unlinkSync(path); else writeFileSync(path,next);
            if(m.rerecord) store.rerecord(key);
          }
          runnerPrecondition(def,{when:m.when,target:m.target,transform:m.transform,rerecorded:m.rerecord});
        }
      };
      fileHooks("after-S3",artifacts);
      active="S4";
      const s4skip=byPoint("S4-skip")[0];
      if(s4skip){evidence.events.push({step:"S4",outcome:"skipped",application:seq,details:{hook:s4skip.hook.id}});runnerPrecondition(s4skip,{check:"S4"});}
      else {
        const probe=await cluster.connect(db);await probe.end();
        const live=cluster.lastIdentity!;
        artifacts.validate({runId,clusterNonce,containerId:cluster.genuineContainerId,containerCreated:cluster.created,application:seq},
          {systemIdentifier:live.sid,database:live.database});
        passed("S4",seq,artifacts.digests());
      }
      fileHooks("after-S4",artifacts);
      active="S5";
      for(const def of byPoint("S5")){
        if(def.mechanics.kind!=="sql") throw Error("S5: mechanics differ");
        await ownerSql(db,def.mechanics.sql);await sqlPrecondition(def,db);
      }
      passed("S5",seq,{hooks:byPoint("S5").map(d=>d.hook.id)});
      lastFacts=await facts(db);factsAt="before-S6";
      active="S6";
      let frozen=artifacts.read();lastDeclaration=frozen.declaration;
      const skipInventory=byPoint("S6-gate-inventory-skip")[0];
      if(skipInventory) runnerPrecondition(skipInventory,{check:"gate-inventory"});
      const gateClient=await cluster.connect(db);let before;
      try{before=await preLedgerGate(gateClient,manifest,frozen.baseline,frozen.declaration,{skipInventory:Boolean(skipInventory)});}
      finally{await gateClient.end();}
      cleanupBefore=before.cleanup;
      const fullExport=join(directory,`${seq}-full-export`),fullFiles=release.exportMigrations(fullExport);
      const apply=byPoint("S6-apply");
      let replaced:string|undefined;
      for(const def of apply){
        const m=def.mechanics;
        if(m.kind==="export-tamper"){
          const victim="20260905153656_identity.sql",path=join(fullExport,"supabase","migrations",victim);
          writeFileSync(path,readFileSync(path,"utf8")+"\n-- tampered after export\n");runnerPrecondition(def,{tampered:victim});
        }
        if(m.kind==="variant"){
          const path=join(fullExport,"supabase","migrations",B1_FILE),text=readFileSync(path,"utf8");
          if(text.split(m.after).length!==2) throw Error("S6: variant anchor not unique");
          writeFileSync(path,text.replace(m.after,`${m.after}\n${m.statement}`));replaced=B1_FILE;
          runnerPrecondition(def,{statement:m.statement});
        }
      }
      release.verifyExport(fullExport,fullFiles,replaced);
      frozen=artifacts.read();lastDeclaration=frozen.declaration;
      const settingsHook=apply.find(d=>d.mechanics.kind==="settings");
      const target=await cluster.engineTarget(db);
      let url=startupUrl(target,frozen.declaration);
      if(settingsHook && settingsHook.mechanics.kind==="settings"){
        url=startupUrlWith(target,resolveSettings(settingsHook.mechanics.settings,frozen.declaration));
        runnerPrecondition(settingsHook,Object.fromEntries(Object.entries(settingsHook.mechanics.settings).map(([k,v])=>[k,"from" in v?"<declaration>":"omit" in v?"<absent>":v.value])));
      }
      const outside=apply.find(d=>d.mechanics.kind==="outside-engine");
      let engineResult=null;
      if(outside){
        const owner=await cluster.connect(db);
        try{
          await owner.query("begin");
          await owner.query("select pg_catalog.set_config('kj.b1.co_resident_set_sha256',$1,true),pg_catalog.set_config('kj.b1.target_system_identifier',$2,true),pg_catalog.set_config('kj.b1.target_database',$3,true)",
            [frozen.declaration.setSha256,frozen.declaration.provenance.systemIdentifier,frozen.declaration.provenance.database]);
          await owner.query(migration.bytes.toString("utf8"));
          await owner.query("commit");
        }catch(error){await owner.query("rollback").catch(()=>undefined);throw error;}
        finally{await owner.end();}
        await sqlPrecondition(outside,db);
      } else {
        b1EngineInvoked=true;
        engineResult=engine.apply(fullExport,url);
        (observed.applications as unknown[]).push({sequence:seq,engine:engineResult});
        if(engineResult.exitStatus!==0){
          const r=engineRefusal(engineResult.stdout+engineResult.stderr);
          throw new EngineRefusal(r.sqlstate,r.message);
        }
      }
      for(const def of apply.filter(d=>d.mechanics.kind==="post-commit")){
        if(def.mechanics.kind!=="post-commit") continue;
        await ownerSql(db,def.mechanics.sql);await sqlPrecondition(def,db);
      }
      const afterClient=await cluster.connect(db);let after:string[],statementsDigest:string;
      try{
        after=(await afterClient.query<{version:string}>("select version from supabase_migrations.schema_migrations order by version")).rows.map(r=>r.version);
        statementsDigest=(await afterClient.query("select encode(sha256(convert_to(array_to_json(statements)::text,'UTF8')),'hex') as digest from supabase_migrations.schema_migrations where version='20261002090000'")).rows[0]?.digest ?? null;
      }finally{await afterClient.end();}
      if(!outside && JSON.stringify(after)!==JSON.stringify([...SEALED_BASE_VERSIONS,"20261002090000"])) throw Error("S6: ledgerAfter differs");
      evidence.applications.push({sequence:seq,database:db,migrationBlob,engineExitStatus:engineResult?.exitStatus ?? null,ledgerAfter:after,postLedgerCompared:false,postLedgerPassed:false});
      passed("S6",seq,{before:{versions:before.versions,inventory:before.inventory},after,files:fullFiles,
        engine:engineResult?{exitStatus:engineResult.exitStatus,environmentNames:engineResult.environmentNames}:null,statementsDigest,
        settings:new URL(url).searchParams.get("options")});
      let recordedBlob={...migrationBlob};
      const altered=apply.find(d=>d.mechanics.kind==="record-altered");
      if(altered){recordedBlob={id:"0".repeat(40),sha256:migrationBlob.sha256};runnerPrecondition(altered,{field:"migrationBlob"});}
      fileHooks("after-S6",artifacts);
      active="S7";
      const current=artifacts.read();
      const postClient=await cluster.connect(db);
      try{
        const post=await postLedgerGate(postClient,manifest,release.json(MANIFEST_PATH) as RuntimeRoleManifest,current.baseline,current.declaration,
          contract?.statementsSha256 ?? "",cleanupBefore);
        const atR=release.blob(`supabase/migrations/${B1_FILE}`);
        if(atR.id!==recordedBlob.id || atR.sha256!==recordedBlob.sha256) throw Error("S7_REFUSED: migrationBlob differs from the B1 blob at R");
        const application=evidence.applications.at(-1)!;
        application.postLedgerCompared=true;application.postLedgerPassed=true;
        passed("S7",seq,post);
      }finally{await postClient.end();}
    }
  }catch(error){
    failure=error instanceof Error?error.message:String(error);
    refusal={sqlstate:error instanceof EngineRefusal?error.sqlstate:null,message:failure};
    const step=active as Step,application=step.startsWith("S")?(evidence.applications.length+(step==="S7"?0:1)):undefined;
    // A lifecycle refusal is already recorded by the factory at its own L step; nothing is added after it.
    if(evidence.events.at(-1)?.outcome!=="refused")
      evidence.events.push({step,outcome:"refused",...(application?{application}:{}),details:failure});
    if(step.startsWith("S")){
      try{afterFacts=await facts(plannedApplications[(application ?? 1)-1]!.database);}catch{afterFacts=null;}
    }
  }
  finally{
    let teardownPassed=false;
    try{cluster.teardown();teardownPassed=true;}catch(error){failure??=String(error);}
    const lastRefused=[...evidence.events].reverse().find(e=>e.outcome==="refused");
    const end=failure?{step:(lastRefused?.step ?? "L6") as Step,outcome:"refused" as const}:{step:"L6" as Step,outcome:"completed" as const};
    const post:Partial<Record<Post,boolean>>={
      "catalogue-unchanged":Boolean(lastFacts && afterFacts && same(lastFacts,afterFacts)),
      "no-b1-effect":Boolean(afterFacts && noB1Effect(afterFacts)),
      "helper-proacl-null":Boolean(afterFacts && afterFacts.helperPresent && afterFacts.helperAcl===null),
      "s7-passed":evidence.events.some(e=>e.step==="S7" && e.outcome==="passed"),
      "declaration-crlf-forensic":Boolean(lastDeclaration && lastDeclaration.entries.length===1 && lastDeclaration.entries[0]!.hasCR &&
        lastDeclaration.entries[0]!.rawDigest!==lastDeclaration.entries[0]!.sourceDigest && lastDeclaration.entries[0]!.sourceDigest===pins.entries[0]!.sourceDigest),
      "fixture-removed":cluster.fixtures.length>0 && cluster.fixtures.every(f=>f.removed),
    };
    const observation:FixtureObservation={end,refusal,b1EngineInvoked,preconditions,post,teardownPassed};
    const problems=selected?fixtureProblems(selected.expectation,observation,input.hooks):[];
    const fixtureOutcome=selected?(problems.length?"failed":"passed"):"not-run";
    const status=qualificationStatus(evidence);
    const record={header,...evidence,observed:{...observed,factsAt,lastFacts,afterFacts},fixture:selected?{primary:selected.primary,observation,problems}:null,
      failure,status,fixtureOutcome,regressionOutcome:"not-run",stageT:{outcome:"not-run",reason:input.suite?"stage T is not implemented in this runner revision":"no regression suite"}};
    const bytes=JSON.stringify(record,null,2)+"\n";writeFileSync(join(directory,"record.json"),bytes,{flag:"wx",mode:0o600});
    let consumer="accepted";
    try{validateRunRecord(strictJson(bytes),release);}catch(error){consumer=error instanceof Error?error.message:String(error);process.exitCode=1;}
    console.log(JSON.stringify({directory,recordSha256:hash(bytes),status,fixtureOutcome,consumer,failure,problems}));
    if(selected?fixtureOutcome!=="passed":status!=="REPOSITORY_QUALIFIED") process.exitCode=1;
  }
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  runEphemeral(process.argv.slice(2)).catch(error=>{console.error(error instanceof Error?error.message:"EPHEMERAL_REFUSED");process.exitCode=1;});
}
