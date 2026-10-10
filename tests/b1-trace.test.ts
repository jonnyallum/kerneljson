import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readTraces, traceWriter, type TraceStatement } from "../scripts/b1/trace.js";
import { sqlFingerprint } from "../scripts/b1/refusal-accounting.js";

const token={runId:"a".repeat(32),suite:"regression-probes"};
const directories:string[]=[];
const directory=()=>{const d=mkdtempSync(join(tmpdir(),"kj-trace-control-"));directories.push(d);return d;};
afterEach(()=>{for(const d of directories.splice(0)) rmSync(d,{recursive:true,force:true});});
const statement=(sql="select denied($1)"):TraceStatement=>({role:"kj_worker",caller:"tests/probe.test.ts",via:"login",classification:"probe",test:"expanded probe",sql});
const error={code:"42501",message:"permission denied"};
function sample(){const dir=directory(),writer=traceWriter(dir,token);writer.write(statement());writer.write(statement(),error);return {dir,writer};}

describe("R279 trace integrity",()=>{
  it.each([["enforce","pool"],["enforce","client"],["discover","pool"],["discover","client"]])(
    "traces production calls using %s owner %s adaptation",(mode,kind)=>{
      const dir=directory();
      const script=`
        import pg from 'pg';
        const failure=()=>Object.assign(Error('denied'),{code:'42501'});
        pg.Pool.prototype.query=function(){return this.options.user==='kj_worker'?Promise.reject(failure()):Promise.resolve({rows:[]});};
        pg.Client.prototype.query=async function(query){
          if(query==='set role kj_worker'){this.effective='kj_worker';return {rows:[]};}
          if(query==='reset role'){this.effective=null;return {rows:[]};}
          if(this.effective==='kj_worker')throw failure();
          return {rows:[]};
        };
        pg.Pool.prototype.connect=async function(){const client=new pg.Client({user:this.options.user});client.release=()=>{};return client;};
        await import(${JSON.stringify(pathToFileURL(resolve("tests/support/runtime-roles.ts")).href)});
        const {readBinding}=await import(${JSON.stringify(pathToFileURL(resolve("services/kernel/src/execution-binding.ts")).href)});
        const db=${kind==="pool"?"new pg.Pool({user:'postgres'})":"new pg.Client({user:'postgres'})"};
        let refused=false;
        try{await readBinding(db,'test-task');}catch(e){if(e.code!=='42501')throw e;refused=true;}
        if(refused!==${mode==="enforce"})throw Error('mode behaviour changed');
      `;
      const env:NodeJS.ProcessEnv={...process.env,KJ_RUNTIME_ROLES:mode!,KJ_RUNTIME_ROLE_FIXED:"kj_worker",KJ_B1_STAGE_T:"1",KJ_B1_TRACE_DIR:dir,KJ_B1_RUN_TOKEN:JSON.stringify(token)};
      delete env.VITEST;
      const child=spawnSync(process.execPath,["--import","tsx","--input-type=module","-e",script],{cwd:process.cwd(),env,encoding:"utf8",timeout:30000,windowsHide:true});
      expect(child.status,child.stderr).toBe(0);
      const files=readdirSync(dir);expect(files).toHaveLength(1);
      const events=readFileSync(join(dir,files[0]!),"utf8").trimEnd().split("\n").slice(1).map(line=>JSON.parse(line));
      expect(events.map(e=>e.kind)).toEqual(["use","refused"]);
      expect(events.every(e=>e.classification==="production" && e.role==="kj_worker")).toBe(true);
      expect(events[1].via).toBe(mode==="enforce" && kind==="pool"?"login":"set-role");
    });
  it.each([ ["enforce","kj_worker"], ["enforce","kj_door"], ["discover","kj_worker"], ["discover","kj_door"] ])(
    "observes promise, callback, pool, direct client and prepared repeats in %s as %s",(mode,role)=>{
      const dir=directory(),sql="select '\t  x\ny' /*"+"x".repeat(700)+"*/";
      // Driver doubles exercise all wrapper APIs without opening a database or applying B1.
      const script=`
        import pg from 'pg';
        const role=${JSON.stringify(role)},sql=${JSON.stringify(sql)};
        const fail=()=>Promise.reject(Object.assign(Error('denied'),{code:'42501'}));
        pg.Pool.prototype.query=fail;
        pg.Client.prototype.query=fail;
        pg.Pool.prototype.connect=function(callback){
          const client=new pg.Client({user:role});client.release=()=>{};
          if(callback){callback(null,client,client.release);return;}
          return Promise.resolve(client);
        };
        await import(${JSON.stringify(pathToFileURL(resolve("tests/support/runtime-roles.ts")).href)});
        const pool=new pg.Pool({user:role}),client=new pg.Client({user:role});
        const caught=promise=>promise.catch(e=>{if(e.code!=='42501')throw e;});
        const callbackQuery=(db,query)=>new Promise((yes,no)=>db.query(query,(e)=>e?.code==='42501'?yes():no(e??Error('no refusal'))));
        await caught(pool.query(sql));
        await callbackQuery(pool,sql);
        await caught(client.query({name:'repeat',text:sql}));
        await callbackQuery(client,{name:'repeat'});
        await new Promise((yes,no)=>pool.connect((e,c,release)=>{if(e)return no(e);callbackQuery(c,sql).then(()=>{release();yes();},no);}));
        const leased=await pool.connect();await caught(leased.query(sql));leased.release();
      `;
      const env:NodeJS.ProcessEnv={...process.env,KJ_RUNTIME_ROLES:mode!,KJ_RUNTIME_ROLE_FIXED:role!,KJ_B1_STAGE_T:"1",KJ_B1_TRACE_DIR:dir,KJ_B1_RUN_TOKEN:JSON.stringify(token)};
      delete env.VITEST;
      const child=spawnSync(process.execPath,["--import","tsx","--input-type=module","-e",script],{cwd:process.cwd(),env,encoding:"utf8",timeout:30000,windowsHide:true});
      expect(child.status,child.stderr).toBe(0);
      const files=readdirSync(dir);expect(files).toHaveLength(1);
      const lines=readFileSync(join(dir,files[0]!),"utf8").trimEnd().split("\n").map(line=>JSON.parse(line));
      expect(lines[0].token).toEqual(token);
      const events=lines.slice(1);expect(events).toHaveLength(12);
      expect(events.map(e=>e.sequence)).toEqual(Array.from({length:12},(_,i)=>i+1));
      expect(events.filter(e=>e.kind==="refused")).toHaveLength(6);
      expect(events.every(e=>e.role===role && e.sql===sql && e.fingerprint===sqlFingerprint(sql) && e.via==="login")).toBe(true);
    });
  it("retains exact long multiline SQL and duplicate refusal multiplicity",()=>{
    const dir=directory(),writer=traceWriter(dir,token),sql="select '\t  x\ny' /*"+"x".repeat(700)+"*/";
    writer.write(statement(sql));writer.write(statement(sql),error);writer.write(statement(sql),error);
    const evidence=readTraces(dir,token,["kj_worker"]);
    expect(evidence.events.map(e=>e.sequence)).toEqual([1,2,3]);
    expect(evidence.events.every(e=>e.sql===sql && e.fingerprint===sqlFingerprint(sql))).toBe(true);
    expect(evidence.refusals).toHaveLength(2);
    expect(evidence.refusals.every(e=>e.multiplicity===1)).toBe(true);
    expect(sqlFingerprint("select 'a  b'")).not.toBe(sqlFingerprint("select 'a b'"));
  });
  it("rejects substitution of either run identity field",()=>{
    const {dir}=sample();
    expect(()=>readTraces(dir,{...token,runId:"b".repeat(32)},["kj_worker"])).toThrow("identity differs");
    expect(()=>readTraces(dir,{...token,suite:"different-suite"},["kj_worker"])).toThrow("identity differs");
  });
  it("requires files and a use event for every exercised role",()=>{
    expect(()=>readTraces(directory(),token,[])).toThrow("missing or foreign");
    const empty=directory();traceWriter(empty,token);expect(()=>readTraces(empty,token,[])).toThrow("empty evidence");
    const {dir}=sample();expect(()=>readTraces(dir,token,["kj_worker","kj_door"])).toThrow("no use event");
  });
  it.each(["sequence","fingerprint","duplicate-key","partial"])("rejects %s corruption",kind=>{
    const {dir,writer}=sample(),lines=readFileSync(writer.path,"utf8").trimEnd().split("\n");
    const event=JSON.parse(lines[1]!);
    if(kind==="sequence") event.sequence=2;
    if(kind==="fingerprint") event.fingerprint="0".repeat(64);
    lines[1]=JSON.stringify(event);
    if(kind==="duplicate-key") lines[1]=lines[1].replace('{','{"kind":"use",');
    writeFileSync(writer.path,lines.join("\n")+(kind==="partial"?"":"\n"));
    expect(()=>readTraces(dir,token,["kj_worker"])).toThrow();
  });
  it("rejects changes after the runner hashes the evidence",()=>{
    const {dir,writer}=sample(),before=readTraces(dir,token,["kj_worker"]);
    writer.write(statement(),error);
    expect(()=>readTraces(dir,token,["kj_worker"],before.hashes)).toThrow("evidence changed");
  });
  it("fails when trace writing fails instead of swallowing the failure",()=>{
    const {dir,writer}=sample();rmSync(dir,{recursive:true});
    expect(()=>writer.write(statement(),error)).toThrow();
  });
  it("returns production refusals apart from the probe refusals, and rejects probes through SET ROLE",()=>{
    const dir=directory(),writer=traceWriter(dir,token);
    writer.write(statement());writer.write({...statement(),classification:"production"},error);
    const read=readTraces(dir,token,["kj_worker"]);
    expect(read.productionRefusals).toHaveLength(1);
    expect(read.refusals).toEqual([]);
    const second=directory(),other=traceWriter(second,token);other.write({...statement(),via:"set-role"});
    expect(()=>readTraces(second,token,["kj_worker"])).toThrow("invalid event");
  });
  it("rejects foreign files and malformed UTF-8",()=>{
    const {dir,writer}=sample();appendFileSync(writer.path,Buffer.from([0xff,0x0a]));
    expect(()=>readTraces(dir,token,["kj_worker"])).toThrow("UTF-8");
    writeFileSync(join(dir,"foreign.json"),"{}");
    expect(()=>readTraces(dir,token,["kj_worker"])).toThrow("foreign");
  });
});
