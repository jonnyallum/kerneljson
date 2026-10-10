import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readRunRecord, type RunRecord } from "../../scripts/b1/evidence.js";
import { Release } from "../../scripts/b1/release.js";
import type { Profile } from "../../scripts/b1/hooks.js";

/**
 * Lanes B and C (27.12.15): runner-case files call the ephemeral entry point as a child process, on the host and
 * outside any run, and then act as an independent consumer of the record it emits. They never open a connection to a
 * cluster themselves. Each case's summary and record are kept under artifacts/local/b1-runner-cases/.
 */
export const ROOT=resolve(".");
const ENTRY=resolve("scripts/b1/ephemeral.ts");
export const EVIDENCE=resolve("artifacts/local/b1-runner-cases");
export const head=()=>spawnSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).stdout.trim();
export interface Summary {directory:string;recordSha256:string;status:string;fixtureOutcome:string;consumer:string;failure:string|null;problems:string[]}
export interface RunnerOutcome {exitCode:number|null;summary:Summary|null;stdout:string;stderr:string;record:RunRecord|null}
function childEnvironment(extra:Record<string,string>={}):NodeJS.ProcessEnv{
  const env={...process.env,...extra};
  for(const key of Object.keys(env)) if(/^KJ_B1_/i.test(key) && !(key in extra)) delete env[key];
  return env;
}
export function runEntry(args:readonly string[],options:{cwd?:string;env?:Record<string,string>;entry?:string}={}):Promise<{exitCode:number|null;stdout:string;stderr:string}>{
  return new Promise((done,fail)=>{
    const child=spawn(process.execPath,["--import","tsx",options.entry ?? ENTRY,...args],
      {cwd:options.cwd ?? ROOT,env:childEnvironment(options.env),windowsHide:true});
    let stdout="",stderr="";
    child.stdout.on("data",d=>{stdout+=d;});child.stderr.on("data",d=>{stderr+=d;});
    child.on("error",fail);child.on("close",exitCode=>done({exitCode,stdout,stderr}));
  });
}
/** One registered runner case: release R is HEAD of the clean checkout; the record is re-validated here. */
export async function runCase(label:string,profile:Profile,hooks:readonly string[],options:{suite?:string;cwd?:string}={}):Promise<RunnerOutcome>{
  const R=head();
  const args=["--release",R,"--profile",profile,...hooks.flatMap(h=>["--hook",h]),...(options.suite?["--regression-suite",options.suite]:[])];
  const result=await runEntry(args,options.cwd?{cwd:options.cwd}:{});
  const line=result.stdout.trim().split(/\r?\n/).at(-1) ?? "";
  let summary:Summary|null=null,record:RunRecord|null=null,consumerError:string|null=null;
  try{summary=JSON.parse(line) as Summary;}catch{summary=null;}
  if(summary){
    try{record=readRunRecord(join(summary.directory,"record.json"),summary.recordSha256,new Release(options.cwd ?? ROOT,R));}
    catch(error){consumerError=error instanceof Error?error.message:String(error);}
  }
  mkdirSync(EVIDENCE,{recursive:true});
  const slug=label.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
  if(summary) copyFileSync(join(summary.directory,"record.json"),join(EVIDENCE,`${slug}.record.json`));
  writeFileSync(join(EVIDENCE,`${slug}.json`),JSON.stringify({label,R,profile,hooks,suite:options.suite ?? null,exitCode:result.exitCode,summary,
    consumerError,end:record?.fixture?.observation.end ?? null,refusal:record?.fixture?.observation.refusal ?? null,
    b1EngineInvoked:record?.fixture?.observation.b1EngineInvoked ?? null,preconditions:record?.fixture?.observation.preconditions ?? null,
    post:record?.fixture?.observation.post ?? null,stderr:summary?null:result.stderr.slice(-2000)},null,2)+"\n");
  if(consumerError) throw Error(`consumer refused the record: ${consumerError}`);
  return {...result,summary,record};
}
/** Asserts a hooked case: the record is a negative fixture whose registered expectation occurred. */
export function expectFixturePassed(outcome:RunnerOutcome):void{
  if(!outcome.summary) throw Error(`no record emitted: ${outcome.stderr.slice(-1500)}`);
  const s=outcome.summary;
  if(s.consumer!=="accepted") throw Error(`runner-side consumer refused: ${s.consumer}`);
  if(s.status!=="NEGATIVE_FIXTURE_RESULT") throw Error(`status ${s.status}`);
  if(s.fixtureOutcome!=="passed") throw Error(`fixture failed: ${JSON.stringify(s.problems)}; failure ${String(s.failure)}`);
}
/** Asserts an unhooked positive control. */
export function expectQualified(outcome:RunnerOutcome):RunRecord{
  if(!outcome.summary || !outcome.record) throw Error(`no record emitted: ${outcome.stderr.slice(-1500)}`);
  if(outcome.summary.status!=="REPOSITORY_QUALIFIED" || outcome.record.status!=="REPOSITORY_QUALIFIED") throw Error(`status ${outcome.summary.status}: ${String(outcome.summary.failure)}`);
  return outcome.record;
}
export const CASE_TIMEOUT=15*60*1000;
