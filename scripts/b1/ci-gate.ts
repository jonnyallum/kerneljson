import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { strictJson } from "../../services/kernel/src/database/strict-json.js";
import { Release } from "./release.js";
import { PartitionSchema, RequiredSchema, coverageProblems, parseReport, partitionProblems, type Report } from "./coverage.js";
import { REGRESSION_SUITES } from "./plans.js";
import type { CollectedEntry } from "./collection.js";
import { stageTSuiteResult } from "./gate-suite.js";
import { SEALED_MUTATIONS, mutationVerdictProblems, mutationVerdicts } from "./gates.js";
import { expectedG8Rows, g8Files, g8SuiteProblems, type ExpectedG8 } from "./g8.js";

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
const reports=new Map<string,Report>(),suiteEvidence=new Map<string,Map<string,Buffer>>();
for(const suite of REGRESSION_SUITES){
  const r=stageTSuiteResult(join(root!,"stage-t",suite.id),suite,R!,release,required,process.cwd());
  for(const [gate,message] of r.problems) fail(gate,message);
  if(r.report && !suite.id.endsWith("-discover")) reports.set(suite.id,r.report);
  if(r.evidence) suiteEvidence.set(suite.id,r.evidence);
  Object.assign(results,r.results);
}
// base-regression and runner-cases: complete reports for this commit.
for(const [suite,files] of [["base-regression",["base-regression.json"]],["runner-cases",existsSync(join(root!,"runner-cases"))?readdirSync(join(root!,"runner-cases")).filter(f=>f.endsWith(".json")).sort():[]]] as const){
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
for(const id of Object.keys(SEALED_MUTATIONS)){
  const out=join(root!,"mutations",`${id}.txt`);
  if(!existsSync(out)){fail("G7",`${id} did not run`);continue;}
  const text=readFileSync(out,"utf8");
  for(const p of mutationVerdictProblems(id,text)) fail("G7",p);
  results[`G7 ${id}`]={verdicts:mutationVerdicts(id,text).length};
}
// G8 (gate table "B1 evidence files", "B1 evidence rows", CON-30): for the probe and definer suites and their discover
// twins, the files this run's record lists with SHA-256s (verified in stageTSuiteResult), every row their test lists
// present exactly once and passed, recomputed here. The "function outside manifest" rows are expected from the committed
// function inventory at R minus each role's manifest functions (scripts/b1/function-inventory.ts; E2, draft A10.7).
let g8Expected:ExpectedG8|undefined;const g8Results:Record<string,unknown>={};
try{g8Expected=expectedG8Rows(release);}catch(error){fail("G8",`expected rows at R: ${error instanceof Error?error.message:String(error)}`);}
for(const suite of g8Expected?REGRESSION_SUITES:[]){
  const required=g8Files(suite.id);
  if(!required.length) continue;
  const files=suiteEvidence.get(suite.id) ?? new Map<string,Buffer>();
  const missing=required.filter(f=>!files.has(f));
  for(const f of missing) fail("G8",`${suite.id} ${f}: not verified against this run's record`);
  const r=g8SuiteProblems(suite.id,files,g8Expected!,R!);
  for(const p of r.problems) if(!missing.some(f=>p===`${f}: missing`)) fail("G8",`${suite.id} ${p}`);
  g8Results[suite.id]=r.rows;
}
results["G8"]=g8Results;
// G1 and G9 are jobs of their own; their markers are written only on success.
for(const [gate,marker] of [["G1","static/g1-passed"],["G9","worker-image/g9-passed"],["EPH-26","eph26/eph26-passed"]] as const)
  if(!existsSync(join(root!,marker))) fail(gate,"did not pass");
writeFileSync(join(root!,"gate.json"),JSON.stringify({R,problems,results},null,2)+"\n");
if(problems.length){console.error(problems.join("\n"));process.exitCode=1;}
else console.log(`CI gate passed for ${R}`);
