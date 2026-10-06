#!/usr/bin/env node
// KJ-P8 B1 - dynamic database capability inventory.
//
// Reads the statement trace written by tests/support/runtime-roles.ts during a suite run and reports, per runtime
// role: what was actually executed (parsed with the SAME extractor as the static inventory), what was refused, and
// how that compares with the frozen manifest in both directions:
//   observed but not in the manifest  -> a missing grant, or a statement that must not be a runtime statement
//   in the manifest but never observed -> a statically reachable path the suite does not exercise (kept, and listed)
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { opsOf } from "./static-inventory.mjs";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const traceDir = join(ROOT, positional[0] ?? "artifacts/local/b1-trace");
const out = positional[1] ?? "artifacts/local/b1-dynamic-inventory.json";
const manifest = JSON.parse(readFileSync(join(ROOT, "infrastructure/database/runtime-role-manifest.json"), "utf8"));

const events = [];
if (existsSync(traceDir))
  for (const f of readdirSync(traceDir).filter((f) => f.endsWith(".jsonl")).sort())
    for (const line of readFileSync(join(traceDir, f), "utf8").split("\n").filter(Boolean)) events.push(JSON.parse(line));

const granted = (role, object, verb) => {
  const r = manifest.roles[role];
  // Manifest functions are keyed by exact identity (ADR-0023 27.11.3); a traced statement names the function only.
  if (verb === "EXECUTE") return Object.keys(r.functions).some((k) => k.slice(0, k.indexOf("(")) === object);
  const rel = r.relations[object];
  if (!rel) return false;
  if (verb === "ROWLOCK") return "UPDATE" in rel.verbs;
  return verb in rel.verbs;
};

const result = { contract: "kerneljson:b1-dynamic-inventory/v1", events: events.length, roles: {} };
for (const role of Object.keys(manifest.roles)) {
  const mine = events.filter((e) => e.role === role);
  const observed = new Map(); // "VERB object" -> { callers:Set, via:Set }
  for (const e of mine.filter((e) => e.kind === "use"))
    for (const o of opsOf(e.sql)) {
      const key = `${o.verb} ${o.object}`;
      if (!observed.has(key)) observed.set(key, { verb: o.verb, object: o.object, callers: new Set(), via: new Set(), columns: new Set() });
      const x = observed.get(key);
      x.callers.add(e.caller); x.via.add(e.via); for (const c of o.columns ?? []) x.columns.add(c);
    }
  const denied = new Map();
  for (const e of mine.filter((e) => e.kind === "denied" || e.kind === "refused")) {
    const key = e.message;
    if (!denied.has(key)) denied.set(key, { message: e.message, callers: new Set(), statements: new Set() });
    denied.get(key).callers.add(e.caller); denied.get(key).statements.add(e.sql.slice(0, 200));
  }
  const list = [...observed.values()].map((x) => ({ verb: x.verb, object: x.object, columns: [...x.columns].sort(), callers: [...x.callers].sort(), via: [...x.via].sort() }))
    .sort((a, b) => (a.object + a.verb).localeCompare(b.object + b.verb));
  const expected = [];
  for (const [object, rel] of Object.entries(manifest.roles[role].relations))
    for (const [verb, v] of Object.entries(rel.verbs)) expected.push(`${verb === "UPDATE" && v?.lockOnly ? "ROWLOCK" : verb} ${object}`);
  for (const fn of Object.keys(manifest.roles[role].functions)) expected.push(`EXECUTE ${fn.slice(0, fn.indexOf("("))}`);
  const seen = new Set(list.map((o) => `${o.verb} ${o.object}`));
  result.roles[role] = {
    statements: mine.filter((e) => e.kind === "use").length,
    byConnection: { login: mine.filter((e) => e.kind === "use" && e.via === "login").length, setRole: mine.filter((e) => e.kind === "use" && e.via === "set-role").length },
    observed: list,
    observedNotInManifest: list.filter((o) => !granted(role, o.object, o.verb)),
    inManifestNeverObserved: expected.filter((k) => !seen.has(k) && !(k.startsWith("ROWLOCK") && seen.has(k.replace("ROWLOCK", "SELECT")))).sort(),
    denied: [...denied.values()].map((d) => ({ message: d.message, callers: [...d.callers].sort(), statements: [...d.statements].sort().slice(0, 5) }))
      .sort((a, b) => a.message.localeCompare(b.message)),
  };
}
mkdirSync(join(ROOT, dirname(out)), { recursive: true });
writeFileSync(join(ROOT, out), JSON.stringify(result, null, 2) + "\n");
for (const [role, r] of Object.entries(result.roles))
  console.log(`${role}: ${r.statements} distinct statements (login ${r.byConnection.login}, set-role ${r.byConnection.setRole}); observed ops ${r.observed.length}; not in manifest ${r.observedNotInManifest.length}; never observed ${r.inManifestNeverObserved.length}; refusals ${r.denied.length}`);
console.log("wrote", out);
if (process.argv.includes("--fail-on-refusal")) {
  const refusals = Object.entries(result.roles).flatMap(([role, r]) => [...r.denied.map((d) => `${role}: ${d.message}`), ...r.observedNotInManifest.map((o) => `${role}: ${o.verb} ${o.object} is not in the manifest`)]);
  if (refusals.length) { console.error("B1: runtime statements were refused or fall outside the manifest:\n" + refusals.join("\n")); process.exit(1); }
}
