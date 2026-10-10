import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { collectionEnvironment, parseCollection, type CollectedEntry } from "../scripts/b1/collection.js";
import { PRIMARY_SUITES, PartitionSchema, coverageProblems, parseReport, partitionProblems, type Partition, type Report, type ReportEntry } from "../scripts/b1/coverage.js";
import { strictJson } from "../services/kernel/src/database/strict-json.js";

describe("pinned collection boundary",()=>{
  it("builds the exact closed Windows environment, discarding ambient credentials and hooks",()=>{
    const env=collectionEnvironment("win32",{Path:"bin",SystemRoot:"root",TEMP:"tmp",TMP:"tmp",USERPROFILE:"user",APPDATA:"app",
      PGHOST:"foreign",DATABASE_URL:"foreign",KJ_RUNTIME_ROLES:"base",SUPABASE_ACCESS_TOKEN:"secret"});
    expect(Object.keys(env).sort()).toEqual(["APPDATA","KJ_GATE3_LIVE","KJ_TEST_PG_URL","PATH","S1B_REARM_LIVE","S1R_LIVE","S1R_RUNTIME","SystemRoot","TEMP","TMP","USERPROFILE"]);
    expect(env.KJ_TEST_PG_URL).toBe("postgresql://kj_collect_placeholder@127.0.0.1:54999/kj_collect_placeholder");
  });
  it("refuses missing platform values, unsupported platforms and missing task locations",()=>{
    expect(()=>collectionEnvironment("linux",{PATH:"bin",HOME:"home"})).toThrow();
    expect(()=>collectionEnvironment("darwin",{})).toThrow();
    expect(()=>parseCollection(JSON.stringify([{file:resolve("tests/x.test.ts"),name:"x"}]),process.cwd())).toThrow();
    expect(()=>parseCollection(JSON.stringify([{file:resolve("outside.test.ts"),name:"x",location:{line:1,column:1}}]),process.cwd())).toThrow();
  });
});

function nativeReport(){
  return {numTotalTestSuites:1,numPassedTestSuites:1,numFailedTestSuites:0,numPendingTestSuites:0,
    numTotalTests:1,numPassedTests:1,numFailedTests:0,numPendingTests:0,numTodoTests:0,snapshot:{},startTime:1,success:true,
    testResults:[{name:resolve("tests/x.test.ts"),startTime:1,endTime:2,status:"passed",message:"",assertionResults:[{
      ancestorTitles:["suite"],fullName:"suite expanded row 0",title:"expanded row 0",status:"passed",duration:1,failureMessages:[],
      location:{line:5,column:3},meta:{},tags:[],
    }]}]};
}
describe("report success and expanded identities",()=>{
  it("accepts the pinned JSON reporter shape with exact locations",()=>{
    expect(parseReport(JSON.stringify(nativeReport()),process.cwd()).entries[0]).toEqual({file:"tests/x.test.ts",name:"suite expanded row 0",status:"passed",location:{line:5,column:3}});
  });
  it.each(["overall","failed-file","file-message","pending","count","missing-location","duplicate-name","unknown-state","duplicate-key"])("rejects %s even when the summary claims success",fault=>{
    const report=nativeReport();
    switch(fault){
      case "overall":report.success=false;break;
      case "failed-file":report.testResults[0]!.status="failed";break;
      case "file-message":report.testResults[0]!.message="beforeAll failed";break;
      case "pending":report.testResults[0]!.assertionResults[0]!.status="pending";break;
      case "count":report.numPassedTests=0;break;
      case "missing-location":delete (report.testResults[0]!.assertionResults[0] as {location?:unknown}).location;break;
      case "duplicate-name":report.testResults[0]!.assertionResults.push(report.testResults[0]!.assertionResults[0]!);report.numTotalTests=2;report.numPassedTests=2;break;
      case "unknown-state":report.testResults[0]!.assertionResults[0]!.status="qualified";break;
    }
    let raw=JSON.stringify(report);
    if(fault==="duplicate-key") raw=raw.replace('"success":true','"success":false,"success":true');
    expect(()=>parseReport(raw,process.cwd())).toThrow();
  });
});

