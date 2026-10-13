import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CASE_TIMEOUT, ROOT, head, runCase, type RunnerOutcome } from "./support/b1-runner.js";
import { strictJson } from "../services/kernel/src/database/strict-json.js";
import { Release } from "../scripts/b1/release.js";
import { RequiredSchema } from "../scripts/b1/coverage.js";
import { REGRESSION_SUITES } from "../scripts/b1/plans.js";
import { stageTSuiteResult, writeSuiteEvidence } from "../scripts/b1/gate-suite.js";
import { DEFINER_PROBES_FILE, NEGATIVE_FILE, expectedG8Rows, g8SuiteProblems, type JsonSource } from "../scripts/b1/g8.js";
import { FUNCTION_INVENTORY_PATH, parseFunctionInventory } from "../scripts/b1/function-inventory.js";
import { RUNTIME_ROLES } from "../services/kernel/src/database/runtime-roles.js";

/**
 * ADR-0023 27.12.15 stage T refusals, end to end through the ephemeral entry point (lane C). CON-5: a suite that fails,
 * skips, runs nothing or leaves a listed file out of its report; each is a committed change in a throwaway clone of
 * the checkout (never pushed) whose own runner runs it. CON-6 and CON-10: a change made from outside the runner while
 * the suite runs: databases created, copied with TEMPLATE and dropped, a foreign container attached to the run
 * network, the cluster removed. Stage T never changes the status except through L6; each case asserts both.
 */
