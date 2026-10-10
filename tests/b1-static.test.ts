import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { b1ShapeProblems, forbiddenMigrationForms } from "../scripts/b1/sql-shape.js";
import { HOOK_DEFINITIONS, CALLERS } from "../scripts/b1/hook-definitions.js";
import { generatedRegistry, registryText, REGISTRY_PATH } from "../scripts/b1/build-hook-registry.js";
import { RegistrySchema } from "../scripts/b1/hooks.js";
import { BASE_PLAN, REGRESSION_SUITES, SUITE_PLANS, planProblems } from "../scripts/b1/plans.js";
import { strictJson } from "../services/kernel/src/database/strict-json.js";

/**
 * ADR-0023 static qualification (27.12.13.8 last list, 27.12.8 item 12, 27.12.13.6, cases 20, 39, CON-32, CON-42),
 * each rule with a failing fixture of its own. These tests read the checkout; they open no connection.
 */
const B1_PATH="supabase/migrations/20261002090000_runtime_least_privilege_roles.sql";
const B1=readFileSync(B1_PATH,"utf8");
function files(dir:string,accept:(p:string)=>boolean,out:string[]=[]):string[]{
  for(const name of readdirSync(dir)){
    if(["node_modules",".git","dist","artifacts"].includes(name)) continue;
    const p=join(dir,name).replaceAll("\\","/");
    if(statSync(p).isDirectory()) files(p,accept,out); else if(accept(p)) out.push(p);
  }
  return out;
}
const CODE=files(".",p=>/\.(ts|mts|mjs|js|sh|ya?ml|sql)$/.test(p)).map(p=>p.replace(/^\.\//,""));

describe("27.12.8 item 12: the generated B1 migration (case 39)",()=>{
  it("contains none of the forbidden forms",()=>{expect(forbiddenMigrationForms(B1)).toEqual([]);});
  it.each([
    ["ON ALL FUNCTIONS","revoke all on all functions in schema public, kernel_private from kj_worker, kj_door;"],
    ["ON ALL ROUTINES","revoke execute on all routines in schema public from public;"],
    ["ON ALL PROCEDURES","revoke all on all  procedures\n in schema kernel_private from kj_door;"],
    ["inside EXECUTE","do $x$ begin execute 'revoke execute on all functions in schema public from public'; end $x$;"],
    ["ALTER DEFAULT PRIVILEGES","alter default privileges in schema public revoke execute on functions from public;"],
    ["ALTER DEFAULT PRIVILEGES routines","ALTER DEFAULT PRIVILEGES REVOKE ALL ON ROUTINES FROM kj_worker;"],
    ["pin name","revoke execute on function public.rls_auto_enable() from public;"],
    ["BEGIN","begin;"],["START TRANSACTION","start transaction;"],["COMMIT","commit;"],["END","end;"],["ROLLBACK","rollback;"],
    ["SAVEPOINT","savepoint a;"],["RELEASE","release a;"],["PREPARE TRANSACTION","prepare transaction 'x';"],
  ])("fails a migration with %s",(_label,fixture)=>{expect(forbiddenMigrationForms(B1+"\n"+fixture).length).toBeGreaterThan(0);});
  it("passes ON ALL TABLES and ON ALL SEQUENCES, and a BEGIN inside a DO body",()=>{
    expect(forbiddenMigrationForms("revoke all on all tables in schema public from kj_worker;\nrevoke all on all sequences in schema public from kj_door;\ndo $$ begin perform 1; end $$;")).toEqual([]);
  });
});

describe("CON-32 the static shape of B1",()=>{
  it("every statement of the generated B1 is a pinned form; DO blocks are exactly the pinned set",()=>{expect(b1ShapeProblems(B1)).toEqual([]);});
  it.each([
    ["CREATE FUNCTION","create function public.f() returns int language sql as $f$ select 1 $f$;"],
    ["CREATE TABLE","create table public.t(x int);"],["CREATE VIEW","create view public.v as select 1;"],["CREATE SEQUENCE","create sequence public.s;"],
    ["GRANT to another role","grant select on public.tasks to anon;"],["policy for another role","create policy kj_worker_select on public.tasks for select to anon using (true);"],
    ["REVOKE outside the list","revoke select on public.tasks from authenticated;"],["GRANT WITH GRANT OPTION","grant select on public.tasks to kj_worker with grant option;"],
    ["ALTER FUNCTION of another function","alter function kernel_private.identity_core_digest_v1(jsonb) security definer;"],
    ["ALTER ROLE of another role","alter role postgres with nosuperuser;"],
    ["an extra DO block","do $$ begin perform 1; end $$;"],
    ["a DO block that creates a function","do $$ begin execute 'create function public.g() returns int language sql as ''select 1'''; end $$;"],
  ])("fails with %s",(_label,fixture)=>{expect(b1ShapeProblems(B1+"\n"+fixture).length).toBeGreaterThan(0);});
  it("fails when a pinned DO block is missing",()=>{
    const without=B1.replace(/do \$\$ begin execute format\('revoke temporary[^\n]*\n/,"");
    expect(without).not.toBe(B1);expect(b1ShapeProblems(without)).toContain("TEMPORARY by format: 0 DO blocks, pinned 1");
  });
});

describe("27.12.8 item 12: who may supply the three settings, and how the runner drives the engine",()=>{
  const WRITERS=new Set(["scripts/b1/engine.ts","scripts/b1/ephemeral.ts"]);
  const NAMES=/kj\.b1\.(co_resident_set_sha256|target_system_identifier|target_database)/;
  const SUPPLY=/set_config\s*\(\s*'kj\.b1\.|\bset\s+(local\s+|session\s+)?kj\.b1\.|-c\s+kj\.b1\./i;
  it("only the runner supplies them; the migration and its generator only read them with current_setting(name, true)",()=>{
    const offenders=CODE.filter(p=>!p.startsWith("tests/") && !WRITERS.has(p) && p!==B1_PATH && p!=="scripts/b1/co-resident-sql.mjs" && NAMES.test(readFileSync(p,"utf8")));
    expect(offenders).toEqual([]);
    expect(CODE.filter(p=>p.startsWith("tests/") && p!=="tests/b1-static.test.ts" && SUPPLY.test(readFileSync(p,"utf8")))).toEqual([]);
    for(const p of [B1_PATH,"scripts/b1/co-resident-sql.mjs"]){
      const text=readFileSync(p,"utf8");
      for(const m of text.matchAll(/[a-z_.]*\(?'kj\.b1\.[a-z_]+'(,\s*true)?\)?/g)) expect(m[0]).toMatch(/^pg_catalog\.current_setting\('kj\.b1\.[a-z_]+',\s*true\)$/);
    }
  });
  it.each([["a set_config","select set_config('kj.b1.target_database','x',true);"],["a SET LOCAL","set local kj.b1.co_resident_set_sha256 = 'x';"],["a startup option","-c kj.b1.target_system_identifier=1"]])("detects %s as a supply",(_label,fixture)=>{expect(SUPPLY.test(fixture)).toBe(true);});
  it("the runner never passes --include-all and never invokes migration repair, db push or db reset",()=>{
    const runner=CODE.filter(p=>p.startsWith("scripts/b1/") && p!=="scripts/b1/diagnostics/r279-helper-rethrow.mjs");
    for(const p of runner){
      const text=readFileSync(p,"utf8");
      expect(text,p).not.toMatch(/--include-all|"repair"|migration repair|db push|db reset|"push"|"reset"/);
    }
    const engine=readFileSync("scripts/b1/engine.ts","utf8");
    expect(engine).toContain('["migration","up","--workdir",exportDirectory,"--db-url",url]');
    expect("x --include-all").toMatch(/--include-all/);
  });
  it("only the runner drives the engine or the ephemeral cluster",()=>{
    const allowed=new Set(["scripts/b1/ephemeral.ts","scripts/b1/hosted.ts","scripts/b1/engine.ts","scripts/b1/ephemeral-cluster.ts","tests/b1-static.test.ts","tests/security-definers.test.ts"]);
    const offenders=CODE.filter(p=>!allowed.has(p) && /\b(prepareEngine|new EphemeralCluster|"migration","up")\b/.test(readFileSync(p,"utf8")));
    expect(offenders).toEqual([]);
  });
  it("the hosted entry point has no path into ephemeral, hook, plan or regression code",()=>{
    const hosted=readFileSync("scripts/b1/hosted.ts","utf8");
    expect(hosted).not.toMatch(/from\s+["'][^"']*(ephemeral|run-artifacts|run-status|hook|plans|regression|stage-t|fixture)[^"']*["']/);
    expect(hosted).not.toMatch(/docker|EphemeralCluster|runEphemeral|snapshotArtifacts/);
  });
});

describe("27.12.13.8 static qualification of the hook registry",()=>{
  const registry=RegistrySchema.parse(strictJson(readFileSync(REGISTRY_PATH,"utf8")));
  it("parses under its exact schema, equals what the committed definitions generate, and ids are unique",()=>{
    expect(readFileSync(REGISTRY_PATH,"utf8")).toBe(registryText(generatedRegistry()));
    expect(new Set(registry.hooks.map(h=>h.id)).size).toBe(registry.hooks.length);
    expect(registry.hooks).toHaveLength(HOOK_DEFINITIONS.length);
  });
  const callerFiles:string[]=[...new Set<string>(Object.values(CALLERS))];
  const hookLiterals=(text:string)=>[...text.matchAll(/\b(?:t|runCase)\(\s*(?:"[^"]*"|`[^`]*`)\s*,\s*[^,]+,\s*\[([^\]]*)\]/g)].map(m=>m[1]!);
  it("every hook's callers exist and name it; every hooked call is in a listed caller and names hooks by string literal",()=>{
    const named=new Map<string,Set<string>>();
    for(const file of callerFiles){
      const text=readFileSync(file,"utf8");
      for(const list of hookLiterals(text)){
        const items=list.split(",").map(s=>s.trim()).filter(Boolean);
        for(const item of items){
          expect(item,`${file}: ${item}`).toMatch(/^"[a-z0-9-]+"$/);
          const id=item.slice(1,-1);
          if(!named.has(id)) named.set(id,new Set());
          named.get(id)!.add(file);
        }
      }
    }
    for(const hook of registry.hooks){
      for(const caller of hook.callers) expect(readFileSync(caller,"utf8"),`${caller} names ${hook.id}`).toContain(`"${hook.id}"`);
      for(const file of named.get(hook.id) ?? []) expect(hook.callers,`${hook.id} called from ${file}`).toContain(file);
      expect(named.has(hook.id),`${hook.id} is called somewhere`).toBe(true);
    }
    for(const id of named.keys()) expect(registry.hooks.map(h=>h.id)).toContain(id);
  });
  it("no file outside the callers passes a hook to the entry point",()=>{
    // The harness builds the argument vector; the refusals file passes only unregistered or malformed ids, which refuse.
    const mechanism=new Set(["tests/b1-static.test.ts","tests/security-definers.test.ts","tests/b1-runner-refusals.test.ts","tests/support/b1-runner.ts"]);
    const others=CODE.filter(p=>p.startsWith("tests/") && !callerFiles.includes(p) && !mechanism.has(p));
    for(const p of others){
      const text=readFileSync(p,"utf8");
      expect(text,p).not.toMatch(/"--hook"/);
      for(const list of hookLiterals(text)) expect(list.trim(),p).toBe("");
    }
  });
  it("a computed hook id at a call site fails the literal rule",()=>{
    const list=hookLiterals('t("x","none",[id])')[0]!;
    expect(list.split(",").map(s=>s.trim()).every(i=>/^"[a-z0-9-]+"$/.test(i))).toBe(false);
  });
  it("the connection factory runs L5 on every connection, with no hook-dependent branch around it",()=>{
    const source=readFileSync("scripts/b1/ephemeral-cluster.ts","utf8");
    const connect=source.slice(source.indexOf("  async connect(database:string)"),source.indexOf("  async engineTarget("));
    const l5=connect.indexOf("LIVE_IDENTITY_SQL");
    expect(l5).toBeGreaterThan(0);
    const beforeL5=connect.slice(connect.indexOf("try{"),l5);
    expect(beforeL5).not.toMatch(/\bif\s*\(|\?|skip|hook/i);
    expect(connect.match(/skipNextAttestation/g)?.length).toBe(2);
    expect(connect.indexOf("this.attest()")).toBeLessThan(l5);
  });
  it("every committed plan is valid, the base plan has one entry, and each suite's databases equal its plan",()=>{
    expect(planProblems(BASE_PLAN)).toEqual([]);expect(BASE_PLAN.entries).toHaveLength(1);
    for(const suite of REGRESSION_SUITES){
      const plan=SUITE_PLANS[suite.id];
      expect(plan,suite.id).toBeDefined();
      expect(planProblems(plan!)).toEqual([]);
      expect(suite.databases).toEqual(plan!.entries.map(e=>e.sequence));
    }
    expect(Object.keys(SUITE_PLANS).sort()).toEqual(REGRESSION_SUITES.map(s=>s.id).sort());
  });
  it("the runner and the consumer share one status function",()=>{
    for(const p of ["scripts/b1/ephemeral.ts","scripts/b1/evidence.ts"]) expect(readFileSync(p,"utf8")).toMatch(/import \{[^}]*qualificationStatus[^}]*\} from "\.\/run-status\.js"/);
    expect(CODE.filter(p=>p!=="tests/b1-static.test.ts" && /function qualificationStatus\b/.test(readFileSync(p,"utf8")))).toEqual(["scripts/b1/run-status.ts"]);
  });
});

describe("27.12.13.6 committed artefacts are HOSTED_COMMITTED only (EPH-12, EPH-16, EPH-19)",()=>{
  type Artifact={mode?:unknown;run?:unknown};
  const problems=(declaration:Artifact|null,baseline:Artifact|null,paths:readonly string[])=>{
    const out:string[]=[];
    for(const [name,a] of [["declaration",declaration],["baseline",baseline]] as const)
      if(a && (a.mode!=="HOSTED_COMMITTED" || "run" in a)) out.push(`${name} is not HOSTED_COMMITTED or carries run`);
    if(declaration && baseline && declaration.mode!==baseline.mode) out.push("modes differ");
    for(const p of paths) if(/(^|\/)(record|header)\.json$|(^|\/)[0-9]+-(declaration|baseline)\.json$|kj-b1-[0-9a-f]{32}/.test(p)) out.push(`run file committed: ${p}`);
    return out;
  };
  const read=(p:string)=>{try{return strictJson(readFileSync(p,"utf8")) as Artifact;}catch{return null;}};
  it("the repository holds no ephemeral artefact and no run file",()=>{
    const tracked=files(".",()=>true).map(p=>p.replace(/^\.\//,"")).filter(p=>!p.startsWith("tests/fixtures/"));
    expect(problems(read("infrastructure/database/co-resident-platform-exceptions.json"),read("infrastructure/database/security-definer-platform-baseline.json"),tracked)).toEqual([]);
  });
  it.each([
    ["an ephemeral declaration",{mode:"EPHEMERAL_RUN_BOUND",run:{}},null,[]],
    ["an ephemeral baseline",null,{mode:"EPHEMERAL_RUN_BOUND",run:{}},[]],
    ["a hosted declaration carrying run",{mode:"HOSTED_COMMITTED",run:{}},null,[]],
    ["mismatched modes",{mode:"HOSTED_COMMITTED"},{mode:"EPHEMERAL_RUN_BOUND"},[]],
    ["a committed run record",null,null,["docs/operations/evidence/record.json"]],
    ["a committed run-bound declaration",null,null,["infrastructure/database/1-declaration.json"]],
  ])("fails with %s",(_label,d,b,paths)=>{expect(problems(d as Artifact|null,b as Artifact|null,paths as string[]).length).toBeGreaterThan(0);});
});

describe("CON-42 and case 20: migrations",()=>{
  const migrations=readdirSync("supabase/migrations").filter(f=>f.endsWith(".sql")).map(f=>readFileSync(join("supabase/migrations",f),"utf8"));
  const handlers=(sql:string)=>/\bexception\s+when\s+(others\b|insufficient_privilege\b|sqlstate\s+'42501')/i.test(sql.replace(/\s+/g," "));
  const createsHelper=(sql:string)=>/\bcreate\s+(or\s+replace\s+)?function\s+("?public"?\.)?"?rls_auto_enable"?\s*\(/i.test(sql);
  it("no migration defines a PL/pgSQL handler that catches a privilege refusal",()=>{expect(migrations.filter(handlers)).toEqual([]);});
  it.each(["begin perform 1; exception when others then null; end","EXCEPTION\n WHEN insufficient_privilege THEN","exception when sqlstate '42501' then"])("fails on a fixture handler: %s",fixture=>{expect(handlers(fixture)).toBe(true);});
  it("no canonical KernelJSON migration creates or replaces rls_auto_enable",()=>{expect(migrations.filter(createsHelper)).toEqual([]);});
  it.each(["create function public.rls_auto_enable() returns event_trigger","CREATE OR REPLACE FUNCTION rls_auto_enable()",'create function "public"."rls_auto_enable" ()'])("fails on %s",fixture=>{expect(createsHelper(fixture)).toBe(true);});
});