function fixture(){
  const baseline=strictJson(readFileSync("tests/baseline.json","utf8")) as {tests:{file:string;name:string}[];intentionalSkips:{file:string;name:string}[]};
  const notRunInCi=["gate3-executor","schedule-restate-live","schedule-restate-runtime","schedule-restate-rearm-live"].map(n=>`tests/${n}.integration.test.ts`);
  const files:Partition["files"]={},reports=new Map<string,Report>();
  for(const suite of PRIMARY_SUITES) reports.set(suite,{files:[],entries:[]});
  const add=(file:string,name:string,suite:typeof PRIMARY_SUITES[number],status:ReportEntry["status"]="passed")=>{
    files[file]=suite;const report=reports.get(suite)!;
    if(!report.files.includes(file)) report.files.push(file);
    report.entries.push({file,name,status,location:{line:1,column:1}});
  };
  for(const row of baseline.tests) add(`tests/${row.file}`,row.name,"regression-enforce");
  for(const row of baseline.intentionalSkips){
    const file=`tests/${row.file}`,skipped=notRunInCi.includes(file);
    add(file,row.name,skipped?"regression-enforce":"regression-gated",skipped?"skipped":"passed");
  }
  for(const suite of PRIMARY_SUITES) if(!reports.get(suite)!.files.length) add(`tests/${suite}.test.ts`,`${suite} control`,suite);
  for(const report of reports.values()) report.files.sort();
  const partition:Partition={kind:"kerneljson:test-lane-partition/v1",files,notRunInCi,
    suites:PRIMARY_SUITES.map(id=>({id,lane:id==="base-regression"?"A":id==="runner-cases"?"B/C":"D",kind:id==="base-regression"?"base":id==="runner-cases"?"runner":"stage-T"})),
    secondary:[...PRIMARY_SUITES.filter(s=>s.startsWith("regression-")).map(primary=>({kind:"discover" as const,id:`${primary}-discover`,primary})),
      ...(["faculties","identity","identity-cognition"] as const).map(id=>({kind:"mutation" as const,id,script:`scripts/mutation-check-${id}.mjs`}))]};
  const collection:CollectedEntry[]=[...reports.values()].flatMap(r=>r.entries.map(e=>({file:e.file,name:e.name,location:e.location})));
  const required={kind:"kerneljson:b1-required-tests/v1" as const,entries:[{file:"tests/runner-cases.test.ts",name:"runner-cases control",refusals:[]}]};
  const registry=partition.suites.filter(s=>s.kind==="stage-T").flatMap(s=>[{id:s.id,files:reports.get(s.id)!.files},
    {id:`${s.id}-discover`,files:reports.get(s.id)!.files}]);
  return {baseline,reports,partition,collection,required,registry};
}
describe("coverage cannot be recovered from an empty table or a failed setup",()=>{
  it("retains all 224 protected rows, 62 skip dispositions, recovery and required rows",()=>{
    const f=fixture();PartitionSchema.parse(f.partition);
    expect(partitionProblems(f.partition,Object.keys(f.partition.files),f.collection,f.registry)).toEqual([]);
    expect(coverageProblems(f.partition,f.collection,f.reports,f.baseline,f.required)).toEqual([]);
  });
  it.each(["protected","required-each-empty","missing-location","skip-vanished","skip-runs","gated-skip","recovery-26"])("refuses %s",fault=>{
    const f=fixture(),report=f.reports.get("regression-enforce")!;
    if(fault==="protected") report.entries.shift();
    if(fault==="required-each-empty") f.reports.get("runner-cases")!.entries=[];
    if(fault==="missing-location") report.entries[0]!.location={line:99999,column:1};
    if(fault==="skip-vanished") report.entries=report.entries.filter(e=>e.status!=="skipped");
    if(fault==="skip-runs") report.entries.find(e=>e.status==="skipped")!.status="passed";
    if(fault==="gated-skip") f.reports.get("regression-gated")!.entries[0]!.status="skipped";
    if(fault==="recovery-26") report.entries.splice(report.entries.findIndex(e=>e.file==="tests/recovery.test.ts"),1);
    expect(coverageProblems(f.partition,f.collection,f.reports,f.baseline,f.required).length).toBeGreaterThan(0);
  });
  it("refuses a file omitted from the partition or registry",()=>{
    const f=fixture();
    expect(partitionProblems(f.partition,[...Object.keys(f.partition.files),"tests/new.test.ts"],f.collection,f.registry)).toContain("committed test file partition differs");
    f.registry[0]!.files=[];
    expect(partitionProblems(f.partition,Object.keys(f.partition.files),f.collection,f.registry).some(p=>p.startsWith("registry files differ"))).toBe(true);
  });
});
