import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CASE_TIMEOUT, expectFixturePassed, expectQualified, runCase } from "./support/b1-runner.js";
import { strictJson } from "../services/kernel/src/database/strict-json.js";
import type { Profile } from "../scripts/b1/hooks.js";
import type { RunRecord } from "../scripts/b1/evidence.js";

/**
 * ADR-0023 27.12.13: positive controls (EPH-1, and cases 1, 23, 41, ACL-A and LEDGER-A in this mode, unhooked) and
 * the lifecycle, run-file and hook-discipline cases, each through the governed ephemeral entry point.
 */
const GOLDEN="80d365b875ba65ae543e351a47c09f66c6df756db772f6fa494a36639291d721",EMPTY="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const t=(label:string,profile:Profile,hooks:string[])=>
  it.concurrent(label,async()=>{expectFixturePassed(await runCase(label,profile,hooks));},CASE_TIMEOUT);
const steps=(r:RunRecord)=>r.events.filter(e=>e.outcome==="passed").map(e=>e.step);
const detail=(r:RunRecord,step:string)=>r.events.find(e=>e.step===step && e.outcome==="passed")?.details as Record<string,unknown>;
const sids:string[]=[];
function positive(profile:Profile,setSha256:string){
  return async()=>{
    const outcome=await runCase(`EPH-1 positive control ${profile}`,profile,[]);
    const record=expectQualified(outcome),dir=outcome.summary!.directory;
    const declaration=strictJson(readFileSync(join(dir,"1-declaration.json"),"utf8")) as {mode:string;run:unknown;setSha256:string;provenance:{systemIdentifier:string}};
    const baseline=strictJson(readFileSync(join(dir,"1-baseline.json"),"utf8")) as {mode:string;run:unknown};
    expect(declaration.mode).toBe("EPHEMERAL_RUN_BOUND");expect(baseline.mode).toBe("EPHEMERAL_RUN_BOUND");
    expect(baseline.run).toEqual(declaration.run);
    expect(declaration.setSha256).toBe(setSha256);
    const order=steps(record).filter(s=>s.startsWith("S") || s==="L6");
    expect(order).toEqual(["S1","S2","S3","S4","S5","S6","S7","L6"]);
    expect(record.applications).toHaveLength(record.plannedApplications.length);
    expect(record.applications[0]!.postLedgerPassed).toBe(true);
    expect(String(detail(record,"S6").settings)).toContain(`kj.b1.co_resident_set_sha256=${setSha256}`);
    expect((detail(record,"S7").aclEquivalence as {members:number}).members).toBeGreaterThan(0);
    sids.push(declaration.provenance.systemIdentifier);
  };
}
describe.concurrent("positive controls, unhooked (EPH-1; 1, 23, 41, ACL-A, LEDGER-A)",()=>{
  it.concurrent("empty target (case 23, LEDGER-A)",positive("none",EMPTY),CASE_TIMEOUT);
  it.concurrent("helper target (case 1, case 41 golden vector, ACL-A)",positive("pinned-helper",GOLDEN),CASE_TIMEOUT);
  it.concurrent("platform-definer-fixture target",positive("platform-definer-fixture",EMPTY),CASE_TIMEOUT);
});
describe("EPH-2 fresh clusters differ",()=>{
  it("the positive controls ran on three different system identifiers",()=>{
    expect(sids).toHaveLength(3);expect(new Set(sids).size).toBe(3);
  });
});
describe.concurrent("hook discipline",()=>{
  t("27.9.4 foreign stamp grants are removed by B1 (frozen _acl hook)","none",["stamp-foreign-grants"]);
  t("27.9.4 a tampered stamp body aborts B1 by its source digest (frozen _tamper hook)","platform-definer-fixture",["stamp-body-tamper"]);
  it.concurrent("CON-43 a no-op hook is not-effective and fails its case",async()=>{
    const outcome=await runCase("CON-43 no-op hook","none",["noop-precondition"]);
    expect(outcome.summary?.status).toBe("NEGATIVE_FIXTURE_RESULT");
    expect(outcome.summary?.fixtureOutcome).toBe("failed");
    expect(outcome.summary?.problems).toContain("noop-precondition: not-effective");
  },CASE_TIMEOUT);
  it.concurrent("CON-44 the right step for another rule fails the case",async()=>{
    const outcome=await runCase("CON-44 stamp and head","none",["stamp-and-head"]);
    expect(outcome.summary?.status).toBe("NEGATIVE_FIXTURE_RESULT");
    expect(outcome.summary?.fixtureOutcome).toBe("failed");
    expect(outcome.summary?.failure).toMatch(/^PLATFORM_BASELINE_REFUSED: the migration ledger head is /);
    expect(outcome.summary?.problems.join(" ")).toMatch(/message .* differs/);
  },CASE_TIMEOUT);
  t("EPH-24 gate-inventory-skip on a genuine run completes and never qualifies","none",["gate-inventory-skip"]);
  t("EPH-24 S4 skip on a genuine run completes and never qualifies","none",["s4-skip"]);
  t("EPH-21 L3 skip on a genuine run passes L5 and never qualifies","none",["l3-skip"]);
});
describe.concurrent("L2 target substitution (EPH-3, EPH-4)",()=>{
  t("EPH-3 foreign container: L3 refuses","none",["l2-foreign-container"]);
  t("EPH-3 foreign container with L3 skipped: L5 refuses on the nonce","none",["l2-foreign-container","l3-skip"]);
  t("EPH-4 pre-existing cluster behind a forwarder: L3 refuses","none",["l2-preexisting-tunnel"]);
  t("EPH-4 pre-existing cluster behind a forwarder with L3 skipped: L5 refuses on nonce and initdb time","none",["l2-preexisting-tunnel","l3-skip"]);
});
describe.concurrent("run-bound artefacts (EPH-2, 5, 6, 7, 15, 18, 19, 20)",()=>{
  t("EPH-6 declaration replaced between S3 and S6","none",["files-declaration-after-s4"]);
  t("EPH-6 declaration replaced between S6 and S7","none",["files-declaration-after-s6"]);
  t("EPH-7 declaration deleted","none",["files-declaration-deleted"]);
  t("EPH-7 invalid JSON","none",["files-declaration-invalid-json"]);
  t("EPH-7 byte-order mark","none",["files-declaration-bom"]);
  t("EPH-7 mode missing","none",["files-declaration-drop-mode"]);
  t("EPH-7 HOSTED_COMMITTED with run","none",["files-declaration-hosted-with-run"]);
  t("EPH-7 EPHEMERAL_RUN_BOUND without run","none",["files-declaration-ephemeral-without-run"]);
  t("EPH-7 unknown field in run","none",["files-declaration-run-unknown-field"]);
  t("EPH-19 baseline HOSTED_COMMITTED","none",["files-baseline-mode-hosted"]);
  t("EPH-19 baseline mode missing","none",["files-baseline-drop-mode"]);
  t("EPH-20 baseline runId","none",["files-baseline-run-runid"]);
  t("EPH-20 baseline clusterNonce","none",["files-baseline-run-clusternonce"]);
  t("EPH-20 baseline containerId","none",["files-baseline-run-containerid"]);
  t("EPH-20 baseline containerCreated","none",["files-baseline-run-containercreated"]);
  t("EPH-20 baseline application","none",["files-baseline-run-application"]);
  t("EPH-2 and EPH-15 another run's files: S4 refuses","none",["files-foreign-run"]);
  t("EPH-2 and EPH-15 another run's files past S4: the gate refuses","none",["files-foreign-run","s4-skip"]);
  t("EPH-18 another run's baseline: S4 refuses","none",["files-foreign-baseline"]);
  t("EPH-18 another run's baseline past S4: the gate refuses","none",["files-foreign-baseline","s4-skip"]);
  t("EPH-5 another system identifier: S4 refuses","none",["files-sysid"]);
  t("EPH-5 another system identifier past S4: the gate refuses","none",["files-sysid","s4-skip"]);
});
describe.concurrent("migration blob binding (EPH-14)",()=>{
  t("EPH-14 an exported file differs from its blob","none",["export-tamper"]);
  t("EPH-14 migrationBlob differs at S7","none",["migration-blob-record"]);
});
