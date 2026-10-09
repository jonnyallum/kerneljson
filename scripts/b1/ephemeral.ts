import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { hash, HASH, pins, PINS_PATH } from "../../services/kernel/src/database/co-resident.js";
import { snapshotArtifacts } from "../../services/kernel/src/database/platform-baseline-snapshot.js";
import { MANIFEST_PATH, type RuntimeRoleManifest } from "../../services/kernel/src/database/runtime-roles.js";
import { SEALED_BASE_VERSIONS } from "../../services/kernel/src/database/ledger-contract.js";
import { Release, B1_FILE, HOOKS_PATH } from "./release.js";
import { prepareEngine, startupUrl } from "./engine.js";
import { EphemeralCluster } from "./ephemeral-cluster.js";
import { freezeArtifacts } from "./run-artifacts.js";
import { preLedgerGate, postLedgerGate } from "./ledger.js";
import { qualificationStatus, type RunEvidence, type Step } from "./run-status.js";

// Deliberately closed while the negative-case and stage-T registries are being implemented.
// Unsupported hooks/suites refuse before L1; no partial registry can authorize a consumer.
const Registry=z.strictObject({kind:z.literal("kerneljson:b1-runner-hook-registry/v1"),
  setupProfiles:z.array(z.strictObject({id:z.enum(["none","pinned-helper","platform-definer-fixture"]),sql:z.string().nullable(),sha256:HASH.nullable()})),
  hooks:z.array(z.never()),regressionSuites:z.array(z.never())});
