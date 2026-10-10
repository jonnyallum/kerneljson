import { spawn } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { strictJson } from "../../services/kernel/src/database/strict-json.js";

/**
 * CI wrapper for one governed run: it invokes the ephemeral entry point exactly as a developer would (release, profile
 * and at most one registered suite, nothing else; the environment passes through unchanged and the runner refuses any
 * KJ_B1_ variable), then copies the run directory and stage T's working directory into the job's evidence directory
 * for the gate. It decides nothing: the gate recomputes every status from these files.
 */
const [release,profile,suite,out]=process.argv.slice(2);
if(!/^[0-9a-f]{40}$/.test(release ?? "") || !profile || !out) throw Error("usage: ci-stage-t <R> <profile> <suite|-> <evidence dir>");
const args=["--import","tsx",resolve("scripts/b1/ephemeral.ts"),"--release",release!,"--profile",profile,...(suite && suite!=="-"?["--regression-suite",suite]:[])];
const child=spawn(process.execPath,args,{stdio:["ignore","pipe","inherit"],windowsHide:true});
let stdout="";child.stdout.on("data",d=>{stdout+=d;process.stdout.write(d);});
const code=await new Promise<number|null>(done=>child.on("close",done));
mkdirSync(out,{recursive:true});
writeFileSync(join(out,"runner-stdout.txt"),stdout);
const line=stdout.trim().split(/\r?\n/).at(-1) ?? "";
let summary:{directory?:string}={};
try{summary=strictJson(line) as {directory?:string};}catch{summary={};}
writeFileSync(join(out,"summary.json"),JSON.stringify({exitCode:code,summary},null,2)+"\n");
if(summary.directory){
  cpSync(summary.directory,join(out,"run"),{recursive:true});
  const record=strictJson((await import("node:fs")).readFileSync(join(summary.directory,"record.json"),"utf8")) as {stageT?:{workingDirectory?:string}};
  if(record.stageT?.workingDirectory) cpSync(record.stageT.workingDirectory,join(out,"stage-t"),{recursive:true});
}
process.exitCode=code ?? 1;
if(process.argv[1] && resolve(process.argv[1])!==fileURLToPath(import.meta.url)) process.exitCode=1;
