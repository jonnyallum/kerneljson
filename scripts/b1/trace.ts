import { appendFileSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hash, HASH } from "../../services/kernel/src/database/co-resident.js";
import { strictJson } from "../../services/kernel/src/database/strict-json.js";
import { sqlFingerprint, type Refusal } from "./refusal-accounting.js";

export const TraceToken=z.strictObject({runId:z.string().regex(/^[0-9a-f]{32}$/),suite:z.string().regex(/^[a-z][a-z0-9-]+$/)});
export type TraceIdentity=z.infer<typeof TraceToken>;
const Role=z.enum(["kj_worker","kj_door"]);
const Header=z.strictObject({kind:z.literal("kerneljson:b1-trace/v1"),token:TraceToken,pid:z.number().int().positive(),processId:z.string().uuid()});
const Event=z.strictObject({kind:z.enum(["use","refused"]),sequence:z.number().int().positive(),role:Role,
  caller:z.string().min(1),via:z.enum(["login","set-role"]),classification:z.enum(["probe","production"]),
  test:z.string().min(1).nullable(),sql:z.string(),fingerprint:HASH,sqlstate:z.literal("42501").nullable(),message:z.string().nullable()});
export type TraceEvent=z.infer<typeof Event>;
export type TraceStatement=Omit<TraceEvent,"kind"|"sequence"|"fingerprint"|"sqlstate"|"message">;

/** One append-only stream per harness instance. An I/O failure is fatal to its caller. */
export function traceWriter(directory:string,token:TraceIdentity){
  TraceToken.parse(token);
  if(!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw Error("TRACE_UNTRUSTED: directory is not regular");
  const header=Header.parse({kind:"kerneljson:b1-trace/v1",token,pid:process.pid,processId:randomUUID()});
  const path=join(directory,`${header.pid}-${header.processId}.jsonl`);
  writeFileSync(path,JSON.stringify(header)+"\n",{flag:"wx",mode:0o644});
  let sequence=0;
  const write=(statement:TraceStatement,error?:{code?:string;message?:string})=>{
    if(error && error.code!=="42501") return;
    const event=Event.parse({...statement,kind:error?"refused":"use",sequence:++sequence,
      fingerprint:sqlFingerprint(statement.sql),sqlstate:error?"42501":null,message:error?.message ?? null});
    appendFileSync(path,JSON.stringify(event)+"\n");
  };
  return {path,write};
}

/** The runner supplies the directory and later pins these raw hashes; consumers cannot name evidence paths. */
export function readTraces(directory:string,token:TraceIdentity,roles:readonly ("kj_worker"|"kj_door")[],expectedHashes?:Record<string,string>){
  TraceToken.parse(token);
  const stat=lstatSync(directory);
  if(!stat.isDirectory() || stat.isSymbolicLink()) throw Error("TRACE_UNTRUSTED: invalid directory");
  const files=readdirSync(directory).sort();
  if(!files.length || files.some(f=>!/^\d+-[0-9a-f-]{36}\.jsonl$/.test(f))) throw Error("TRACE_UNTRUSTED: missing or foreign files");
  const hashes:Record<string,string>={},events:TraceEvent[]=[],processes=new Set<string>();
  for(const file of files){
    const path=join(directory,file),stat=lstatSync(path);
    if(!stat.isFile() || stat.isSymbolicLink()) throw Error("TRACE_UNTRUSTED: invalid file");
    const bytes=readFileSync(path);hashes[file]=hash(bytes);
    const raw=bytes.toString("utf8");
    if(!raw.endsWith("\n") || !Buffer.from(raw,"utf8").equals(bytes)) throw Error("TRACE_UNTRUSTED: incomplete or invalid UTF-8");
    const lines=raw.slice(0,-1).split("\n"),header=Header.parse(strictJson(lines.shift()!));
    if(header.token.runId!==token.runId || header.token.suite!==token.suite || file!==`${header.pid}-${header.processId}.jsonl` || processes.has(header.processId))
      throw Error("TRACE_UNTRUSTED: run or process identity differs");
    processes.add(header.processId);
    let sequence=0;
    for(const line of lines){
      const event=Event.parse(strictJson(line));
      if(event.sequence!==++sequence || event.fingerprint!==sqlFingerprint(event.sql) ||
        (event.kind==="refused")!==(event.sqlstate==="42501") ||
        (event.classification==="probe" && (event.via!=="login" || !event.test))) throw Error("TRACE_UNTRUSTED: invalid event");
      events.push(event);
    }
  }
  if(expectedHashes && JSON.stringify(Object.entries(hashes).sort())!==JSON.stringify(Object.entries(expectedHashes).sort()))
    throw Error("TRACE_UNTRUSTED: evidence changed");
  if(!events.length) throw Error("TRACE_UNTRUSTED: empty evidence");
  if(roles.some(role=>!events.some(e=>e.kind==="use" && e.role===role))) throw Error("TRACE_UNTRUSTED: runtime role has no use event");
  const refusals:Refusal[]=events.filter(e=>e.kind==="refused").map(e=>{
    if(e.classification!=="probe" || !e.test) throw Error("TRACE_UNTRUSTED: production refusal");
    return {test:e.test,role:e.role,sqlstate:"42501",fingerprint:e.fingerprint,multiplicity:1};
  });
  return {hashes,events,refusals};
}