const Contract=z.strictObject({kind:z.literal("kerneljson:b1-ledger-contract/v1"),migrationSha256:HASH,statementsSha256:HASH,engineVersion:z.literal("2.120.0")});
export function ephemeralArguments(argv:string[]):{R:string;profile:string}{
  if(argv.length!==4 || argv[0]!=="--release" || !/^[0-9a-f]{40}$/.test(argv[1]!) || argv[2]!=="--profile" ||
    !["none","pinned-helper","platform-definer-fixture"].includes(argv[3]!)) throw Error("EPHEMERAL_REFUSED: expected --release <SHA> --profile <registered profile>; no other input accepted");
  return {R:argv[1]!,profile:argv[3]!};
}
export async function runEphemeral(argv:string[],root=process.cwd()):Promise<void>{
  const input=ephemeralArguments(argv),release=new Release(root,input.R);
  const {manifest,files}=release.migrations(),migration=files.get(B1_FILE)!;
  const registryBlob=release.blob(HOOKS_PATH),registry=Registry.parse(release.json(HOOKS_PATH));
  if(JSON.stringify(registry.setupProfiles.map(p=>p.id))!==JSON.stringify(["none","pinned-helper","platform-definer-fixture"])) throw Error("EPHEMERAL_REFUSED: setup profile set differs");
  for(const profile of registry.setupProfiles){
    if(profile.id==="none"){if(profile.sql!==null || profile.sha256!==null) throw Error("EPHEMERAL_REFUSED: none profile mutated");}
    else if(!profile.sql || !profile.sha256 || release.blob(profile.sql).sha256!==profile.sha256) throw Error("EPHEMERAL_REFUSED: fixture hash differs");
  }
  const profile=registry.setupProfiles.find(p=>p.id===input.profile)!;
  if(!migration.bytes.toString("utf8").includes(`-- Sealed pins: ${JSON.stringify(release.json(PINS_PATH))}`) ||
    JSON.stringify(release.json(PINS_PATH))!==JSON.stringify(pins)) throw Error("EPHEMERAL_REFUSED: migration or checkout pins differ");
  const contractPath="infrastructure/database/b1-ledger-contract.json";
  const hasContract=release.git(["ls-tree","--name-only",input.R,"--",contractPath]).toString().trim()===contractPath;
  const contract=hasContract ? Contract.parse(release.json(contractPath)) : null;
  if(contract && contract.migrationSha256!==migration.sha256) throw Error("EPHEMERAL_REFUSED: ledger contract belongs to another migration blob");
  const preflight=mkdtempSync(join(tmpdir(),"kj-b1-engine-"));
  const engine=await prepareEngine(release,join(preflight,"verified"));
  const runId=randomBytes(16).toString("hex"),clusterNonce=randomBytes(16).toString("hex");
  const directory=mkdtempSync(join(tmpdir(),`kj-b1-${runId}-`));
  const migrationBlob={id:migration.id,sha256:migration.sha256};
  const evidence:RunEvidence={negativeFixture:false,hookIds:[],migrationBlob,baseVersions:[...SEALED_BASE_VERSIONS],
    plannedApplications:[{sequence:1,database:"kj_b1",version:"20261002090000",migrationBlob}],events:[],applications:[]};
  const header={kind:"kerneljson:b1-ephemeral-run/v1",runId,clusterNonce,R:input.R,runnerBlob:release.blob("scripts/b1/ephemeral.ts").id,
    registryBlob:registryBlob.id,profile:input.profile,hookIds:[],negativeFixture:false,planId:"base",regressionSuite:null,
    plannedApplications:evidence.plannedApplications,hostTime:new Date().toISOString()};
  writeFileSync(join(directory,"header.json"),JSON.stringify(header,null,2)+"\n",{flag:"wx",mode:0o600});
  evidence.events.push({step:"L1",outcome:"passed",details:{headerSha256:hash(JSON.stringify(header,null,2)+"\n")}});
  // Defend against an ephemeral identifier matching any committed hosted authority artifact.
  const hostedIds:string[]=[];
  for(const path of ["infrastructure/database/co-resident-platform-exceptions.json","infrastructure/database/security-definer-platform-baseline.json"]){
    if(release.git(["ls-tree","--name-only",input.R,"--",path]).toString().trim()===path){
      const value=release.json(path) as {mode?:string;provenance?:{systemIdentifier?:string}};
      if(value.mode==="HOSTED_COMMITTED" && value.provenance?.systemIdentifier) hostedIds.push(value.provenance.systemIdentifier);
    }
  }
  const cluster=new EphemeralCluster(runId,clusterNonce,engine.pins.image,engine.pins.serverVersion,["kj_b1"],hostedIds,event=>evidence.events.push(event));
  let active:Step="L2",failure:string|null=null;
  const observed:Record<string,unknown>={engine:{version:engine.pins.version,platform:engine.platform,hashes:engine.executableHashes}};
  const passed=(step:Step,details:unknown)=>{evidence.events.push({step,outcome:"passed",application:1,details});};
  try{
    await cluster.create();active="S1";
    const bootstrap=await cluster.connect("postgres");
    try{
      await bootstrap.query("create role anon nologin; create role authenticated nologin; create role service_role nologin");
      await bootstrap.query("create database kj_b1 template template0");
    }finally{await bootstrap.end();}
    const baseExport=join(directory,"base-export"),baseFiles=release.exportMigrations(baseExport,true);
    const baseResult=engine.apply(baseExport,await cluster.engineTarget("kj_b1"));
    if(baseResult.exitStatus!==0) throw Error(`S1: engine failed: ${baseResult.stderr}`);
    const baseClient=await cluster.connect("kj_b1");let baseVersions:string[];
    try{baseVersions=(await baseClient.query<{version:string}>("select version from supabase_migrations.schema_migrations order by version")).rows.map(r=>r.version);}
    finally{await baseClient.end();}
    if(JSON.stringify(baseVersions)!==JSON.stringify(SEALED_BASE_VERSIONS)) throw Error("S1: base ledger differs");
    passed("S1",{files:baseFiles,engine:baseResult,baseVersions});active="S2";
    if(profile.sql){const client=await cluster.connect("kj_b1");try{await client.query(release.blob(profile.sql).bytes.toString("utf8"));}finally{await client.end();}}
    passed("S2",{profile:profile.id});active="S3";
    const client=await cluster.connect("kj_b1");
    let pair;
    try{pair=await snapshotArtifacts(client,"ephemeral",manifest,{mode:"EPHEMERAL_RUN_BOUND",run:{runId,clusterNonce,containerId:cluster.containerId,containerCreated:cluster.created,application:1}});}
    finally{await client.end();}
    const artifacts=freezeArtifacts(directory,1,pair,manifest);passed("S3",artifacts.digests);active="S4";
    artifacts.read();passed("S4",artifacts.digests);active="S5";passed("S5",{hooks:[]});active="S6";
    const frozen=artifacts.read(),gateClient=await cluster.connect("kj_b1");
    let before;try{before=await preLedgerGate(gateClient,manifest,frozen.baseline,frozen.declaration);}finally{await gateClient.end();}
    const fullExport=join(directory,"full-export"),fullFiles=release.exportMigrations(fullExport);
    const engineUrl=startupUrl(await cluster.engineTarget("kj_b1"),artifacts.read().declaration);
    const result=engine.apply(fullExport,engineUrl);observed.S6Engine=result;
    if(result.exitStatus!==0) throw Error(`S6: engine failed: ${result.stderr}`);
    const afterClient=await cluster.connect("kj_b1");
    let after:string[],statementsDigest:string;
    try{
      after=(await afterClient.query<{version:string}>("select version from supabase_migrations.schema_migrations order by version")).rows.map(r=>r.version);
      statementsDigest=(await afterClient.query("select encode(sha256(convert_to(array_to_json(statements)::text,'UTF8')),'hex') as digest from supabase_migrations.schema_migrations where version='20261002090000'")).rows[0]?.digest;
    }finally{await afterClient.end();}
    observed.statementsDigest=statementsDigest;
    if(JSON.stringify(after)!==JSON.stringify([...SEALED_BASE_VERSIONS,"20261002090000"])) throw Error("S6: ledgerAfter differs");
    evidence.applications.push({sequence:1,database:"kj_b1",migrationBlob,engineExitStatus:result.exitStatus,ledgerAfter:after,postLedgerCompared:false,postLedgerPassed:false});
    passed("S6",{before,after,files:fullFiles,engine:result,statementsDigest});active="S7";
    const postClient=await cluster.connect("kj_b1");
    try{
      const current=artifacts.read();
      const post=await postLedgerGate(postClient,manifest,release.json(MANIFEST_PATH) as RuntimeRoleManifest,current.baseline,current.declaration,contract?.statementsSha256 ?? "");
      evidence.applications[0]!.postLedgerCompared=true;evidence.applications[0]!.postLedgerPassed=true;passed("S7",post);
    }finally{await postClient.end();}
  }catch(error){failure=error instanceof Error?error.message:String(error);evidence.events.push({step:active,outcome:"refused",...(active.startsWith("S")?{application:1}:{}),details:failure});}
  finally{
    try{cluster.teardown();}catch(error){failure??=String(error);}
    const status=qualificationStatus(evidence),record={header,...evidence,observed,failure,status,regressionOutcome:"not-run"};
    const bytes=JSON.stringify(record,null,2)+"\n";writeFileSync(join(directory,"record.json"),bytes,{flag:"wx",mode:0o600});
    console.log(JSON.stringify({directory,recordSha256:hash(bytes),status,failure}));
    if(status!=="REPOSITORY_QUALIFIED") process.exitCode=1;
  }
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  runEphemeral(process.argv.slice(2)).catch(error=>{console.error(error instanceof Error?error.message:"EPHEMERAL_REFUSED");process.exitCode=1;});
}
