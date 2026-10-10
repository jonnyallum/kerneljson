import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hash } from "../../services/kernel/src/database/co-resident.js";
import { canonicalJson } from "../../services/kernel/src/database/security-definers.js";
import { strictJson } from "../../services/kernel/src/database/strict-json.js";
import type { EphemeralCluster } from "./ephemeral-cluster.js";
import type { FrozenArtifacts } from "./run-artifacts.js";
import type { Suite } from "./hooks.js";
import type { Release } from "./release.js";
import { extractLogRefusals, LOG_PREFIX, projectRefusals, refusalDifferences, type Refusal } from "./refusal-accounting.js";
import { readTraces } from "./trace.js";
import { parseReport, RequiredSchema, type Report } from "./coverage.js";
import type { CollectedEntry } from "./collection.js";

/**
 * ADR-0023 27.12.15 stage T. It runs inside the ephemeral entry point after S7 of the last planned application and
 * before L6, only for an unhooked run whose every application passed S1 to S7. It writes no L or S outcome, so it
 * cannot change the qualification status; it produces `regressionOutcome` and its evidence.
 */
export interface StageTInput {
  cluster:EphemeralCluster;release:Release;root:string;runId:string;suite:Suite;
  applications:{sequence:number;database:string;run:unknown;artifacts:FrozenArtifacts}[];
  collection:CollectedEntry[];partitionFiles:string[];
}
export interface StageTResult {
  outcome:"passed"|"failed";problems:string[];exitCode:number|null;
  reportSha256:string|null;traceHashes:Record<string,string>;logExtractSha256:string|null;
  logSettings:{before:unknown;after:unknown};markerPid:string|null;
  expected:Refusal[];trace:Refusal[];log:unknown[];databases:string[];network:string[];
  workingDirectory:string;durationMs:number;
}
const LOG_SETTINGS_SQL=`select current_setting('log_line_prefix') as log_line_prefix,current_setting('log_min_error_statement') as log_min_error_statement,
  current_setting('log_min_messages') as log_min_messages,current_setting('log_destination') as log_destination,
  current_setting('logging_collector') as logging_collector,
  coalesce((select pg_catalog.json_agg(pg_catalog.json_build_object('db',s.setdatabase,'role',s.setrole,'config',s.setconfig)
    order by s.setdatabase,s.setrole) from pg_catalog.pg_db_role_setting s),'[]'::json) as role_settings`;
