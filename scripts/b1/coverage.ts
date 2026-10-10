import { relative, resolve } from "node:path";
import { z } from "zod";
import { strictJson } from "../../services/kernel/src/database/strict-json.js";
import type { CollectedEntry } from "./collection.js";

export const PRIMARY_SUITES=["base-regression","runner-cases","regression-enforce","regression-stack","regression-probes","regression-definers","regression-gated","regression-helper-probes"] as const;
const SuiteId=z.enum(PRIMARY_SUITES),File=z.string().regex(/^tests\/[^/]+\.test\.ts$/);
const Location=z.strictObject({line:z.number().int().positive(),column:z.number().int().positive()});
export const PartitionSchema=z.strictObject({kind:z.literal("kerneljson:test-lane-partition/v1"),
  suites:z.array(z.strictObject({id:SuiteId,lane:z.enum(["A","B/C","D"]),kind:z.enum(["base","runner","stage-T"])})),
  files:z.record(File,SuiteId),notRunInCi:z.array(File),
  secondary:z.array(z.discriminatedUnion("kind",[
    z.strictObject({kind:z.literal("discover"),id:z.string(),primary:SuiteId}),
    z.strictObject({kind:z.literal("mutation"),id:z.enum(["faculties","identity","identity-cognition"]),script:z.string()}),
  ]))});
export type Partition=z.infer<typeof PartitionSchema>;
export const RequiredSchema=z.strictObject({kind:z.literal("kerneljson:b1-required-tests/v1"),entries:z.array(z.strictObject({
  file:File,name:z.string().min(1),refusals:z.array(z.strictObject({role:z.enum(["kj_worker","kj_door"]),sqlstate:z.literal("42501"),
    fingerprint:z.string().regex(/^[0-9a-f]{64}$/),multiplicity:z.number().int().positive()})),
}))});
const Count=z.number().int().nonnegative();
const ReportSchema=z.strictObject({numTotalTestSuites:Count,numPassedTestSuites:Count,numFailedTestSuites:Count,numPendingTestSuites:Count,
  numTotalTests:Count,numPassedTests:Count,numFailedTests:Count,numPendingTests:Count,numTodoTests:Count,
  snapshot:z.record(z.string(),z.unknown()),startTime:z.number(),success:z.boolean(),coverageMap:z.unknown().optional(),
  testResults:z.array(z.strictObject({name:z.string(),startTime:z.number(),endTime:z.number(),status:z.enum(["passed","failed"]),message:z.string(),
    assertionResults:z.array(z.strictObject({ancestorTitles:z.array(z.string()),fullName:z.string().min(1),title:z.string(),
      status:z.enum(["passed","failed","skipped","pending","todo"]),duration:z.number().optional(),failureMessages:z.array(z.string()),
      location:Location,meta:z.record(z.string(),z.unknown()),tags:z.array(z.string()),benchmarks:z.unknown().optional()}))}))});
