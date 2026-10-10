import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { strictJson } from "../../services/kernel/src/database/strict-json.js";
import { loadManifest, RUNTIME_ROLES, type RuntimeRole } from "../../services/kernel/src/database/runtime-roles.js";
import { COPROBES, FORBIDDEN, PROBES, SEPARATION, grantWithoutOption } from "../../tests/support/b1-probes.js";
import { LOG_FIXTURE } from "../../tests/support/b1-log-fixture.js";
import { RELATION_INVENTORY_PATH, type RelationInventory } from "./relation-inventory.js";
import { RequiredSchema } from "./coverage.js";
import { collectTests, type CollectedEntry } from "./collection.js";

/**
 * tests/b1-required.json (ADR-0023 27.12.15 "B1 evidence rows"): every B1-specific test, by file and expanded report
 * name, and for each probe its declared refusals (role, SQLSTATE, exact statement fingerprint, multiplicity). The
 * refusals are derived from the probe tables the tests run, the frozen runtime manifest and the committed relation
 * inventory; nothing is read from a test run. `--check` refuses a committed file that differs: removing a row is a
 * reviewed edit of the committed file.
 */
export const REQUIRED_PATH="tests/b1-required.json";
const sha=(t:string)=>createHash("sha256").update(t,"utf8").digest("hex");
type Refusal={role:RuntimeRole;sqlstate:"42501";fingerprint:string;multiplicity:number};
const refusal=(role:RuntimeRole,sql:string):Refusal=>({role,sqlstate:"42501",fingerprint:sha(sql),multiplicity:1});
/** Files whose every test is B1-specific: probes, catalogue, connection, definers, the runner cases and the static rules. */
export const B1_FILES=["tests/runtime-roles-negative.integration.test.ts","tests/runtime-roles-catalogue.integration.test.ts",
  "tests/runtime-roles-connection.integration.test.ts","tests/runtime-roles-definers.integration.test.ts","tests/runtime-roles-definers-base.integration.test.ts",
  "tests/runtime-roles-topology.test.ts",
  "tests/runtime-roles-coresident-probes.integration.test.ts","tests/runtime-roles-log-fixture.integration.test.ts",
  "tests/security-definers.test.ts","tests/b1-static.test.ts","tests/b1-evidence.test.ts","tests/b1-coverage.test.ts","tests/b1-trace.test.ts",
  "tests/b1-refusal-accounting.test.ts","tests/b1-base-guard.test.ts","tests/b1-relation-inventory.integration.test.ts",
  "tests/b1-runner-coresident.test.ts","tests/b1-runner-settings.test.ts","tests/b1-runner-ledger.test.ts","tests/b1-runner-lifecycle.test.ts",
  "tests/b1-runner-refusals.test.ts"] as const;
