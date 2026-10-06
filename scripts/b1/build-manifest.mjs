#!/usr/bin/env node
// KJ-P8 B1 - build the frozen runtime-role manifest and the migration that realises it.
//
//   manifest  = (static inventory - reviewed denials) + reviewed additions
//   migration = pure function of the manifest
//
// The reviewed denials and additions live in infrastructure/database/runtime-role-decisions.json, each with a
// reason. Nothing reaches the manifest without either static evidence or a written decision. Running this script
// with --check fails if the committed manifest or migration differs from what the inputs produce.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import inventory from "./static-inventory.mjs";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
const DECISIONS = "infrastructure/database/runtime-role-decisions.json";
const MANIFEST = "infrastructure/database/runtime-role-manifest.json";
const MIGRATION = "supabase/migrations/20261002090000_runtime_least_privilege_roles.sql";
const STAGE_MANIFEST = "infrastructure/database/security-definer-stage-manifest.json";
const STAMP_SOURCE_MIGRATION = "supabase/migrations/20260916205049_release_provenance.sql";
const SEALED_DESIGN = "424f85c283a543ba00a650ecc2ecc3a4346623df";
const STAMP = "kernel_private.stamp_binding_provenance";
const OWNER = "<deployment owner>";
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const decisions = readJson(DECISIONS);
const lf = (t) => t.replaceAll("\r\n", "\n");
const sha256 = (t) => createHash("sha256").update(t, "utf8").digest("hex");

// ADR-0023 section 27.9.3, derivation B: the text between the dollar quotes of the function in the applied migration,
// CRLF replaced by LF, UTF-8, SHA-256. It must equal the reviewed pin in the decisions file, or nothing is generated.
const stampDecision = (decisions.securityDefinerTriggers ?? []).find((d) => d.function === STAMP);
if (!stampDecision || (decisions.securityDefinerTriggers ?? []).length !== 1) {
  console.error(`B1: the decisions file must name exactly one SECURITY DEFINER function, ${STAMP} (ADR-0023 section 27.9)`);
  process.exit(1);
}
const stampBody = /create function kernel_private\.stamp_binding_provenance\(\) returns trigger\s*\nlanguage plpgsql security invoker set search_path = '' as \$\$([\s\S]*?)\$\$;/
  .exec(lf(readFileSync(join(ROOT, STAMP_SOURCE_MIGRATION), "utf8")));
const derivationB = stampBody ? sha256(stampBody[1]) : null;
if (derivationB !== stampDecision.sourceDigest) {
  console.error(`B1: source digest derivation B (${derivationB}) differs from the reviewed pin (${stampDecision.sourceDigest})`);
  process.exit(1);
}

// First declared column of every table, for lock-only grants (row locks need UPDATE on at least one column).
const sql = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql") && !MIGRATION.endsWith(f)).sort()
  .map((f) => readFileSync(join(ROOT, "supabase/migrations", f), "utf8").replace(/--[^\n]*/g, "")).join("\n");
const firstColumn = {};
for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?((?:public|kernel_private)\.)?([a-z_][a-z0-9_]*)\s*\(\s*"?([a-z_][a-z0-9_]*)"?/gi))
  firstColumn[`${(m[1] ?? "public.").slice(0, -1)}.${m[2]}`.toLowerCase()] = m[3].toLowerCase();

const ROLES = ["kj_worker", "kj_door"];
const ATTRIBUTES = { login: true, superuser: false, createdb: false, createrole: false, replication: false, bypassrls: false, inherit: false };