export interface ReportEntry {file:string;name:string;status:"passed"|"failed"|"skipped"|"pending"|"todo";location:{line:number;column:number}}
export interface Report {files:string[];entries:ReportEntry[]}
export function parseReport(raw:string,root:string):Report{
  const report=ReportSchema.parse(strictJson(raw));
  if(!report.success || report.numFailedTests!==0 || report.numFailedTestSuites!==0 || report.numPendingTestSuites!==0)
    throw Error("REPORT_REFUSED: unsuccessful report");
  const files:string[]=[],entries:ReportEntry[]=[],names=new Set<string>();
  for(const result of report.testResults){
    const file=relative(resolve(root),resolve(result.name)).replaceAll("\\","/");File.parse(file);
    if(files.includes(file) || result.status!=="passed" || result.message!=="" || !result.assertionResults.length)
      throw Error("REPORT_REFUSED: duplicate, empty or failed file result");
    files.push(file);
    for(const assertion of result.assertionResults){
      if(names.has(assertion.fullName)) throw Error("REPORT_REFUSED: duplicate expanded full name");
      names.add(assertion.fullName);
      if(assertion.failureMessages.length || ["failed","pending","todo"].includes(assertion.status)) throw Error("REPORT_REFUSED: failed or incomplete test");
      entries.push({file,name:assertion.fullName,status:assertion.status,location:assertion.location});
    }
  }
  if(report.numTotalTests!==entries.length || report.numPassedTests!==entries.filter(e=>e.status==="passed").length ||
    report.numPendingTests!==entries.filter(e=>e.status==="skipped").length || report.numTodoTests!==0)
    throw Error("REPORT_REFUSED: test counts differ");
  return {files:files.sort(),entries};
}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const identity=(entry:{file:string;name:string})=>`${entry.file}\0${entry.name}`;
const location=(entry:{file:string;location:{line:number;column:number}})=>`${entry.file}:${entry.location.line}:${entry.location.column}`;
export function partitionProblems(partition:Partition,committedFiles:string[],collection:CollectedEntry[],registrySuites:{id:string;files:string[]}[]):string[]{
  const problems:string[]=[];
  if(!same(partition.suites.map(s=>s.id).sort(),[...PRIMARY_SUITES].sort())) problems.push("primary suite set differs");
  if(!same(Object.keys(partition.files).sort(),[...committedFiles].sort())) problems.push("committed test file partition differs");
  for(const suite of partition.suites){
    const expected=suite.id==="base-regression"?{lane:"A",kind:"base"}:suite.id==="runner-cases"?{lane:"B/C",kind:"runner"}:{lane:"D",kind:"stage-T"};
    if(suite.lane!==expected.lane || suite.kind!==expected.kind) problems.push(`suite lane/kind differs: ${suite.id}`);
    const files=Object.keys(partition.files).filter(f=>partition.files[f]===suite.id).sort();
    if(!files.length) problems.push(`suite is empty: ${suite.id}`);
    if(suite.kind==="stage-T" && !same(files,registrySuites.find(s=>s.id===suite.id)?.files.slice().sort())) problems.push(`registry files differ: ${suite.id}`);
  }
  // The registry holds each stage T primary and its discover twin (same files and profile).
  const stageT=partition.suites.filter(s=>s.kind==="stage-T").map(s=>s.id);
  if(!same(registrySuites.map(s=>s.id).sort(),[...stageT,...stageT.map(id=>`${id}-discover`)].sort())) problems.push("registry suite set differs");
  for(const id of stageT){
    const primary=registrySuites.find(s=>s.id===id),twin=registrySuites.find(s=>s.id===`${id}-discover`);
    if(!primary || !twin || !same(primary.files.slice().sort(),twin.files.slice().sort())) problems.push(`discover twin differs: ${id}`);
  }
  const collected=new Set(collection.map(e=>e.file));
  if(!same([...collected].sort(),[...committedFiles].sort())) problems.push("collection file set differs");
  const expectedNotRun=["gate3-executor","schedule-restate-live","schedule-restate-runtime","schedule-restate-rearm-live"].map(n=>`tests/${n}.integration.test.ts`).sort();
  if(!same([...partition.notRunInCi].sort(),expectedNotRun)) problems.push("notRunInCi differs");
  const twins=partition.secondary.filter(s=>s.kind==="discover");
  if(!same(twins.map(s=>s.primary).sort(),partition.suites.filter(s=>s.kind==="stage-T").map(s=>s.id).sort()) ||
    twins.some(s=>s.id!==`${s.primary}-discover`)) problems.push("discover twins differ");
  const mutations=partition.secondary.filter(s=>s.kind==="mutation");
  if(!same(mutations.map(s=>s.id).sort(),["faculties","identity","identity-cognition"]) ||
    mutations.some(s=>s.script!==`scripts/mutation-check-${s.id}.mjs`)) problems.push("mutation suite set differs");
  return problems;
}
export function coverageProblems(partition:Partition,collection:CollectedEntry[],reports:Map<string,Report>,
  baseline:{tests:{file:string;name:string}[];intentionalSkips:{file:string;name:string}[]},required:z.infer<typeof RequiredSchema>):string[]{
  const problems:string[]=[],all:ReportEntry[]=[];
  for(const suite of partition.suites){
    const report=reports.get(suite.id),files=Object.keys(partition.files).filter(f=>partition.files[f]===suite.id).sort();
    if(!report){problems.push(`report missing: ${suite.id}`);continue;}
    if(!same(report.files,files)) problems.push(`report file set differs: ${suite.id}`);
    const locations=new Set(report.entries.map(location)),collected=new Set(collection.filter(e=>files.includes(e.file)).map(location));
    if([...collected].some(l=>!locations.has(l)) || [...locations].some(l=>!collected.has(l))) problems.push(`source coverage differs: ${suite.id}`);
    all.push(...report.entries);
  }
  if(reports.size!==partition.suites.length) problems.push("report suite set differs");
  const normalize=(e:{file:string;name:string})=>({...e,file:e.file.startsWith("tests/")?e.file:`tests/${e.file}`});
  const protectedRows=baseline.tests.map(normalize),skips=baseline.intentionalSkips.map(normalize);
  if(protectedRows.length!==224 || new Set(protectedRows.map(identity)).size!==224) problems.push("protected baseline set differs");
  if(skips.length!==62 || new Set(skips.map(identity)).size!==62) problems.push("intentional skip baseline set differs");
  const requirePassed=(row:{file:string;name:string},label:string)=>{
    const found=all.filter(e=>identity(e)===identity(row));
    if(found.length!==1 || found[0]!.status!=="passed") problems.push(`${label}: ${row.file}: ${row.name}`);
  };
  for(const row of protectedRows) requirePassed(row,"protected test missing or not passed");
  if(!required.entries.length || new Set(required.entries.map(identity)).size!==required.entries.length) problems.push("required test list empty or duplicated");
  for(const row of required.entries) requirePassed(row,"required expanded row missing or not passed");
  const allowedSkips=new Set(skips.map(identity));
  for(const row of all) if(row.status!=="passed" && (row.status!=="skipped" || !allowedSkips.has(identity(row)))) problems.push(`unexpected non-pass: ${row.name}`);
  for(const row of skips){
    const found=all.filter(e=>identity(e)===identity(row));
    if(found.length!==1) problems.push(`intentional skip vanished or duplicated: ${row.name}`);
    else if(partition.notRunInCi.includes(row.file)?found[0]!.status!=="skipped":found[0]!.status!=="passed" || partition.files[row.file]!=="regression-gated")
      problems.push(`intentional skip disposition differs: ${row.name}`);
  }
  for(const file of partition.notRunInCi){
    const actual=all.filter(e=>e.file===file),expected=skips.filter(e=>e.file===file);
    if(!same(actual.map(identity).sort(),expected.map(identity).sort()) || actual.some(e=>e.status!=="skipped")) problems.push(`notRunInCi report binding differs: ${file}`);
  }
  if(all.filter(e=>e.file==="tests/recovery.test.ts" && e.status==="passed").length<27) problems.push("recovery passed fewer than 27");
  return problems;
}