const NEGATIVE="tests/runtime-roles-negative.integration.test.ts",LOG="tests/runtime-roles-log-fixture.integration.test.ts",CORESIDENT="tests/runtime-roles-coresident-probes.integration.test.ts";
/** The declared refusals of every probe test, by expanded report name. */
export function declaredRefusals():Map<string,{file:string;refusals:Refusal[]}>{
  const manifest=loadManifest(),inventory=strictJson(readFileSync(RELATION_INVENTORY_PATH,"utf8")) as RelationInventory;
  const out=new Map<string,{file:string;refusals:Refusal[]}>();
  const put=(file:string,name:string,refusals:Refusal[])=>{if(out.has(name)) throw Error(`duplicate expanded name: ${name}`);out.set(name,{file,refusals});};
  const holds=(role:RuntimeRole,relation:string)=>Object.hasOwn(manifest.roles[role].relations,relation);
  for(const role of RUNTIME_ROLES){
    for(const [probe,sql,expected] of FORBIDDEN) put(NEGATIVE,`B1 forbidden powers: ${role} ${probe}`,expected==="42501"?[refusal(role,sql)]:[]);
    // GRANT and REVOKE by a role without grant option raise 42501 only where the role holds no privilege at all on an
    // object the statement names; otherwise PostgreSQL warns and changes nothing.
    const [one,all,execute,revoke]=grantWithoutOption(role);
    const publicTables=inventory.relations.filter(r=>r.name.startsWith("public.") && ["r","v","m","p","f"].includes(r.kind));
    put(NEGATIVE,`B1 forbidden powers: ${role} GRANT without grant option changes nothing`,[
      ...(!holds(role,"public.identity_versions")?[refusal(role,one!)]:[]),
      ...(publicTables.some(r=>!holds(role,r.name))?[refusal(role,all!)]:[]),
      ...(!Object.keys(manifest.roles[role].functions).some(f=>f.startsWith("kernel_private.set_identity_freeze("))?[refusal(role,execute!)]:[]),
      ...(!holds(role,"public.tasks")?[refusal(role,revoke!)]:[]),
    ]);
    put(NEGATIVE,`B1 forbidden powers: ${role} every relation outside the manifest is unreadable and unwritable`,
      inventory.relations.filter(r=>["r","v"].includes(r.kind) && !holds(role,r.name)).map(r=>refusal(role,`select 1 from ${r.name} limit 1`)));
    put(NEGATIVE,`B1 forbidden powers: ${role} every function outside the manifest is not executable`,[]);
    for(const [row,probe,statement,expected] of PROBES)
      put(NEGATIVE,`ADR-0023 27.9.5 release-provenance probes: ${role} row ${row}: ${probe}`,expected==="42501"?[refusal(role,statement.replaceAll("$ROLE",role))]:[]);
    put(NEGATIVE,`ADR-0023 27.9.5 release-provenance probes: ${role} row 25: a changed session search_path does not affect the stamp`,[]);
    put(NEGATIVE,`ADR-0023 27.9.5 release-provenance probes: ${role} row 26: forged release_epoch and persisted_at are overwritten with the canonical epoch and a fresh timestamp`,[]);
    put(NEGATIVE,`ADR-0023 27.9.5 release-provenance probes: ${role} row 27: repeated binding inserts do not change the release epoch's value`,[]);
  }
  for(const [probe,role,sql] of SEPARATION) put(NEGATIVE,`B1 role separation ${probe}`,[refusal(role,sql)]);
  for(const role of RUNTIME_ROLES) for(const [n,probe,sql,expected] of COPROBES)
    put(CORESIDENT,`27.12.9 co-resident probes: ${role} case ${n}: ${probe}`,expected==="42501"?[refusal(role,sql)]:[]);
  for(const item of LOG_FIXTURE) put(LOG,item.name,item.statements.map(sql=>refusal(item.role,sql)));
  return out;
}
const reportName=(entry:CollectedEntry)=>{
  const parts=entry.name.split(" > ");
  if(parts.some(p=>p.includes(" > "))) throw Error(`ambiguous collected name: ${entry.name}`);
  return parts.join(" ");
};
export async function generatedRequired(){
  const collection=await collectTests(process.cwd()),declared=declaredRefusals();
  const entries:{file:string;name:string;refusals:Refusal[]}[]=[];
  const seen=new Set<string>();
  for(const entry of collection.entries.filter(e=>(B1_FILES as readonly string[]).includes(e.file))){
    const name=reportName(entry),key=`${entry.file}\0${name}`;
    if(seen.has(key)) continue;seen.add(key);
    const d=declared.get(name);
    if(d && d.file!==entry.file) throw Error(`declared probe in another file: ${name}`);
    entries.push({file:entry.file,name,refusals:d?.refusals ?? []});
  }
  for(const [name,d] of declared) if(!seen.has(`${d.file}\0${name}`)) throw Error(`declared probe not collected: ${name}`);
  entries.sort((a,b)=>a.file<b.file?-1:a.file>b.file?1:a.name<b.name?-1:a.name>b.name?1:0);
  for(const file of B1_FILES) if(!entries.some(e=>e.file===file)) throw Error(`B1 file collected no test: ${file}`);
  return RequiredSchema.parse({kind:"kerneljson:b1-required-tests/v1",entries});
}
if(process.argv[1]?.replaceAll("\\","/").endsWith("scripts/b1/build-required.ts")){
  const text=JSON.stringify(await generatedRequired(),null,2)+"\n";
  if(process.argv.includes("--check")){
    if(readFileSync(REQUIRED_PATH,"utf8")!==text){console.error(`${REQUIRED_PATH} differs from what its sources generate`);process.exitCode=1;}
    else console.log(`${REQUIRED_PATH} matches its sources`);
  } else {writeFileSync(REQUIRED_PATH,text);console.log(`wrote ${REQUIRED_PATH}`);}
}
