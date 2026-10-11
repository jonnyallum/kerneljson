import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { HASH, hash } from "../../services/kernel/src/database/co-resident.js";
import { strictJson } from "../../services/kernel/src/database/strict-json.js";
import { MANIFEST_PATH, RUNTIME_ROLES, type RuntimeRole, type RuntimeRoleManifest } from "../../services/kernel/src/database/runtime-roles.js";
import { STAGE_MANIFEST_PATH } from "../../services/kernel/src/database/security-definers.js";
import { FORBIDDEN, PROBES, SEPARATION, grantWithoutOption } from "../../tests/support/b1-probes.js";
import { RELATION_INVENTORY_PATH, type RelationInventory } from "./relation-inventory.js";
import { RequiredSchema } from "./coverage.js";

/**
 * ADR-0023 27.12.15 G8 (gate table, "B1 evidence files"; "B1 evidence rows"; CON-30): the evidence files of the probe
 * and definer suites are written in the suite's working directory, collected by the runner with SHA-256s, and must
 * hold every row their test lists, each passed. This module is shared by the runner (stage-t.ts, which collects and
 * hashes the files and refuses incomplete evidence itself) and the CI gate (gate-suite.ts and ci-gate.ts, which verify
 * the files against the digests in the run record and recompute every row; nothing the runner concluded is trusted).
 *
 * Expected rows come from the same committed sources at R that scripts/b1/build-required.ts derives
 * tests/b1-required.json from: the probe tables of tests/support/b1-probes.ts, the runtime-role manifest, the committed
 * relation inventory, and tests/b1-required.json itself for the definers fixtures. No count is written by hand.
 *
 * INTERIM (KJ-P8 B1 E1, not sealed): the "function outside manifest" rows of b1-negative-probes.json are derived by the
 * test from the live catalogue, and no committed source lists every function. They are checked as unique, passed, not
 * granted to the role, and identical as a set in the primary suite and its discover twin. That is NOT "every row their
 * test lists": the same row removed from both twins is not detected. It is an unresolved blocker for final G8.
 */
export const G8_FILES:Readonly<Record<string,readonly string[]>>=Object.freeze({
  "regression-probes":Object.freeze(["artifacts/local/b1-negative-probes.json","artifacts/local/b1-definer-probes.json"]),
  "regression-definers":Object.freeze(["artifacts/local/b1-definers.json"]),
});
export const NEGATIVE_FILE="artifacts/local/b1-negative-probes.json",DEFINER_PROBES_FILE="artifacts/local/b1-definer-probes.json",DEFINERS_FILE="artifacts/local/b1-definers.json";
export const g8Files=(suiteId:string):readonly string[]=>G8_FILES[suiteId.replace(/-discover$/,"")] ?? [];
const EVIDENCE_PATH=/^artifacts\/local\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
export const EvidenceEntrySchema=z.strictObject({path:z.string().regex(EVIDENCE_PATH),sha256:HASH,bytes:z.number().int().nonnegative()});
export type EvidenceEntry=z.infer<typeof EvidenceEntrySchema>;
/** The three rows of tests/runtime-roles-negative.integration.test.ts that are not PROBES table rows (literals there). */
export const STATE_ROWS:readonly [number,string][]=Object.freeze([[25,"search_path manipulation then insert"],[26,"forged release_epoch / persisted_at"],[27,"repeated binding inserts"]]);
export const FUNCTION_PROBE="function outside manifest";
const DEFINERS_PREFIX="27.9.4 and 27.10: every assertion fails on purpose ";
const DEFINERS_TEST="tests/runtime-roles-definers.integration.test.ts";

