#!/usr/bin/env node
// KJ-P8 B1 - assemble the qualification summary from the artefacts of a qualification run.
// Usage: node scripts/b1/summarise.mjs <artefact dir> <output dir>
// It only reads result files and repository files; it runs nothing and decides nothing.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
const [src = "artifacts/local/b1", dst = "docs/operations/evidence/kj-p8-b1"] = process.argv.slice(2);
const json = (p) => (existsSync(join(ROOT, p)) ? JSON.parse(readFileSync(join(ROOT, p), "utf8")) : null);
const sha = (p) => createHash("sha256").update(readFileSync(join(ROOT, p), "utf8").replaceAll("\r\n", "\n")).digest("hex");
const suite = (r) => r && { total: r.numTotalTests, passed: r.numPassedTests, failed: r.numFailedTests, skipped: r.numPendingTests, files: r.testResults.length, success: r.success };
const B1_FILES = /runtime-roles-(catalogue|connection|negative|topology)/;
const split = (r) => {
  if (!r) return null;
  const count = (keep) => r.testResults.filter((f) => keep(f.name)).flatMap((f) => f.assertionResults).reduce((a, t) => ((a[t.status] = (a[t.status] ?? 0) + 1), a), {});
  return { preExistingFiles: count((n) => !B1_FILES.test(n)), b1Files: count((n) => B1_FILES.test(n)) };
};

const manifest = json("infrastructure/database/runtime-role-manifest.json");
const counts = (role) => {
  const c = { SELECT: 0, INSERT: 0, UPDATE: 0, DELETE: 0, ROWLOCK: 0, EXECUTE: Object.keys(manifest.roles[role].functions).length, relations: Object.keys(manifest.roles[role].relations).length };
  for (const t of Object.values(manifest.roles[role].relations)) for (const [v, x] of Object.entries(t.verbs)) c[v === "UPDATE" && x?.lockOnly ? "ROWLOCK" : v]++;
  return c;
};
const policies = [];
for (const [role, r] of Object.entries(manifest.roles))
  for (const [object, t] of Object.entries(r.relations))
    if (t.kind === "table")
      for (const [verb, x] of Object.entries(t.verbs)) {
        const lock = verb === "UPDATE" && x?.lockOnly;
        policies.push({ table: object, policy: `${role}_${lock ? "rowlock" : verb.toLowerCase()}`, role, command: verb,
          using: verb === "INSERT" ? null : "true", withCheck: verb === "INSERT" ? "true" : verb === "UPDATE" ? (lock ? "false" : "true") : null });
      }
policies.sort((a, b) => (a.table + a.policy).localeCompare(b.table + b.policy));

const probes = json(`${src}/negative-probes.json`);
const dyn = (name) => { const d = json(`${src}/${name}`); return d && Object.fromEntries(Object.entries(d.roles).map(([role, r]) => [role, {
  distinctStatements: r.statements, byConnection: r.byConnection, observedOperations: r.observed.length,
  observedNotInManifest: r.observedNotInManifest, refusals: r.denied, inManifestNeverObserved: r.inManifestNeverObserved }])); };
const migrations = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
const b1Migration = migrations.at(-1);

const summary = {
  contract: "kerneljson:b1-qualification-summary/v1",
  design: manifest.design,
  manifest: { path: "infrastructure/database/runtime-role-manifest.json", sha256: sha("infrastructure/database/runtime-role-manifest.json"),
    decisions: { path: "infrastructure/database/runtime-role-decisions.json", sha256: sha("infrastructure/database/runtime-role-decisions.json") },
    entryCounts: { kj_worker: counts("kj_worker"), kj_door: counts("kj_door") }, securityDefinerTriggers: Object.keys(manifest.securityDefinerTriggers) },
  migrations: { added: [{ file: b1Migration, sha256: sha(`supabase/migrations/${b1Migration}`) }], total: migrations.length,
    existingUnchanged: migrations.slice(0, -1).map((f) => ({ file: f, sha256: sha(`supabase/migrations/${f}`) })) },
  rlsPolicies: { count: policies.length },
  suites: {
    baselineOwnerAtBaseCommit: suite(json(`${src}/baseline-tests.json`) ?? json("artifacts/local/baseline-tests.json")),
    discover: { ...suite(json(`${src}/discover-tests.json`)), split: split(json(`${src}/discover-tests.json`)) },
    enforce: { ...suite(json(`${src}/enforce-tests.json`)), split: split(json(`${src}/enforce-tests.json`)) },
    gatedFilesOwnerAtBaseCommit: suite(json(`${src}/gated-baseline.json`) ?? json("artifacts/local/gated-baseline.json")),
    gatedFilesEnforce: suite(json(`${src}/gated-enforce.json`)),
  },
  dynamicInventory: { discover: dyn("dynamic-inventory-discover.json"), enforce: dyn("dynamic-inventory-enforce.json") },
  negativeProbes: probes && { total: probes.results.length, passed: probes.results.filter((p) => p.pass).length,
    failed: probes.results.filter((p) => !p.pass), byRole: probes.results.reduce((a, p) => ((a[p.role] = (a[p.role] ?? 0) + 1), a), {}) },
};
mkdirSync(join(ROOT, dst), { recursive: true });
const write = (name, value) => writeFileSync(join(ROOT, dst, name), JSON.stringify(value, null, 2) + "\n");
write("qualification-summary.json", summary);
write("rls-policy-inventory.json", { contract: "kerneljson:b1-rls-policy-inventory/v1", policies });
for (const f of ["static-inventory.json", "dynamic-inventory-discover.json", "dynamic-inventory-enforce.json", "negative-probes.json"])
  if (existsSync(join(ROOT, src, f))) writeFileSync(join(ROOT, dst, f), readFileSync(join(ROOT, src, f), "utf8"));
console.log(JSON.stringify({ suites: summary.suites, entryCounts: summary.manifest.entryCounts, policies: policies.length, probes: summary.negativeProbes && { total: summary.negativeProbes.total, passed: summary.negativeProbes.passed } }, null, 1));
