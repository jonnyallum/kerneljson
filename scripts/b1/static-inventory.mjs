#!/usr/bin/env node
// KJ-P8 B1 - static database capability inventory (ADR-0023 section 27.6 step 1).
//
// Deterministic: reads only files in this repository, sorts everything, and writes one JSON document. It answers
// "which database objects can each runtime process touch, and how?" from two sources:
//   1. SQL embedded in the TypeScript reachable (by static import) from each runtime entry point;
//   2. the closure of that set through SECURITY INVOKER trigger functions and views declared in the migrations,
//      because those run with the caller's privileges.
// It over-approximates on purpose (file-level reachability). The dynamic trace (tests/support/runtime-roles.ts)
// is the cross-check; scripts/b1/build-manifest.mjs combines them. Neither alone is the manifest.
import { readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { ROOT, read, ENTRY_POINTS, DEPLOYMENT_MODULES, SOURCES, stripTsComments, reach } from "./runtime-graph.mjs";
export { ENTRY_POINTS, DEPLOYMENT_MODULES, reach };

// ---------------------------------------------------------------------------------------------------------------
// Catalogue from the migrations.
const MIGRATIONS = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
const stripSqlComments = (s) => s.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const sqlAll = MIGRATIONS.map((f) => stripSqlComments(read(`supabase/migrations/${f}`))).join("\n;\n");

const relations = new Map(); // "schema.name" -> "table" | "view"
for (const m of sqlAll.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?((?:public|kernel_private)\.)?([a-z_][a-z0-9_]*)/gi))
  relations.set(`${(m[1] ?? "public.").slice(0, -1)}.${m[2]}`.toLowerCase(), "table");
