import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { z } from "zod";
import { DECLARATION_PATH, HASH, PINS_PATH, hash, parseDeclaration } from "../../services/kernel/src/database/co-resident.js";
import { BaselineSchema, PLATFORM_BASELINE_PATH, artifactPairProblems, baselineProblems } from "../../services/kernel/src/database/security-definers.js";
import { MANIFEST_PATH, type RuntimeRoleManifest } from "../../services/kernel/src/database/runtime-roles.js";
import { strictJson } from "../../services/kernel/src/database/strict-json.js";
import { B1_FILE, Release } from "./release.js";
import { prepareEngine, startupUrl } from "./engine.js";
import { postLedgerGate, preLedgerGate, type CleanupMember } from "./ledger.js";

// No wildcard passfile matches or ambient connection defaults. TLS trust is explicit.
const field=z.string().min(1).refine(s=>Array.from(s).every(c=>c.charCodeAt(0)>=32 && c.charCodeAt(0)!==127 && c!=="*"));
const Target=z.strictObject({kind:z.literal("kerneljson:b1-hosted-target/v1"),
  host:field.refine(s=>!/[\s/@?#\\]/.test(s)),port:z.number().int().min(1).max(65535),
  database:field.refine(s=>Buffer.byteLength(s)<=63),user:field,password:field,ca:z.string().min(1)});
export function hostedArguments(argv:string[]):{R:string;targetFile:string}{
  if(argv.length!==4 || argv[0]!=="--release" || !/^[0-9a-f]{40}$/.test(argv[1]!) ||
    argv[2]!=="--target-file" || !argv[3] || argv[3].startsWith("--"))
    throw Error("HOSTED_REFUSED: expected --release <SHA> --target-file <credential file>");
  return {R:argv[1]!,targetFile:resolve(argv[3])};
}
export function parseHostedTarget(text:string):z.infer<typeof Target>{
  try{return Target.parse(strictJson(text));}catch{throw Error("HOSTED_REFUSED: invalid target credential file");}
}
export function hostedPassfile(target:z.infer<typeof Target>):string{
  const escape=(s:string)=>s.replaceAll("\\","\\\\").replaceAll(":","\\:");
  return [target.host,String(target.port),target.database,target.user,target.password].map(escape).join(":")+"\n";
}
export function hostedAuthority(release:Release){
  const {manifest,files}=release.migrations(),migration=files.get(B1_FILE)!;
  const declarationBlob=release.blob(DECLARATION_PATH),baselineBlob=release.blob(PLATFORM_BASELINE_PATH),pinsBlob=release.blob(PINS_PATH);
  const declaration=parseDeclaration(declarationBlob.bytes.toString("utf8"));
  const baseline=BaselineSchema.parse(strictJson(baselineBlob.bytes.toString("utf8")));
  if(declaration.mode!=="HOSTED_COMMITTED" || baseline.mode!=="HOSTED_COMMITTED") throw Error("HOSTED_REFUSED: committed hosted artifacts required");
  const problems=[...artifactPairProblems(baseline,declaration),...baselineProblems(baseline,manifest)];
  if(problems.length) throw Error("HOSTED_REFUSED: authority artifacts differ");
  if(pinsBlob.sha256!==declaration.pinsSha256 || !migration.bytes.toString("utf8").includes(`-- Sealed pins: ${JSON.stringify(release.json(PINS_PATH))}`))
    throw Error("HOSTED_REFUSED: migration pins differ");
  const contract=z.strictObject({kind:z.literal("kerneljson:b1-ledger-contract/v1"),migrationSha256:HASH,
    statementsSha256:HASH,engineVersion:z.literal("2.120.0")}).parse(release.json("infrastructure/database/b1-ledger-contract.json"));
  if(contract.migrationSha256!==migration.sha256) throw Error("HOSTED_REFUSED: ledger contract belongs to another migration");
  return {manifest,migration,declaration,baseline,contract,blobs:{declaration:declarationBlob.id,baseline:baselineBlob.id,pins:pinsBlob.id}};
}
export async function runHosted(argv:string[],root=process.cwd()):Promise<void>{
  const input=hostedArguments(argv),release=new Release(root,input.R),authority=hostedAuthority(release);
  const target=parseHostedTarget(readFileSync(input.targetFile,"utf8"));
  if(target.database!==authority.declaration.provenance.database || target.user!==authority.declaration.provenance.snapshotUser)
    throw Error("HOSTED_REFUSED: credential target differs from committed authority");
  const directory=mkdtempSync(join(tmpdir(),"kj-b1-cutover-"));
  const engine=await prepareEngine(release,join(directory,"verified"));
  const exported=join(directory,"export"),files=release.exportMigrations(exported);
  const caFile=join(directory,"root.crt"),passfile=join(directory,"pgpass");
  writeFileSync(caFile,target.ca,{flag:"wx",mode:0o600});
  const connect=async()=>{
    const client=new pg.Client({host:target.host,port:target.port,database:target.database,user:target.user,password:target.password,
      ssl:{ca:target.ca,rejectUnauthorized:true},options:"",application_name:"kj-b1-hosted",connectionTimeoutMillis:10000});
    try{await client.connect();return client;}catch(error){await client.end().catch(()=>undefined);throw error;}
  };
  const record:Record<string,unknown>={kind:"kerneljson:b1-cutover-record/v1",R:input.R,mode:"HOSTED_COMMITTED",
    blobs:authority.blobs,migrationBlob:{id:authority.migration.id,sha256:authority.migration.sha256},
    pinsSha256:authority.declaration.pinsSha256,setSha256:authority.declaration.setSha256,files,
    engine:{version:engine.pins.version,platform:engine.platform,hashes:engine.executableHashes},status:"NOT_QUALIFIED"};
  let passfileCreated=false;
  try{
    const pre=await connect();
    let cleanup:CleanupMember[]|null=null;
    try{const before=await preLedgerGate(pre,authority.manifest,authority.baseline,authority.declaration);cleanup=before.cleanup;
      record.before={versions:before.versions,inventory:before.inventory};}finally{await pre.end();}
    // Recheck release cleanliness and immutable authority immediately before engine invocation.
    const current=hostedAuthority(new Release(root,input.R));
    if(JSON.stringify(current.blobs)!==JSON.stringify(authority.blobs)) throw Error("HOSTED_REFUSED: authority blobs changed");
    const url=new URL("postgresql://localhost");
    url.hostname=target.host.includes(":")?`[${target.host}]`:target.host;
    url.port=String(target.port);url.username=target.user;url.pathname=`/${encodeURIComponent(target.database)}`;
    url.searchParams.set("sslmode","verify-full");url.searchParams.set("sslrootcert",caFile);
    writeFileSync(passfile,hostedPassfile(target),{flag:"wx",mode:0o600});passfileCreated=true;
    let result;
    try{result=engine.apply(exported,startupUrl(url.toString(),authority.declaration),passfile);}
    finally{unlinkSync(passfile);passfileCreated=false;}
    // Engine diagnostics can include connection details. Store only bounded non-secret status fields.
    record.application={exitStatus:result.exitStatus,signal:result.signal,environmentNames:result.environmentNames};
    if(result.exitStatus!==0) throw Error("HOSTED_REFUSED: migration engine failed");
    const afterAuthority=hostedAuthority(new Release(root,input.R));
    if(JSON.stringify(afterAuthority.blobs)!==JSON.stringify(authority.blobs)) throw Error("HOSTED_REFUSED: post-application authority changed");
    const post=await connect();
    try{record.after=await postLedgerGate(post,authority.manifest,release.json(MANIFEST_PATH) as RuntimeRoleManifest,
      afterAuthority.baseline,afterAuthority.declaration,authority.contract.statementsSha256,cleanup);}finally{await post.end();}
    record.status="HOSTED_APPLICATION_CHECKS_PASSED";
  }catch{record.failure="Hosted application or qualification refused";process.exitCode=1;}
  finally{
    if(passfileCreated) unlinkSync(passfile);
    const bytes=JSON.stringify(record,null,2)+"\n";
    writeFileSync(join(directory,"record.json"),bytes,{flag:"wx",mode:0o600});
    console.log(JSON.stringify({directory,recordSha256:hash(bytes),status:record.status}));
  }
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  // Preflight messages are fixed texts or artifact validation results; the credential file is only ever parsed by
  // parseHostedTarget, whose refusal is one fixed message, so no credential can reach this output.
  runHosted(process.argv.slice(2)).catch(error=>{
    const first=(error instanceof Error?error.message:"").split("\n")[0]!.slice(0,300);
    console.error(/^(HOSTED_REFUSED|RELEASE_REFUSED|ENGINE_REFUSED|co-resident [a-zA-Z0-9 ]+)/.test(first)?`HOSTED_REFUSED: preflight failed: ${first}`:"HOSTED_REFUSED: preflight failed");
    process.exitCode=1;
  });
}