const EXPECTED_SETTINGS={log_line_prefix:LOG_PREFIX,log_min_error_statement:"error",log_destination:"stderr",logging_collector:"off"};
/** The consumer's environment: the runner's own, every database, Supabase, KJ and proxy variable removed, then exactly these. */
export function consumerEnvironment(parent:NodeJS.ProcessEnv,added:Record<string,string>):Record<string,string>{
  const env:Record<string,string>={};
  for(const [k,v] of Object.entries(parent)){
    if(v===undefined) continue;
    if(/^(PG|SUPABASE_|KJ_)/i.test(k) || /^(DATABASE_URL|HTTPS?_PROXY|ALL_PROXY|NO_PROXY)$/i.test(k)) continue;
    env[k]=v;
  }
  return {...env,...added};
}
function settingsProblems(row:Record<string,unknown>):string[]{
  const problems:string[]=[];
  for(const [k,v] of Object.entries(EXPECTED_SETTINGS)) if(row[k]!==v) problems.push(`${k} is ${JSON.stringify(row[k])}`);
  if(!["warning","notice","info","log","debug1","debug2","debug3","debug4","debug5"].includes(String(row.log_min_messages))) problems.push(`log_min_messages is ${String(row.log_min_messages)}`);
  const roles=row.role_settings as {config:string[]}[];
  if(roles.some(r=>r.config.some(c=>/^(log_|client_min_messages)/i.test(c)))) problems.push("a role or database setting changes logging");
  return problems;
}
/** Both markers come from one owner backend held open for the whole of stage T, so the log window has one author. */
async function marker(client:Awaited<ReturnType<EphemeralCluster["connect"]>>,runId:string,which:"begin"|"end"):Promise<{pid:string;settings:Record<string,unknown>;problems:string[]}>{
  const settings=(await client.query(LOG_SETTINGS_SQL)).rows[0] as Record<string,unknown>;
  const problems=settingsProblems(settings);
  const pid=String((await client.query("select pg_catalog.pg_backend_pid() as pid")).rows[0].pid);
  await client.query(`do $kj$ begin raise log 'kj-t-${which} ${runId}'; end $kj$`);
  return {pid,settings,problems};
}
function docker(args:string[]):{ok:boolean;stdout:string;stderr:string}{
  const r=spawnSync("docker",args,{encoding:"utf8",timeout:120000,windowsHide:true,maxBuffer:256*1024*1024});
  return {ok:r.status===0 && !r.error,stdout:r.stdout ?? "",stderr:r.stderr ?? ""};
}
export async function runStageT(input:StageTInput):Promise<StageTResult>{
  const started=Date.now(),problems:string[]=[];
  const {cluster,suite,runId}=input;
  // 1. Log settings in the run's own cluster, then the begin marker.
  const setup=await cluster.connect("postgres");
  try{
    await setup.query(`alter system set log_line_prefix = '${LOG_PREFIX}'`);
    await setup.query("alter system set log_min_error_statement = 'error'");
    await setup.query("select pg_catalog.pg_reload_conf()");
  }finally{await setup.end();}
  // pg_reload_conf() is asynchronous: wait for the settings to be visible before the one begin marker is written.
  const markerClient=await cluster.connect("postgres");
  for(let i=0;i<40;i++){
    const row=(await markerClient.query(LOG_SETTINGS_SQL)).rows[0] as Record<string,unknown>;
    if(!settingsProblems(row).length) break;
    await new Promise(r=>setTimeout(r,250));
  }
  const begin=await marker(markerClient,runId,"begin");
  if(begin.problems.length) problems.push(...begin.problems.map(p=>`log settings before stage T: ${p}`));
  // 2. Working directory, trace directory, authority copies; never the run directory.
  const work=mkdtempSync(join(tmpdir(),`kj-b1-t-${runId}-`)),traceDir=join(work,"trace"),report=join(work,"report.json");
  mkdirSync(traceDir,{mode:0o777});
  const port=cluster.address.port;
  const databases=input.applications.map(a=>{
    const copies:Record<string,{path:string;sha256:string}>={};
    for(const key of ["baseline","declaration"] as const){
      const target=join(work,`${a.sequence}-${key}.json`);copyFileSync(a.artifacts.files[key],target);
      copies[key]={path:target,sha256:a.artifacts.digests()[key]};
      if(hash(readFileSync(target))!==copies[key]!.sha256) problems.push(`authority copy ${a.sequence} ${key} differs`);
    }
    return {name:a.database,sequence:a.sequence,ownerUrl:`postgresql://postgres@127.0.0.1:${port}/${a.database}?sslmode=disable`,
      networkOwnerUrl:`postgresql://postgres@kj-eph-db:5432/${a.database}?sslmode=disable`,run:a.run,baseline:copies.baseline!,declaration:copies.declaration!};
  });
  const token={runId,suite:suite.id};
  const env=consumerEnvironment(process.env,{
    KJ_RUNTIME_ROLES:suite.harness,KJ_B1_STAGE_T:"1",KJ_B1_RUN_TOKEN:JSON.stringify(token),KJ_B1_TRACE_DIR:traceDir,
    KJ_B1_CONSUMER_CONTEXT:JSON.stringify({kind:"kerneljson:b1-consumer-context/v1",runId,databases}),
    KJ_B1_RUN_NETWORK:`kj-eph-${runId}`,KJ_B1_REPORT:report,
    ...(suite.compose?{KJ_B1_COMPOSE_FILE:resolve(input.root,suite.compose)}:{}),
  });
  const argv=suite.argv.map(a=>a.replaceAll("${checkout}",resolve(input.root)).replaceAll("${report}",report));
  // 3. The suite, as a child process, bounded by its registered timeout.
  const exitCode=await new Promise<number|null>(done=>{
    const child=spawn(process.execPath,argv,{cwd:work,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let output="";
    child.stdout.on("data",d=>{output+=d;if(output.length>8e6) output=output.slice(-4e6);});
    child.stderr.on("data",d=>{output+=d;if(output.length>8e6) output=output.slice(-4e6);});
    const timer=setTimeout(()=>{problems.push(`suite exceeded its ${suite.timeoutSeconds}s timeout`);child.kill();},suite.timeoutSeconds*1000);
    child.on("close",code=>{clearTimeout(timer);writeFileSync(join(work,"suite-output.log"),output);done(code);});
  });
  if(exitCode!==0) problems.push(`suite exited ${String(exitCode)}`);
  // 4. Post-T reads through the factory (L3 and L5), then the end marker.
  const reader=await cluster.connect("postgres");let dbNames:string[]=[];
  try{dbNames=(await reader.query<{datname:string;oid:string}>("select datname,oid::text from pg_catalog.pg_database order by datname collate \"C\"")).rows.map(r=>r.datname);}
  finally{await reader.end();}
  const wantDbs=[...input.applications.map(a=>a.database),"postgres","template0","template1"].sort();
  if(canonicalJson(dbNames)!==canonicalJson(wantDbs)) problems.push(`post-T database list differs: ${dbNames.join(", ")}`);
  const net=docker(["network","inspect",`kj-eph-${runId}`]);let attached:string[]=[];
  if(!net.ok) problems.push("post-T network unreadable");
  else{
    const containers=(JSON.parse(net.stdout)[0]?.Containers ?? {}) as Record<string,{Name:string}>;
    attached=Object.keys(containers).sort();
    for(const id of attached){
      if(id===cluster.genuineContainerId) continue;
      const labels=docker(["inspect","--format","{{json .Config.Labels}}",id]);
      const l=labels.ok?JSON.parse(labels.stdout) as Record<string,string>:{};
      if(!suite.compose || l["com.docker.compose.project"]!=="kerneljson-regression") problems.push(`foreign container on the run network: ${containers[id]!.Name}`);
    }
    if(!attached.includes(cluster.genuineContainerId)) problems.push("the cluster left the run network");
  }
  let end:{pid:string;settings:Record<string,unknown>;problems:string[]};
  try{end=await marker(markerClient,runId,"end");}
  catch(error){problems.push(`end marker failed: ${error instanceof Error?error.message:String(error)}`);end={pid:"",settings:{},problems:["no end marker"]};}
  finally{await markerClient.end().catch(()=>undefined);}
  if(end.pid!==begin.pid) problems.push("the markers come from different backends");
  if(end.problems.length) problems.push(...end.problems.map(p=>`log settings after stage T: ${p}`));
  if(canonicalJson(end.settings)!==canonicalJson(begin.settings)) problems.push("log settings changed during stage T");
  // 5. The database log between the markers, read through the daemon.
  const logs=docker(["logs",cluster.genuineContainerId]);let logExtractSha256:string|null=null;
  let logRefusalsTyped:ReturnType<typeof extractLogRefusals>=[];
  if(!logs.ok) problems.push("database log unreadable");
  else{
    // PostgreSQL writes its log to standard error; the entry point's own lines on standard output are not log records.
    const text=logs.stderr;
    try{
      logRefusalsTyped=extractLogRefusals(text,runId,begin.pid);
      const window=text.slice(text.indexOf(`kj-t-begin ${runId}`),text.indexOf(`kj-t-end ${runId}`));
      writeFileSync(join(work,"log-extract.txt"),window);logExtractSha256=hash(window);
    }catch(error){problems.push(error instanceof Error?error.message:String(error));}
  }
  // 6. Traces: read by the runner from the directory it created, hashed, and accounted.
  let traceRefusals:Refusal[]=[],traceHashes:Record<string,string>={};
  try{
    const traces=readTraces(traceDir,token,suite.roles);
    traceRefusals=traces.refusals;traceHashes=traces.hashes;
    if(suite.harness==="enforce" && traces.events.some(e=>e.kind==="refused" && e.classification==="production")) problems.push("a production statement was refused");
  }catch(error){problems.push(error instanceof Error?error.message:String(error));}
  // 7. Expected refusal multiset: empty, or the declared refusals of the probe tests the suite runs.
  let expected:Refusal[]=[];
  if(suite.refusalPolicy==="probes"){
    const required=RequiredSchema.parse(strictJson(input.release.blob("tests/b1-required.json").bytes.toString("utf8")));
    expected=required.entries.filter(e=>suite.files.includes(e.file)).flatMap(e=>e.refusals.map(r=>({test:e.name,...r})));
  }
  problems.push(...refusalDifferences(expected,traceRefusals,logRefusalsTyped));
  // 8. The report: complete for the suite's files, every entry passed or an accounted skip.
  let reportSha256:string|null=null;
  if(!existsSync(report)) problems.push("suite report missing");
  else{
    const raw=readFileSync(report,"utf8");reportSha256=hash(raw);
    try{
      const parsed:Report=parseReport(raw,input.root);
      const files=[...suite.files].sort();
      if(canonicalJson(parsed.files)!==canonicalJson(files)) problems.push("report file set differs from the suite's files");
      const located=new Set(parsed.entries.map(e=>`${e.file}:${e.location.line}:${e.location.column}`));
      const collected=input.collection.filter(e=>files.includes(e.file));
      for(const c of collected) if(!located.has(`${c.file}:${c.location.line}:${c.location.column}`)) problems.push(`collected location without a report entry: ${c.file}:${c.location.line}`);
      if(!parsed.entries.length) problems.push("report has no tests");
    }catch(error){problems.push(error instanceof Error?error.message:String(error));}
  }
  return {outcome:problems.length?"failed":"passed",problems,exitCode,reportSha256,traceHashes,logExtractSha256,
    logSettings:{before:begin.settings,after:end.settings},markerPid:begin.pid,expected,trace:traceRefusals,log:projectRefusals(logRefusalsTyped),
    databases:dbNames,network:attached,workingDirectory:work,durationMs:Date.now()-started};
}
