import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { z } from "zod";
import { strictJson } from "./strict-json.js";
import { Provenance, RunBinding, HASH, parseDeclaration, readCoResident, setDigest, hash, CO_RESIDENT_SQL,
  DECLARATION_PATH, type Declaration } from "./co-resident.js";

/**
 * KJ-P8 B1 - the stage-aware SECURITY DEFINER inventory (ADR-0023 sections 27.10 and 27.12, revision 2.7.9).
 * It is global over every governed schema and is never narrowed
 * by the schema-USAGE gate of section 27.11.
 *
 *   EXPECTED(stage) = PLATFORM_BASELINE UNION CO_RESIDENT_PLATFORM_EXCEPTIONS UNION KERNELJSON_STAGE_MANIFEST(stage)
 *   ACTUAL          = every pg_proc row with prosecdef = true whose schema is governed
 *
 * ACTUAL must equal EXPECTED(stage) in both directions. Identity is schema, name and ordered input argument types;
 * return type, owner, language, configuration, ACL and source digest are compared separately. A schema is governed
 * unless the exact predicate of 27.10.2 excludes it, so no schema name or owner exempts a function. Nothing here is
 * learned from the database: the platform baseline is a frozen, reviewed artefact and the stage manifest is generated
 * from reviewed inputs.
 */
type Db = Pick<pg.Pool | pg.PoolClient | pg.Client, "query">;

export const SEALED_DESIGN = "af2f7320aae32eaa0ce699b1c09d015371f156d5";
export const STAGES = ["B1", "P8A-0", "B2", "P8A-1", "P8A-2", "P8B"] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_MANIFEST_PATH = "infrastructure/database/security-definer-stage-manifest.json";
export const PLATFORM_BASELINE_PATH = "infrastructure/database/security-definer-platform-baseline.json";
/** Stands for the deployment owner in the stage manifest: the owner of schema kernel_private, read from the catalogue. */
export const DEPLOYMENT_OWNER = "<deployment owner>";
export const STAMP = { schema: "kernel_private", name: "stamp_binding_provenance", args: [] as string[] };

// ---------------------------------------------------------------------------------------------------------------
// Section 27.10.2: the only excluded schemas. Every other schema is governed, whatever its name or owner.
export const excludedSchemaSql = (column: string): string =>
  `(${column} in ('pg_catalog', 'information_schema', 'pg_toast') or ${column} ~ '^pg_temp_[0-9]+$' or ${column} ~ '^pg_toast_temp_[0-9]+$')`;
export const isExcludedSchema = (name: string): boolean =>
  name === "pg_catalog" || name === "information_schema" || name === "pg_toast" || /^pg_temp_[0-9]+$/.test(name) || /^pg_toast_temp_[0-9]+$/.test(name);

// ---------------------------------------------------------------------------------------------------------------
// One catalogue row
export interface FunctionIdentity { schema: string; name: string; args: string[] }
export interface DefinerEntry extends FunctionIdentity {
  returns: string;
  retset: boolean;
  kind: string;
  owner: string;
  securityDefiner: boolean;
  language: string;
  config: string[] | null;
  acl: string[] | null;
  sourceDigest: string;
}
export const identityKey = (f: FunctionIdentity): string => `${f.schema}.${f.name}(${f.args.join(", ")})`;
const compareIdentity = (a: FunctionIdentity, b: FunctionIdentity): number => {
  const x = [a.schema, a.name, a.args.join(",")], y = [b.schema, b.name, b.args.join(",")];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
};
export const sortEntries = <T extends FunctionIdentity>(entries: readonly T[]): T[] => [...entries].sort(compareIdentity);

