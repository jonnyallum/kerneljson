import { describe,expect,it } from "vitest";
import { extractLogRefusals,refusalDifferences,sqlFingerprint,type Refusal } from "../scripts/b1/refusal-accounting.js";

// Parser-level controls only. These do not substitute for the pinned-image CON-48 fixture.
const runId="a".repeat(32);
const record=(pid:number,line:number,severity:string,message:string,user="kj_worker",state="42501")=>
  `kjlog|${pid}|${line}|${state}|${user}|kj_b1| ${severity}:  ${message}`;
const window=(records:string[])=>[record(1,1,"LOG",`kj-t-begin ${runId}`,"postgres","00000"),...records,
  record(1,2,"LOG",`kj-t-end ${runId}`,"postgres","00000")].join("\n")+"\n";
const event=(sql:string,pid=2,start=1)=>[record(pid,start,"ERROR","permission denied"),
  record(pid,start+1,"CONTEXT","SQL function"),record(pid,start+2,"STATEMENT",sql.replaceAll("\n","\n\t"))];
const refusal=(test:string,sql:string):Refusal=>({test,role:"kj_worker",sqlstate:"42501",fingerprint:sqlFingerprint(sql),multiplicity:1});
describe("R279 refusal accounting parser",()=>{
  it("sums identical statements across tests without losing trace attribution",()=>{
    const sql="select denied()",expected=[refusal("first",sql),refusal("second",sql)];
    const log=extractLogRefusals(window([...event(sql),...event(sql,2,4)]),runId,"1");
    expect(log).toEqual([{role:"kj_worker",sqlstate:"42501",fingerprint:sqlFingerprint(sql),multiplicity:2}]);
    expect(refusalDifferences(expected,expected,log)).toEqual([]);
    expect(refusalDifferences(expected,[{...expected[0]!,multiplicity:2}],log)).toEqual(["trace refusal multiset differs"]);
  });
  it("reconstructs multiline SQL, parameters, tabs and more than 600 characters exactly",()=>{
    const sql="select $1, 'two  spaces'\n\tfrom denied_table /*"+"x".repeat(900)+"*/";
    const log=extractLogRefusals(window(event(sql)),runId,"1");
    expect(log[0]!.fingerprint).toBe(sqlFingerprint(sql));
    expect(log[0]!.fingerprint).not.toBe(sqlFingerprint(sql.slice(0,600)));
    expect(log[0]!.fingerprint).not.toBe(sqlFingerprint(sql.replace(/\s+/g," ")));
  });
  it("distinguishes whitespace inside literals",()=>{
    expect(sqlFingerprint("select 'x  y'" )).not.toBe(sqlFingerprint("select 'x y'"));
  });
  it("allows other backends between ERROR, CONTEXT and STATEMENT",()=>{
    const first=event("select a()",2),second=event("select b()",3);
    expect(extractLogRefusals(window([first[0]!,second[0]!,first[1]!,second[1]!,second[2]!,first[2]!]),runId,"1")).toHaveLength(2);
  });
  it.each(["dropped","duplicated"])("fails %s refusal multiplicity",variation=>{
    const sql="select denied()",expected=[refusal("first",sql),refusal("second",sql)];
    const lines=variation==="dropped" ? event(sql) : [...event(sql),...event(sql,2,4),...event(sql,2,7)];
    expect(refusalDifferences(expected,expected,extractLogRefusals(window(lines),runId,"1"))).toEqual(["log refusal projection differs"]);
  });
  it.each([
    [record(2,1,"ERROR","denied"),record(3,2,"STATEMENT","select denied()")],
    [record(2,1,"ERROR","denied"),record(2,2,"LOG","unrelated"),record(2,3,"STATEMENT","select denied()")],
    [record(2,1,"ERROR","denied"),record(2,2,"STATEMENT","select denied()","kj_door")],
    [record(2,1,"ERROR","denied"),record(2,2,"STATEMENT","select denied()","kj_worker","00000")],
    [record(2,1,"FATAL","denied")],
    [record(2,1,"STATEMENT","select denied()")],
    ["unprefixed garbage"],
    ["\torphan continuation"],
  ])("refuses an untrusted log %#",(...records)=>{
    expect(()=>extractLogRefusals(window(records),runId,"1")).toThrow(/LOG_UNTRUSTED/);
  });
  it("requires unique ordered markers from the recorded owner backend",()=>{
    expect(()=>extractLogRefusals(window(event("select denied()")),runId,"99")).toThrow(/markers/);
    expect(()=>extractLogRefusals(window(event("select denied()"))+window([]),runId,"1")).toThrow(/markers/);
  });
});