const docker = (args: string[]) => spawnSync("docker", args, { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
const git = (cwd: string, args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=kj-fixture", "-c", "user.email=fixture@invalid", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const HELPER_FILE = "tests/runtime-roles-coresident-probes.integration.test.ts";
const REGISTRY = "infrastructure/database/b1-runner-hooks.json";
/** A clone of HEAD with committed changes, its node_modules a junction to this checkout's (untracked, ignored). */
function clone(changes: Record<string, (text: string) => string>, regenerateRegistry = false): { dir: string; R: string } {
  const dir = mkdtempSync(join(tmpdir(), "kj-b1-clone-"));
  git(tmpdir(), ["clone", "--quiet", "--no-checkout", ROOT, dir]);
  git(dir, ["checkout", "--quiet", "--detach", head()]);
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "junction");
  for (const [path, edit] of Object.entries(changes)) {
    const before = readFileSync(join(dir, path), "utf8"), after = edit(before);
    if (after === before) throw Error(`fixture edit changed nothing in ${path}`);
    writeFileSync(join(dir, path), after);
  }
  const paths = Object.keys(changes);
  if (regenerateRegistry) {
    const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/b1/build-hook-registry.ts"], { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw Error(`registry: ${r.stderr}`);
    paths.push(REGISTRY);
  }
  git(dir, ["add", "--", ...paths]); git(dir, ["commit", "--quiet", "-m", "stage T fixture"]);
  return { dir, R: git(dir, ["rev-parse", "HEAD"]) };
}
const runClone = (label: string, c: { dir: string; R: string }, profile: "none" | "pinned-helper", suite: string) =>
  runCase(label, profile, [], { suite, cwd: c.dir, release: c.R, entry: join(c.dir, "scripts/b1/ephemeral.ts") });
const stageT = (o: RunnerOutcome) => o.record!.stageT as { outcome: string; problems: string[]; exitCode: number | null };
function expectRegressionFailed(o: RunnerOutcome, pattern: RegExp) {
  expect(o.summary?.status).toBe("REPOSITORY_QUALIFIED");
  expect(o.record!.status).toBe("REPOSITORY_QUALIFIED");
  expect(o.record!.regressionOutcome).toBe("failed");
  expect(stageT(o).outcome).toBe("failed");
  expect(stageT(o).problems.join("\n")).toMatch(pattern);
}
/** The plans.ts argv of one suite replaced, so its registry entry (generated from plans.ts) changes with it. */
const argvFor = (suite: string, files: string, extra: string) => (t: string) =>
  t.replace("argv:vitest(spec.files),", `argv:spec.id===${JSON.stringify(suite)}?[...vitest(${files}),${extra}]:vitest(spec.files),`);

describe("CON-5 a suite that does not run its listed tests completely and successfully", () => {
  it("one failed test: regressionOutcome failed, status unchanged; the CI gate refuses it (CON-11, CON-27)", async () => {
    const c = clone({ [HELPER_FILE]: (t) => t + '\nit("CON-5 fixture: a failing test", () => { expect(1).toBe(2); });\n' });
    const o = await runClone("CON-5 one failed test", c, "pinned-helper", "regression-helper-probes");
    expectRegressionFailed(o, /suite exited 1[\s\S]*REPORT_REFUSED/);
    // The gate's own verification over this genuine record, laid out as CI lays it out.
    const release = new Release(c.dir, c.R);
    const required = RequiredSchema.parse(strictJson(release.blob("tests/b1-required.json").bytes.toString("utf8")));
    const suite = REGRESSION_SUITES.find((x) => x.id === "regression-helper-probes")!;
    const out = mkdtempSync(join(tmpdir(), "kj-b1-gate-evidence-"));
    writeSuiteEvidence(out, o.exitCode, o.summary!);
    const gate = (dir: string, R = c.R, s = suite) => stageTSuiteResult(dir, s, R, release, required, c.dir).problems.map((p) => p.join(": "));
    expect(gate(out).join("\n")).toMatch(/regressionOutcome failed/);
    expect(gate(out, head()).join("\n")).toMatch(/record is for another commit/);
    expect(gate(out, c.R, REGRESSION_SUITES.find((x) => x.id === "regression-probes")!).join("\n")).toMatch(/record names another suite or profile/);
    expect(gate(join(out, "absent"))).toEqual(["regression-helper-probes: no result for this suite"]);
    const recordPath = join(out, "run", "record.json");
    const edited = readFileSync(recordPath, "utf8").replace(/"regressionOutcome":\s*"failed"/, '"regressionOutcome": "passed"');
    expect(edited).toMatch(/"regressionOutcome": "passed"/);
    writeFileSync(recordPath, edited);
    expect(gate(out).join("\n")).toMatch(/emitted record hash differs/);
  }, CASE_TIMEOUT);
  it("a listed file skipped: the skips are not intentional, and the declared probes never ran", async () => {
    const c = clone({ [HELPER_FILE]: (t) => t.replace("describe.each(RUNTIME_ROLES)(", "describe.skip.each(RUNTIME_ROLES)(") });
    const o = await runClone("CON-5 listed file skipped", c, "pinned-helper", "regression-helper-probes");
    expectRegressionFailed(o, /skipped test not an intentional skip/);
    expect(stageT(o).problems.join("\n")).toMatch(/trace refusal multiset differs/);
  }, CASE_TIMEOUT);
  it("zero tests and exit 0: the report holds no tests and not the suite's file", async () => {
    const c = clone({ "scripts/b1/plans.ts": argvFor("regression-helper-probes", "[]", '"--passWithNoTests","tests/kj-con5-absent.test.ts"') }, true);
    const o = await runClone("CON-5 zero tests exit 0", c, "pinned-helper", "regression-helper-probes");
    expectRegressionFailed(o, /report has no tests|suite report missing|report file set differs/);
    expect(stageT(o).exitCode).toBe(0);
  }, CASE_TIMEOUT);
  it("a listed file missing from the report: the file set differs and its collected locations have no entries", async () => {
    const c = clone({ "scripts/b1/plans.ts": argvFor("regression-probes", '["tests/runtime-roles-log-fixture.integration.test.ts"]', '"--passWithNoTests"') }, true);
    const o = await runClone("CON-5 listed file missing", c, "none", "regression-probes");
    expectRegressionFailed(o, /report file set differs from the suite's files/);
    expect(stageT(o).problems.join("\n")).toMatch(/collected location without a report entry: tests\/runtime-roles-negative/);
  }, CASE_TIMEOUT);
});

/**
 * CON-15 and CON-16: an absorbed refusal. The sealed construction removes a manifest grant on a path whose code catches
 * the error; that changes the B1 migration and so its frozen statements digest, and the run would stop at S7 before
 * stage T. The same observable is built here without touching B1: production code (packages/identity withTenant) issues
 * a statement no runtime role may run and swallows the error. CON-15 issues it on the host only, CON-16 only inside the
 * compose worker (the one process with KJ_RUNTIME_ROLE_FIXED), whose image the stack builds from the clone.
 */
const absorbed = (where: "host" | "worker") => (t: string) => t.replace(
  " const db=await pool.connect();try{\n  await db.query(\"begin\");const context=await authorize(db,raw,permission);",
  ` if(${where === "worker" ? "" : "!"}process.env["KJ_RUNTIME_ROLE_FIXED"]) await pool.query("select rolpassword from pg_catalog.pg_authid limit 1").catch(()=>undefined);\n` +
  " const db=await pool.connect();try{\n  await db.query(\"begin\");const context=await authorize(db,raw,permission);");
function expectAbsorbedRefusalCaught(o: RunnerOutcome, gate: "G4") {
  expectRegressionFailed(o, /a production statement was refused/);
  const problems = stageT(o).problems.join("\n");
  expect(problems).toContain(`trace inventory gate (${gate}) failed`);
  expect(problems).toMatch(/log refusal projection differs/);
}
describe("CON-15 and CON-16 an absorbed production refusal", () => {
  it("CON-15 on the host, in an enforce suite: the trace records it, G4 fails and the log check fails", async () => {
    const c = clone({ "packages/identity/src/index.ts": absorbed("host") });
    const o = await runClone("CON-15 absorbed refusal on the host", c, "none", "regression-gated");
    expectAbsorbedRefusalCaught(o, "G4");
  }, 2 * CASE_TIMEOUT);
  it("CON-16 inside the compose worker: the container's trace records it and the log check fails", async () => {
    const c = clone({ "packages/identity/src/index.ts": absorbed("worker") });
    const o = await runClone("CON-16 absorbed refusal in the worker", c, "none", "regression-stack");
    expectAbsorbedRefusalCaught(o, "G4");
  }, 4 * CASE_TIMEOUT);
});

/** Watch for this run's cluster, then for its stage T working directory (the suite is about to start), then act. */
async function duringStageT(run: Promise<RunnerOutcome>, change: (container: string, runId: string) => boolean): Promise<boolean> {
  const before = new Set(docker(["ps", "-aq", "--filter", "label=kj.b1.ephemeral.run"]));
  let finished = false, container = "", runId = "";
  void run.then(() => { finished = true; }, () => { finished = true; });
  for (const deadline = Date.now() + CASE_TIMEOUT; Date.now() < deadline && !finished;) {
    if (!container) {
      const fresh = docker(["ps", "-q", "--filter", "label=kj.b1.ephemeral.run"]).filter((id) => !before.has(id));
      if (fresh.length === 1) {
        container = fresh[0]!;
        runId = spawnSync("docker", ["inspect", "--format", '{{index .Config.Labels "kj.b1.ephemeral.run"}}', container], { encoding: "utf8" }).stdout.trim();
      }
    } else if (readdirSync(tmpdir()).some((d) => d.startsWith(`kj-b1-t-${runId}-`))) return change(container, runId);
    await Promise.race([run, new Promise((r) => setTimeout(r, 25))]);
  }
  return false;
}
const psql = (container: string, sql: string) => spawnSync("docker", ["exec", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).status === 0;

describe("CON-6 and CON-10 changes made during stage T", () => {
  it("CON-6 databases created, copied with TEMPLATE and a planned one dropped: the post-T database list fails", async () => {
    const run = runCase("CON-6 databases changed during stage T", "pinned-helper", [], { suite: "regression-helper-probes" });
    const induced = await duringStageT(run, (c) => psql(c, "create database kj_induced_extra") &&
      psql(c, "create database kj_induced_copy template template1") && psql(c, "drop database kj_b1_helper with (force)"));
    const o = await run;
    expect(induced).toBe(true);
    expectRegressionFailed(o, /post-T database list differs/);
    expect((o.record!.stageT as { databases: string[] }).databases).toEqual(expect.arrayContaining(["kj_induced_extra", "kj_induced_copy"]));
    expect((o.record!.stageT as { databases: string[] }).databases).not.toContain("kj_b1_helper");
  }, CASE_TIMEOUT);
  it("CON-10 a foreign container attached to the run network: the post-T network check fails", async () => {
    let foreign = "";
    const run = runCase("CON-10 foreign container during stage T", "pinned-helper", [], { suite: "regression-helper-probes" });
    const induced = await duringStageT(run, (_c, runId) => {
      const r = spawnSync("docker", ["run", "-d", "--network", `kj-eph-${runId}`, "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
        "postgres@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929"], { encoding: "utf8" });
      foreign = r.stdout.trim(); return r.status === 0;
    });
    const o = await run;
    if (foreign) spawnSync("docker", ["rm", "-f", foreign]);
    const runId = o.record?.header.runId;
    if (runId) spawnSync("docker", ["network", "rm", `kj-eph-${runId}`]);
    expect(induced).toBe(true);
    // The post-T network check fails regressionOutcome (27.12.15). The foreign container is still attached at L6, which
    // the runner never touches, so removing the run network fails and the status is NOT_QUALIFIED as well.
    expect(o.record!.regressionOutcome).toBe("failed");
    expect(stageT(o).problems.join("\n")).toMatch(/foreign container on the run network/);
    expect(o.record!.events.filter((e) => e.step === "L3").map((e) => e.outcome)).not.toContain("refused");
    expect(o.record!.events.find((e) => e.step === "L6")).toMatchObject({ outcome: "refused" });
    expect(o.summary?.status).toBe("NOT_QUALIFIED");
  }, CASE_TIMEOUT);
  it("CON-10 the cluster removed during stage T: L6 fails and the status is NOT_QUALIFIED", async () => {
    const run = runCase("CON-10 cluster removed during stage T", "pinned-helper", [], { suite: "regression-helper-probes" });
    const induced = await duringStageT(run, (c) => spawnSync("docker", ["rm", "-f", c]).status === 0);
    const o = await run;
    expect(induced).toBe(true);
    expect(o.summary?.status).toBe("NOT_QUALIFIED");
    expect(o.record!.regressionOutcome).not.toBe("passed");
    expect(o.record!.events.filter((e) => e.step === "L6").map((e) => e.outcome)).not.toContain("passed");
  }, CASE_TIMEOUT);
});

/**
 * CON-30, the G8 half, end to end (ADR-0023 27.12.15 gate table "B1 evidence files": written in the suite's working
 * directory, collected by the runner with SHA-256s; every row present and passed). A genuine regression-probes run at
 * HEAD records both evidence files with their digests in the record; the gate's verification accepts them, and refuses
 * a copy edited after the run. A throwaway clone whose negative test writes one row fewer (the committed test is never
 * changed) is refused by the runner itself: regressionOutcome failed, status unchanged.
 */
const NEGATIVE_TEST = "tests/runtime-roles-negative.integration.test.ts";

/**
 * KJ-P8 B1 A10.7 v7 R3 (local candidate, not sealed): the exact failure signature of an N4 stage T equality refusal, so
 * an N4 case passes only when the frozen negative test's inventory equality failed and nothing else did:
 * - the run is sound: a record for R and this suite, every L and S step passed (L6 included), REPOSITORY_QUALIFIED;
 * - the suite exited 1, and the stage T problems are exactly the suite exit, the unsuccessful report and a missing G8
 *   row for every expected function row of both roles at R; no other problem, and no other row missing;
 * - the report, bound to the record by its SHA-256, has exactly the two failed function tests (one per role), each
 *   failing at the equality (line 101 of the frozen test), and every other test passed;
 * - the claimed edit is the release's own inventory change: "inventoryOnly" is what the committed inventory at R lists
 *   and the base (the commit the fixture was cut from, whose inventory equals the catalogue: the unmodified controls)
 *   does not, "catalogueOnly" the reverse;
 * - each equality failure in the digest-bound report compares a catalogue of the base's size with an inventory of R's
 *   size, which separates an added (N4a), removed (N4b) and changed (N4c) identity by count;
 * - the suite output's diff lists exactly those release-derived identities: "- " for inventoryOnly, "+ " for
 *   catalogueOnly. The output is read from the run's working directory; unlike the report it is not digest-bound in
 *   the record, so it corroborates the identities and never establishes one (R3-H1).
 * Returns every difference; empty means the signature holds. An absent record or stage T result is a difference.
 */
export interface InventoryEdit { inventoryOnly: string[]; catalogueOnly: string[] }
const EQUALITY_TEST = "every function outside the manifest is not executable";
const EQUALITY_COUNTS = /^AssertionError: expected \[ \u2026\((\d+)\) \] to deeply equal \[ \u2026\((\d+)\) \]\n/;
const inventoryAt = (s: JsonSource) => parseFunctionInventory(s.json(FUNCTION_INVENTORY_PATH)).functions;
const editLines = (e: InventoryEdit) => [...e.inventoryOnly.map((i) => `- ${JSON.stringify(i)}`), ...e.catalogueOnly.map((i) => `+ ${JSON.stringify(i)}`)].sort();
interface Report { testResults: { name: string; assertionResults: { fullName: string; status: string; failureMessages: string[] }[] }[] }
export function equalityRefusalProblems(o: RunnerOutcome, release: JsonSource, base: JsonSource, R: string, suite: string, edit: InventoryEdit): string[] {
  const p: string[] = [], r = o.record;
  if (!o.summary || !r) return ["no runner record"];
  if (r.header.R !== R || r.header.regressionSuite !== suite) p.push(`record is for ${r.header.R} ${String(r.header.regressionSuite)}`);
  if (o.summary.status !== "REPOSITORY_QUALIFIED" || r.status !== "REPOSITORY_QUALIFIED") p.push(`status ${o.summary.status}, record ${r.status}`);
  const steps = r.events.map((e) => `${e.step} ${e.outcome}`), notPassed = steps.filter((s) => !s.endsWith(" passed"));
  if (notPassed.length || !steps.includes("L6 passed")) p.push(`runner steps not all passed: ${notPassed.join(", ") || "no L6"}`);
  if (r.regressionOutcome !== "failed") p.push(`regressionOutcome ${r.regressionOutcome}`);
  const t = r.stageT as { outcome?: unknown; problems?: unknown; exitCode?: unknown; reportSha256?: unknown; workingDirectory?: unknown };
  if (!Array.isArray(t.problems) || typeof t.workingDirectory !== "string") return [...p, "no stage T result"];
  if (t.outcome !== "failed" || t.exitCode !== 1) p.push(`stage T ${String(t.outcome)}, exit ${String(t.exitCode)}`);
  const functionRows = [...expectedG8Rows(release).negative].filter(([, v]) => v.kind === "function").map(([k]) => `G8 evidence ${NEGATIVE_FILE}: missing row ${k}`);
  for (const role of RUNTIME_ROLES) if (!functionRows.some((m) => m.includes(JSON.stringify(role)))) p.push(`no expected function row for ${role}`);
  const want = ["suite exited 1", "REPORT_REFUSED: unsuccessful report", ...functionRows], got = (t.problems as unknown[]).map(String);
  for (const x of got.filter((x) => !want.includes(x))) p.push(`unexpected stage T problem: ${x.slice(0, 300)}`);
  for (const x of want.filter((x) => !got.includes(x))) p.push(`expected stage T problem absent: ${x.slice(0, 300)}`);
  if (new Set(got).size !== got.length) p.push("a stage T problem is repeated");
  const atR = inventoryAt(release), atBase = inventoryAt(base);
  const derived = editLines({ inventoryOnly: atR.filter((f) => !atBase.includes(f)), catalogueOnly: atBase.filter((f) => !atR.includes(f)) });
  if (!derived.length) p.push("the release does not change the committed inventory");
  if (JSON.stringify(editLines(edit)) !== JSON.stringify(derived)) p.push(`claimed edit ${editLines(edit).join(" ") || "nothing"} is not the release's inventory change ${derived.join(" ") || "nothing"}`);
  const reportPath = join(t.workingDirectory, "report.json");
  if (!existsSync(reportPath)) return [...p, "suite report absent"];
  const raw = readFileSync(reportPath);
  if (createHash("sha256").update(raw).digest("hex") !== t.reportSha256) p.push("suite report differs from the recorded digest");
  const failed: string[] = [];
  for (const f of (JSON.parse(raw.toString("utf8")) as Report).testResults) {
    const file = f.name.replaceAll("\\", "/").split("/").slice(-2).join("/");
    for (const a of f.assertionResults) {
      if (a.status === "passed") continue;
      const m = a.failureMessages;
      if (a.status === "failed" && file === NEGATIVE_TEST && m.length === 1 && m[0]!.startsWith("AssertionError: expected [")
        && m[0]!.includes("to deeply equal") && m[0]!.includes("runtime-roles-negative.integration.test.ts:101:")) {
        failed.push(a.fullName);
        const n = EQUALITY_COUNTS.exec(m[0]!);
        if (!n || Number(n[1]) !== atBase.length || Number(n[2]) !== atR.length)
          p.push(`${a.fullName} compares ${n ? `${n[1]} with ${n[2]}` : "unreadable counts"}, not the base's ${atBase.length} with R's ${atR.length}`);
      } else p.push(`test not passed other than at the equality: ${file} ${a.fullName} (${a.status})`);
    }
  }
  const wantFailed = RUNTIME_ROLES.map((role) => `B1 forbidden powers: ${role} ${EQUALITY_TEST}`);
  if (failed.length !== wantFailed.length || wantFailed.some((n) => !failed.includes(n))) p.push(`equality failures: ${failed.join("; ") || "none"}`);
  const outputPath = join(t.workingDirectory, "suite-output.log");
  const lines = existsSync(outputPath) ? readFileSync(outputPath, "utf8").split(/\r?\n/) : [];
  for (const role of RUNTIME_ROLES)
    if (!lines.some((l) => l.includes("FAIL") && l.includes(`> B1 forbidden powers: ${role} > ${EQUALITY_TEST}`))) p.push(`suite output has no failure line for ${role}`);
  const shown = [...new Set(lines.map((l) => /^\s*([-+])\s+(".*"),?\s*$/.exec(l)).filter((x) => x !== null).map((x) => `${x[1]} ${x[2]}`))].sort();
  if (!editLines(edit).length) p.push("no edited identity named");
  if (JSON.stringify(shown) !== JSON.stringify(derived)) p.push(`suite output diff shows ${shown.join(" ") || "nothing"}, not ${derived.join(" ")}`);
  return p;
}
/** The base is the commit the clone was cut from: R's only parent, and HEAD of this checkout. */
const expectEqualityRefusal = (o: RunnerOutcome, c: { dir: string; R: string }, suite: string, edit: InventoryEdit) => {
  expect(git(c.dir, ["rev-parse", `${c.R}^@`])).toBe(head());
  expect(equalityRefusalProblems(o, new Release(c.dir, c.R), new Release(ROOT, head()), c.R, suite, edit)).toEqual([]);
};

/**
 * R3-H1 (hostile review of dde65ca): suite-output.log is not digest-bound, so rewriting its diff once named any
 * identity the caller claimed, one never exercised included. A run of each N4 shape is rebuilt here without Docker
 * from HEAD's authorities with the clone's inventory edit, its report bound by SHA-256 as the runner binds it; the
 * rebuilt run is accepted, and every substitution of the output (with the claim made to match it) is refused.
 */
describe("R3-H1 a substituted suite output cannot establish an edited identity", () => {
  const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  const R = "0".repeat(40), PHANTOM = "kernel_private.kj_r3_h1_phantom(pg_catalog.int4)";
  type Shape = "N4a" | "N4b" | "N4c";
  /** Read at the first test, not at collection: Release refuses a checkout with tracked changes. */
  let fixture: { base: Release; atBase: string[]; nonManifest: string[]; retyped: string; shapes: Record<Shape, InventoryEdit> } | undefined;
  const f = () => fixture ??= (() => {
    const base = new Release(ROOT, head()), atBase = inventoryAt(base), nonManifest = atBase.filter((x) => !x.startsWith("kernel_private.identity_"));
    const target = nonManifest.find((x) => x.includes("pg_catalog.text"))!, retyped = target.replace("pg_catalog.text", "pg_catalog.bytea");
    return { base, atBase, nonManifest, retyped, shapes: {
      N4a: { inventoryOnly: ["kernel_private.kj_b1_e2_extra(pg_catalog.int4)"], catalogueOnly: [] },
      N4b: { inventoryOnly: [], catalogueOnly: [nonManifest[0]!] },
      N4c: { inventoryOnly: [retyped], catalogueOnly: [target] } } };
  })();
  /** The release at R: HEAD's authorities with the committed inventory edited. */
  const releaseFor = (e: InventoryEdit): JsonSource => ({ json: (path) => path !== FUNCTION_INVENTORY_PATH ? f().base.json(path)
    : { ...(f().base.json(path) as object), functions: [...f().atBase.filter((x) => !e.catalogueOnly.includes(x)), ...e.inventoryOnly].sort(byteOrder) } });
  /** A run as the runner records it: the report and the output in its working directory, the report's digest in the record. */
  function run(e: InventoryEdit, output = (lines: string[]) => lines) {
    const release = releaseFor(e), atR = inventoryAt(release), n = f().atBase.length, dir = mkdtempSync(join(tmpdir(), "kj-r3-h1-"));
    const at = `${dir}/tests/runtime-roles-negative.integration.test.ts`;
    const counts = `AssertionError: expected [ \u2026(${n}) ] to deeply equal [ \u2026(${atR.length}) ]`;
    const report = Buffer.from(JSON.stringify({ testResults: [{ name: at, assertionResults: [
      ...RUNTIME_ROLES.map((role) => ({ fullName: `B1 forbidden powers: ${role} ${EQUALITY_TEST}`, status: "failed", failureMessages: [`${counts}\n    at ${at}:101:116`] })),
      { fullName: "B1 role separation probe", status: "passed", failureMessages: [] }] }] }));
    writeFileSync(join(dir, "report.json"), report);
    writeFileSync(join(dir, "suite-output.log"), output([
      ...RUNTIME_ROLES.map((role) => ` FAIL  tests/runtime-roles-negative.integration.test.ts:95 > B1 forbidden powers: ${role} > ${EQUALITY_TEST}`),
      counts, "- Expected", "+ Received", "",
      ...e.inventoryOnly.map((x) => `-   ${JSON.stringify(x)},`), ...e.catalogueOnly.map((x) => `+   ${JSON.stringify(x)},`)]).join("\n"));
    const rows = [...expectedG8Rows(release).negative].filter(([, v]) => v.kind === "function").map(([k]) => `G8 evidence ${NEGATIVE_FILE}: missing row ${k}`);
    const record = { header: { R, regressionSuite: "regression-probes" }, status: "REPOSITORY_QUALIFIED", regressionOutcome: "failed",
      events: [{ step: "S7", outcome: "passed" }, { step: "L6", outcome: "passed" }],
      stageT: { outcome: "failed", exitCode: 1, workingDirectory: dir, reportSha256: createHash("sha256").update(report).digest("hex"),
        problems: ["suite exited 1", ...rows, "REPORT_REFUSED: unsuccessful report"] } };
    return { o: { exitCode: 0, stdout: "", stderr: "", summary: { status: "REPOSITORY_QUALIFIED" }, record } as unknown as RunnerOutcome, release };
  }
  const check = (e: InventoryEdit, claim: InventoryEdit, output?: (lines: string[]) => string[]) => {
    const { o, release } = run(e, output);
    return equalityRefusalProblems(o, release, f().base, R, "regression-probes", claim);
  };
  const phantomOutput = (lines: string[]) => lines.map((l) => l.replace(/^([-+])\s+".*",$/, `$1   ${JSON.stringify(PHANTOM)},`));

  it.each(["N4a", "N4b", "N4c"] as const)("%s rebuilt is accepted, and the claim must be the release's own edit", (shape) => {
    const e = f().shapes[shape];
    expect(check(e, e)).toEqual([]);
    expect(check(e, { inventoryOnly: e.catalogueOnly, catalogueOnly: e.inventoryOnly }).join("\n")).toMatch(/claimed edit .* is not the release's inventory change/);
  });
  it("the review's attack: the output's diff rewritten to a phantom identity and the claim made to match is refused", () => {
    const real = JSON.stringify(f().shapes.N4a.inventoryOnly[0]), p = check(f().shapes.N4a, { inventoryOnly: [PHANTOM], catalogueOnly: [] }, phantomOutput);
    expect(p).toContain(`claimed edit - ${JSON.stringify(PHANTOM)} is not the release's inventory change - ${real}`);
    expect(p).toContain(`suite output diff shows - ${JSON.stringify(PHANTOM)}, not - ${real}`);
  });
  it.each([
    ["a phantom catalogue identity on N4b", "N4b", () => ({ inventoryOnly: [], catalogueOnly: [PHANTOM] }), () => phantomOutput],
    ["a real but unedited identity claimed on N4b", "N4b", () => ({ inventoryOnly: [], catalogueOnly: [f().nonManifest[1]!] }),
      () => (l: string[]) => l.map((x) => x.replace(JSON.stringify(f().nonManifest[0]), JSON.stringify(f().nonManifest[1])))],
    ["one side of N4c dropped from the output and the claim", "N4c", () => ({ inventoryOnly: [f().retyped], catalogueOnly: [] }),
      () => (l: string[]) => l.filter((x) => !x.startsWith("+   "))],
    ["a phantom named beside the real N4a identity", "N4a", () => ({ inventoryOnly: [...f().shapes.N4a.inventoryOnly, PHANTOM], catalogueOnly: [] }),
      () => (l: string[]) => [...l, `-   ${JSON.stringify(PHANTOM)},`]],
  ] as const)("%s is refused", (_name, shape, claim, output) => {
    expect(check(f().shapes[shape], claim(), output()).join("\n")).toMatch(/claimed edit .* is not the release's inventory change/);
  });
  it("the report's counts must be the base's and R's: a run of another shape is refused", () => {
    const n = f().atBase.length, n4c = f().shapes.N4c, { o } = run(f().shapes.N4a);
    expect(equalityRefusalProblems(o, releaseFor(n4c), f().base, R, "regression-probes", n4c).join("\n")).toContain(
      `B1 forbidden powers: kj_door ${EQUALITY_TEST} compares ${n} with ${n + 1}, not the base's ${n} with R's ${n}`);
  });
});

describe("CON-30 G8 evidence collected by the runner with SHA-256s", () => {
  it("a genuine run records both evidence files; the gate verifies them and refuses a copy edited after the run", async () => {
    const o = await runCase("CON-30 G8 evidence recorded", "none", [], { suite: "regression-probes" });
    expect(o.record!.status).toBe("REPOSITORY_QUALIFIED");
    expect(o.record!.regressionOutcome).toBe("passed");
    const recorded = (o.record!.stageT as { evidence: { path: string; sha256: string }[] }).evidence;
    expect(recorded.map((e) => e.path)).toEqual([DEFINER_PROBES_FILE, NEGATIVE_FILE]);
    const release = new Release(ROOT, head());
    const required = RequiredSchema.parse(strictJson(release.blob("tests/b1-required.json").bytes.toString("utf8")));
    const suite = REGRESSION_SUITES.find((x) => x.id === "regression-probes")!;
    const out = mkdtempSync(join(tmpdir(), "kj-b1-g8-evidence-"));
    writeSuiteEvidence(out, o.exitCode, o.summary!);
    const verified = stageTSuiteResult(out, suite, head(), release, required, ROOT);
    expect(verified.problems).toEqual([]);
    expect(g8SuiteProblems(suite.id, verified.evidence!, expectedG8Rows(release), head()).problems).toEqual([]);
    const file = join(out, "stage-t", NEGATIVE_FILE), v = JSON.parse(readFileSync(file, "utf8")) as { results: unknown[] };
    v.results.splice(5, 1);
    writeFileSync(file, JSON.stringify(v, null, 2) + "\n");
    const after = stageTSuiteResult(out, suite, head(), release, required, ROOT).problems.map((p) => p.join(": "));
    expect(after).toContain(`G8: regression-probes ${NEGATIVE_FILE}: differs from the recorded digest`);
  }, CASE_TIMEOUT);
  it("evidence missing a row the test lists: the runner refuses it itself, regressionOutcome failed, status unchanged", async () => {
    const c = clone({ [NEGATIVE_TEST]: (t) => t.replace(
      'JSON.stringify({ contract: "kerneljson:b1-negative-probes/v1", results }, null, 2)',
      'JSON.stringify({ contract: "kerneljson:b1-negative-probes/v1", results: results.slice(1) }, null, 2)') });
    const o = await runClone("CON-30 G8 evidence row missing", c, "none", "regression-probes");
    expectRegressionFailed(o, /G8 evidence artifacts\/local\/b1-negative-probes\.json: missing row /);
  }, CASE_TIMEOUT);
  it("E2 stage T catalogue equality: a committed function inventory listing a function the catalogue lacks fails the negative test, and G8 refuses", async () => {
    // Draft A10.7 (not sealed): the negative test fails unless the live function set under the shared predicate equals
    // the committed inventory, so enumeration cannot shrink or grow silently; the runner's G8 expects the extra rows.
    const extra = "kernel_private.kj_b1_e2_extra(pg_catalog.int4)";
    const c = clone({ "infrastructure/database/b1-function-inventory.json": (t) => {
      const v = JSON.parse(t) as { functions: string[] }; v.functions = [...v.functions, extra].sort();
      return JSON.stringify(v, null, 2) + "\n";
    } });
    const o = await runClone("E2 function inventory extra", c, "none", "regression-probes");
    expectRegressionFailed(o, /suite exited 1/);
    expect(stageT(o).problems.join("\n")).toContain(`G8 evidence artifacts/local/b1-negative-probes.json: missing row ${JSON.stringify(["kj_door", "function outside manifest", `has_function_privilege(${extra})`])}`);
    expectEqualityRefusal(o, c, "regression-probes", { inventoryOnly: [extra], catalogueOnly: [] });
  }, CASE_TIMEOUT);
  /**
   * KJ-P8 B1 A10.7 v7 (local candidate, not sealed) N4a-N4c with the sealed B1: the committed inventory alone is
   * edited (UTF-8 byte order kept, so the static contract and committedFunctionInventory() still parse it). The
   * equality throws before any function row is appended, so G8 reports MISSING rows (1.5b). Each of N4a-N4c runs in
   * both twins (R3), and each instance must show the exact failure signature (equalityRefusalProblems) and nothing
   * else. Unexpected-row rejection is the controlled-evidence unit case N10a in tests/b1-gates.test.ts.
   */
  const inventoryEdit = (edit: (functions: string[]) => string[]) => (t: string) => {
    const v = JSON.parse(t) as { functions: string[] };
    v.functions = edit(v.functions).sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
    return JSON.stringify(v, null, 2) + "\n";
  };
  const MANIFEST_PREFIX = "kernel_private.identity_";
  const missingRow = (fn: string) => `G8 evidence artifacts/local/b1-negative-probes.json: missing row ${JSON.stringify(["kj_door", "function outside manifest", `has_function_privilege(${fn})`])}`;
  const committed = () => (JSON.parse(readFileSync(join(ROOT, "infrastructure/database/b1-function-inventory.json"), "utf8")) as { functions: string[] }).functions;
  /** N4b: one catalogued non-manifest identity removed from the committed inventory; another such identity is kept. */
  const n4b = () => {
    const inv = committed(), removed = inv.find((f) => !f.startsWith(MANIFEST_PREFIX))!;
    return { removed, kept: inv.find((f) => f !== removed && !f.startsWith(MANIFEST_PREFIX))! };
  };
  /** N4c: one committed non-manifest identity with a text argument re-typed to bytea. */
  const n4c = () => {
    const target = committed().find((f) => !f.startsWith(MANIFEST_PREFIX) && f.includes("pg_catalog.text"))!;
    return { target, changed: target.replace("pg_catalog.text", "pg_catalog.bytea") };
  };
  it("N4a discover twin: a committed function inventory listing a function the catalogue lacks fails regression-probes-discover, and G8 refuses", async () => {
    const extra = "kernel_private.kj_b1_e2_extra(pg_catalog.int4)";
    const c = clone({ "infrastructure/database/b1-function-inventory.json": inventoryEdit((f) => [...f, extra]) });
    const o = await runClone("A10.7 N4a discover", c, "none", "regression-probes-discover");
    expectRegressionFailed(o, /suite exited 1/);
    expect(stageT(o).problems.join("\n")).toContain(missingRow(extra));
    expectEqualityRefusal(o, c, "regression-probes-discover", { inventoryOnly: [extra], catalogueOnly: [] });
  }, CASE_TIMEOUT);
  it("N4b a committed inventory missing a catalogued non-manifest function fails the equality; G8 reports missing rows", async () => {
    const { removed, kept } = n4b();
    const c = clone({ "infrastructure/database/b1-function-inventory.json": inventoryEdit((f) => f.filter((x) => x !== removed)) });
    const o = await runClone("A10.7 N4b missing", c, "none", "regression-probes");
    expectRegressionFailed(o, /suite exited 1/);
    expect(stageT(o).problems.join("\n")).toContain(missingRow(kept));
    expectEqualityRefusal(o, c, "regression-probes", { inventoryOnly: [], catalogueOnly: [removed] });
  }, CASE_TIMEOUT);
  it("N4b discover twin: a committed inventory missing a catalogued non-manifest function fails regression-probes-discover; G8 reports missing rows", async () => {
    const { removed, kept } = n4b();
    const c = clone({ "infrastructure/database/b1-function-inventory.json": inventoryEdit((f) => f.filter((x) => x !== removed)) });
    const o = await runClone("A10.7 N4b discover", c, "none", "regression-probes-discover");
    expectRegressionFailed(o, /suite exited 1/);
    expect(stageT(o).problems.join("\n")).toContain(missingRow(kept));
    expectEqualityRefusal(o, c, "regression-probes-discover", { inventoryOnly: [], catalogueOnly: [removed] });
  }, CASE_TIMEOUT);
  it("N4c one committed identity changed (an argument type altered) fails the equality; G8 reports missing rows", async () => {
    const { target, changed } = n4c();
    const c = clone({ "infrastructure/database/b1-function-inventory.json": inventoryEdit((f) => f.map((x) => (x === target ? changed : x))) });
    const o = await runClone("A10.7 N4c changed", c, "none", "regression-probes");
    expectRegressionFailed(o, /suite exited 1/);
    expect(stageT(o).problems.join("\n")).toContain(missingRow(changed));
    expectEqualityRefusal(o, c, "regression-probes", { inventoryOnly: [changed], catalogueOnly: [target] });
  }, CASE_TIMEOUT);
  it("N4c discover twin: one committed identity changed (an argument type altered) fails regression-probes-discover; G8 reports missing rows", async () => {
    const { target, changed } = n4c();
    const c = clone({ "infrastructure/database/b1-function-inventory.json": inventoryEdit((f) => f.map((x) => (x === target ? changed : x))) });
    const o = await runClone("A10.7 N4c discover", c, "none", "regression-probes-discover");
    expectRegressionFailed(o, /suite exited 1/);
    expect(stageT(o).problems.join("\n")).toContain(missingRow(changed));
    expectEqualityRefusal(o, c, "regression-probes-discover", { inventoryOnly: [changed], catalogueOnly: [target] });
  }, CASE_TIMEOUT);
});