const views = new Map(); // "schema.name" -> definition text (last wins)
for (const m of sqlAll.matchAll(/create\s+(?:or\s+replace\s+)?view\s+((?:public|kernel_private)\.)?([a-z_][a-z0-9_]*)([\s\S]*?);/gi)) {
  const key = `${(m[1] ?? "public.").slice(0, -1)}.${m[2]}`.toLowerCase();
  relations.set(key, "view");
  views.set(key, m[3]);
}
const functions = new Map(); // "schema.name" -> { trigger: boolean, body: string, definer: boolean }
for (const m of sqlAll.matchAll(/create\s+(?:or\s+replace\s+)?function\s+((?:public|kernel_private)\.)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\$\$([\s\S]*?)\$\$/gi)) {
  const key = `${(m[1] ?? "public.").slice(0, -1)}.${m[2]}`.toLowerCase();
  functions.set(key, { trigger: /returns\s+trigger/i.test(m[3]), definer: /security\s+definer/i.test(m[3]), body: m[4] });
}
const triggers = []; // { table, fn, events }
for (const m of sqlAll.matchAll(/create\s+(?:constraint\s+)?trigger\s+[a-z_0-9"%|']+\s+(before|after|instead\s+of)\s+([a-z\s]+?)\s+on\s+((?:public|kernel_private)\.)?([a-z_][a-z0-9_]*)[\s\S]*?execute\s+function\s+((?:public|kernel_private)\.)?([a-z_][a-z0-9_]*)/gi))
  triggers.push({
    table: `${(m[3] ?? "public.").slice(0, -1)}.${m[4]}`.toLowerCase(),
    fn: `${(m[5] ?? "public.").slice(0, -1)}.${m[6]}`.toLowerCase(),
    events: m[2].toLowerCase().split(/\s+or\s+/).map((e) => e.trim().split(/\s+/)[0]),
  });
// Triggers created through execute format(...) in DO blocks: the immutability triggers. They call
// reject_ledger_mutation(), which touches no relation, so they add nothing to the closure.

const qualify = (schema, name) => {
  const n = name.toLowerCase();
  if (schema) return `${schema.slice(0, -1).toLowerCase()}.${n}`;
  return `public.${n}`; // unqualified names resolve through search_path = public in this codebase
};

// ---------------------------------------------------------------------------------------------------------------
// SQL operation extractor. Works on a text blob; only names in the catalogue count, which removes prose noise.
const REL = String.raw`((?:public|kernel_private)\.)?([a-z_][a-z0-9_]*)`;
export function opsOf(text) {
  const t = text.replace(/\s+/g, " ");
  const out = [];
  const push = (verb, schema, name, extra = {}) => {
    const key = qualify(schema, name);
    if (relations.has(key)) out.push({ verb, object: key, kind: relations.get(key), ...extra });
  };
  const setColumns = (clause) =>
    [...clause.matchAll(/(?:^|,)\s*"?([a-z_][a-z0-9_]*)"?\s*=(?!=)/gi)].map((c) => c[1].toLowerCase()).filter((c) => c !== "excluded");
  // Postgres requires SELECT for RETURNING, for an ON CONFLICT arbiter, and for any column read in a WHERE or SET
  // expression. An UPDATE or DELETE always has one of those in this codebase, so both imply SELECT.
  for (const m of t.matchAll(new RegExp(String.raw`insert\s+into\s+${REL}`, "gi"))) {
    push("INSERT", m[1], m[2]);
    const tail = t.slice(m.index, m.index + 4000);
    if (/^insert\s+into[^;]*?\b(on\s+conflict|returning)\b/i.test(tail)) push("SELECT", m[1], m[2]);
    const up = /^insert\s+into[^;]*?on\s+conflict[^;]*?do\s+update\s+set\s+([^;]*?)(?=\bwhere\b|\breturning\b|;|$)/i.exec(tail);
    if (up) push("UPDATE", m[1], m[2], { columns: setColumns(up[1]), upsert: true });
  }
  for (const m of t.matchAll(new RegExp(String.raw`(?<!do\s)update\s+(?:only\s+)?${REL}\s+(?:(?:as\s+)?(?!set\b)[a-z_]+\s+)?set\s+([^;]*?)(?=\bwhere\b|\bfrom\b|\breturning\b|;|$)`, "gi"))) {
    push("UPDATE", m[1], m[2], { columns: setColumns(m[3].replace(/\b[a-z_]+\.(?=[a-z_]+\s*=)/gi, "")) });
    push("SELECT", m[1], m[2]);
  }
  for (const m of t.matchAll(new RegExp(String.raw`delete\s+from\s+(?:only\s+)?${REL}`, "gi"))) {
    push("DELETE", m[1], m[2]);
    push("SELECT", m[1], m[2]);
  }
  for (const m of t.matchAll(new RegExp(String.raw`truncate\s+(?:table\s+)?${REL}`, "gi"))) push("TRUNCATE", m[1], m[2]);
  for (const m of t.matchAll(new RegExp(String.raw`\b(from|join)\s+(?:only\s+)?${REL}`, "gi"))) {
    const before = t.slice(Math.max(0, m.index - 12), m.index).toLowerCase();
    if (/delete\s*$/.test(before) || /distinct\s*$/.test(before)) continue;
    push("SELECT", m[2], m[3]);
  }
  if (/\bfor\s+(update|no\s+key\s+update|share|key\s+share)\b/i.test(t))
    for (const o of out.filter((x) => x.verb === "SELECT")) out.push({ ...o, verb: "ROWLOCK" });
  for (const [key, def] of functions) {
    if (def.trigger) continue;
    const [schema, name] = key.split(".");
    const re = schema === "public"
      ? new RegExp(String.raw`(?<![a-z0-9_.])(?:public\.)?${name}\s*\(`, "i")
      : new RegExp(String.raw`${schema}\.${name}\s*\(`, "i");
    if (re.test(t)) out.push({ verb: "EXECUTE", object: key, kind: "function" });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Per-file operations, then per-role closure.
const fileOps = new Map();
for (const f of SOURCES) {
  // One chunk per string literal, so a row lock is attributed to the statement that takes it, not to the whole file.
  const ops = stripTsComments(read(f)).split(/["`]/).flatMap((chunk) => opsOf(chunk));
  if (ops.length) fileOps.set(f, ops);
}
const triggerOps = new Map(); // table -> [{event, ops}]
for (const tr of triggers) {
  const def = functions.get(tr.fn);
  if (!def || def.definer) continue;
  const ops = bodyOps(def.body);
  if (!triggerOps.has(tr.table)) triggerOps.set(tr.table, []);
  triggerOps.get(tr.table).push({ fn: tr.fn, events: tr.events, ops });
}
const viewOps = new Map();
for (const [v, def] of views) viewOps.set(v, opsOf(def).filter((o) => o.verb === "SELECT" && o.object !== v));
function bodyOps(body) { return body.split(";").flatMap((statement) => opsOf(statement)); }
const fnOps = new Map();
for (const [f, def] of functions) if (!def.trigger && !def.definer) fnOps.set(f, bodyOps(def.body));

function closure(files) {
  const entries = new Map(); // key verb|object -> { verb, object, kind, columns:Set, sources:Set }
  const add = (o, source) => {
    const key = `${o.verb}|${o.object}`;
    if (!entries.has(key)) entries.set(key, { verb: o.verb, object: o.object, kind: o.kind, columns: new Set(), sources: new Set(), fresh: true });
    const e = entries.get(key);
    for (const c of o.columns ?? []) e.columns.add(c);
    e.sources.add(source);
  };
  for (const f of files) for (const o of fileOps.get(f) ?? []) add(o, f);
  // Fixed point through views, plain functions and invoker trigger functions.
  for (let changed = true; changed; ) {
    changed = false;
    for (const e of [...entries.values()]) {
      if (!e.fresh) continue;
      e.fresh = false;
      changed = true;
      if (e.kind === "view" && e.verb === "SELECT") for (const o of viewOps.get(e.object) ?? []) add(o, `view:${e.object}`);
      if (e.kind === "function") for (const o of fnOps.get(e.object) ?? []) add(o, `function:${e.object}`);
      if (e.kind === "table" && ["INSERT", "UPDATE", "DELETE"].includes(e.verb))
        for (const t of triggerOps.get(e.object) ?? [])
          if (t.events.includes(e.verb.toLowerCase())) for (const o of t.ops) add(o, `trigger:${e.object}:${t.fn}`);
    }
  }
  return [...entries.values()]
    .map((e) => ({ verb: e.verb, object: e.object, kind: e.kind, columns: [...e.columns].sort(), sources: [...e.sources].sort() }))
    .sort((a, b) => (a.object + a.verb).localeCompare(b.object + b.verb));
}

const result = {
  contract: "kerneljson:b1-static-inventory/v1",
  migrations: MIGRATIONS,
  catalogue: {
    tables: [...relations].filter(([, k]) => k === "table").map(([n]) => n).sort(),
    views: [...relations].filter(([, k]) => k === "view").map(([n]) => n).sort(),
    functions: [...functions].filter(([, d]) => !d.trigger).map(([n]) => n).sort(),
    triggerFunctions: [...functions].filter(([, d]) => d.trigger).map(([n]) => n).sort(),
    securityDefinerFunctions: [...functions].filter(([, d]) => d.definer).map(([n]) => n).sort(),
  },
  entryPoints: ENTRY_POINTS,
  deploymentModules: DEPLOYMENT_MODULES.map((f) => ({ file: f, operations: closure([f]).filter((e) => e.sources.includes(f)) })),
  roles: Object.fromEntries(
    Object.entries(ENTRY_POINTS).map(([role, entries]) => {
      const files = reach(entries, DEPLOYMENT_MODULES);
      return [role, { reachableFilesWithSql: files.filter((f) => fileOps.has(f)), operations: closure(files) }];
    }),
  ),
  filesWithSqlNotReachableFromAnyRuntimeEntry: [...fileOps.keys()]
    .filter((f) => !Object.values(ENTRY_POINTS).some((e) => reach(e, DEPLOYMENT_MODULES).includes(f)) && !DEPLOYMENT_MODULES.includes(f))
    .sort(),
};

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop())) {
  const out = process.argv[2] ?? "docs/operations/evidence/kj-p8-b1/static-inventory.json";
  mkdirSync(join(ROOT, dirname(out)), { recursive: true });
  writeFileSync(join(ROOT, out), JSON.stringify(result, null, 2) + "\n");
  const count = (ops) => Object.entries(ops.reduce((a, o) => ((a[o.verb] = (a[o.verb] ?? 0) + 1), a), {})).sort().map(([k, v]) => `${k}=${v}`).join(" ");
  for (const [role, r] of Object.entries(result.roles)) console.log(role, r.reachableFilesWithSql.length, "files |", count(r.operations));
  console.log("unreached files with SQL:", result.filesWithSqlNotReachableFromAnyRuntimeEntry.join(", ") || "none");
  console.log("wrote", out);
}
export default result;
