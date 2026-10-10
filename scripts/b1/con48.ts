import { extractLogRefusals, refusalDifferences, sqlFingerprint, type LogRefusal, type Refusal } from "./refusal-accounting.js";
import { LOG_FIXTURE, LOG_PEEK } from "../../tests/support/b1-log-fixture.js";

/**
 * ADR-0023 27.12.15 case CON-48 over the evidence of a stage T run of regression-probes on the pinned image: the
 * database log the runner saved (database-log.txt), the trace refusals and the refusals tests/b1-required.json
 * declares for the suite. The positive fixture must reconcile exactly and the two literal variants must hash
 * differently; each of the seven sealed perturbations, applied to that same evidence, must fail. Shared by
 * scripts/b1/ci-gate.ts and the CLI below; the perturbations are exercised on a synthetic log in tests/b1-con48.test.ts.
 */
const LINE=/^kjlog\|([0-9]+)\|([0-9]+)\|([0-9A-Z]{5})\|([^|]*)\|([^|]*)\| ([A-Z]+): {2}(.*)$/;
const DENIED_SAME=LOG_FIXTURE[0]!.statements[0]!;
const MULTILINE=LOG_FIXTURE[2]!.statements[0]!;
const [LITERAL_TWO,LITERAL_ONE]=LOG_FIXTURE[7]!.statements as [string,string];
export interface Con48Evidence {log:string;runId:string;markerPid:string;expected:readonly Refusal[];trace:readonly Refusal[];traceSql:readonly {test:string;sql:string}[]}
export interface Con48Result {positive:string[];perturbations:{id:string;failed:boolean;how:string}[]}

interface Line {index:number;pid:string;seq:number;severity:string;sqlstate:string;user:string;text:string;continuation:number}
function parse(lines:string[]):Line[]{
  const out:Line[]=[];
  lines.forEach((line,index)=>{
    const m=LINE.exec(line);
    if(m) out.push({index,pid:m[1]!,seq:Number(m[2]),sqlstate:m[3]!,user:m[4]!,severity:m[6]!,text:m[7]!,continuation:0});
    else if(line.startsWith("\t") && out.length){const last=out.at(-1)!;last.text+="\n"+line.slice(1);last.continuation++;}
  });
  return out;
}
/** Each 42501 refusal of a runtime role with the STATEMENT record of the same backend (the sealed association). */
function pairs(lines:string[]){
  const records=parse(lines),found:{error:Line;statement:Line}[]=[];
  records.forEach((r,i)=>{
    if(r.severity!=="ERROR" || r.sqlstate!=="42501" || !["kj_worker","kj_door"].includes(r.user)) return;
    const statement=records.slice(i+1).find(n=>n.pid===r.pid && n.severity==="STATEMENT");
    if(statement) found.push({error:r,statement});
  });
  return found;
}
const linesOf=(log:string)=>{const lines=log.split("\n");if(lines.at(-1)==="") lines.pop();return lines;};
const join=(lines:string[])=>lines.join("\n")+"\n";
const span=(l:Line)=>Array.from({length:l.continuation+1},(_,k)=>l.index+k);
const withPid=(line:string,pid:string,seq:number)=>line.replace(/^kjlog\|[0-9]+\|[0-9]+\|/,`kjlog|${pid}|${seq}|`);
const unusedPid=(lines:string[],from:number)=>{const used=new Set(parse(lines).map(l=>l.pid));let p=from;while(used.has(String(p))) p++;return String(p);};
function statementLines(statement:Line,sql:string,lines:string[]):string[]{
  const head=lines[statement.index]!.replace(/ STATEMENT: {2}.*$/,""),[first,...rest]=sql.split("\n");
  return [`${head} STATEMENT:  ${first}`,...rest.map(r=>`\t${r}`)];
}
function reconcile(e:Con48Evidence,log:string,trace=e.trace,extract=(text:string)=>extractLogRefusals(text,e.runId,e.markerPid)):string[]{
  let logRefusals:LogRefusal[];
  try{logRefusals=extract(log);}catch(error){return [error instanceof Error?error.message:String(error)];}
  return refusalDifferences(e.expected,trace,logRefusals);
}
/** The rejected association rule: the line after the refusal is the statement, whatever its severity. */
function nextLineExtract(text:string):LogRefusal[]{
  const records=parse(linesOf(text)),out:LogRefusal[]=[];
  records.forEach((r,i)=>{
    if(r.severity==="ERROR" && r.sqlstate==="42501" && ["kj_worker","kj_door"].includes(r.user) && records[i+1])
      out.push({role:r.user as LogRefusal["role"],sqlstate:"42501",fingerprint:sqlFingerprint(records[i+1]!.text),multiplicity:1});
  });
  return out;
}

