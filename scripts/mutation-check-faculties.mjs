// Run only on the local/disposable qualification database. Restores source after every mutant.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
function restore() { for (const [f, text] of files) writeFileSync(f, text); }
process.on("SIGINT", () => { restore(); process.exit(130); });
function run(label) {
  const path = `artifacts/local/faculty-mutation-${label}.json`;
  const r = spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["exec", "vitest", "run", "tests/faculty.test.ts", "tests/mission-workflow.integration.test.ts", "-t", "P6", "--reporter=json", `--outputFile=${path}`], { encoding: "utf8", shell: process.platform === "win32", timeout: 180000 });
  let report;
  try { report = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error(`No test report for ${label}: ${r.stderr}`); }
  if (r.error || report.numTotalTests === 0) throw new Error(`Mutation runner failed: ${label}`);
  return { label, exitCode: r.status, failed: report.numFailedTests };
}
try {
  const base = run("baseline");
  if (base.exitCode !== 0 || base.failed !== 0) throw new Error("Unmutated faculty tests failed");
  const results = [];
  for (const [id, file, find, replacement] of cases) {
    const text = files.get(file);
    if (text.split(find).length !== 2) throw new Error(`Non-unique mutation target: ${id}`);
    writeFileSync(file, text.replace(find, replacement));
    const r = run(id);
    results.push(r);
    restore();
    if (r.exitCode === 0 || r.failed < 1) throw new Error(`Surviving or invalid mutation: ${id}`);
    console.log(`${id}: detected by ${r.failed} failed assertions`);
  }
  writeFileSync("artifacts/local/faculty-mutations.json", JSON.stringify({ baseline: base, results }, null, 2));
} finally { restore(); }
