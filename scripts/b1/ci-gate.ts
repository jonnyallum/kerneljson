import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { strictJson } from "../../services/kernel/src/database/strict-json.js";
import { hash } from "../../services/kernel/src/database/co-resident.js";
import { Release } from "./release.js";
import { readRunRecord } from "./evidence.js";
import { PartitionSchema, RequiredSchema, coverageProblems, parseReport, partitionProblems, type Report } from "./coverage.js";
import { REGRESSION_SUITES } from "./plans.js";
import { extractLogRefusals, refusalDifferences, type Refusal } from "./refusal-accounting.js";
import { readTraces } from "./trace.js";
import type { CollectedEntry } from "./collection.js";

/**
 * ADR-0023 27.12.15 "CI gate over every registered suite": the commit is refused unless, for every primary and
 * secondary suite of the partition at R, exactly one valid result exists for this commit, and G1 to G9 and the merged
 * coverage hold. Every status is recomputed here from the evidence files; nothing a job reports about itself is
 * trusted. Usage: ci-gate <R> <evidence directory>. Writes <evidence directory>/gate.json.
 */
const [R,root]=process.argv.slice(2);
if(!/^[0-9a-f]{40}$/.test(R ?? "") || !root) throw Error("usage: ci-gate <R> <evidence directory>");
const release=new Release(process.cwd(),R!);
const problems:string[]=[],results:Record<string,unknown>={};
const fail=(gate:string,message:string)=>problems.push(`${gate}: ${message}`);
const readJson=(path:string)=>strictJson(readFileSync(path,"utf8"));
const partition=PartitionSchema.parse(strictJson(release.blob("tests/lanes.json").bytes.toString("utf8")));
const required=RequiredSchema.parse(strictJson(release.blob("tests/b1-required.json").bytes.toString("utf8")));
const baseline=strictJson(release.blob("tests/baseline.json").bytes.toString("utf8")) as {tests:{file:string;name:string}[];intentionalSkips:{file:string;name:string}[]};

// Collection (CON-47), taken at R by the static job.
const collectionFile=join(root!,"static","collection.json");
let collection:CollectedEntry[]=[];
if(!existsSync(collectionFile)) fail("CON-47","collection missing");
else{
  const c=readJson(collectionFile) as {entries:CollectedEntry[];acceptedConnections:number};
  collection=c.entries;
  if(c.acceptedConnections!==0) fail("CON-47","collection connected to the placeholder");
}
const committed=Object.keys(partition.files).sort();
const pp=partitionProblems(partition,committed,collection,REGRESSION_SUITES.map(s=>({id:s.id,files:[...s.files]})));
for(const p of pp) fail("partition",p);

// Stage T suites: one record each, for R, recomputed status and regressionOutcome, and the accounting recomputed.
const reports=new Map<string,Report>();
for(const suite of REGRESSION_SUITES){
  const dir=join(root!,"stage-t",suite.id);
  const summaryPath=join(dir,"summary.json");
  if(!existsSync(summaryPath)){fail(suite.id,"no result for this suite");continue;}
  const {summary}=readJson(summaryPath) as {summary:{recordSha256?:string}};
  try{
    const record=readRunRecord(join(dir,"run","record.json"),summary.recordSha256 ?? "",release);
    const st=record.stageT as {outcome?:string;problems?:string[];expected?:Refusal[];reportSha256?:string;traceHashes?:Record<string,string>;
      logExtractSha256?:string;markerPid?:string};
    if(record.header.R!==R) fail(suite.id,"record is for another commit");
    if(record.header.regressionSuite!==suite.id || record.header.profile!==suite.profile) fail(suite.id,"record names another suite or profile");
    if(record.status!=="REPOSITORY_QUALIFIED") fail(suite.id,`status ${record.status}`);
    if(record.regressionOutcome!=="passed" || st.outcome!=="passed" || (st.problems ?? []).length) fail(suite.id,`regressionOutcome ${record.regressionOutcome}: ${(st.problems ?? []).join("; ")}`);
    const work=join(dir,"stage-t");
    const reportText=readFileSync(join(work,"report.json"),"utf8");
    if(hash(reportText)!==st.reportSha256) fail(suite.id,"report differs from the recorded digest");
    const report=parseReport(reportText,process.cwd());
    if(!suite.id.endsWith("-discover")) reports.set(suite.id,report);
    const token={runId:record.header.runId,suite:suite.id};
    const traces=readTraces(join(work,"trace"),token,suite.roles,st.traceHashes);
    const log=readFileSync(join(work,"database-log.txt"),"utf8");
    if(hash(log)!==st.logExtractSha256) fail(suite.id,"database log differs from the recorded digest");
    const logRefusals=extractLogRefusals(log,record.header.runId,st.markerPid ?? "");
    const expected=suite.refusalPolicy==="probes"?required.entries.filter(e=>suite.files.includes(e.file)).flatMap(e=>e.refusals.map(r=>({test:e.name,...r}))):[];
    const trace=traces.refusals.map(r=>({...r,test:r.test.split(" > ").join(" ")}));
    for(const p of refusalDifferences(expected,trace,logRefusals)) fail(suite.id,p);
    const inventory=spawnSync(process.execPath,[resolve("scripts/b1/analyse-trace.mjs"),join(work,"trace"),join(work,"gate-inventory.json"),"--fail-on-refusal"],{encoding:"utf8"});
    if(inventory.status!==0) fail(suite.harness==="enforce"?"G4":"G5",`${suite.id}: ${inventory.stderr.slice(0,400)}`);
    results[suite.id]={status:record.status,regressionOutcome:record.regressionOutcome,recordSha256:summary.recordSha256,tests:report.entries.length};
  }catch(error){fail(suite.id,error instanceof Error?error.message:String(error));}
}
// base-regression and runner-cases: complete reports for this commit.
for(const [suite,files] of [["base-regression",["base-regression.json"]],["runner-cases",readdirSync(join(root!,"runner-cases")).filter(f=>f.endsWith(".json")).sort()]] as const){
  const merged:Report={files:[],entries:[]};
  try{
    for(const f of files){
      const r=parseReport(readFileSync(join(root!,suite,f),"utf8"),process.cwd());
      merged.files.push(...r.files);merged.entries.push(...r.entries);
    }
    merged.files.sort();reports.set(suite,merged);
    results[suite]={tests:merged.entries.length,files:merged.files.length};
  }catch(error){fail(suite,error instanceof Error?error.message:String(error));}
}
// Merged coverage, G2 and G3 (protected tests, intentional skips, recovery) and the b1-required match.
for(const p of coverageProblems(partition,collection,reports,baseline,required)) fail("coverage",p);
// G2 again with the frozen script, over the merged report of every primary suite.
const mergedReport={success:problems.length===0,numFailedTests:0,numTotalTests:[...reports.values()].reduce((n,r)=>n+r.entries.length,0),
  numPendingTests:[...reports.values()].reduce((n,r)=>n+r.entries.filter(e=>e.status==="skipped").length,0),
  testResults:[...reports.values()].flatMap(r=>r.files.map(file=>({name:resolve(file),assertionResults:r.entries.filter(e=>e.file===file).map(e=>({fullName:e.name,status:e.status}))})))};
