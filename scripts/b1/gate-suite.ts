import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { z } from "zod";
import { strictJson } from "../../services/kernel/src/database/strict-json.js";
import { hash } from "../../services/kernel/src/database/co-resident.js";
import type { Release } from "./release.js";
import { readRunRecord } from "./evidence.js";
import { parseReport, type RequiredSchema, type Report } from "./coverage.js";
import type { REGRESSION_SUITES } from "./plans.js";
import { extractLogRefusals, refusalDifferences, type Refusal } from "./refusal-accounting.js";
import { readTraces } from "./trace.js";
import { con48, con48Problems } from "./con48.js";

/**
 * The CI gate's verification of one registered stage T suite (ADR-0023 27.12.15 "CI gate over every registered
 * suite"), shared by scripts/b1/ci-gate.ts and its end-to-end failing fixtures in tests/b1-runner-staget.test.ts.
 * `dir` is the suite's evidence directory as scripts/b1/ci-stage-t.ts writes it: summary.json, run/ (the run
 * directory) and stage-t/ (stage T's working directory). Every status is recomputed from these files; a missing,
 * stale, forged or failing result is a problem. Problems are [gate, message] pairs.
 */
type Suite = (typeof REGRESSION_SUITES)[number];
export interface SuiteResult {problems:[string,string][];report?:Report;results:Record<string,unknown>}
export function stageTSuiteResult(dir:string,suite:Suite,R:string,release:Release,required:z.infer<typeof RequiredSchema>,checkout:string):SuiteResult{
  const problems:[string,string][]=[],results:Record<string,unknown>={},fail=(gate:string,message:string)=>problems.push([gate,message]);
  const summaryPath=join(dir,"summary.json");
  if(!existsSync(summaryPath)){fail(suite.id,"no result for this suite");return {problems,results};}
  let report:Report|undefined;
  try{
    const {summary}=strictJson(readFileSync(summaryPath,"utf8")) as {summary:{recordSha256?:string}};
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
    report=parseReport(reportText,checkout);
    const token={runId:record.header.runId,suite:suite.id};
    const traces=readTraces(join(work,"trace"),token,suite.roles,st.traceHashes);
    const log=readFileSync(join(work,"database-log.txt"),"utf8");
    if(hash(log)!==st.logExtractSha256) fail(suite.id,"database log differs from the recorded digest");
    const logRefusals=extractLogRefusals(log,record.header.runId,st.markerPid ?? "");
    const expected=suite.refusalPolicy==="probes"?required.entries.filter(e=>suite.files.includes(e.file)).flatMap(e=>e.refusals.map(r=>({test:e.name,...r}))):[];
    const trace=traces.refusals.map(r=>({...r,test:r.test.split(" > ").join(" ")}));
    if(traces.productionRefusals.length) fail(suite.id,`a production statement was refused (${traces.productionRefusals.length})`);
    for(const p of refusalDifferences(expected,trace,logRefusals)) fail(suite.id,p);
    if(suite.id==="regression-probes"){
      // CON-48 over this run's pinned-image log: the positive fixture reconciles and the seven perturbations fail.
      const traceSql=traces.events.filter(e=>e.kind==="refused" && e.test).map(e=>({test:e.test!.split(" > ").join(" "),sql:e.sql}));
      const evidence={log,runId:record.header.runId,markerPid:st.markerPid ?? "",expected,trace,traceSql};
      for(const p of con48Problems(evidence)) fail("CON-48",p);
      results["CON-48"]=con48(evidence).perturbations.map(p=>`${p.id} ${p.failed?"FAILED":"RECONCILED"}`);
    }
    const inventory=spawnSync(process.execPath,[resolve(checkout,"scripts/b1/analyse-trace.mjs"),join(work,"trace"),join(work,"gate-inventory.json"),"--fail-on-refusal"],{encoding:"utf8"});
    if(inventory.status!==0) fail(suite.harness==="enforce"?"G4":"G5",`${suite.id}: ${inventory.stderr.slice(0,400)}`);
    results[suite.id]={status:record.status,regressionOutcome:record.regressionOutcome,recordSha256:summary.recordSha256,tests:report.entries.length};
  }catch(error){fail(suite.id,error instanceof Error?error.message:String(error));}
  return {problems,...(report?{report}:{}),results};
}
/** The evidence layout the gate reads, written by scripts/b1/ci-stage-t.ts and by the failing fixtures. */
export function writeSuiteEvidence(out:string,exitCode:number|null,summary:{directory?:string}):void{
  mkdirSync(out,{recursive:true});
  writeFileSync(join(out,"summary.json"),JSON.stringify({exitCode,summary},null,2)+"\n");
  if(!summary.directory) return;
  cpSync(summary.directory,join(out,"run"),{recursive:true});
  const record=strictJson(readFileSync(join(summary.directory,"record.json"),"utf8")) as {stageT?:{workingDirectory?:string}};
  if(record.stageT?.workingDirectory) cpSync(record.stageT.workingDirectory,join(out,"stage-t"),{recursive:true});
}