/** Every regular file under <work>/artifacts/local, by posix path relative to <work>, sorted; anything else is a problem. */
function walk(work:string):{files:string[];problems:string[]}{
  const files:string[]=[],problems:string[]=[];
  const visit=(rel:string)=>{
    const abs=join(work,...rel.split("/"));let stat;
    try{stat=lstatSync(abs);}catch{return;}
    if(stat.isSymbolicLink()){problems.push(`${rel}: not a regular file`);return;}
    if(stat.isDirectory()){for(const name of readdirSync(abs).sort()) visit(`${rel}/${name}`);return;}
    if(!stat.isFile()){problems.push(`${rel}: not a regular file`);return;}
    if(!EVIDENCE_PATH.test(rel)){problems.push(`${rel}: invalid evidence path`);return;}
    files.push(rel);
  };
  visit("artifacts/local");
  return {files:files.sort(),problems};
}
/** Runner side (stage T, after the suite exits): collect and hash every local evidence file of the run. */
export function collectLocalEvidence(work:string,suiteId:string):{entries:EvidenceEntry[];files:Map<string,Buffer>;problems:string[]}{
  const {files,problems}=walk(work),entries:EvidenceEntry[]=[],bytes=new Map<string,Buffer>();
  for(const path of files){const b=readFileSync(join(work,...path.split("/")));bytes.set(path,b);entries.push({path,sha256:hash(b),bytes:b.length});}
  for(const path of g8Files(suiteId)) if(!bytes.has(path)) problems.push(`${path}: missing`);
  return {entries,files:bytes,problems};
}
/** Gate side: the files under <stageTDir>/artifacts/local against the entries the runner recorded in this run's record. */
export function verifyRecordedEvidence(stageTDir:string,recorded:unknown,suiteId:string):{problems:string[];files:Map<string,Buffer>}{
  const problems:string[]=[],files=new Map<string,Buffer>();
  if(recorded===undefined) return {problems:["evidence not recorded by the runner"],files};
  const parsed=z.array(EvidenceEntrySchema).safeParse(recorded);
  if(!parsed.success) return {problems:[`evidence record malformed: ${parsed.error.issues.map(i=>i.message).join("; ")}`],files};
  const seen=new Set<string>();
  for(const e of parsed.data){
    if(seen.has(e.path)){problems.push(`${e.path}: recorded twice`);continue;}
    seen.add(e.path);
    const abs=join(stageTDir,...e.path.split("/"));let stat;
    try{stat=lstatSync(abs);}catch{problems.push(`${e.path}: missing`);continue;}
    if(!stat.isFile() || stat.isSymbolicLink()){problems.push(`${e.path}: not a regular file`);continue;}
    const b=readFileSync(abs);
    if(hash(b)!==e.sha256 || b.length!==e.bytes){problems.push(`${e.path}: differs from the recorded digest`);continue;}
    files.set(e.path,b);
  }
  const present=walk(stageTDir);
  problems.push(...present.problems);
  for(const path of present.files) if(!seen.has(path)) problems.push(`${path}: unrecorded file`);
  for(const path of g8Files(suiteId)) if(!seen.has(path) && !problems.some(p=>p.startsWith(`${path}:`))) problems.push(`${path}: missing`);
  return {problems,files};
}

type NegKind="pinned"|"grant"|"relation"|"provenance";
export interface ExpectedG8 {
  negative:Map<string,{kind:NegKind;role:RuntimeRole;expected:string;provenanceRow?:string}>;
  definerProbes:Map<string,{role:RuntimeRole;row:number;sql:string|null;expected:string|null}>;
  fixtures:string[];
  granted:Record<RuntimeRole,Set<string>>;
  designSha:string;
}
const key=(...parts:unknown[])=>JSON.stringify(parts);
/** Reads a committed JSON authority; the runner and the gate pass a Release (blobs at R, duplicate keys refused). */
export interface JsonSource {json(path:string):unknown}
/** The expected rows at R (see the module comment). JSON authorities are read as blobs at R; b1-probes.ts is the checkout of R. */
export function expectedG8Rows(release:JsonSource):ExpectedG8{
  const manifest=release.json(MANIFEST_PATH) as RuntimeRoleManifest;
  const inventory=release.json(RELATION_INVENTORY_PATH) as RelationInventory;
  const required=RequiredSchema.parse(release.json("tests/b1-required.json"));
  const stage=release.json(STAGE_MANIFEST_PATH) as {design?:{sha?:string}};
  const negative:ExpectedG8["negative"]=new Map(),definerProbes:ExpectedG8["definerProbes"]=new Map();
  const put=<V>(m:Map<string,V>,k:string,v:V)=>{if(m.has(k)) throw Error(`G8 expected rows: duplicate identity ${k}`);m.set(k,v);};
  const holds=(role:RuntimeRole,relation:string)=>Object.hasOwn(manifest.roles[role].relations,relation);
  for(const role of RUNTIME_ROLES){
    for(const [probe,sql,expected] of FORBIDDEN) put(negative,key(role,probe,sql),{kind:"pinned",role,expected});
    for(const sql of grantWithoutOption(role)) put(negative,key(role,"grant/revoke has no effect",sql),{kind:"grant",role,expected:"OK|42501 and no change"});
    for(const r of inventory.relations.filter(r=>["r","v"].includes(r.kind) && !holds(role,r.name)))
      put(negative,key(role,"relation outside manifest",`select 1 from ${r.name} limit 1`),{kind:"relation",role,expected:"42501"});
    for(const [row,probe,statement,expected] of PROBES){
      const sql=statement.replaceAll("$ROLE",role);
      put(negative,key(role,`27.9.5 row ${row}: ${probe}`,sql),{kind:"provenance",role,expected,provenanceRow:key(role,row,probe)});
      put(definerProbes,key(role,row,probe),{role,row,sql,expected});
    }
    for(const [row,probe] of STATE_ROWS) put(definerProbes,key(role,row,probe),{role,row,sql:null,expected:null});
  }
  for(const [probe,role,sql] of SEPARATION) put(negative,key(role,probe,sql),{kind:"pinned",role,expected:"42501"});
  const fixtures=required.entries.filter(e=>e.file===DEFINERS_TEST && e.name.startsWith(DEFINERS_PREFIX)).map(e=>e.name.slice(DEFINERS_PREFIX.length));
  if(!fixtures.length) throw Error("G8 expected rows: no definers fixtures in tests/b1-required.json");
  const granted={} as Record<RuntimeRole,Set<string>>;
  for(const role of RUNTIME_ROLES) granted[role]=new Set(Object.keys(manifest.roles[role].functions));
  if(!stage.design?.sha) throw Error("G8 expected rows: the stage manifest names no design");
  return {negative,definerProbes,fixtures,granted,designSha:stage.design.sha};
}