function roleManifest(role) {
  const denied = (o) => decisions.deny.find((d) => d.role === role && d.object === o.object && (d.verb === o.verb || d.verb === "*"));
  const tables = {}, functions = {};
  const ensure = (object, kind) => (tables[object] ??= { kind, verbs: {}, evidence: {} });
  const add = (o, evidence) => {
    if (o.kind === "function") { (functions[o.object] ??= []).push(...evidence); return; }
    const t = ensure(o.object, o.kind);
    const verb = o.verb;
    if (verb === "UPDATE") {
      const prev = t.verbs.UPDATE;
      const cols = o.columns?.length ? o.columns : null;
      if (prev === true || !cols) t.verbs.UPDATE = true; else t.verbs.UPDATE = [...new Set([...(Array.isArray(prev) ? prev : []), ...cols])].sort();
    } else t.verbs[verb] = true;
    (t.evidence[verb] ??= []).push(...evidence);
  };
  for (const o of inventory.roles[role].operations) if (!denied(o)) add(o, o.sources);
  for (const a of decisions.allow.filter((a) => a.role === role)) add({ ...a, kind: a.kind ?? "table" }, [`decision: ${a.reason}`]);
  for (const t of Object.values(tables)) {
    // A row lock needs UPDATE on one column. If the role may not otherwise UPDATE the table, grant a lock-only UPDATE.
    if (t.verbs.ROWLOCK && !t.verbs.UPDATE) t.verbs.UPDATE = { lockOnly: true };
    delete t.verbs.ROWLOCK;
    for (const k of Object.keys(t.evidence)) t.evidence[k] = [...new Set(t.evidence[k])].sort();
  }
  for (const [object, t] of Object.entries(tables))
    if (t.verbs.UPDATE?.lockOnly) t.verbs.UPDATE = { lockOnly: true, column: firstColumn[object] };
  const sort = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  return {
    attributes: { ...ATTRIBUTES, connectionLimit: decisions.connectionLimit[role] },
    memberOf: [],
    owns: [],
    schemas: { kernel_private: ["USAGE"], public: ["USAGE"] },
    database: ["CONNECT"],
    relations: sort(Object.fromEntries(Object.entries(tables).map(([k, t]) => [k, { kind: t.kind, verbs: sort(t.verbs), evidence: sort(t.evidence) }]))),
    functions: sort(Object.fromEntries(Object.entries(functions).map(([k, e]) => [k, [...new Set(e)].sort()]))),
    sequences: {},
  };
}

const manifest = {
  contract: "kerneljson:runtime-role-manifest/v1",
  design: `ADR-0023 revision 2.5, section 27, sealed at ${SEALED_DESIGN}`,
  note: "Generated by scripts/b1/build-manifest.mjs from the static inventory and runtime-role-decisions.json. Do not edit by hand.",
  roles: Object.fromEntries(ROLES.map((r) => [r, roleManifest(r)])),
  securityDefinerTriggers: { [STAMP]: stampDecision.reason },
  publicRevocations: {
    functionsInSchemas: ["kernel_private", "public"],
    schemaCreate: ["public"],
    databaseTemporary: true,
  },
};

