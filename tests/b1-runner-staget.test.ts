import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CASE_TIMEOUT, ROOT, head, runCase, type RunnerOutcome } from "./support/b1-runner.js";

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
  it("one failed test: regressionOutcome failed, status unchanged", async () => {
    const c = clone({ [HELPER_FILE]: (t) => t + '\nit("CON-5 fixture: a failing test", () => { expect(1).toBe(2); });\n' });
    const o = await runClone("CON-5 one failed test", c, "pinned-helper", "regression-helper-probes");
    expectRegressionFailed(o, /suite exited 1[\s\S]*REPORT_REFUSED/);
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
    expectRegressionFailed(o, /foreign container on the run network/);
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