const Role=z.enum(RUNTIME_ROLES as unknown as [RuntimeRole,...RuntimeRole[]]);
const NegativeFile=z.strictObject({contract:z.literal("kerneljson:b1-negative-probes/v1"),
  results:z.array(z.strictObject({role:Role,probe:z.string(),sql:z.string(),expected:z.string(),observed:z.string(),pass:z.boolean()}))});
const TableRow=z.strictObject({role:Role,row:z.number().int().min(1).max(24),probe:z.string(),sql:z.string(),expected:z.string(),observed:z.string(),stateUnchanged:z.boolean(),pass:z.boolean()});
const StateRow=z.strictObject({role:Role,row:z.number().int().min(25).max(27),probe:z.string(),observed:z.unknown(),pass:z.boolean()});
const DefinerProbesFile=z.strictObject({contract:z.literal("kerneljson:b1-definer-probes/v1"),design:z.string(),results:z.array(z.union([TableRow,StateRow]))});
const DefinersFile=z.object({contract:z.literal("kerneljson:b1-definer-qualification/v1"),design:z.string(),testedCommit:z.string(),environment:z.string(),
  fixtures:z.array(z.strictObject({fixture:z.string(),expected:z.string().min(1),observedProblems:z.array(z.string()),failedOnPurpose:z.boolean(),restored:z.boolean()}))});
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function parse<T>(schema:z.ZodType<T>,bytes:Buffer):{value?:T;problem?:string}{
  let raw:unknown;
  try{raw=strictJson(bytes.toString("utf8"));}catch(error){return {problem:`malformed: ${error instanceof Error?error.message:String(error)}`};}
  const r=schema.safeParse(raw);
  return r.success?{value:r.data}:{problem:`malformed: ${r.error.issues.map(i=>`${i.path.join(".")} ${i.message}`).join("; ").slice(0,300)}`};
}
/** One row's verdict: the recomputed pass, and the recorded flag must agree with it. */
function verdict(out:string[],file:string,id:string,recomputed:boolean,flag:boolean){
  if(!recomputed) out.push(`${file}: row not passed ${id}`);
  if(flag!==recomputed) out.push(`${file}: pass flag differs from recomputation ${id}`);
}
export interface G8SuiteResult {problems:string[];functionRows:string[]|null;rows:Record<string,number>}
/**
 * Every row of the suite's G8 files: identities exactly the expected set, each once, each passed by recomputation.
 * `R` is given only by the CI gate (b1-definers.json testedCommit binding); the runner passes null.
 */
