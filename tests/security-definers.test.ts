import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INVENTORY_SQL, INVENTORY_SQL_SHA256, SEALED_DESIGN, STAGES, baselineEligibilityProblems, baselineEntry, baselineProblems, canonicalJson,
  compareDefiners, excludedSchemaSql, expectedDefiners, identityKey, isExcludedSchema, loadStageManifest, sha256, sortEntries,
  stageBindingProblems, stageFunctions, healthArtifactModeProblems, type DefinerEntry, type PlatformBaseline, type StageManifest,
} from "../services/kernel/src/database/security-definers.js";
import { expectedLedgerHead, expectedLedgerVersions, ledgerSetProblems, parseConnectionFile, scrubPgEnvironment } from "../services/kernel/src/database/platform-baseline-snapshot.js";
import { TABLE_PRIVILEGES, loadManifest } from "../services/kernel/src/database/runtime-roles.js";
import { engineEnvironment, startupUrl } from "../scripts/b1/engine.js";
import { identityProblems, type LiveIdentity } from "../scripts/b1/ephemeral-cluster.js";
import { qualificationStatus, type RunEvidence } from "../scripts/b1/run-status.js";
import { environmentProblems, ephemeralArguments } from "../scripts/b1/ephemeral.js";
import { hostedArguments, hostedPassfile, parseHostedTarget } from "../scripts/b1/hosted.js";
import { HookSchema, RegistrySchema, selectExpectation } from "../scripts/b1/hooks.js";
import { strictJson } from "../services/kernel/src/database/strict-json.js";
import { CO_RESIDENT_SQL, EMPTY_SET_DIGEST, GOLDEN, hash, parseDeclaration, pins, pinText, setDigest,
  type CoResidentEntry } from "../services/kernel/src/database/co-resident.js";

/**
 * KJ-P8 B1 - the stage-aware SECURITY DEFINER inventory of ADR-0023 revision 2.5, section 27.10, without a database:
 * the schema predicate, the static stage binding, the stage sets, the equality rule and the baseline rules. Every rule
 * has a negative case that makes it fail on purpose. The catalogue side is tests/runtime-roles-definers.integration.test.ts.
 */