/**
 * Columns of every inventoried function. Types are written <type schema>.<type name>, independent of search_path.
 * The source digest is the sealed 27.10.4 rule, computed in the database so a snapshot and a later comparison read
 * the same bytes: UTF-8, every CRLF replaced by LF, SHA-256, lowercase hexadecimal, over
 *   lanname || LF || coalesce(probin, '') || LF || prosrc   for language internal or c;
 *   pg_get_function_sqlbody(oid)                             for a SQL-standard body;
 *   prosrc                                                   otherwise (the 27.9.3 rule).
 */
const COLUMNS = `n.nspname as schema, p.proname as name,
  array(select tn.nspname || '.' || t.typname from unnest(p.proargtypes::oid[]) with ordinality as a(oid, i)
          join pg_type t on t.oid = a.oid join pg_namespace tn on tn.oid = t.typnamespace order by a.i)::text[] as args,
  rn.nspname || '.' || rt.typname as returns, p.proretset as retset, p.prokind::text as kind,
  pg_get_userbyid(p.proowner) as owner, p.prosecdef as "securityDefiner", l.lanname as language,
  p.proconfig as config, p.proacl::text[] as acl,
  encode(sha256(convert_to(replace(case
      when l.lanname in ('internal', 'c') then l.lanname || E'\\n' || coalesce(p.probin, '') || E'\\n' || p.prosrc
      when p.prosqlbody is not null then pg_get_function_sqlbody(p.oid)
      else p.prosrc end, E'\\r\\n', E'\\n'), 'UTF8')), 'hex') as "sourceDigest"
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
  join pg_type rt on rt.oid = p.prorettype join pg_namespace rn on rn.oid = rt.typnamespace`;
/** The inventory query of 27.10.1 (ACTUAL). Its SHA-256 is recorded in every platform baseline. */
export const INVENTORY_SQL = `select ${COLUMNS}\n where p.prosecdef and not ${excludedSchemaSql("n.nspname")}`;
export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export const INVENTORY_SQL_SHA256 = sha256(INVENTORY_SQL);

export async function readDefiners(db: Db): Promise<DefinerEntry[]> {
  return sortEntries((await db.query<DefinerEntry>(INVENTORY_SQL)).rows);
}

// ---------------------------------------------------------------------------------------------------------------
// RFC 8785 canonical JSON: ECMAScript scalar serialization and object keys sorted by UTF-16 code units.
// Finite numbers support the run binding's application sequence; non-finite values are refused.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported value of type ${typeof value}`);
}

// ---------------------------------------------------------------------------------------------------------------
// The KernelJSON stage manifest (kerneljson:security-definer-stage-manifest/v1), generated by
// scripts/b1/build-manifest.mjs.
export interface StageFunction extends FunctionIdentity {
  returns: string;
  retset: boolean;
  kind: string;
  owner: string;
  securityDefiner: true;
  /** null until the stage is implemented; a stage with any null pin cannot be declared. */
  language: string | null;
  config: string[];
  acl: string[];
  sourceDigest: string | null;
  contract: string;
}
export interface StageEntry {
  stage: Stage;
  implemented: boolean;
  migrations: { file: string; sha256: string }[];
  adds: StageFunction[];
}
export interface StageManifest {
  contract: "kerneljson:security-definer-stage-manifest/v1";
  design: { adr: string; revision: string; sha: string };
  repository: string;
  releaseIdentity: string;
  declaredStage: Stage;
  baseMigrations: { file: string; sha256: string }[];
  stages: StageEntry[];
  stampTrigger: { name: string; relation: string; tgtype: number; tgenabled: string; tgqual: null; tgisinternal: false; tgnargs: number; tgattr: string };
}
const repoFile = (relative: string): string => fileURLToPath(new URL(`../../../../${relative}`, import.meta.url));
export function loadStageManifest(path?: string): StageManifest {
  const manifest = JSON.parse(readFileSync(path ?? repoFile(STAGE_MANIFEST_PATH), "utf8")) as StageManifest;
  if (manifest.contract !== "kerneljson:security-definer-stage-manifest/v1") throw new Error("Unknown SECURITY DEFINER stage manifest contract");
  return manifest;
}

