// Run only on the local/disposable qualification database. Restores source after every mutant.
import { assertBaseEnvironment } from './b1/base-guard.mjs';
process.env.KJ_RUNTIME_ROLES='base';
assertBaseEnvironment();
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRestorer, listTests, runClassified } from "./b1/mutation-infra.mjs";
const policy = "services/kernel/src/faculty/policy.ts";
const verify = "services/kernel/src/faculty/verify.ts";
const sql = "supabase/migrations/20260923150000_core_team_faculties.sql";
const cases = [
  ["F1", policy, "if (!f.enabled)", "if (false)"],
  ["F2", policy, "p.tenantId !== f.tenantId ||", "false ||"],
  ["F3", policy, '!f.permittedCapabilityClasses.includes("MODEL_TEXT")', "false"],
  ["F4", verify, 'if (required) throw new Error("Configured mission requires canonical faculty pins");', "if (false) throw new Error('disabled');"],
  ["F5", sql, "before update or delete on public.faculty_versions", "before delete on public.faculty_versions"],
];
mkdirSync("artifacts/local", { recursive: true });
const files = new Map(cases.map(([, f]) => [f, readFileSync(f, "utf8")]));
// KJ-P8 B1 A10.7 2-R4e: crash-safe restore and infrastructure classification first (scripts/b1/mutation-infra.mjs).
const restorer = createRestorer(".mutation-check-faculties.backup.json");
function restore() { restorer.restore(); for (const [f, text] of files) if (readFileSync(f, "utf8") !== text) writeFileSync(f, text); }
const TESTS = ["tests/faculty.test.ts", "tests/mission-workflow.integration.test.ts"], FILTER = ["-t", "P6"];
const LISTED = listTests(TESTS, { filter: FILTER });
function run(label) {
  mkdirSync("artifacts/local/faculty-mutation-logs", { recursive: true });
  const r = runClassified({ label, files: TESTS, filter: FILTER, tests: LISTED, restore, logDir: "artifacts/local/faculty-mutation-logs", timeout: 180000 });
  writeFileSync(`artifacts/local/faculty-mutation-${label}.json`, JSON.stringify(r.report));
  if (r.total === 0) throw new Error(`Mutation runner failed: ${label}`);
  return { label, exitCode: r.code, failed: r.failed };
}
try {
  const base = run("baseline");
  if (base.exitCode !== 0 || base.failed !== 0) throw new Error("Unmutated faculty tests failed");
  const results = [];
  for (const [id, file, find, replacement] of cases) {
    const text = files.get(file);
    if (text.split(find).length !== 2) throw new Error(`Non-unique mutation target: ${id}`);
    restorer.save(file, text);
    writeFileSync(file, text.replace(find, replacement));
    const r = run(id);
    results.push(r);
    restore();
    if (r.exitCode === 0 || r.failed < 1) throw new Error(`Surviving or invalid mutation: ${id}`);
    console.log(`${id}: detected by ${r.failed} failed assertions`);
  }
  writeFileSync("artifacts/local/faculty-mutations.json", JSON.stringify({ baseline: base, results }, null, 2));
} finally { restore(); }