writeFileSync(join(root!,"merged-report.json"),JSON.stringify(mergedReport));
const g2=spawnSync(process.execPath,["scripts/check-baseline.mjs",join(root!,"merged-report.json")],{encoding:"utf8"});
if(g2.status!==0) fail("G2/G3",g2.stderr.slice(0,800));
results["G2/G3"]=g2.stdout.trim();
// G7: each mutation suite ran, lists exactly its sealed number of mutations, every one killed.
const SEALED:Record<string,number>={"faculties":5,"identity":57,"identity-cognition":62};
for(const [id,count] of Object.entries(SEALED)){
  const out=join(root!,"mutations",`${id}.txt`);
  if(!existsSync(out)){fail("G7",`${id} did not run`);continue;}
  const text=readFileSync(out,"utf8");
  const verdicts=id==="faculties"?[...text.matchAll(/^(F[0-9]+): detected by ([0-9]+) failed assertions$/gm)].map(m=>[m[1]!,"KILLED"]):
    [...text.matchAll(/^([A-Z][0-9]+) (KILLED-PRECOMMIT|KILLED|SURVIVED|INCONCLUSIVE|CANNOT APPLY)\b/gm)].map(m=>[m[1]!,m[2]!]);
  const ids=new Set(verdicts.map(v=>v[0]));
  if(ids.size!==count || verdicts.length!==count) fail("G7",`${id}: ${ids.size} mutation verdicts, sealed ${count}`);
  const bad=verdicts.filter(v=>!["KILLED","KILLED-PRECOMMIT"].includes(v[1]!));
  if(bad.length) fail("G7",`${id}: not killed: ${bad.map(v=>v.join(" ")).join(", ")}`);
  if(id!=="faculties" && !/ALL MUTATIONS KILLED/.test(text)) fail("G7",`${id}: no ALL MUTATIONS KILLED line`);
  results[`G7 ${id}`]={verdicts:verdicts.length};
}
// G8: the B1 evidence files of the probe and definer suites, every row present and passed.
const evidenceFile=(suite:string,file:string)=>join(root!,"stage-t",suite,"stage-t","artifacts","local",file);
const g8:[string,string,(v:Record<string,unknown>)=>boolean][]=[
  ["regression-probes","b1-negative-probes.json",v=>(v.results as {pass:boolean}[]).length>0 && (v.results as {pass:boolean}[]).every(r=>r.pass)],
  ["regression-probes","b1-definer-probes.json",v=>(v.results as {pass:boolean}[]).length>0 && (v.results as {pass:boolean}[]).every(r=>r.pass)],
  ["regression-definers","b1-definers.json",v=>(v.fixtures as {failedOnPurpose:boolean;restored:boolean}[]).length===28 &&
    (v.fixtures as {failedOnPurpose:boolean;restored:boolean}[]).every(f=>f.failedOnPurpose && f.restored)],
];
for(const [suite,file,ok] of g8){
  const path=evidenceFile(suite,file);
  if(!existsSync(path)) fail("G8",`${file} missing`);
  else if(!ok(readJson(path) as Record<string,unknown>)) fail("G8",`${file} holds a row not passed`);
}
// G1 and G9 are jobs of their own; their markers are written only on success.
for(const [gate,marker] of [["G1","static/g1-passed"],["G9","worker-image/g9-passed"],["EPH-26","eph26/eph26-passed"]] as const)
  if(!existsSync(join(root!,marker))) fail(gate,"did not pass");
writeFileSync(join(root!,"gate.json"),JSON.stringify({R,problems,results},null,2)+"\n");
if(problems.length){console.error(problems.join("\n"));process.exitCode=1;}
else console.log(`CI gate passed for ${R}`);