/** The KernelJSON functions of every stage up to and including `stage`, in rollout order. */
export function stageFunctions(manifest: StageManifest, stage: Stage = manifest.declaredStage): StageFunction[] {
  const last = STAGES.indexOf(stage);
  if (last < 0) throw new Error(`Unknown stage ${String(stage)}`);
  return manifest.stages.filter((s) => STAGES.indexOf(s.stage) <= last).flatMap((s) => s.adds);
}

/**
 * Static stage binding (27.10.5): the declared stage is not a free label. It must be a known stage; every stage up to
 * it must be implemented, with every listed migration present at its pinned SHA-256 and every function pin filled in;
 * every stage after it must be unimplemented; and the release may carry no migration that neither the base set nor an
 * implemented stage lists. `migrations` maps a migration file name to the SHA-256 of its LF-normalised text.
 */
export function stageBindingProblems(manifest: StageManifest, migrations: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  const declared = STAGES.indexOf(manifest.declaredStage);
  if (declared < 0) return [`declared stage ${String(manifest.declaredStage)} is not one of ${STAGES.join(", ")}`];
  if (manifest.design?.sha !== SEALED_DESIGN) problems.push(`stage manifest is bound to design ${String(manifest.design?.sha)}, not ${SEALED_DESIGN}`);
  const order = manifest.stages.map((s) => s.stage);
  if (order.join(",") !== STAGES.join(",")) problems.push(`stage manifest lists stages ${order.join(", ")}, not ${STAGES.join(", ")}`);
  const listed = new Set<string>();
  const pinned = (file: string, sha: string, owner: string) => {
    listed.add(file);
    const actual = migrations.get(file);
    if (actual === undefined) problems.push(`${owner} migration ${file} is not in the release`);
    else if (actual !== sha) problems.push(`${owner} migration ${file} has SHA-256 ${actual}, pinned ${sha}`);
  };
  for (const m of manifest.baseMigrations) pinned(m.file, m.sha256, "base");
  for (const s of manifest.stages) {
    const i = STAGES.indexOf(s.stage);
    if (i <= declared) {
      if (!s.implemented) problems.push(`stage ${s.stage} is declared (via ${manifest.declaredStage}) but not implemented`);
      for (const m of s.migrations) pinned(m.file, m.sha256, `stage ${s.stage}`);
      for (const f of s.adds)
        for (const k of ["language", "sourceDigest"] as const)
          if (f[k] === null) problems.push(`stage ${s.stage} declares ${identityKey(f)} with no ${k} pin`);
    } else {
      if (s.implemented) problems.push(`stage ${s.stage} is implemented but the release declares only ${manifest.declaredStage}`);
      for (const m of s.migrations) if (migrations.has(m.file)) problems.push(`stage ${s.stage} migration ${m.file} is in a release that declares ${manifest.declaredStage}`);
    }
  }
  for (const file of migrations.keys()) if (!listed.has(file)) problems.push(`migration ${file} belongs to no implemented stage of ${manifest.declaredStage}`);
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// The frozen platform baseline (kerneljson:security-definer-platform-baseline/v1, section 27.10.4)
export type BaselineEntry = Omit<DefinerEntry, "acl">;
export interface PlatformBaseline {
  mode: "HOSTED_COMMITTED" | "EPHEMERAL_RUN_BOUND";
  run?: z.infer<typeof RunBinding>;
  contract: "kerneljson:security-definer-platform-baseline/v1";
  design: string;
  environment: string;
  provenance: {
    systemIdentifier: string;
    database: string;
    serverVersion: string;
    snapshotAt: string;
    snapshotUser: string;
    transaction: { readOnly: boolean; searchPath: string };
    migrationLedger: { table: string; present: boolean; head: string | null; b1Recorded: boolean; versions: string[] };
    stampSecurityDefiner: boolean;
    querySha256: string;
  };
  entries: BaselineEntry[];
  entriesSha256: string;
}
export const B1_MIGRATION_VERSION = "20261002090000";
/** A baseline entry is a catalogue row without its ACL: 27.10.4 pins no ACL for platform functions. */
export const baselineEntry = (e: DefinerEntry): BaselineEntry => {
  const { acl, ...rest } = e;
  void acl;
  return rest;
};

/** 27.10.4 eligibility: entries that may never be baselined. */
export function baselineEligibilityProblems(entries: readonly FunctionIdentity[], manifest: StageManifest): string[] {
  const kernel = new Set(manifest.stages.flatMap((s) => s.adds).map(identityKey));
  const problems: string[] = [];
  for (const e of entries) {
    if (e.schema === "public" || e.schema === "kernel_private") problems.push(`${identityKey(e)} is in KernelJSON schema ${e.schema}`);
    if (e.name === STAMP.name) problems.push(`${identityKey(e)} is named ${STAMP.name}`);
    if (e.name === "rls_auto_enable") problems.push(`${identityKey(e)} carries a sealed co-resident name`);
    if (kernel.has(identityKey(e))) problems.push(`${identityKey(e)} is a KernelJSON stage-manifest function`);
  }
  return problems;
}

/** Structural validation of a baseline before it is trusted: its digests recompute and every entry is eligible. */
export function baselineProblems(baseline: PlatformBaseline, manifest: StageManifest): string[] {
  const problems: string[] = [];
  const parsed = BaselineSchema.safeParse(baseline);
  if (!parsed.success) {
    if (baseline.provenance?.migrationLedger?.b1Recorded || baseline.provenance?.stampSecurityDefiner) problems.push("platform baseline was taken after B1");
    return [...problems, "platform baseline schema invalid: " + parsed.error.message];
  }
  if (baseline.design !== SEALED_DESIGN) problems.push("platform baseline design differs from sealed design");
  if (baseline.contract !== "kerneljson:security-definer-platform-baseline/v1") problems.push("unknown platform baseline contract");
  if (baseline.provenance?.querySha256 !== INVENTORY_SQL_SHA256) problems.push("platform baseline was taken with a different inventory query");
  if (baseline.provenance?.migrationLedger?.b1Recorded || baseline.provenance?.stampSecurityDefiner) problems.push("platform baseline was taken after B1");
  if (sha256(canonicalJson(baseline.entries)) !== baseline.entriesSha256) problems.push("platform baseline entries do not match entriesSha256");
  const sorted = sortEntries(baseline.entries);
  if (new Set(baseline.entries.map(identityKey)).size !== baseline.entries.length) problems.push("platform baseline has duplicate identities");
  const expectedVersions = manifest.baseMigrations.map(m => m.file.slice(0, 14)).sort();
  if (JSON.stringify(baseline.provenance.migrationLedger.versions) !== JSON.stringify(expectedVersions) ||
      baseline.provenance.migrationLedger.head !== expectedVersions.at(-1)) problems.push("platform baseline ledger differs from the exact base set");
  if (sorted.some((e, i) => e !== baseline.entries[i])) problems.push("platform baseline entries are not in canonical order");
  problems.push(...baselineEligibilityProblems(baseline.entries, manifest));
  return problems;
}
export function loadPlatformBaseline(path?: string): PlatformBaseline | null {
  const file = path ?? repoFile(PLATFORM_BASELINE_PATH);
  return existsSync(file) ? BaselineSchema.parse(strictJson(readFileSync(file, "utf8"))) : null;
}

const baselineFields = {
  contract: z.literal("kerneljson:security-definer-platform-baseline/v1"), design: z.literal(SEALED_DESIGN),
  environment: z.string().min(1), provenance: Provenance, entriesSha256: HASH,
  entries: z.array(z.strictObject({schema:z.string(),name:z.string(),args:z.array(z.string()),returns:z.string(),
    retset:z.boolean(),kind:z.string(),owner:z.string(),securityDefiner:z.literal(true),language:z.string(),
    config:z.array(z.string()).nullable(),sourceDigest:HASH})),
};
export const BaselineSchema = z.discriminatedUnion("mode", [
  z.strictObject({...baselineFields, mode:z.literal("HOSTED_COMMITTED")}),
  z.strictObject({...baselineFields, mode:z.literal("EPHEMERAL_RUN_BOUND"),run:RunBinding}),
]);
export function loadDeclaration(path?:string):Declaration|null {
  const file=path ?? repoFile(DECLARATION_PATH);
  return existsSync(file) ? parseDeclaration(readFileSync(file,"utf8")) : null;
}
export function artifactPairProblems(baseline:PlatformBaseline, declaration:Declaration):string[] {
  const problems:string[]=[];
  const {querySha256: baselineQuery,...bp}=baseline.provenance;
  const {querySha256: declarationQuery,...dp}=declaration.provenance;
  if (baselineQuery !== INVENTORY_SQL_SHA256 || declarationQuery !== hash(CO_RESIDENT_SQL)) problems.push("artifact inventory query differs");
  if (canonicalJson(bp)!==canonicalJson(dp)) problems.push("baseline and declaration provenance differ");
  if (baseline.environment!==declaration.environment) problems.push("baseline and declaration environment differ");
  if (baseline.mode!==declaration.mode || canonicalJson(baseline.run ?? null)!==canonicalJson("run" in declaration ? declaration.run : null))
    problems.push("baseline and declaration mode/run differ");
  return problems;
}
/** Deployed health is hosted-only. An explicit expected run binds disposable health to its runner application. */
export function healthArtifactModeProblems(baseline:PlatformBaseline|null,declaration:Declaration|null,run?:z.infer<typeof RunBinding>):string[]{
  if(run===undefined) return baseline?.mode==="HOSTED_COMMITTED" && declaration?.mode==="HOSTED_COMMITTED" &&
    !baseline.run && !("run" in declaration) ? []:["deployed health requires HOSTED_COMMITTED artifacts without run bindings"];
  if(!RunBinding.safeParse(run).success || baseline?.mode!=="EPHEMERAL_RUN_BOUND" || declaration?.mode!=="EPHEMERAL_RUN_BOUND" ||
    canonicalJson(baseline.run ?? null)!==canonicalJson(run) || canonicalJson(declaration.run)!==canonicalJson(run))
    return ["ephemeral health requires both artifacts bound to the expected application"];
  return [];
}

// ---------------------------------------------------------------------------------------------------------------
// Equality (27.10.1)
const FIELDS = ["returns", "retset", "kind", "owner", "securityDefiner", "language", "config", "acl", "sourceDigest"] as const;
type Field = (typeof FIELDS)[number];
export interface ExpectedDefiner extends FunctionIdentity { source: "platform" | "co-resident" | "kernel"; pins: Partial<Record<Field, unknown>> }

export function expectedDefiners(manifest: StageManifest, baseline: PlatformBaseline | null, owner: string, stage: Stage = manifest.declaredStage, declaration:Declaration|null = null): ExpectedDefiner[] {
  const resolve = (v: string): string => v.replaceAll(DEPLOYMENT_OWNER, owner);
  const kernel = stageFunctions(manifest, stage).map((f): ExpectedDefiner => ({
    schema: f.schema, name: f.name, args: f.args, source: "kernel",
    pins: {
      returns: f.returns, retset: f.retset, kind: f.kind, owner: resolve(f.owner), securityDefiner: true,
      language: f.language, config: f.config, acl: [...f.acl.map(resolve)].sort(), sourceDigest: f.sourceDigest,
    },
  }));
  const platform = (baseline?.entries ?? []).map((e): ExpectedDefiner => ({
    schema: e.schema, name: e.name, args: e.args, source: "platform",
    pins: { returns: e.returns, retset: e.retset, kind: e.kind, owner: e.owner, securityDefiner: true, language: e.language, config: e.config, sourceDigest: e.sourceDigest },
  }));
  const coResident=(declaration?.entries ?? []).map((e):ExpectedDefiner=>({schema:e.schema,name:e.name,args:e.args,source:"co-resident",
    pins:Object.fromEntries(FIELDS.map(k=>[k,e[k]]))}));
  return sortEntries([...platform, ...coResident, ...kernel]);
}

export interface InventoryDiff { missing: string[]; extra: string[]; mismatched: string[] }
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** Bidirectional equality of ACTUAL and EXPECTED: extra, missing, and every pinned attribute of each expected function. */
export function compareDefiners(actual: readonly DefinerEntry[], expected: readonly ExpectedDefiner[]): InventoryDiff {
  const byKey = new Map(actual.map((a) => [identityKey(a), a]));
  const want = new Set(expected.map(identityKey));
  const diff: InventoryDiff = { missing: [], extra: [], mismatched: [] };
  for (const e of expected) {
    const a = byKey.get(identityKey(e));
    if (!a) { diff.missing.push(identityKey(e)); continue; }
    for (const field of FIELDS) {
      if (!(field in e.pins)) continue;
      const observed = field === "acl" ? (a.acl ? [...a.acl].sort() : null) : a[field];
      if (!same(observed, e.pins[field])) diff.mismatched.push(`${identityKey(e)} ${field}: ${JSON.stringify(observed)}, expected ${JSON.stringify(e.pins[field])}`);
    }
  }
  for (const a of actual) if (!want.has(identityKey(a))) diff.extra.push(identityKey(a));
  return diff;
}

// ---------------------------------------------------------------------------------------------------------------
// The section 27.9 exception: global name uniqueness (27.10.6) and trigger topology (27.9.4)
export async function deploymentOwner(db: Db): Promise<string> {
  const row = (await db.query<{ owner: string }>(`select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = 'kernel_private'`)).rows[0];
  if (!row) throw new Error("schema kernel_private is missing");
  return row.owner;
}
export interface StampTrigger { name: string; relation: string; tgtype: number; tgenabled: string; tgqual: string | null; tgisinternal: boolean; tgnargs: number; tgattr: string }
export async function readStampFacts(db: Db): Promise<{ sameName: DefinerEntry[]; triggers: StampTrigger[] }> {
  const sameName = sortEntries((await db.query<DefinerEntry>(
    `select ${COLUMNS}\n where p.proname = '${STAMP.name}' and not ${excludedSchemaSql("n.nspname")}`)).rows);
  const triggers = (await db.query<StampTrigger>(
    `select t.tgname as name, cn.nspname || '.' || c.relname as relation, t.tgtype::int as tgtype, t.tgenabled::text as tgenabled,
            case when t.tgqual is null then null else pg_get_triggerdef(t.oid) end as tgqual, t.tgisinternal, t.tgnargs::int as tgnargs,
            t.tgattr::text as tgattr
       from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace cn on cn.oid = c.relnamespace
      where t.tgfoid in (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = '${STAMP.schema}' and p.proname = '${STAMP.name}' and p.pronargs = 0)
      order by 1, 2`)).rows;
  return { sameName, triggers };
}
export function stampProblems(facts: { sameName: readonly DefinerEntry[]; triggers: readonly StampTrigger[] }, manifest: StageManifest): string[] {
  const problems: string[] = [];
  const names = facts.sameName.map(identityKey);
  if (names.length !== 1 || names[0] !== identityKey(STAMP) || facts.sameName[0]!.returns !== "pg_catalog.trigger")
    problems.push(`exactly one function named ${STAMP.name} must exist, kernel_private.${STAMP.name}() returning pg_catalog.trigger; found ${names.length ? names.join(", ") : "none"}`);
  const want = manifest.stampTrigger;
  if (facts.triggers.length !== 1) problems.push(`${identityKey(STAMP)} must be attached to exactly one trigger; found ${facts.triggers.length}`);
  for (const t of facts.triggers) {
    const observed = { name: t.name, relation: t.relation, tgtype: t.tgtype, tgenabled: t.tgenabled, tgqual: t.tgqual, tgisinternal: t.tgisinternal, tgnargs: t.tgnargs, tgattr: t.tgattr };
    if (!same(observed, want)) problems.push(`trigger topology of ${identityKey(STAMP)}: ${JSON.stringify(observed)}, expected ${JSON.stringify(want)}`);
  }
  return problems;
}

/**
 * ADR-0023 revision 2.6 section 27.11.6 item 4: the committed baseline belongs to THIS database. Its systemIdentifier
 * must equal the live one, and its database name the live current_database(). Either mismatch is a P0 problem; an
 * unreadable live identifier is a problem too, never a pass.
 */
export async function baselineBindingProblems(db: Db, baseline: PlatformBaseline): Promise<string[]> {
  let live: { sid: string; db: string };
  try {
    live = (await db.query<{ sid: string; db: string }>(
      `select (select system_identifier::text from pg_catalog.pg_control_system()) as sid, pg_catalog.current_database() as db`)).rows[0]!;
  } catch (error) {
    return [`platform baseline binding unverifiable: the live system identifier cannot be read (SQLSTATE ${(error as { code?: string }).code ?? "unknown"})`];
  }
  const problems: string[] = [];
  if (live.sid !== baseline.provenance.systemIdentifier)
    problems.push(`platform baseline belongs to system ${baseline.provenance.systemIdentifier}, not this database's ${live.sid}`);
  if (live.db !== baseline.provenance.database)
    problems.push(`platform baseline belongs to database ${baseline.provenance.database}, not ${live.db}`);
  return problems;
}

/** Everything 27.10 and 27.9.4 assert, as problem strings; empty means the inventory is exactly as sealed. */
export async function definerInventoryProblems(db: Db, manifest: StageManifest, baseline: PlatformBaseline | null, declaration:Declaration|null = null): Promise<string[]> {
  const problems: string[] = [];
  if (!baseline) problems.push("TARGET_PLATFORM_BASELINE_PENDING: no frozen platform SECURITY DEFINER baseline for this environment");
  else {
    problems.push(...baselineProblems(baseline, manifest).map((p) => `platform baseline invalid: ${p}`));
    problems.push(...(await baselineBindingProblems(db, baseline)));
  }
  if (!declaration) problems.push("TARGET_CO_RESIDENT_DECLARATION_PENDING: no frozen co-resident declaration");
  else {
    try {
      parseDeclaration(JSON.stringify(declaration));
      if (baseline) problems.push(...artifactPairProblems(baseline,declaration));
      const live=await readCoResident(db);
      if(setDigest(live)!==declaration.setSha256) problems.push("live co-resident set differs from declaration");
      problems.push(...await baselineBindingProblems(db,{provenance:declaration.provenance} as PlatformBaseline));
    } catch(error) { problems.push(`co-resident validation failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const actual = await readDefiners(db);
  const diff = compareDefiners(actual, expectedDefiners(manifest, baseline, await deploymentOwner(db), manifest.declaredStage, declaration));
  // Without a baseline the platform half is unknown: only KernelJSON schemas are judged for extras.
  for (const f of baseline ? diff.extra : diff.extra.filter((k) => k.startsWith("public.") || k.startsWith("kernel_private.")))
    problems.push(`unlisted SECURITY DEFINER function ${f}`);
  for (const f of diff.missing) problems.push(`missing SECURITY DEFINER function ${f}`);
  for (const f of diff.mismatched) problems.push(`SECURITY DEFINER mismatch ${f}`);
  problems.push(...stampProblems(await readStampFacts(db), manifest));
  return problems;
}