// --------------------------------------------------------------------------------------------------------------
// Migration text. Deterministic: sorted roles, relations and verbs.
const policyName = (role, verb, lockOnly) => `${role}_${lockOnly ? "rowlock" : verb.toLowerCase()}`;
function migrationSql(m) {
  const L = [];
  L.push(`-- KJ-P8 B1: least-privilege runtime database roles (ADR-0023 revision 2.5, section 27, sealed at ${SEALED_DESIGN}).`);
  L.push(`-- GENERATED by scripts/b1/build-manifest.mjs from infrastructure/database/runtime-role-manifest.json.`);
  L.push(`-- Do not edit by hand: change the decisions file and regenerate. tests/runtime-roles-catalogue.test.ts`);
  L.push(`-- fails if this file, the manifest and the live catalogue disagree in either direction.`);
  L.push(`--`);
  L.push(`-- No credential appears here. The roles are created without a password; a password is set out of band at`);
  L.push(`-- cutover by the deployment owner. No object changes owner. No row level security setting is relaxed.`);
  L.push(``);
  for (const [role, r] of Object.entries(m.roles)) {
    L.push(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role}; end if; end $$;`);
    L.push(`alter role ${role} with login nosuperuser nocreatedb nocreaterole noreplication nobypassrls noinherit connection limit ${r.attributes.connectionLimit};`);
  }
  L.push(``);
  L.push(`-- No memberships, in either direction.`);
  L.push(`do $$ declare r record; begin`);
  L.push(`  for r in select m.roleid::regrole as granted, m.member::regrole as member from pg_auth_members m`);
  L.push(`    where m.member::regrole::text in (${Object.keys(m.roles).map((r) => `'${r}'`).join(", ")}) or m.roleid::regrole::text in (${Object.keys(m.roles).map((r) => `'${r}'`).join(", ")}) loop`);
  L.push(`    execute format('revoke %s from %s', r.granted, r.member);`);
  L.push(`  end loop;`);
  L.push(`end $$;`);
  L.push(``);
  L.push(`-- PUBLIC cleanup: a runtime role must hold nothing through PUBLIC.`);
  L.push(`revoke create on schema public from public;`);
  L.push(`revoke execute on all functions in schema public, kernel_private from public;`);
  L.push(`do $$ begin execute format('revoke temporary on database %I from public', current_database()); end $$;`);
  L.push(``);
  L.push(`-- Start from nothing, so that re-applying after a manifest change removes what the manifest no longer lists.`);
  const roles = Object.keys(m.roles).join(", ");
  L.push(`revoke all on all tables in schema public, kernel_private from ${roles};`);
  L.push(`revoke all on all sequences in schema public, kernel_private from ${roles};`);
  L.push(`revoke all on all functions in schema public, kernel_private from ${roles};`);
  L.push(`revoke all on schema public, kernel_private from ${roles};`);
  L.push(`do $$ declare p record; begin`);
  L.push(`  for p in select schemaname, tablename, policyname from pg_policies where policyname ~ '^kj_(worker|door)_' loop`);
  L.push(`    execute format('drop policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);`);
  L.push(`  end loop;`);
  L.push(`end $$;`);
  L.push(``);
  for (const [role, r] of Object.entries(m.roles)) {
    L.push(`-- ${role}`);
    L.push(`do $$ begin execute format('grant connect on database %I to ${role}', current_database()); end $$;`);
    for (const [schema, privs] of Object.entries(r.schemas)) L.push(`grant ${privs.join(", ").toLowerCase()} on schema ${schema} to ${role};`);
    for (const [object, t] of Object.entries(r.relations)) {
      for (const [verb, v] of Object.entries(t.verbs)) {
        if (verb === "UPDATE" && v !== true) {
          const cols = v.lockOnly ? [v.column] : v;
          L.push(`grant update (${cols.join(", ")}) on ${object} to ${role};`);
        } else L.push(`grant ${verb.toLowerCase()} on ${object} to ${role};`);
        if (t.kind !== "table") continue;
        const name = policyName(role, verb, v?.lockOnly);
        if (verb === "SELECT") L.push(`create policy ${name} on ${object} for select to ${role} using (true);`);
        if (verb === "INSERT") L.push(`create policy ${name} on ${object} for insert to ${role} with check (true);`);
        if (verb === "DELETE") L.push(`create policy ${name} on ${object} for delete to ${role} using (true);`);
        if (verb === "UPDATE") L.push(`create policy ${name} on ${object} for update to ${role} using (true) with check (${v?.lockOnly ? "false" : "true"});`);
      }
    }
    for (const fn of Object.keys(r.functions)) {
      const [schema, name] = fn.split(".");
      L.push(`do $$ declare f record; begin for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = '${schema}' and p.proname = '${name}' loop execute format('grant execute on function %s to ${role}', f.sig); end loop; end $$;`);
    }
    L.push(``);
  }
  const fn = STAMP;
  L.push(`-- ${fn}() (ADR-0023 revision 2.5, section 27.9): the one B1 SECURITY DEFINER exception. It runs with the`);
  L.push(`-- owner's rights so that no runtime role needs the write its body performs. Its body is not touched: this migration`);
  L.push(`-- contains no CREATE FUNCTION for it and changes only its security attributes and its EXECUTE ACL.`);
  L.push(`alter function ${fn}() security definer;`);
  L.push(`alter function ${fn}() set search_path = '';`);
  L.push(`revoke all on function ${fn}() from public;`);
  L.push(`do $$ declare g record; begin`);
  L.push(`  for g in select distinct pg_get_userbyid(a.grantee) as grantee from pg_proc p, aclexplode(p.proacl) a`);
  L.push(`    where p.oid = '${fn}()'::regprocedure and a.grantee <> 0 and a.grantee <> p.proowner loop`);
  L.push(`    execute format('revoke all on function ${fn}() from %I', g.grantee);`);
  L.push(`  end loop;`);
  L.push(`end $$;`);
  L.push(``);
  L.push(`-- Pre-COMMIT self-check of the exception (ADR-0023 sections 27.9.4 and 27.10.6): refuse to commit unless it is`);
  L.push(`-- exactly as sealed. The full inventory, including the frozen platform baseline, is asserted by qualification.`);
  L.push(`do $$ declare f record; n int; begin`);
  L.push(`  select p.prosecdef, p.proconfig, p.proacl is null as acl_null,`);
  L.push(`         encode(sha256(convert_to(replace(p.prosrc, E'\\r\\n', E'\\n'), 'UTF8')), 'hex') as digest,`);
  L.push(`         (select count(*) from aclexplode(p.proacl) a where not (a.grantee = p.proowner and a.grantor = p.proowner`);
  L.push(`            and a.privilege_type = 'EXECUTE' and not a.is_grantable)) as foreign_acl,`);
  L.push(`         (select count(*) from aclexplode(p.proacl) a) as acl_items`);
  L.push(`    into f from pg_proc p where p.oid = '${fn}()'::regprocedure;`);
  L.push(`  if not f.prosecdef then raise exception 'B1: ${fn}() is not SECURITY DEFINER' using errcode = '23514'; end if;`);
  L.push(`  if f.proconfig is distinct from array['search_path=""'] then`);
  L.push(`    raise exception 'B1: proconfig of ${fn}() is %, sealed is the one element search_path=""', f.proconfig using errcode = '23514'; end if;`);
  L.push(`  if f.acl_null or f.acl_items <> 1 or f.foreign_acl <> 0 then`);
  L.push(`    raise exception 'B1: EXECUTE ACL of ${fn}() is not exactly the owner''s' using errcode = '23514'; end if;`);
  L.push(`  if f.digest <> '${stampDecision.sourceDigest}' then`);
  L.push(`    raise exception 'B1: source digest of ${fn}() is %, pinned ${stampDecision.sourceDigest}', f.digest using errcode = '23514'; end if;`);
  L.push(`  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where p.proname = 'stamp_binding_provenance'`);
  L.push(`    and not (s.nspname in ('pg_catalog', 'information_schema', 'pg_toast') or s.nspname ~ '^pg_temp_[0-9]+$' or s.nspname ~ '^pg_toast_temp_[0-9]+$');`);
  L.push(`  if n <> 1 then raise exception 'B1: % functions are named stamp_binding_provenance; exactly one is sealed', n using errcode = '23514'; end if;`);
  L.push(`  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where p.prosecdef and s.nspname in ('public', 'kernel_private');`);
  L.push(`  if n <> 1 then raise exception 'B1: KernelJSON schemas hold % SECURITY DEFINER functions; stage B1 allows exactly one', n using errcode = '23514'; end if;`);
  L.push(`end $$;`);
  L.push(``);
  L.push(`-- Pre-COMMIT self-check: refuse to commit a role that is not exactly as sealed.`);
  L.push(`do $$ declare bad text; begin`);
  L.push(`  select string_agg(rolname, ', ') into bad from pg_roles where rolname in (${Object.keys(m.roles).map((r) => `'${r}'`).join(", ")})`);
  L.push(`    and (not rolcanlogin or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls or rolinherit);`);
  L.push(`  if bad is not null then raise exception 'B1: runtime role attributes are not as sealed: %', bad using errcode = '23514'; end if;`);
  L.push(`  if exists (select 1 from pg_auth_members m where m.member::regrole::text in (${Object.keys(m.roles).map((r) => `'${r}'`).join(", ")}) or m.roleid::regrole::text in (${Object.keys(m.roles).map((r) => `'${r}'`).join(", ")})) then`);
  L.push(`    raise exception 'B1: a runtime role has a role membership' using errcode = '23514'; end if;`);
  L.push(`end $$;`);
  return L.join("\n") + "\n";
}

const manifestText = JSON.stringify(manifest, null, 2) + "\n";
const migrationText = migrationSql(manifest);

// --------------------------------------------------------------------------------------------------------------
// The KernelJSON SECURITY DEFINER stage manifest (ADR-0023 revision 2.5, section 27.10.3). Stage B1 is the only one
// implemented; later stages are known by exact identity but carry no migration and no source pin, so a release cannot
// declare them (services/kernel/src/database/security-definers.ts stageBindingProblems).
const definer = (schema, name, args, returns, pins) =>
  ({ schema, name, args, returns, retset: false, kind: "f", owner: OWNER, securityDefiner: true, ...pins });
const laterPins = (contract) => ({ language: null, config: ['search_path=""'], acl: [`${OWNER}=X/${OWNER}`, `kj_worker=X/${OWNER}`], sourceDigest: null, contract });
const stageManifest = {
  contract: "kerneljson:security-definer-stage-manifest/v1",
  design: { adr: "ADR-0023", revision: "2.5", sha: SEALED_DESIGN },
  repository: "jonnyallum/kerneljson",
  releaseIdentity: "The commit that carries this file; a running process reports it as KERNELJSON_RELEASE_ID. A database is bound to the declared stage by catalogue equality (ADR-0023 section 27.10.5).",
  note: "Generated by scripts/b1/build-manifest.mjs. Do not edit by hand.",
  declaredStage: "B1",
  baseMigrations: readdirSync(join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql") && !MIGRATION.endsWith(f)).sort()
    .map((f) => ({ file: f, sha256: sha256(lf(readFileSync(join(ROOT, "supabase/migrations", f), "utf8"))) })),
  stampTrigger: { name: "execution_bindings_provenance", relation: "kernel_private.execution_bindings", tgtype: 7, tgenabled: "O", tgqual: null, tgisinternal: false, tgnargs: 0, tgattr: "" },
  stages: [
    { stage: "B1", implemented: true, migrations: [{ file: basename(MIGRATION), sha256: sha256(migrationText) }],
      adds: [definer("kernel_private", "stamp_binding_provenance", [], "pg_catalog.trigger",
        { language: "plpgsql", config: ['search_path=""'], acl: [`${OWNER}=X/${OWNER}`], sourceDigest: stampDecision.sourceDigest, contract: "ADR-0023 section 27.9" })] },
    { stage: "P8A-0", implemented: false, migrations: [],
      adds: [definer("kernel_private", "freeze_reflection", ["pg_catalog.uuid"], "pg_catalog.void", laterPins("ADR-0023 sections 17.1 and 27.5"))] },
    { stage: "B2", implemented: false, migrations: [], adds: [] },
    { stage: "P8A-1", implemented: false, migrations: [], adds: [] },
    { stage: "P8A-2", implemented: false, migrations: [], adds: [] },
    { stage: "P8B", implemented: false, migrations: [],
      adds: [definer("kernel_private", "close_growth_window_by_owner", ["pg_catalog.uuid", "pg_catalog.uuid"], "kernel_private.identity_growth_window_closures", laterPins("ADR-0023 sections 17.2 and 27.5"))] },
  ],
};
const stageManifestText = JSON.stringify(stageManifest, null, 2) + "\n";

if (process.argv.includes("--check")) {
  const same = (p, text) => readFileSync(join(ROOT, p), "utf8").replaceAll("\r\n", "\n") === text;
  const bad = [[MANIFEST, manifestText], [MIGRATION, migrationText], [STAGE_MANIFEST, stageManifestText]].filter(([p, t]) => !same(p, t)).map(([p]) => p);
  if (bad.length) { console.error("B1 manifest drift: regenerate with `node scripts/b1/build-manifest.mjs`:", bad.join(", ")); process.exit(1); }
  console.log("B1 manifest and migration match their inputs");
} else {
  writeFileSync(join(ROOT, MANIFEST), manifestText);
  writeFileSync(join(ROOT, MIGRATION), migrationText);
  writeFileSync(join(ROOT, STAGE_MANIFEST), stageManifestText);
  const count = (r) => { const c = {}; for (const t of Object.values(r.relations)) for (const [v, x] of Object.entries(t.verbs)) { const k = v === "UPDATE" && x?.lockOnly ? "ROWLOCK" : v; c[k] = (c[k] ?? 0) + 1; } c.EXECUTE = Object.keys(r.functions).length; return c; };
  for (const [role, r] of Object.entries(manifest.roles)) console.log(role, JSON.stringify(count(r)));
  console.log("wrote", MANIFEST, MIGRATION, "and", STAGE_MANIFEST, "; stamp source digest", derivationB);
}
export { manifest, policyName, stageManifest, MANIFEST, MIGRATION, STAGE_MANIFEST };
