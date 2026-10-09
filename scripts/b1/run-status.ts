/** The runner and evidence consumers use this same non-vacuous predicate. */
import { SEALED_BASE_VERSIONS } from "../../services/kernel/src/database/ledger-contract.js";
export type Step="L1"|"L2"|"L3"|"L4"|"L5"|"L6"|"S1"|"S2"|"S3"|"S4"|"S5"|"S6"|"S7";
export interface MigrationBlob {id:string;sha256:string}
export interface PlannedApplication {sequence:number;database:string;version:"20261002090000";migrationBlob:MigrationBlob}
export interface RunEvent {step:Step;outcome:"passed"|"refused";application?:number;details:unknown}
export interface AppliedApplication {
  sequence:number;database:string;migrationBlob:MigrationBlob;engineExitStatus:number|null;
  ledgerAfter:string[];postLedgerCompared:boolean;postLedgerPassed:boolean;
}
export interface RunEvidence {
  negativeFixture:boolean;hookIds:string[];plannedApplications:PlannedApplication[];
  migrationBlob:MigrationBlob;baseVersions:string[];events:RunEvent[];applications:AppliedApplication[];
}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export function qualificationStatus(record:RunEvidence):"NEGATIVE_FIXTURE_RESULT"|"REPOSITORY_QUALIFIED"|"NOT_QUALIFIED"{
  if(record.negativeFixture===true) return "NEGATIVE_FIXTURE_RESULT";
  if(record.negativeFixture!==false || record.hookIds.length || !record.plannedApplications.length) return "NOT_QUALIFIED";
  if(!/^[0-9a-f]{40}$/.test(record.migrationBlob.id) || !/^[0-9a-f]{64}$/.test(record.migrationBlob.sha256)) return "NOT_QUALIFIED";
  if(record.events.some(e=>e.outcome!=="passed")) return "NOT_QUALIFIED";
  if(!["L1","L2","L3","L4","L5","L6"].every(step=>record.events.some(e=>e.step===step && e.outcome==="passed"))) return "NOT_QUALIFIED";
  if(record.events[0]?.step!=="L1" || record.events.at(-1)?.step!=="L6") return "NOT_QUALIFIED";
  if(record.applications.length!==record.plannedApplications.length || !same(record.baseVersions,SEALED_BASE_VERSIONS)) return "NOT_QUALIFIED";
  const expectedLedger=[...record.baseVersions,"20261002090000"].sort();
  for(let i=0;i<record.plannedApplications.length;i++){
    const plan=record.plannedApplications[i]!,applied=record.applications[i]!;
    if(!plan.database || Buffer.byteLength(plan.database)>63 || Array.from(plan.database).some(c=>c.charCodeAt(0)<32)) return "NOT_QUALIFIED";
    if(plan.sequence!==i+1 || plan.version!=="20261002090000" || !same(plan.migrationBlob,record.migrationBlob) ||
      applied.sequence!==plan.sequence || applied.database!==plan.database || !same(applied.migrationBlob,plan.migrationBlob) ||
      applied.engineExitStatus!==0 || !same(applied.ledgerAfter,expectedLedger) ||
      applied.postLedgerCompared!==true || applied.postLedgerPassed!==true) return "NOT_QUALIFIED";
    const steps=record.events.filter(e=>e.application===plan.sequence && e.step.startsWith("S")).map(e=>e.step);
    if(!same(steps,["S1","S2","S3","S4","S5","S6","S7"])) return "NOT_QUALIFIED";
  }
  if(record.events.some(e=>e.step.startsWith("S") && !record.plannedApplications.some(p=>p.sequence===e.application))) return "NOT_QUALIFIED";
  return "REPOSITORY_QUALIFIED";
}
