import { createHash } from "node:crypto";
export const LOG_PREFIX="kjlog|%p|%l|%e|%u|%d| ";
export const sqlFingerprint=(sql:string):string=>createHash("sha256").update(sql,"utf8").digest("hex");
export interface Refusal {test:string;role:"kj_worker"|"kj_door";sqlstate:string;fingerprint:string;multiplicity:number}
export interface LogRefusal {role:"kj_worker"|"kj_door";sqlstate:string;fingerprint:string;multiplicity:number}
interface LogRecord {pid:string;line:number;sqlstate:string;user:string;database:string;severity:string;message:string}
const PREFIX=/^kjlog\|([0-9]+)\|([0-9]+)\|([0-9A-Z]{5})\|([^|]*)\|([^|]*)\| ([A-Z]+): {2}(.*)$/;

/** Parse the exact marked window. LF is the delimiter; CR and SQL whitespace remain data. */
export function extractLogRefusals(log:string,runId:string,markerPid:string):LogRefusal[]{
  if(!/^[0-9a-f]{32}$/.test(runId) || !/^[0-9]+$/.test(markerPid)) throw Error("LOG_UNTRUSTED: marker identity malformed");
  const lines=log.split("\n");if(lines.at(-1)==="") lines.pop();
  const marker=(line:string,which:string)=>{
    const m=PREFIX.exec(line);return m && m[1]===markerPid && m[4]==="postgres" && m[6]==="LOG" && m[7]===`kj-t-${which} ${runId}`;
  };
  const starts=lines.flatMap((line,i)=>marker(line,"begin")?[i]:[]),ends=lines.flatMap((line,i)=>marker(line,"end")?[i]:[]);
  if(starts.length!==1 || ends.length!==1 || starts[0]!>=ends[0]!) throw Error("LOG_UNTRUSTED: unique ordered markers required");
  const records:LogRecord[]=[],lastLine=new Map<string,number>();
  for(const line of lines.slice(starts[0]!+1,ends[0])){
    const m=PREFIX.exec(line);
    if(m){
      const sequence=Number(m[2]);
      if(!Number.isSafeInteger(sequence) || sequence<1 || sequence<=(lastLine.get(m[1]!) ?? 0)) throw Error("LOG_UNTRUSTED: backend line sequence differs");
      lastLine.set(m[1]!,sequence);
      records.push({pid:m[1]!,line:sequence,sqlstate:m[3]!,user:m[4]!,database:m[5]!,severity:m[6]!,message:m[7]!});
    }else if(line.startsWith("\t") && records.length){
      records.at(-1)!.message+="\n"+line.slice(1);
    }else throw Error("LOG_UNTRUSTED: unprefixed line or orphan continuation");
  }
  const refusals:LogRefusal[]=[];
  const associated=new Set<LogRecord>();
  for(let i=0;i<records.length;i++){
    const event=records[i]!;
    if(!["ERROR","FATAL"].includes(event.severity) || event.sqlstate!=="42501" || !["kj_worker","kj_door"].includes(event.user)) continue;
    let statement:LogRecord|undefined;
    for(let j=i+1;j<records.length;j++){
      const next=records[j]!;if(next.pid!==event.pid) continue;
      if(next.severity==="STATEMENT"){statement=next;break;}
      if(!["CONTEXT","DETAIL","HINT","QUERY"].includes(next.severity)) break;
    }
    if(!statement || statement.user!==event.user || statement.sqlstate!==event.sqlstate || statement.database!==event.database)
      throw Error("LOG_UNTRUSTED: refusal has missing or ambiguous statement");
    if(associated.has(statement)) throw Error("LOG_UNTRUSTED: statement associated twice");
    associated.add(statement);
    refusals.push({role:event.user as LogRefusal["role"],sqlstate:event.sqlstate,fingerprint:sqlFingerprint(statement.message),multiplicity:1});
  }
  if(records.some(r=>r.severity==="STATEMENT" && r.sqlstate==="42501" && ["kj_worker","kj_door"].includes(r.user) && !associated.has(r)))
    throw Error("LOG_UNTRUSTED: orphan refusal statement");
  return projectRefusals(refusals);
}
export function projectRefusals(entries:readonly LogRefusal[]):LogRefusal[]{
  const counts=new Map<string,LogRefusal>();
  for(const entry of entries){
    if(!Number.isSafeInteger(entry.multiplicity) || entry.multiplicity<1) throw Error("REFUSAL_INVALID: multiplicity must be positive");
    const key=JSON.stringify([entry.role,entry.sqlstate,entry.fingerprint]),current=counts.get(key);
    if(current) current.multiplicity+=entry.multiplicity;
    else counts.set(key,{role:entry.role,sqlstate:entry.sqlstate,fingerprint:entry.fingerprint,multiplicity:entry.multiplicity});
  }
  return [...counts].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,entry])=>entry);
}
export function refusalDifferences(expected:readonly Refusal[],trace:readonly Refusal[],log:readonly LogRefusal[]):string[]{
  const full=(entries:readonly Refusal[])=>{
    const counts=new Map<string,number>();
    for(const e of entries){
      if(!Number.isSafeInteger(e.multiplicity) || e.multiplicity<1) throw Error("REFUSAL_INVALID: multiplicity must be positive");
      const key=JSON.stringify([e.test,e.role,e.sqlstate,e.fingerprint]);counts.set(key,(counts.get(key) ?? 0)+e.multiplicity);
    }
    return [...counts].sort(([a],[b])=>a<b?-1:a>b?1:0);
  };
  const problems:string[]=[];
  if(JSON.stringify(full(expected))!==JSON.stringify(full(trace))) problems.push("trace refusal multiset differs");
  if(JSON.stringify(projectRefusals(expected))!==JSON.stringify(projectRefusals(log))) problems.push("log refusal projection differs");
  return problems;
}
