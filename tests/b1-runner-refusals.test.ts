import { spawnSync } from "node:child_process";
import { connect, createServer, type Server } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CASE_TIMEOUT, ROOT, head, runCase, runEntry } from "./support/b1-runner.js";

/**
 * ADR-0023 27.12.6 steps 1 to 5, 27.12.13.3 and 27.12.13.6: refusals that must happen before L1 (ephemeral) or before
 * any connection (hosted), each shown failing on purpose. These cases run one at a time so the daemon's labelled
 * containers and networks can be counted before and after each call: a refusal before L1 creates none. Altered
 * releases are commits in throwaway clones of the checkout; nothing here is pushed.
 */
const docker=(args:string[])=>spawnSync("docker",args,{encoding:"utf8"}).stdout.trim().split("\n").filter(Boolean);
const labelled=()=>[...docker(["ps","-aq","--filter","label=kj.b1.ephemeral.run"]),...docker(["network","ls","-q","--filter","label=kj.b1.ephemeral.run"])].sort();
async function refusedBeforeL1(args:string[],pattern:RegExp,options:{cwd?:string;env?:Record<string,string>}={}){
  const before=labelled();
  const result=await runEntry(args,options);
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout.trim()).toBe("");
  expect(result.stderr).toMatch(pattern);
  expect(labelled()).toEqual(before);
}
const git=(cwd:string,args:string[])=>{
  const r=spawnSync("git",["-c","user.name=kj-fixture","-c","user.email=fixture@invalid","-c","core.autocrlf=false",...args],{cwd,encoding:"utf8"});
  if(r.status!==0) throw Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const clones:string[]=[];
/** A clone of R with optional committed changes; returns the clone and its HEAD. */
function clone(changes:Record<string,(text:string)=>string>={},message="fixture"):{dir:string;R:string}{
  const dir=mkdtempSync(join(tmpdir(),"kj-b1-clone-"));clones.push(dir);
  git(tmpdir(),["clone","--quiet","--no-checkout",ROOT,dir]);
  git(dir,["checkout","--quiet","--detach",head()]);
  for(const [path,edit] of Object.entries(changes)) writeFileSync(join(dir,path),edit(readFileSync(join(dir,path),"utf8")));
  if(Object.keys(changes).length){git(dir,["add","--",...Object.keys(changes)]);git(dir,["commit","--quiet","-m",message]);}
  return {dir,R:git(dir,["rev-parse","HEAD"])};
}
const eph=(R:string,...extra:string[])=>["--release",R,"--profile","none",...extra];
const HOSTED=resolve("scripts/b1/hosted.ts");

describe("27.12.13.3 the ephemeral entry point accepts no other input (EPH-3, EPH-21, EPH-22, EPH-25, CON-2, CON-3)",()=>{
  for(const option of ["--url","--connection-file","--host","--port","--database","--declaration","--baseline","--status","--mode","--suite"])
    it(`refuses ${option}`,()=>refusedBeforeL1(eph(head(),option,"x"),/EPHEMERAL_REFUSED: option not accepted/),CASE_TIMEOUT);
  for(const [name,value] of [["KJ_B1_STATUS","REPOSITORY_QUALIFIED"],["KJ_B1_SKIP_L3","1"],["KJ_B1_REGRESSION_SUITE","regression-enforce"],["KJ_B1_HOOK","ledger-absent"]] as const)
    it(`refuses ${name} in its environment`,()=>refusedBeforeL1(eph(head()),new RegExp(`runner variables in the environment: ${name}`),{env:{[name]:value}}),CASE_TIMEOUT);
  it("refuses an unknown hook id",()=>refusedBeforeL1(eph(head(),"--hook","ledger-vanished"),/EPHEMERAL_REFUSED: unknown hook id: ledger-vanished/),CASE_TIMEOUT);
  it("refuses a hook id differing only in case",()=>refusedBeforeL1(eph(head(),"--hook","Ledger-Absent"),/EPHEMERAL_REFUSED: malformed option value/),CASE_TIMEOUT);
  it("refuses an unregistered hook combination",()=>refusedBeforeL1(eph(head(),"--hook","ledger-absent","--hook","ledger-extra"),/hook combination or profile not registered/),CASE_TIMEOUT);
  it("refuses a hook with a profile its expectation does not name",()=>refusedBeforeL1(["--release",head(),"--profile","platform-definer-fixture","--hook","ledger-absent"],/hook combination or profile not registered/),CASE_TIMEOUT);
  it("refuses an unknown regression suite id",()=>refusedBeforeL1(eph(head(),"--regression-suite","regression-unknown"),/EPHEMERAL_REFUSED: unknown regression suite id/),CASE_TIMEOUT);
  it("refuses a regression suite together with a hook (CON-3)",()=>refusedBeforeL1(eph(head(),"--hook","ledger-absent","--regression-suite","regression-enforce"),/cannot be combined with a hook/),CASE_TIMEOUT);
  it("refuses an unknown profile",()=>refusedBeforeL1(["--release",head(),"--profile","platform"],/EPHEMERAL_REFUSED: expected --release/),CASE_TIMEOUT);
});
describe("27.12.6 step 1 and case 40: the release is exact, clean and unflagged",()=>{
  // One fixture commit in the clone, so its parent (this checkout's HEAD) exists at any clone depth; CI checks out shallow.
  it("refuses a release other than HEAD (case 36)",()=>{const {dir}=clone({"docs/AUTHORITY_MAP.md":t=>t+"\n"});return refusedBeforeL1(eph(git(dir,["rev-parse","HEAD~1"])),/RELEASE_REFUSED: HEAD differs from R/,{cwd:dir});},CASE_TIMEOUT);
  it("refuses a tracked change in the working tree (case 36; EPH-14 working-copy B1 edit)",()=>{
    const {dir,R}=clone();writeFileSync(join(dir,"supabase/migrations/20261002090000_runtime_least_privilege_roles.sql"),"-- edited in the working copy only\n",{flag:"a"});
    return refusedBeforeL1(eph(R),/RELEASE_REFUSED: tracked changes or untracked migration/,{cwd:dir});
  },CASE_TIMEOUT);
  it("refuses a registry edited in the working copy only (EPH-22)",()=>{
    const {dir,R}=clone();writeFileSync(join(dir,"infrastructure/database/b1-runner-hooks.json"),"\n",{flag:"a"});
    return refusedBeforeL1(eph(R),/RELEASE_REFUSED: tracked changes/,{cwd:dir});
  },CASE_TIMEOUT);
  it("refuses an untracked .sql under supabase/migrations (case 40)",()=>{
    const {dir,R}=clone();writeFileSync(join(dir,"supabase/migrations/20261003000000_untracked.sql"),"select 1;\n");
    return refusedBeforeL1(eph(R),/RELEASE_REFUSED: tracked changes or untracked migration/,{cwd:dir});
  },CASE_TIMEOUT);
  for(const flag of ["--skip-worktree","--assume-unchanged"]) for(const path of ["infrastructure/database/co-resident-platform-pins.json","supabase/migrations/20261002090000_runtime_least_privilege_roles.sql","infrastructure/database/b1-runner-hooks.json"])
    it(`refuses ${flag} on ${path} (case 40)`,()=>{const {dir,R}=clone();git(dir,["update-index",flag,path]);return refusedBeforeL1(eph(R),/RELEASE_REFUSED: flagged tracked path/,{cwd:dir});},CASE_TIMEOUT);
});
describe("committed artefact integrity before L1",()=>{
  const json=(edit:(o:Record<string,unknown>)=>void)=>(text:string)=>{const o=JSON.parse(text);edit(o);return JSON.stringify(o,null,2)+"\n";};
  it("EPH-22 a registry entry with an unknown field",()=>{const {dir,R}=clone({"infrastructure/database/b1-runner-hooks.json":json(o=>{(o.hooks as Record<string,unknown>[])[0]!.address="localhost";})});
    return refusedBeforeL1(eph(R),/Unrecognized key|unrecognized_keys|address/i,{cwd:dir});},CASE_TIMEOUT);
  it("EPH-23 a registry entry whose point names L5",()=>{const {dir,R}=clone({"infrastructure/database/b1-runner-hooks.json":json(o=>{(o.hooks as Record<string,unknown>[])[0]!.point="L5";})});
    return refusedBeforeL1(eph(R),/invalid|point/i,{cwd:dir});},CASE_TIMEOUT);
  it("EPH-23 a registry entry whose effect names L5",()=>{const {dir,R}=clone({"infrastructure/database/b1-runner-hooks.json":json(o=>{(o.hooks as Record<string,unknown>[])[0]!.effect="skips L5 once";})});
    return refusedBeforeL1(eph(R),/an effect may not name L1, L5, L6, S7 or the status/,{cwd:dir});},CASE_TIMEOUT);
  it("a registry that differs from the committed hook definitions (an expectation relaxed)",()=>{const {dir,R}=clone({"infrastructure/database/b1-runner-hooks.json":json(o=>{
    const e=(o.hooks as {expected:{refusal:{message:string|null;pattern:string|null}|null}[]}[])[0]!.expected[0]!.refusal!;e.message=null;e.pattern="^.";})});
    return refusedBeforeL1(eph(R),/hook registry at R differs from the committed hook definitions/,{cwd:dir});},CASE_TIMEOUT);
  it("CON-46 the platform-definer fixture SQL changed",()=>{const {dir,R}=clone({"infrastructure/database/b1-fixture-platform-definers.sql":t=>t+"-- changed\n"});
    return refusedBeforeL1(["--release",R,"--profile","platform-definer-fixture"],/hook registry at R differs|fixture hash differs/,{cwd:dir});},CASE_TIMEOUT);
  it("case 36 pins embedded in the migration differ from the pins file",()=>{const {dir,R}=clone({"infrastructure/database/co-resident-platform-pins.json":t=>t.replace('"ensure_rls"','"ensure_rls_x"')});
    return refusedBeforeL1(eph(R),/REFUSED/,{cwd:dir});},CASE_TIMEOUT);
  it("EPH-9 another engine version",()=>{const {dir,R}=clone({"infrastructure/database/b1-engine-pins.json":t=>t.replace('"version": "2.120.0"','"version": "2.119.0"')});
    return refusedBeforeL1(eph(R),/2\.120\.0|invalid/i,{cwd:dir});},CASE_TIMEOUT);
  it("EPH-10 one byte of supabase-go's pin changed",()=>{const {dir,R}=clone({"infrastructure/database/b1-engine-pins.json":t=>t.replace(/("supabase-go\.exe": ")[0-9a-f]/,"$10").replace(/("supabase-go": ")[0-9a-f]/,"$10")});
    return refusedBeforeL1(eph(R),/ENGINE_REFUSED: executable SHA-256 differs/,{cwd:dir});},CASE_TIMEOUT);
  it("EPH-10 the other platform's executables",()=>{const {dir,R}=clone({"infrastructure/database/b1-engine-pins.json":json(o=>{
    const p=o.platforms as Record<string,{executables:Record<string,string>}>;const w=p["windows-x64"]!.executables,l=p["linux-x64"]!.executables;
    p["windows-x64"]!.executables={"supabase-go.exe":l["supabase-go"]!,"supabase.exe":l["supabase"]!};p["linux-x64"]!.executables={"supabase":w["supabase.exe"]!,"supabase-go":w["supabase-go.exe"]!};})});
    return refusedBeforeL1(eph(R),/ENGINE_REFUSED: executable SHA-256 differs/,{cwd:dir});},CASE_TIMEOUT);
  it("EPH-10 the archive pin changed",()=>{const {dir,R}=clone({"infrastructure/database/b1-engine-pins.json":t=>t.replace(/("sha256": ")[0-9a-f]/g,"$10")});
    return refusedBeforeL1(eph(R),/ENGINE_REFUSED: archive (SHA-256 differs|download failed)/,{cwd:dir});},CASE_TIMEOUT);
});

let listener:Server|undefined,accepted=0,port=0;
async function listen(){
  if(listener) return;
  listener=createServer(socket=>{accepted++;socket.destroy();});
  await new Promise<void>(done=>listener!.listen(0,"127.0.0.1",()=>done()));
  port=(listener.address() as {port:number}).port;
}
afterAll(()=>{listener?.close();});
function targetFile(database="kj_hosted",user="postgres"){
  const dir=mkdtempSync(join(tmpdir(),"kj-b1-target-"));clones.push(dir);
  const path=join(dir,"target.json");
  // A disposable loopback listener, not a database: the password is a fixture literal, never a credential.
  writeFileSync(path,JSON.stringify({kind:"kerneljson:b1-hosted-target/v1",host:"127.0.0.1",port,database,user,password:"fixture",ca:"fixture"}));
  chmodSync(path,0o600);return path;
}
async function hostedRefused(R:string,dir:string,pattern:RegExp,extra:string[]=[]){
  await listen();const before=accepted,containers=labelled();
  const result=await runEntry(["--release",R,"--target-file",targetFile(),...extra],{cwd:dir,entry:HOSTED});
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr+result.stdout).toMatch(pattern);
  expect(accepted).toBe(before);
  expect(labelled()).toEqual(containers);
}
describe("HOSTED_COMMITTED refuses before any connection (case 36, EPH-11, EPH-12, EPH-16, EPH-17, EPH-19, CON-12)",()=>{
  it("EPH-11 no declaration committed at R",()=>{const {dir,R}=clone();return hostedRefused(R,dir,/HOSTED_REFUSED/);},CASE_TIMEOUT);
  it("EPH-11 a declaration present only in the working copy",()=>{const {dir,R}=clone();
    mkdirSync(join(dir,"infrastructure/database"),{recursive:true});writeFileSync(join(dir,"infrastructure/database/co-resident-platform-exceptions.json"),"{}\n");
    return hostedRefused(R,dir,/HOSTED_REFUSED/);},CASE_TIMEOUT);
  for(const option of ["--profile","--hook","--regression-suite","--baseline","--declaration","--status"])
    it(`EPH-17 and CON-12 refuses ${option}`,async()=>{
      await listen();const before=accepted;
      const result=await runEntry(["--release",head(),option,"x"],{entry:HOSTED});
      expect(result.exitCode).not.toBe(0);expect(result.stderr).toMatch(/HOSTED_REFUSED/);expect(accepted).toBe(before);
    },CASE_TIMEOUT);
  it("the listener counts connections (it must fail on purpose)",async()=>{
    await listen();const before=accepted;
    await new Promise<void>(done=>{const s=connect(port,"127.0.0.1",()=>{s.end();done();});});
    await new Promise(r=>setTimeout(r,200));expect(accepted).toBe(before+1);
  },CASE_TIMEOUT);
});
describe("EPH-9 a polluted parent environment and PATH never reach the engine",()=>{
  it("the engine environment holds exactly the H1 names, and fake executables never run",async()=>{
    const fakes=mkdtempSync(join(tmpdir(),"kj-b1-fakes-"));clones.push(fakes);
    const marker=join(fakes,"ran");
    for(const name of ["supabase","psql"]){
      writeFileSync(join(fakes,`${name}.cmd`),`@echo off\r\necho ran > "${marker}"\r\n`);
      writeFileSync(join(fakes,name),`#!/bin/sh\necho ran > "${marker}"\n`);chmodSync(join(fakes,name),0o755);
    }
    const path=`${fakes}${process.platform==="win32"?";":":"}${process.env.PATH ?? ""}`;
    const outcome=await runCase("EPH-9 polluted environment","none",[],{env:{PGHOST:"203.0.113.1",PGOPTIONS:"-c search_path=evil",PGSERVICE:"evil",
      PGPASSFILE:join(fakes,"pgpass"),SUPABASE_ACCESS_TOKEN:"fixture-not-a-token",PATH:path}});
    expect(outcome.summary?.status).toBe("REPOSITORY_QUALIFIED");
    const s6=outcome.record!.events.find(e=>e.step==="S6" && e.outcome==="passed")!.details as {engine:{environmentNames:string[]}};
    expect(s6.engine.environmentNames).toEqual(process.platform==="win32"?["HOME","PATH","SystemRoot","TEMP","TMP","TMPDIR","USERPROFILE"]:["HOME","PATH","TMPDIR"]);
    expect(()=>readFileSync(marker)).toThrow();
  },CASE_TIMEOUT);
});
describe("EPH-27 end to end: an unhooked run refused at L5 by an outside change",()=>{
  it("a non-superuser default role set from outside the runner makes L5 refuse; teardown passes; NOT_QUALIFIED",async()=>{
    let last="";
    for(let attempt=1;attempt<=3;attempt++){
      const before=new Set(docker(["ps","-aq","--filter","label=kj.b1.ephemeral.run"]));
      const run=runCase(`EPH-27 attempt ${attempt}`,"none",[]);
      let induced=false;
      for(let i=0;i<1200 && !induced;i++){
        const fresh=docker(["ps","-q","--filter","label=kj.b1.ephemeral.run"]).filter(id=>!before.has(id));
        if(fresh.length===1){
          const logs=spawnSync("docker",["logs",fresh[0]!],{encoding:"utf8"});
          if((logs.stdout+logs.stderr).includes("database system is ready to accept connections")){
            const r=spawnSync("docker",["exec",fresh[0]!,"psql","-U","postgres","-v","ON_ERROR_STOP=1","-c",
              "create role kj_fixture_nonsuper nologin; alter role postgres set role kj_fixture_nonsuper;"],{encoding:"utf8"});
            induced=r.status===0;
          }
        }
        if(!induced) await new Promise(r=>setTimeout(r,25));
      }
      const outcome=await run;
      const refused=outcome.record?.events.filter(e=>e.outcome==="refused") ?? [];
      last=JSON.stringify({induced,status:outcome.summary?.status,refused:refused.map(e=>e.step)});
      if(induced && refused.length===1 && refused[0]!.step==="L5"){
        expect(outcome.summary?.status).toBe("NOT_QUALIFIED");
        expect(outcome.record!.applications).toHaveLength(0);
        expect(outcome.record!.events.at(-1)).toMatchObject({step:"L6",outcome:"passed"});
        expect(String(refused[0]!.details)).toMatch(/current_user is not superuser/);
        return;
      }
    }
    throw Error(`the outside change did not land before the runner's next connection in three attempts: ${last}`);
  },3*CASE_TIMEOUT);
});

/** Watch for the run's own container, wait until its server reports ready, then apply an outside change to it. */
async function induce(run:Promise<unknown>,change:(container:string,runId:string)=>boolean,windowMs:number):Promise<boolean>{
  const before=new Set(docker(["ps","-aq","--filter","label=kj.b1.ephemeral.run"]));
  let finished=false;
  run.then(()=>{finished=true;},()=>{finished=true;});
  for(const deadline=Date.now()+windowMs;Date.now()<deadline && !finished;){
    const fresh=docker(["ps","-q","--filter","label=kj.b1.ephemeral.run"]).filter(id=>!before.has(id));
    if(fresh.length===1){
      const logs=spawnSync("docker",["logs",fresh[0]!],{encoding:"utf8"});
      if((logs.stdout+logs.stderr).includes("database system is ready to accept connections")){
        const runId=spawnSync("docker",["inspect","--format","{{index .Config.Labels \"kj.b1.ephemeral.run\"}}",fresh[0]!],{encoding:"utf8"}).stdout.trim();
        return change(fresh[0]!,runId);
      }
    }
    await Promise.race([run,new Promise(r=>setTimeout(r,25))]);
  }
  return false;
}
describe("CON-8 and CON-9: the run network and the cluster's attachment, changed from outside the runner",()=>{
  it("CON-8 a foreign container attached to the run network before stage T: L3 refuses at the next connection",async()=>{
    let foreign="";
    const run=runCase("CON-8 foreign container on the run network","none",[]);
    const induced=await induce(run,(_c,runId)=>{
      const r=spawnSync("docker",["run","-d","--network",`kj-eph-${runId}`,"-e","POSTGRES_HOST_AUTH_METHOD=trust",
        "postgres@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929"],{encoding:"utf8"});
      foreign=r.stdout.trim();return r.status===0;
    },600000);
    const outcome=await run;
    if(foreign) spawnSync("docker",["rm","-f",foreign]);
    const runId=outcome.record?.header.runId;
    if(runId) spawnSync("docker",["network","rm",`kj-eph-${runId}`]);
    expect(induced).toBe(true);
    const refused=outcome.record!.events.filter(e=>e.outcome==="refused");
    expect(refused[0]).toMatchObject({step:"L3"});
    expect(String(refused[0]!.details)).toMatch(/network membership differs/);
    expect(outcome.summary?.status).toBe("NOT_QUALIFIED");
  },CASE_TIMEOUT);
  it("CON-9 the cluster attached to a second network: L3 refuses",async()=>{
    const net=`kj-induced-${Date.now()}`;
    spawnSync("docker",["network","create",net]);
    const run=runCase("CON-9 second network on the cluster","none",[]);
    const induced=await induce(run,c=>spawnSync("docker",["network","connect",net,c]).status===0,600000);
    const outcome=await run;
    spawnSync("docker",["network","rm",net]);
    expect(induced).toBe(true);
    const refused=outcome.record!.events.filter(e=>e.outcome==="refused");
    expect(refused[0]).toMatchObject({step:"L3"});
    expect(String(refused[0]!.details)).toMatch(/container network differs/);
    expect(outcome.summary?.status).toBe("NOT_QUALIFIED");
  },CASE_TIMEOUT);
});
describe("CON-9 a run network without the exact label",()=>{
  // A network's labels cannot change, so the only outside route is to replace it: the cluster is moved to an
  // unlabelled network of the same name. L3 must refuse; which clause fires first (identity or label) is recorded.
  it("the run network replaced by an unlabelled one of the same name: L3 refuses",async()=>{
    const run=runCase("CON-9 unlabelled run network","none",[]);
    const induced=await induce(run,(c,runId)=>{
      const name=`kj-eph-${runId}`;
      // The runner may reach its next connection between these steps; L3 then refuses and L6 removes the cluster before
      // the re-connect, which is best effort. The induction is the labelled network replaced by an unlabelled one.
      const replaced=spawnSync("docker",["network","disconnect","-f",name,c]).status===0 && spawnSync("docker",["network","rm",name]).status===0 &&
        spawnSync("docker",["network","create",name]).status===0;
      if(replaced) spawnSync("docker",["network","connect","--alias","kj-eph-db",name,c]);
      return replaced;
    },600000);
    const outcome=await run;
    const runId=outcome.record?.header.runId;
    if(runId) spawnSync("docker",["network","rm",`kj-eph-${runId}`]);
    expect(induced).toBe(true);
    const refused=outcome.record!.events.filter(e=>e.outcome==="refused");
    expect(refused[0]).toMatchObject({step:"L3"});
    // Whichever L3 clause the replacement trips first: on Linux the published port goes with the network.
    expect(String(refused[0]!.details)).toMatch(/L3: (container network differs|network membership differs|port binding differs)/);
    expect(outcome.summary?.status).toBe("NOT_QUALIFIED");
  },CASE_TIMEOUT);
});
describe("CON-4 end to end: a run given a regression suite and refused at L5 never launches the suite",()=>{
  it("stage T is not run, the suite never starts, and the status is NOT_QUALIFIED",async()=>{
    const run=runCase("CON-4 suite run refused at L5","none",[],{suite:"regression-gated"});
    // The first readiness line can come from the image's temporary init server; the outside change is retried until it
    // lands on the real server (or the run ends), as EPH-27 does.
    const induced=await induce(run,c=>{
      for(let i=0;i<200;i++){
        if(spawnSync("docker",["exec",c,"psql","-U","postgres","-v","ON_ERROR_STOP=1","-c",
          "create role kj_fixture_nonsuper nologin; alter role postgres set role kj_fixture_nonsuper;"]).status===0) return true;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);
      }
      return false;
    },900000);
    const outcome=await run;
    expect(induced).toBe(true);
    const refused=outcome.record!.events.filter(e=>e.outcome==="refused").map(e=>e.step);
    expect(refused).toEqual(["L5"]);
    expect(outcome.summary?.status).toBe("NOT_QUALIFIED");
    expect(outcome.record!.regressionOutcome).toBe("not-run");
    expect(outcome.record!.stageT).toMatchObject({outcome:"not-run"});
    expect(outcome.record!.stageT).not.toHaveProperty("workingDirectory");
  },2*CASE_TIMEOUT);
});