export function con48(e:Con48Evidence):Con48Result{
  const positive:string[]=[],lines=linesOf(e.log),found=pairs(lines);
  positive.push(...reconcile(e,e.log));
  const fingerprints=new Set(found.map(p=>sqlFingerprint(p.statement.text)));
  if(sqlFingerprint(LITERAL_TWO)===sqlFingerprint(LITERAL_ONE) || !fingerprints.has(sqlFingerprint(LITERAL_TWO)) || !fingerprints.has(sqlFingerprint(LITERAL_ONE)))
    positive.push("the two literal variants are not both in the log under distinct fingerprints");
  const same=found.filter(p=>p.statement.text===DENIED_SAME);
  if(same.length<2) positive.push(`the same denied statement appears ${same.length} times in the log, expected at least 2`);
  const peek=found.find(p=>p.statement.text===LOG_PEEK);
  if(!peek || !parse(lines).some(l=>l.pid===peek.error.pid && l.severity==="CONTEXT" && l.index>peek.error.index && l.index<peek.statement.index))
    positive.push("no CONTEXT line between the denied function call and its STATEMENT");
  const multiline=found.find(p=>p.statement.text===MULTILINE);
  const literal=found.find(p=>p.statement.text===LITERAL_TWO);
  const long=e.traceSql.find(t=>t.sql.length>600);
  if(!multiline || !literal || !long || !peek || same.length<2) return {positive,perturbations:[]};

  const perturbed:{id:string;how:string;problems:string[]}[]=[];
  const edit=(id:string,how:string,change:(copy:string[])=>string[])=>perturbed.push({id,how,problems:reconcile(e,join(change([...lines])))});
  edit("P1","one of the two identical refusals dropped",copy=>{
    const drop=new Set([same[0]!.error.index,...span(same[0]!.statement)]);return copy.filter((_,i)=>!drop.has(i));
  });
  edit("P2","a third identical refusal added",copy=>{
    const pid=unusedPid(copy,900000),end=copy.findIndex(l=>l.endsWith(` LOG:  kj-t-end ${e.runId}`)),s=same[0]!;
    copy.splice(end,0,withPid(copy[s.error.index]!,pid,1),...span(s.statement).map((i,k)=>k===0?withPid(copy[i]!,pid,2):copy[i]!));return copy;
  });
  edit("P3","a STATEMENT attributed to another process id",copy=>{
    const s=same[0]!.statement;copy[s.index]=withPid(copy[s.index]!,unusedPid(copy,910000),1);return copy;
  });
  perturbed.push({id:"P4",how:"the trace text truncated at 600 characters",problems:reconcile(e,e.log,e.trace.map(r=>
    r.test===long.test && r.fingerprint===sqlFingerprint(long.sql)?{...r,fingerprint:sqlFingerprint(long.sql.slice(0,600))}:r))});
  edit("P5","whitespace collapsed",copy=>{
    const s=multiline.statement,replacement=statementLines(s,s.text.replace(/\s+/g," "),copy);
    copy.splice(s.index,s.continuation+1,...replacement);return copy;
  });
  perturbed.push({id:"P6",how:"the next line taken as the statement when it is CONTEXT",problems:reconcile(e,e.log,e.trace,nextLineExtract)});
  edit("P7","whitespace inside a quoted literal altered",copy=>{
    const s=literal.statement;copy.splice(s.index,s.continuation+1,...statementLines(s,LITERAL_ONE,copy));return copy;
  });
  return {positive,perturbations:perturbed.map(p=>({id:p.id,failed:p.problems.length>0,how:`${p.how}: ${p.problems.join("; ") || "RECONCILED"}`}))};
}
export function con48Problems(e:Con48Evidence):string[]{
  const r=con48(e);
  return [...r.positive.map(p=>`positive: ${p}`),
    ...(r.perturbations.length===7?[]:[`${r.perturbations.length} perturbations applied, sealed 7`]),
    ...r.perturbations.filter(p=>!p.failed).map(p=>`${p.id} reconciled: ${p.how}`)];
}