export function g8SuiteProblems(suiteId:string,files:ReadonlyMap<string,Buffer>,exp:ExpectedG8,R:string|null):G8SuiteResult{
  const problems:string[]=[],rows:Record<string,number>={};let functionRows:string[]|null=null;
  const base=suiteId.replace(/-discover$/,"");
  const exact=(file:string,ids:string[],expected:Iterable<string>)=>{
    const seen=new Set<string>();
    for(const id of ids){if(seen.has(id)) problems.push(`${file}: duplicate row ${id}`);seen.add(id);}
    const want=new Set(expected);
    for(const id of seen) if(!want.has(id)) problems.push(`${file}: unexpected row ${id}`);
    for(const id of want) if(!seen.has(id)) problems.push(`${file}: missing row ${id}`);
  };
  if(base==="regression-probes"){
    const nb=files.get(NEGATIVE_FILE),db=files.get(DEFINER_PROBES_FILE);
    const neg=nb?parse(NegativeFile,nb):{problem:"missing"},def=db?parse(DefinerProbesFile,db):{problem:"missing"};
    if(neg.problem) problems.push(`${NEGATIVE_FILE}: ${neg.problem}`);
    if(def.problem) problems.push(`${DEFINER_PROBES_FILE}: ${def.problem}`);
    const stateUnchanged=new Map<string,boolean>();
    if(def.value){
      const ids:string[]=[];
      for(const r of def.value.results){
        const id=key(r.role,r.row,r.probe);ids.push(id);
        const e=exp.definerProbes.get(id);if(!e) continue;
        let ok:boolean;
        if("sql" in r){
          ok=e.sql!==null && r.sql===e.sql && r.expected===e.expected && r.observed===r.expected && r.stateUnchanged===true;
          if(e.sql!==null && (r.sql!==e.sql || r.expected!==e.expected)) problems.push(`${DEFINER_PROBES_FILE}: row content differs from the probe table ${id}`);
          stateUnchanged.set(id,r.stateUnchanged);
        } else if(r.row===27) ok=same(r.observed,[{epoch:"7"}]);
        else {const o=r.observed as {epoch?:unknown;recent?:unknown}|null;ok=typeof o==="object" && o!==null && o.epoch==="7" && o.recent===true;}
        verdict(problems,DEFINER_PROBES_FILE,id,ok,r.pass);
      }
      exact(DEFINER_PROBES_FILE,ids,exp.definerProbes.keys());rows[DEFINER_PROBES_FILE]=ids.length;
    }
    if(neg.value){
      const ids:string[]=[],fns:string[]=[];
      for(const r of neg.value.results){
        if(r.probe===FUNCTION_PROBE){
          // INTERIM: catalogue-derived rows (see the module comment).
          const id=key(r.role,r.probe,r.sql),m=/^has_function_privilege\((.+)\)$/.exec(r.sql);
          if(fns.includes(id)) problems.push(`${NEGATIVE_FILE}: duplicate row ${id}`);
          fns.push(id);
          if(!m || exp.granted[r.role].has(m[1]!)) problems.push(`${NEGATIVE_FILE}: unexpected row ${id}`);
          verdict(problems,NEGATIVE_FILE,id,r.expected==="false" && r.observed==="false",r.pass);
          continue;
        }
        const id=key(r.role,r.probe,r.sql);ids.push(id);
        const e=exp.negative.get(id);if(!e) continue;
        if(r.expected!==e.expected) problems.push(`${NEGATIVE_FILE}: row content differs from the probe table ${id}`);
        let ok=r.expected===e.expected && (e.kind==="grant"?["OK","42501"].includes(r.observed):r.observed===e.expected);
        if(e.kind==="provenance") ok=ok && stateUnchanged.get(e.provenanceRow!)===true;
        verdict(problems,NEGATIVE_FILE,id,ok,r.pass);
      }
      exact(NEGATIVE_FILE,ids,exp.negative.keys());
      functionRows=[...fns].sort();rows[NEGATIVE_FILE]=ids.length+fns.length;
    }
  } else if(base==="regression-definers"){
    const b=files.get(DEFINERS_FILE),d=b?parse(DefinersFile,b):{problem:"missing"};
    if(d.problem) problems.push(`${DEFINERS_FILE}: ${d.problem}`);
    if(d.value){
      if(d.value.design!==exp.designSha) problems.push(`${DEFINERS_FILE}: design ${d.value.design} is not the stage manifest's ${exp.designSha}`);
      if(R!==null && d.value.testedCommit!==R) problems.push(`${DEFINERS_FILE}: testedCommit ${d.value.testedCommit} is not R`);
      const ids:string[]=[];
      for(const f of d.value.fixtures){
        const id=JSON.stringify(f.fixture);ids.push(id);
        const failed=f.observedProblems.some(p=>p.includes(f.expected));
        if(f.failedOnPurpose!==failed) problems.push(`${DEFINERS_FILE}: failedOnPurpose differs from recomputation ${id}`);
        if(!(failed && f.failedOnPurpose && f.restored===true)) problems.push(`${DEFINERS_FILE}: row not passed ${id}`);
      }
      exact(DEFINERS_FILE,ids,exp.fixtures.map(f=>JSON.stringify(f)));rows[DEFINERS_FILE]=ids.length;
    }
  }
  return {problems,functionRows,rows};
}
/** INTERIM cross-twin rule for the catalogue-derived function rows: one identical set in the primary and the twin. */
export function functionRowTwinProblems(primary:string[]|null,twin:string[]|null):string[]{
  if(primary===null || twin===null) return [];
  return same(primary,twin)?[]:["INTERIM function-outside-manifest rows differ between regression-probes and regression-probes-discover"];
}