const manifest = loadStageManifest();
describe("closed hook registry (27.12.13.8)",()=>{
  const registry=()=>strictJson(readFileSync("infrastructure/database/b1-runner-hooks.json","utf8"));
  it("contains the six frozen _ledger snapshot faults with S2 effects, exact S3 messages and ledger preconditions",()=>{
    const value=RegistrySchema.parse(registry());
    const ledger=["ledger-absent","ledger-wrong-head","ledger-gap","ledger-extra","ledger-b1-recorded","stamp-missing"];
    for(const id of ledger){
      const hook=value.hooks.find(h=>h.id===id)!;
      expect(hook.point).toBe("S2");
      expect(hook.expected).toHaveLength(1);
      expect(hook.expected[0]!.end).toEqual({step:"S3",outcome:"refused"});
      expect(hook.expected[0]!.refusal!.message).toMatch(/^PLATFORM_BASELINE_REFUSED: /);
      expect(hook.precondition.kind).toBe("sql");
      expect(ephemeralArguments(["--release","a".repeat(40),"--profile","none","--hook",id]).hooks).toEqual([id]);
    }
    expect(value.hooks.find(h=>h.id==="ledger-gap")!.expected[0]!.refusal!.message).toBe("PLATFORM_BASELINE_REFUSED: the migration ledger does not record exactly the 22 base migrations before B1; missing 20260908234849, 20260910180000, 20260915220000");
  });
  it("refuses widened, duplicated, unknown, mislabelled or vacuous hooks",()=>{
    const value=RegistrySchema.parse(registry()),hook=value.hooks[0]!;
    for(const change of [{point:"L5"},{effect:"skips L5"},{effect:"sets the status"},{callers:[]},{callers:["tests/other.test.ts"]},{cases:[]},
      {expected:[]},{expected:[{...hook.expected[0]!,refusal:{sqlstate:null,message:null,pattern:null}}]},
      {expected:[{...hook.expected[0]!,refusal:{sqlstate:null,message:null,pattern:"any error"}}]},
      {precondition:{kind:"runner",fact:"anything",expected:true}},{address:"localhost"}])
      expect(()=>HookSchema.parse({...hook,...change}),JSON.stringify(change)).toThrow();
    expect(()=>RegistrySchema.parse({...value,hooks:[...value.hooks,hook]})).toThrow();
    expect(()=>RegistrySchema.parse({...value,hooks:[{...hook,id:hook.id.toUpperCase()},...value.hooks]})).toThrow();
    expect(()=>RegistrySchema.parse({...value,setupProfiles:value.setupProfiles.slice(1)})).toThrow();
  });
  it("selects exactly one registered expectation for a hook set and profile, and refuses any other combination",()=>{
    const value=RegistrySchema.parse(registry());
    expect(selectExpectation(value,["drift-ensure-rls-dropped"],"pinned-helper").expectation.end.step).toBe("S6");
    expect(selectExpectation(value,["drift-ensure-rls-dropped","gate-inventory-skip"],"pinned-helper").expectation.refusal!.message)
      .toBe("B1 P2 (c) E3: sealed topology of the pinned function is incomplete or extended");
    expect(()=>selectExpectation(value,["drift-ensure-rls-dropped"],"none")).toThrow(/not registered/);
    expect(()=>selectExpectation(value,["ledger-absent","ledger-gap"],"none")).toThrow(/not registered/);
    expect(()=>selectExpectation(value,["ledger-absent","ledger-absent"],"none")).toThrow(/repeated/);
  });
});
describe("hosted entry point boundaries", () => {
  const R="a".repeat(40);
  const target={kind:"kerneljson:b1-hosted-target/v1",host:"db.example.internal",port:5432,database:"postgres",user:"owner",password:"p:a\\ss",ca:"fixture CA"};
  it("accepts only a release and credential file, never an authority path or suite", () => {
    expect(hostedArguments(["--release",R,"--target-file","credentials.json"]).R).toBe(R);
    for(const option of ["--profile","--hook","--regression-suite","--baseline","--declaration","--status"])
      expect(()=>hostedArguments(["--release",R,option,"value"])).toThrow("HOSTED_REFUSED");
  });
  it("refuses duplicate, unknown, wildcard and incomplete connection fields without echoing credentials", () => {
    for(const raw of [JSON.stringify({...target,ssl:false}),JSON.stringify({...target,host:"*"}),
      JSON.stringify({...target,port:0}),JSON.stringify({...target,user:""}),JSON.stringify({...target,password:"a\nb"}),
      JSON.stringify(target).replace('"port":5432','"port":5432,"port":5433')]) {
      expect(()=>parseHostedTarget(raw)).toThrow(/^HOSTED_REFUSED: invalid target credential file$/);
    }
  });
  it("creates one exact passfile entry with libpq escaping", () => {
    expect(hostedPassfile(parseHostedTarget(JSON.stringify(target)))).toBe("db.example.internal:5432:postgres:owner:p\\:a\\\\ss\n");
  });
  it("contains no ephemeral, hook or regression import or fallback", () => {
    const source=readFileSync("scripts/b1/hosted.ts","utf8");
    expect(source).not.toMatch(/from\s+["'][^"']*(?:ephemeral|run-artifacts|run-status|regression|hooks)[^"']*["']/);
    expect(source).not.toMatch(/(?:createContainer|docker|runEphemeral|process\.env)/);
    expect(source).toContain('ssl:{ca:target.ca,rejectUnauthorized:true}');
    expect(source).toContain("unlinkSync(passfile)");
  });
});
const lf = (t: string) => t.replaceAll("\r\n", "\n");
const hex = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const MIGRATIONS = "supabase/migrations";
const B1 = "20261002090000_runtime_least_privilege_roles.sql";
const releaseMigrations = (): Map<string, string> =>
  new Map(readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort().map((f) => [f, hex(lf(readFileSync(`${MIGRATIONS}/${f}`, "utf8")))]));
const clone = (): StageManifest => JSON.parse(JSON.stringify(manifest)) as StageManifest;

describe("27.10.2 governed and excluded schemas", () => {
  it("excludes exactly pg_catalog, information_schema, pg_toast, pg_temp_<n> and pg_toast_temp_<n>", () => {
    for (const s of ["pg_catalog", "information_schema", "pg_toast", "pg_temp_1", "pg_temp_42", "pg_toast_temp_7"]) expect(isExcludedSchema(s), s).toBe(true);
  });
  it("governs every other schema, whatever its name: platform-looking, KernelJSON, near-misses and case variants", () => {
    for (const s of ["public", "kernel_private", "auth", "storage", "extensions", "graphql", "vault", "realtime", "supabase_migrations",
      "pg_temp_", "pg_temp_1x", "pg_temp_-1", "xpg_temp_1", "pg_toast_temp_", "pg_toastx", "PG_CATALOG", "pg_catalog_x", "information_schema2"])
      expect(isExcludedSchema(s), s).toBe(false);
  });
  it("the SQL predicate is the sealed text", () => {
    expect(excludedSchemaSql("n.nspname")).toBe(
      "(n.nspname in ('pg_catalog', 'information_schema', 'pg_toast') or n.nspname ~ '^pg_temp_[0-9]+$' or n.nspname ~ '^pg_toast_temp_[0-9]+$')");
    expect(INVENTORY_SQL).toContain(`where p.prosecdef and not ${excludedSchemaSql("n.nspname")}`);
    expect(INVENTORY_SQL_SHA256).toBe(sha256(INVENTORY_SQL));
  });
});

describe("27.10.3 the KernelJSON stage manifest", () => {
  it("is bound to the sealed design and lists the six stages in rollout order", () => {
    expect(manifest.design).toEqual({ adr: "ADR-0023", revision: "2.7.9", sha: SEALED_DESIGN });
    expect(SEALED_DESIGN).toBe("af2f7320aae32eaa0ce699b1c09d015371f156d5");
    expect(manifest.stages.map((s) => s.stage)).toEqual([...STAGES]);
    expect(manifest.declaredStage).toBe("B1");
  });
  it("has exact stage sets: 1 at B1, 2 from P8A-0 to P8A-2, 3 at P8B", () => {
    const at = (stage: (typeof STAGES)[number]) => stageFunctions(manifest, stage).map((f) => `${identityKey(f)} -> ${f.returns}`);
    const stamp = "kernel_private.stamp_binding_provenance() -> pg_catalog.trigger";
    const freeze = "kernel_private.freeze_reflection(pg_catalog.uuid) -> pg_catalog.void";
    const close = "kernel_private.close_growth_window_by_owner(pg_catalog.uuid, pg_catalog.uuid) -> kernel_private.identity_growth_window_closures";
    expect(at("B1")).toEqual([stamp]);
    for (const s of ["P8A-0", "B2", "P8A-1", "P8A-2"] as const) expect(at(s), s).toEqual([stamp, freeze]);
    expect(at("P8B")).toEqual([stamp, freeze, close]);
  });
  it("pins the section 27.9 exception exactly", () => {
    const [stamp] = stageFunctions(manifest, "B1");
    expect(stamp).toMatchObject({
      retset: false, kind: "f", owner: "<deployment owner>", securityDefiner: true, language: "plpgsql",
      config: ['search_path=""'], acl: ["<deployment owner>=X/<deployment owner>"],
    });
    expect(manifest.stampTrigger).toEqual({
      name: "execution_bindings_provenance", relation: "kernel_private.execution_bindings", tgtype: 7, tgenabled: "O", tgqual: null, tgisinternal: false, tgnargs: 0, tgattr: "",
    });
  });
  it("the stamp source digest pin equals derivation B, recomputed here independently from the applied migration", () => {
    const text = lf(readFileSync(`${MIGRATIONS}/20260916205049_release_provenance.sql`, "utf8"));
    const open = text.indexOf("create function kernel_private.stamp_binding_provenance()");
    const start = text.indexOf("$$", open) + 2, end = text.indexOf("$$", start);
    const derivationB = hex(text.slice(start, end));
    const decisions = JSON.parse(readFileSync("infrastructure/database/runtime-role-decisions.json", "utf8")) as { securityDefinerTriggers: { sourceDigest: string }[] };
    expect(stageFunctions(manifest, "B1")[0]!.sourceDigest).toBe(derivationB);
    expect(decisions.securityDefinerTriggers[0]!.sourceDigest).toBe(derivationB);
  });
  it("the B1 migration does not recreate the stamp function (body immutability, 27.9.2 item 2)", () => {
    const b1 = lf(readFileSync(`${MIGRATIONS}/${B1}`, "utf8")).replace(/--[^\n]*/g, "");
    expect(b1).not.toMatch(/create\s+(or\s+replace\s+)?function\s+kernel_private\.stamp_binding_provenance/i);
    expect(b1).toContain("alter function kernel_private.stamp_binding_provenance() security definer;");
    expect(b1).toContain("alter function kernel_private.stamp_binding_provenance() set search_path = '';");
    // B1 creates no function at all, no later-stage function, and turns exactly one function into a definer.
    expect(b1).not.toMatch(/create\s+(or\s+replace\s+)?function/i);
    expect(b1).not.toMatch(/freeze_reflection|close_growth_window_by_owner/);
    expect(b1.match(/alter\s+function\s+[^;]*\bsecurity\s+definer\s*;/gi)).toEqual(["alter function kernel_private.stamp_binding_provenance() security definer;"]);
  });
});

describe("27.10.5 the declared stage is not a free label", () => {
  it("this release carries exactly the B1 stage", () => {
    expect(stageBindingProblems(manifest, releaseMigrations())).toEqual([]);
  });
  it("a release claiming B1 without the B1 migration fails", () => {
    const m = releaseMigrations();
    m.delete(B1);
    expect(stageBindingProblems(manifest, m)).toEqual([`stage B1 migration ${B1} is not in the release`]);
  });
  it("a changed B1 migration, or a changed base migration, fails", () => {
    const m = releaseMigrations();
    m.set(B1, "0".repeat(64));
    m.set("20260916205049_release_provenance.sql", "1".repeat(64));
    const problems = stageBindingProblems(manifest, m);
    expect(problems.some((p) => p.startsWith(`stage B1 migration ${B1} has SHA-256 ${"0".repeat(64)}`))).toBe(true);
    expect(problems.some((p) => p.startsWith("base migration 20260916205049_release_provenance.sql has SHA-256"))).toBe(true);
  });
  it("a release carrying a migration that no implemented stage lists fails (a later stage cannot ride along)", () => {
    const m = releaseMigrations();
    m.set("20261101000000_p8a0_reflection.sql", "2".repeat(64));
    expect(stageBindingProblems(manifest, m)).toEqual(["migration 20261101000000_p8a0_reflection.sql belongs to no implemented stage of B1"]);
  });
  it("relabelling the release as a later stage fails: the stage is not implemented and its pins are empty", () => {
    for (const later of ["P8A-0", "B2", "P8A-1", "P8A-2", "P8B"] as const) {
      const m = clone();
      m.declaredStage = later;
      const problems = stageBindingProblems(m, releaseMigrations());
      expect(problems.some((p) => p.includes("is declared") && p.includes("not implemented")), later).toBe(true);
    }
    const p8a0 = clone();
    p8a0.declaredStage = "P8A-0";
    expect(stageBindingProblems(p8a0, releaseMigrations())).toEqual(expect.arrayContaining([
      "stage P8A-0 declares kernel_private.freeze_reflection(pg_catalog.uuid) with no language pin",
      "stage P8A-0 declares kernel_private.freeze_reflection(pg_catalog.uuid) with no sourceDigest pin",
    ]));
  });
  it("marking a later stage implemented without declaring it fails, and so does an unknown label", () => {
    const m = clone();
    m.stages[1]!.implemented = true;
    expect(stageBindingProblems(m, releaseMigrations())).toEqual(["stage P8A-0 is implemented but the release declares only B1"]);
    const bogus = clone();
    (bogus as unknown as { declaredStage: string }).declaredStage = "P8Z";
    expect(stageBindingProblems(bogus, releaseMigrations())).toEqual([`declared stage P8Z is not one of ${STAGES.join(", ")}`]);
  });
  it("a manifest bound to another design, or with stages out of order, fails", () => {
    const m = clone();
    m.design.sha = "8a17de18b26edd12a9f3af7ab6179552ff0cd20e";
    [m.stages[2], m.stages[3]] = [m.stages[3]!, m.stages[2]!];
    const problems = stageBindingProblems(m, releaseMigrations());
    expect(problems).toContain(`stage manifest is bound to design 8a17de18b26edd12a9f3af7ab6179552ff0cd20e, not ${SEALED_DESIGN}`);
    expect(problems.some((p) => p.startsWith("stage manifest lists stages"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
const OWNER = "postgres";
const row = (o: Partial<DefinerEntry> & { schema: string; name: string; args: string[] }): DefinerEntry => ({
  returns: "pg_catalog.int4", retset: false, kind: "f", owner: "supabase_admin", securityDefiner: true, language: "sql",
  config: null, acl: null, sourceDigest: "a".repeat(64), ...o,
});
const stampRow = row({
  schema: "kernel_private", name: "stamp_binding_provenance", args: [], returns: "pg_catalog.trigger", owner: OWNER, language: "plpgsql",
  config: ['search_path=""'], acl: [`${OWNER}=X/${OWNER}`], sourceDigest: stageFunctions(manifest, "B1")[0]!.sourceDigest!,
});
const platform = [row({ schema: "auth", name: "uid", args: [], returns: "pg_catalog.uuid" }), row({ schema: "storage", name: "search", args: ["pg_catalog.text"] })];
const baselineOf = (entries: DefinerEntry[]): PlatformBaseline => {
  const e = sortEntries(entries).map(baselineEntry);
  return {
    contract: "kerneljson:security-definer-platform-baseline/v1", mode:"HOSTED_COMMITTED", design: SEALED_DESIGN, environment: "unit",
    provenance: {
      systemIdentifier: "1", database: "x", serverVersion: "PostgreSQL 17", snapshotAt: "2026-10-06T00:00:00.000000Z", snapshotUser: OWNER,
      transaction: { readOnly: true, searchPath: '""' },
      migrationLedger: { table: "supabase_migrations.schema_migrations", present: true, head: expectedLedgerHead(manifest), b1Recorded: false, versions: expectedLedgerVersions(manifest) },
      stampSecurityDefiner: false, querySha256: INVENTORY_SQL_SHA256,
    },
    entries: e, entriesSha256: sha256(canonicalJson(e)),
  };
};
const baseline = baselineOf(platform);

describe("27.12 co-resident authority artifacts",()=>{
  const entry:CoResidentEntry={...pins.entries[0]!,rawDigest:pins.entries[0]!.sourceDigest,rawBytes:953,hasCR:false};
  const declaration=()=>({kind:"kerneljson:co-resident-platform-exceptions/v1",mode:"HOSTED_COMMITTED",environment:"unit",
    provenance:{...baseline.provenance,querySha256:hash(CO_RESIDENT_SQL)},pinsSha256:hash(pinText),
    setSha256:setDigest([entry]),entries:[structuredClone(entry)]});
  it("keeps deployed health hosted-only and binds disposable health to every expected run field",()=>{
    const hosted=parseDeclaration(JSON.stringify(declaration()));
    expect(healthArtifactModeProblems(baseline,hosted)).toEqual([]);
    const run={runId:"a".repeat(32),clusterNonce:"b".repeat(32),containerId:"c".repeat(64),containerCreated:"2026-10-10T00:00:00Z",application:1};
    const ephemeral=parseDeclaration(JSON.stringify({...declaration(),mode:"EPHEMERAL_RUN_BOUND",run}));
    const paired={...baseline,mode:"EPHEMERAL_RUN_BOUND" as const,run};
    expect(healthArtifactModeProblems(paired,ephemeral,run)).toEqual([]);
    expect(healthArtifactModeProblems(paired,ephemeral).length).toBe(1);
    expect(healthArtifactModeProblems(baseline,hosted,run).length).toBe(1);
    for(const changed of [{runId:"d".repeat(32)},{clusterNonce:"d".repeat(32)},{containerId:"d".repeat(64)},
      {containerCreated:"2026-10-11T00:00:00Z"},{application:2}])
      expect(healthArtifactModeProblems(paired,ephemeral,{...run,...changed}).length).toBe(1);
  });
  it("pins every source attribute and the complete topology independently",()=>{
    expect(pins).toEqual({kind:"kerneljson:co-resident-platform-pins/v1",entries:[{
      schema:"public",name:"rls_auto_enable",args:[],returns:"pg_catalog.event_trigger",retset:false,kind:"f",owner:"postgres",
      securityDefiner:true,language:"plpgsql",config:["search_path=pg_catalog"],acl:null,volatility:"v",strict:false,
      leakproof:false,parallel:"u",binary:null,sqlBody:null,sourceDigest:"2782e98b348aca7d6f6f73c420fd78d2e094957dd7a52b0483d4c34f29d2a7a1",
      sourceBytes:953,bindings:[{name:"ensure_rls",owner:"postgres",event:"ddl_command_end",function:"public.rls_auto_enable()",
        enabled:"O",tags:["CREATE TABLE","CREATE TABLE AS","SELECT INTO"]}]}]});
  });
  it("matches the sealed empty and 285-byte populated golden vectors",()=>{
    expect(Buffer.byteLength(GOLDEN)).toBe(285);
    expect(hash(GOLDEN)).toBe("80d365b875ba65ae543e351a47c09f66c6df756db772f6fa494a36639291d721");
    expect(setDigest([])).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(parseDeclaration(JSON.stringify(declaration())).entries).toEqual([entry]);
    expect(parseDeclaration(JSON.stringify({...declaration(),entries:[],setSha256:EMPTY_SET_DIGEST})).entries).toEqual([]);
  });
  it.each(['{"mode":1,"mode":2}','{"x":{"a":1,"\\u0061":2}}','{"a":[{"x":1,"x":2}]}'])("rejects duplicate decoded keys: %s",text=>{
    expect(()=>strictJson(text)).toThrow(/DUPLICATE_JSON_KEY/);
  });
  it.each(["",'{"x":1,}',"[1,]","true false",'"unterminated',"01","\uFEFF{}"])("rejects malformed JSON: %s",text=>{
    expect(()=>strictJson(text)).toThrow();
  });
  it.each(["pinsSha256","setSha256","environment","provenance","entries","mode","kind"])("rejects missing field %s",field=>{
    const d:Record<string,unknown>=declaration(); delete d[field]; expect(()=>parseDeclaration(JSON.stringify(d))).toThrow();
  });
  it.each(["owner","returns","sourceDigest","config","acl","bindings"])("rejects changed pin field %s",field=>{
    const d=declaration(); (d.entries[0] as unknown as Record<string,unknown>)[field]=field==="acl" ? [] : null;
    expect(()=>parseDeclaration(JSON.stringify(d))).toThrow();
  });
  it("rejects missing bindings, extra bindings, copied identities and duplicate members",()=>{
    for(const entries of [[{...entry,bindings:[]}],[{...entry,bindings:[...entry.bindings,...entry.bindings]}],
      [{...entry,schema:"auth"}],[entry,entry]]) expect(()=>setDigest(entries)).toThrow();
  });
  it("rejects unknown nested fields and hosted/run substitution",()=>{
    const d=declaration();
    for(const altered of [{...d,unknown:true},{...d,provenance:{...d.provenance,unknown:true}},
      {...d,entries:[{...entry,unknown:true}]},{...d,run:{}},{...d,mode:"EPHEMERAL_RUN_BOUND"}])
      expect(()=>parseDeclaration(JSON.stringify(altered))).toThrow();
  });
  it("builds H1 environments with exactly the permitted names",()=>{
    expect(engineEnvironment("engine","home","temp",false)).toEqual({PATH:"engine",HOME:"home",TMPDIR:"temp"});
    expect(engineEnvironment("engine","home","temp",true,"system")).toEqual({PATH:"engine",HOME:"home",TMPDIR:"temp",
      USERPROFILE:"home",TEMP:"temp",TMP:"temp",SystemRoot:"system"});
    expect(()=>engineEnvironment("engine","home","temp",true)).toThrow(/SystemRoot/);
    expect(engineEnvironment("engine","home","temp",false,undefined,"pass").PGPASSFILE).toBe("pass");
  });
  it("accepts only the exact current ephemeral argument contract",()=>{
    const args=["--release","a".repeat(40),"--profile","none"];
    expect(ephemeralArguments(args)).toEqual({R:"a".repeat(40),profile:"none",hooks:[],suite:null});
    expect(ephemeralArguments([...args,"--hook","l3-skip","--hook","s4-skip"]).hooks).toEqual(["l3-skip","s4-skip"]);
    expect(ephemeralArguments([...args,"--regression-suite","regression-enforce"]).suite).toBe("regression-enforce");
    for(const extra of ["--url","--host","--port","--database","--baseline","--declaration","--status","--mode","--suite"])
      expect(()=>ephemeralArguments([...args,extra,"x"])).toThrow(/EPHEMERAL_REFUSED/);
    expect(()=>ephemeralArguments([...args,"--regression-suite","a","--regression-suite","b"])).toThrow(/EPHEMERAL_REFUSED/);
    expect(()=>ephemeralArguments([...args,"--hook","Ledger-Absent"])).toThrow(/EPHEMERAL_REFUSED/);
    expect(()=>ephemeralArguments([...args,"--hook"])).toThrow(/EPHEMERAL_REFUSED/);
    expect(()=>ephemeralArguments(["--release","HEAD","--profile","none"])).toThrow();
    expect(()=>ephemeralArguments(["--release","a".repeat(40),"--profile","unknown"])).toThrow();
    expect(environmentProblems({KJ_B1_STATUS:"x",KJ_RUNTIME_ROLES:"base",PATH:"p"})).toEqual(["KJ_B1_STATUS"]);
  });
  it("pins the platform fixture to its four exact functions and per-function revokes",()=>{
    const fixture=readFileSync("infrastructure/database/b1-fixture-platform-definers.sql","utf8");
    expect(hash(fixture)).toBe("272681f3aec95c0d7ff99865c80d54643bafd7bf21c5d7faf68a70d5771048b4");
    expect(fixture.match(/^create schema auth;$/gm)).toHaveLength(1);
    expect([...fixture.matchAll(/^create function ([^(]+)\(/gm)].map(m=>m[1])).toEqual([
      "auth.kj_platform_uid","auth.kj_platform_guard","auth.kj_platform_atomic","auth.kj_platform_len"]);
    expect(fixture.match(/^revoke execute on function auth\.[^;]+ from public;$/gm)).toHaveLength(4);
    expect(fixture).not.toMatch(/kernel_private|supabase_migrations|create role|alter role|on all functions/i);
  });
  it("encodes startup settings and refuses inherited options or URL passwords",()=>{
    const d=parseDeclaration(JSON.stringify(declaration()));d.provenance.database="space and\\slash";
    expect(new URL(startupUrl("postgresql://postgres@127.0.0.1:1234/db",d)).searchParams.get("options"))
      .toContain("kj.b1.target_database=space\\ and\\\\slash");
    expect(()=>startupUrl("postgresql://postgres:secret@127.0.0.1/db",d)).toThrow(/password/);
    expect(()=>startupUrl("postgresql://postgres@127.0.0.1/db?options=x",d)).toThrow(/options/);
  });
  it("checks nonce, initdb lifetime, exact server and superuser independently",()=>{
    const created="2026-10-09T10:00:00.000Z",seconds=Date.parse(created)/1000;
    const live:LiveIdentity={cluster:"kj-eph-nonce",sid:String(BigInt(seconds)<<32n),started:seconds+2,
      version:"pinned",superuser:true,database:"kj_b1"};
    expect(identityProblems(live,created,"nonce","pinned",[])).toEqual([]);
    for(const changed of [{...live,cluster:"kj-eph-other"},{...live,version:"other"},{...live,superuser:false},
      {...live,started:seconds-1},{...live,sid:String(BigInt(seconds-1)<<32n)},
      {...live,sid:String(BigInt(seconds+3)<<32n)}]) expect(identityProblems(changed,created,"nonce","pinned",[]).length).toBeGreaterThan(0);
    expect(identityProblems(live,created,"nonce","pinned",[live.sid])).toContain("system identifier belongs to hosted artifact");
  });
  it("never qualifies zero applications, skipped steps, engine failures, missing ledger checks or negative fixtures",()=>{
    const blob={id:"a".repeat(40),sha256:"b".repeat(64)},versions=expectedLedgerVersions(manifest);
    const good:RunEvidence={negativeFixture:false,hookIds:[],migrationBlob:blob,baseVersions:versions,
      plannedApplications:[{sequence:1,database:"kj_b1",version:"20261002090000",migrationBlob:blob}],
      events:[...(["L1","L2","L3","L4","L5"] as const).map(step=>({step,outcome:"passed" as const,details:{}})),
        ...(["S1","S2","S3","S4","S5","S6","S7"] as const).map(step=>({step,application:1,outcome:"passed" as const,details:{}})),
        {step:"L6",outcome:"passed",details:{}}],
      applications:[{sequence:1,database:"kj_b1",migrationBlob:blob,engineExitStatus:0,
        ledgerAfter:[...versions,"20261002090000"],postLedgerCompared:true,postLedgerPassed:true}]};
    expect(qualificationStatus(good)).toBe("REPOSITORY_QUALIFIED");
    expect(qualificationStatus({...good,plannedApplications:[],applications:[]})).toBe("NOT_QUALIFIED");
    for(const step of ["L1","L2","L3","L4","L5","L6","S1","S2","S3","S4","S5","S6","S7"])
      expect(qualificationStatus({...good,events:good.events.filter(e=>e.step!==step)}),step).toBe("NOT_QUALIFIED");
    for(const change of [{engineExitStatus:1},{postLedgerCompared:false},{postLedgerPassed:false},{ledgerAfter:versions}])
      expect(qualificationStatus({...good,applications:[{...good.applications[0]!,...change}]})).toBe("NOT_QUALIFIED");
    expect(qualificationStatus({...good,hookIds:["fixture"]})).toBe("NOT_QUALIFIED");
    expect(qualificationStatus({...good,negativeFixture:true,hookIds:["fixture"]})).toBe("NEGATIVE_FIXTURE_RESULT");
  });
});
const actual = sortEntries([...platform, stampRow]);
const diff = (rows: DefinerEntry[], b: PlatformBaseline | null = baseline) => compareDefiners(sortEntries(rows), expectedDefiners(manifest, b, OWNER));

describe("27.10.1 ACTUAL equals EXPECTED(stage), both directions", () => {
  it("passes when ACTUAL is exactly the baseline plus the B1 stage set", () => {
    expect(diff(actual)).toEqual({ missing: [], extra: [], mismatched: [] });
  });
  it("an extra definer fails, wherever it is", () => {
    for (const extra of [row({ schema: "public", name: "x", args: [] }), row({ schema: "auth", name: "late", args: [] }), row({ schema: "kj_app", name: "x", args: [] })])
      expect(diff([...actual, extra]).extra, identityKey(extra)).toEqual([identityKey(extra)]);
  });
  it("a later-stage function present at B1 is extra", () => {
    const freeze = row({ schema: "kernel_private", name: "freeze_reflection", args: ["pg_catalog.uuid"], returns: "pg_catalog.void" });
    expect(diff([...actual, freeze]).extra).toEqual(["kernel_private.freeze_reflection(pg_catalog.uuid)"]);
  });
  it("a missing definer fails, platform or KernelJSON", () => {
    expect(diff(actual.filter((r) => r.name !== "uid")).missing).toEqual(["auth.uid()"]);
    expect(diff(actual.filter((r) => r !== stampRow)).missing).toEqual(["kernel_private.stamp_binding_provenance()"]);
  });
  it("a moved function or changed arguments is missing and extra", () => {
    const moved = actual.map((r) => (r.name === "uid" ? { ...r, schema: "extensions" } : r));
    expect(diff(moved)).toMatchObject({ missing: ["auth.uid()"], extra: ["extensions.uid()"] });
    const reargued = actual.map((r) => (r.name === "search" ? { ...r, args: ["pg_catalog.varchar"] } : r));
    expect(diff(reargued)).toMatchObject({ missing: ["storage.search(pg_catalog.text)"], extra: ["storage.search(pg_catalog.varchar)"] });
  });
  it.each([
    ["returns", "pg_catalog.text"], ["retset", true], ["kind", "p"], ["owner", "someone_else"], ["language", "plpgsql"],
    ["config", ["search_path=public"]], ["sourceDigest", "b".repeat(64)],
  ] as const)("a platform entry with a changed %s fails", (field, value) => {
    const changed = actual.map((r) => (r.name === "uid" ? { ...r, [field]: value } : r));
    expect(diff(changed).mismatched.some((m) => m.startsWith(`auth.uid() ${field}:`))).toBe(true);
  });
  it.each([
    ["owner", "kj_worker"], ["language", "sql"], ["config", null], ["config", ['search_path=""', "work_mem=1MB"]],
    ["acl", null], ["acl", [`${OWNER}=X/${OWNER}`, `kj_worker=X/${OWNER}`]], ["acl", [`${OWNER}=X/${OWNER}`, `=X/${OWNER}`]], ["sourceDigest", "c".repeat(64)],
  ] as const)("the stamp function with %s = %j fails", (field, value) => {
    const changed = actual.map((r) => (r === stampRow ? { ...r, [field]: value } : r));
    expect(diff(changed).mismatched.some((m) => m.startsWith(`kernel_private.stamp_binding_provenance() ${field}:`))).toBe(true);
  });
});

describe("27.10.4 the frozen platform baseline", () => {
  it("a well-formed baseline has no problems", () => {
    expect(baselineProblems(baseline, manifest)).toEqual([]);
  });
  it("tampered entries, a different query, a post-B1 snapshot and a non-canonical order are each refused", () => {
    expect(baselineProblems({ ...baseline, entries: baseline.entries.map((e) => ({ ...e, owner: "x" })) }, manifest)).toContain("platform baseline entries do not match entriesSha256");
    expect(baselineProblems({ ...baseline, provenance: { ...baseline.provenance, querySha256: "0".repeat(64) } }, manifest)).toContain("platform baseline was taken with a different inventory query");
    expect(baselineProblems({ ...baseline, provenance: { ...baseline.provenance, stampSecurityDefiner: true } }, manifest)).toContain("platform baseline was taken after B1");
    const reversed = [...baseline.entries].reverse();
    expect(baselineProblems({ ...baseline, entries: reversed, entriesSha256: sha256(canonicalJson(reversed)) }, manifest)).toContain("platform baseline entries are not in canonical order");
  });
  it("cannot contain public or kernel_private, the stamp name, or a stage-manifest identity", () => {
    const ineligible = [
      row({ schema: "public", name: "helper", args: [] }),
      row({ schema: "kernel_private", name: "x", args: [] }),
      row({ schema: "auth", name: "stamp_binding_provenance", args: [] }),
      row({ schema: "kernel_private", name: "close_growth_window_by_owner", args: ["pg_catalog.uuid", "pg_catalog.uuid"] }),
    ];
    const problems = baselineEligibilityProblems(ineligible, manifest);
    expect(problems).toEqual([
      "public.helper() is in KernelJSON schema public",
      "kernel_private.x() is in KernelJSON schema kernel_private",
      "auth.stamp_binding_provenance() is named stamp_binding_provenance",
      "kernel_private.close_growth_window_by_owner(pg_catalog.uuid, pg_catalog.uuid) is in KernelJSON schema kernel_private",
      "kernel_private.close_growth_window_by_owner(pg_catalog.uuid, pg_catalog.uuid) is a KernelJSON stage-manifest function",
    ]);
    // ...and a baseline that slipped one in is refused as a whole.
    expect(baselineProblems(baselineOf([...platform, ineligible[2]!]), manifest)).toContain("auth.stamp_binding_provenance() is named stamp_binding_provenance");
  });
  it("without a baseline nothing is learned: the platform half is unknown and stays red (see definerInventoryProblems)", () => {
    expect(diff(actual, null).extra).toEqual(["auth.uid()", "storage.search(pg_catalog.text)"]);
  });
});

describe("RFC 8785 canonical JSON", () => {
  it("sorts keys at every depth and is stable", () => {
    expect(canonicalJson({ b: [true, null, { z: "1", a: "2" }], a: "x" })).toBe('{"a":"x","b":[true,null,{"a":"2","z":"1"}]}');
    expect(canonicalJson({ n: 1 })).toBe('{"n":1}');
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow(/unsupported/);
  });
});

describe("27.11 runtime capability facts (static)", () => {
  it("the table privilege vocabulary is exactly the seven PostgreSQL defines", () => {
    expect([...TABLE_PRIVILEGES]).toEqual(["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]);
  });
  it("manifest function facts are exact identities and the migration grants exactly those, never by name", () => {
    const runtime = loadManifest();
    const identity = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\((?:[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*(?:, [a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)*)?\)$/;
    const keys = Object.values(runtime.roles).flatMap((r) => Object.keys(r.functions));
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k, k).toMatch(identity);
    const b1 = lf(readFileSync(`${MIGRATIONS}/${B1}`, "utf8"));
    for (const k of Object.keys(runtime.roles.kj_worker.functions)) expect(b1).toContain(`grant execute on function ${k} to kj_worker;`);
    expect(b1).not.toContain("grant execute on function %s"); // no grant loop over every overload of a name
  });
});

describe("27.11.6 snapshot hardening (static)", () => {
  const ok = "postgresql://owner@db.example.internal:5432/postgres";
  it("accepts exactly one explicit postgres URL, with or without one trailing newline", () => {
    expect(parseConnectionFile(ok)).toEqual({ connectionString: ok });
    expect(parseConnectionFile(`${ok}\n`)).toEqual({ connectionString: ok });
    expect(parseConnectionFile(`\uFEFF${ok}\r\n`)).toEqual({ connectionString: ok });
  });
  it.each([
    ["an empty file", "", "empty or whitespace only"],
    ["a whitespace-only file", "   \n", "empty or whitespace only"],
    ["a NUL byte", `${ok}\0`, "NUL byte"],
    ["two lines", `${ok}\n${ok}`, "more than one line"],
    ["a trailing blank line", `${ok}\n\n`, "more than one line"],
    ["surrounding spaces", ` ${ok} `, "leading or trailing whitespace"],
    ["not a URL", "host=db user=owner", "does not hold a URL"],
    ["another scheme", "mysql://owner@db/x", "not a postgres URL"],
    ["no host (socket or PGHOST fallback)", "postgresql:///postgres", "must name the host, the user and the database"],
    ["no user (PGUSER fallback)", "postgresql://db.example.internal/postgres", "must name the host, the user and the database"],
    ["no database (PGDATABASE fallback)", "postgresql://owner@db.example.internal", "must name the host, the user and the database"],
  ])("refuses %s, without echoing the content", (_label, raw, message) => {
    let error: Error | undefined;
    try { parseConnectionFile(raw); } catch (e) { error = e as Error; }
    expect(error?.message).toMatch(/^CONNECTION_FILE_REFUSED: /);
    expect(error?.message).toContain(message);
    expect(error?.message).not.toContain("owner@");
  });
  it("scrubs every PG* variable so no default can fill a gap", () => {
    const env: NodeJS.ProcessEnv = { PGHOST: "x", PGPASSWORD: "y", PGSSLMODE: "z", PATH: "p", KJ: "k" };
    expect(scrubPgEnvironment(env)).toEqual(["PGHOST", "PGPASSWORD", "PGSSLMODE"]);
    expect(env).toEqual({ PATH: "p", KJ: "k" });
  });
  it("the expected ledger head is the final base migration before B1", () => {
    const last = manifest.baseMigrations.at(-1)!.file;
    expect(expectedLedgerHead(manifest)).toBe(last.slice(0, 14));
    expect(last < B1).toBe(true);
  });
});

describe("snapshot ledger gate: the exact base migration version set, not only the head", () => {
  const expected = expectedLedgerVersions(manifest);
  it("is the 22 base migrations of the stage manifest, ending at the expected head", () => {
    expect(expected).toHaveLength(manifest.baseMigrations.length);
    expect(expected).toHaveLength(22);
    expect(expected.at(-1)).toBe(expectedLedgerHead(manifest));
  });
  it("accepts exactly that set, in any order", () => {
    expect(ledgerSetProblems([...expected].reverse(), expected)).toBeNull();
  });
  it("refuses a gapped ledger whose head is still correct (manually applied, unrecorded migrations)", () => {
    const gapped = expected.filter((_, i) => i < 10 || i > 13);
    expect(gapped.at(-1)).toBe(expected.at(-1));
    expect(ledgerSetProblems(gapped, expected)).toBe(
      `the migration ledger does not record exactly the 22 base migrations before B1; missing ${expected.slice(10, 14).join(", ")}`);
  });
  it("refuses an extra row, a duplicated row and an empty ledger", () => {
    expect(ledgerSetProblems([...expected, "20261101000000"], expected)).toContain("; unexpected 20261101000000");
    expect(ledgerSetProblems([...expected, expected[0]!], expected)).toContain("; duplicated versions");
    expect(ledgerSetProblems([], expected)).toContain(`; missing ${expected.join(", ")}`);
  });
});
