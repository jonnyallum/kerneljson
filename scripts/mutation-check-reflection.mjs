// K1 only: pure behavioral guard removals. No database, provider or production access.
// Crash recovery restores the exact saved bytes before running a new baseline.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const contracts = "packages/contracts/src/reflection.ts";
const verifier = "services/kernel/src/reflection/verify.ts";
const directory = resolve("artifacts/local/reflection-mutations");
mkdirSync(directory, { recursive: true });
const backup = resolve(directory, "restore.json");
function restore() {
  if (!existsSync(backup)) return;
  const { file, original } = JSON.parse(readFileSync(backup, "utf8"));
  if (![contracts, verifier].includes(file)) throw new Error("Unexpected mutation backup path");
  writeFileSync(file, original);
  rmSync(backup);
}
restore();
const mutations = [
  ["M01", contracts, "if (Object.hasOwn(result, key)) fail();", ""],
  ["M02", contracts, "new TextEncoder().encode(text).byteLength > REFLECTION_INPUT_MAX_BYTES", "false"],
  ["M03", contracts, "new TextEncoder().encode(JSON.stringify(p)).byteLength > REFLECTION_PROPOSAL_MAX_BYTES", "false"],
  ["M04", contracts, "export const ReflectionProposalV1 = z.strictObject({", "export const ReflectionProposalV1 = z.object({"],
  ["M05", verifier, ' || task.status !== "COMPLETED"', ""],
  ["M06", verifier, 'verifyMissionCompletion({ ...task, status: "VERIFYING" }, outcome, plan, steps,\n    records.map(record => ({ record, step: steps.find(s => s.id === record.stepId) })));', ""],
  ["M07", verifier, "verifyFacultyEvidence(pins, records, true);", ""],
  ["M08", verifier, "verifyIdentityEvidence({ contractStartEpoch: f.contractStartEpoch, bindingEpoch: f.bindingEpoch,\n    analystStepId, latches: f.latches, pins: f.identityPins, modelCalls: f.modelCalls, evidence: records });", ""],
  ["M09", verifier, "if (identityCoreDigestV1(expectedProjection) !== pin.projectionDigest) fail();", ""],
  ["M10", verifier, 'if (continuity !== analyst.metadata["continuity_digest"]) fail();', ""],
  ["M11", verifier, " || findSecretShapedContent(source)", ""],
  ["M12", verifier, "canonicalDigest(body) !== proposalDigest", "false"],
  ["M13", verifier, 'import { z } from "zod";', 'import { z } from "zod";\nimport "../identity/projection.js";'],
  ["M14", verifier, "if (canonicalDigest(step) !== canonicalDigest(expected)) fail();", ""],
];
function run(label) {
  const report = resolve(directory, `${label}.json`);
  if (existsSync(report)) rmSync(report);
  const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/reflection.test.ts",
    "tests/identity-topology.test.ts",
    "--reporter=json", `--outputFile=${report}`], { encoding: "utf8", timeout: 120000 });
  writeFileSync(resolve(directory, `${label}.log`), `${result.stdout ?? ""}${result.stderr ?? ""}`);
  const json = existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : {};
  return { exit: result.status, failed: json.numFailedTests ?? 0, total: json.numTotalTests ?? 0,
    passed: json.numPassedTests ?? 0, runtimeErrors: json.numRuntimeErrorTestSuites ?? 0 };
}
const baseline = run("baseline");
if (baseline.exit !== 0 || baseline.failed || !baseline.total || baseline.runtimeErrors) throw new Error("Baseline failed");
console.log(`Baseline: ${baseline.passed} passed`);
const results = [];
for (const [id, file, needle, replacement] of mutations) {
  const original = readFileSync(file, "utf8"), eol = original.includes("\r\n") ? "\r\n" : "\n";
  const target = needle.replaceAll("\n", eol);
  if (original.split(target).length !== 2) throw new Error(`${id}: mutation target must occur exactly once`);
  writeFileSync(backup, JSON.stringify({ file, original }));
  let result;
  try {
    writeFileSync(file, original.replace(target, replacement.replaceAll("\n", eol)));
    result = run(id);
  } finally { restore(); }
  // Collection, import and runtime setup errors do not count as assertion kills.
  const killed = result.exit !== 0 && result.failed > 0 && result.passed > 0
    && result.total === baseline.total && result.runtimeErrors === 0;
  results.push({ id, killed, ...result });
  console.log(`${id}: ${killed ? "KILLED" : "SURVIVED/INCONCLUSIVE"} (${result.failed}/${result.total} failed assertions)`);
}
writeFileSync(resolve(directory, "summary.json"), JSON.stringify({ baseline, results }, null, 2));
if (results.some(r => !r.killed)) process.exitCode = 1;
