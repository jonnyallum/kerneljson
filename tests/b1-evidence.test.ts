import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hash } from "../services/kernel/src/database/co-resident.js";
import { SEALED_BASE_VERSIONS } from "../services/kernel/src/database/ledger-contract.js";
import { readRunRecord, validateRunRecord } from "../scripts/b1/evidence.js";
import type { Release } from "../scripts/b1/release.js";

/**
 * EPH-26 (a) and EPH-25 at the record layer: the consumer recomputes the status from a synthetic record of exactly the
 * shape a clean, unhooked run refused at L2 would write, and refuses edits. Real records are checked end to end by the
 * runner-case files; none is committed (27.12.13.6).
 */
function refusedRecord(){
  const enginePins=JSON.parse(readFileSync("infrastructure/database/b1-engine-pins.json","utf8"));
  const id="a".repeat(40),digest="b".repeat(64),migrationBlob={id,sha256:digest};
  const plannedApplications=[{sequence:1,database:"kj_b1",version:"20261002090000",migrationBlob}];
  const header={kind:"kerneljson:b1-ephemeral-run/v2",runId:"c".repeat(32),clusterNonce:"d".repeat(32),R:id,runnerBlob:id,registryBlob:id,
    profile:"none",hookIds:[] as string[],negativeFixture:false,planId:"base",regressionSuite:null,plannedApplications,hostTime:"2026-10-10T00:00:00.000Z"};
  const record={header,negativeFixture:false,hookIds:[] as string[],migrationBlob,baseVersions:[...SEALED_BASE_VERSIONS],plannedApplications,
    events:[{step:"L1",outcome:"passed",details:{headerSha256:hash(JSON.stringify(header,null,2)+"\n")} as unknown},
      {step:"L2",outcome:"refused",details:"LIFECYCLE_REFUSED: docker run failed"},{step:"L6",outcome:"passed",details:[]}],applications:[] as unknown[],
    observed:{engine:{version:"2.120.0",platform:"windows-x64",hashes:enginePins.platforms["windows-x64"].executables},applications:[]},
    fixture:null,failure:"LIFECYCLE_REFUSED: docker run failed",status:"NOT_QUALIFIED",fixtureOutcome:"not-run",regressionOutcome:"not-run",stageT:{outcome:"not-run"}};
  const release={R:id,blob:()=>({id,sha256:digest}),migrations:()=>({files:new Map()}),git:()=>Buffer.from(id),
    json:(path:string)=>JSON.parse(readFileSync(path,"utf8"))} as unknown as Release;
  return {record,release};
}
describe("run evidence consumer",()=>{
  it("EPH-26 (a): independently keeps a zero-application L2 refusal NOT_QUALIFIED despite successful teardown",()=>{
    const {record,release}=refusedRecord();
    expect(validateRunRecord(record,release).status).toBe("NOT_QUALIFIED");
  });
  it("EPH-27 (a): the same shape refused at L5 is NOT_QUALIFIED",()=>{
    const {record,release}=refusedRecord();
    record.events.splice(1,1,{step:"L2",outcome:"passed",details:{}},{step:"L3",outcome:"passed",details:{}},{step:"L4",outcome:"passed",details:{}},
      {step:"L5",outcome:"refused",details:"L5: current_user is not superuser"});
    record.failure="L5: current_user is not superuser";
    expect(validateRunRecord(record,release).status).toBe("NOT_QUALIFIED");
  });
  it.each(["status","negative","header","plan","plan-id","suite-with-hook","unknown-record-field","unknown-event-field","fixture-on-unhooked"])("EPH-25: refuses edited %s",edit=>{
    const {record,release}=refusedRecord() as {record:Record<string,unknown>&ReturnType<typeof refusedRecord>["record"];release:Release};
    if(edit==="status") record.status="REPOSITORY_QUALIFIED";
    if(edit==="negative") record.negativeFixture=true;
    if(edit==="header") record.header.clusterNonce="e".repeat(32);
    if(edit==="plan") record.plannedApplications[0]!.database="foreign";
    if(edit==="plan-id") record.header.planId="regression-enforce";
    if(edit==="suite-with-hook"){record.header.hookIds=["l3-skip"];(record.header as Record<string,unknown>).regressionSuite="regression-enforce";}
    if(edit==="unknown-record-field") Object.assign(record,{qualified:true});
    if(edit==="unknown-event-field") Object.assign(record.events[0]!,{bypass:true});
    if(edit==="fixture-on-unhooked") record.fixtureOutcome="passed";
    expect(()=>validateRunRecord(record,release)).toThrow();
  });
  it("requires the exact bytes whose hash the runner emitted",()=>{
    const {record,release}=refusedRecord(),directory=mkdtempSync(join(tmpdir(),"kj-evidence-test-")),path=join(directory,"record.json");
    const bytes=JSON.stringify(record);
    try{
      writeFileSync(path,bytes,{flag:"wx"});
      expect(readRunRecord(path,hash(bytes),release).status).toBe("NOT_QUALIFIED");
      writeFileSync(path,bytes+" ");
      expect(()=>readRunRecord(path,hash(bytes),release)).toThrow("emitted record hash differs");
    }finally{unlinkSync(path);rmdirSync(directory);}
  });
});
