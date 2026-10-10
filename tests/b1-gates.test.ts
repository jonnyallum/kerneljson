import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mutationVerdictProblems } from "../scripts/b1/gates.js";
import { REGRESSION_SUITES } from "../scripts/b1/plans.js";

/**
 * Failing fixtures for two CI gate rules (ADR-0023 27.12.15): CON-20, the discover/enforce inventory gate (G4, G5) of
 * scripts/b1/analyse-trace.mjs, and CON-21, the mutation verdicts (G7).
 */
const ids = (prefix: string, n: number, verdict = "KILLED") => Array.from({ length: n }, (_, i) => `${prefix}${i + 1} ${verdict} (1/1 failing) x`).join("\n");
describe("CON-21 mutation verdicts (G7)", () => {
  it("accepts exactly the sealed number of mutations, every one killed", () => {
    expect(mutationVerdictProblems("identity", `${ids("I", 57)}\nALL MUTATIONS KILLED`)).toEqual([]);
    expect(mutationVerdictProblems("faculties", Array.from({ length: 5 }, (_, i) => `F${i + 1}: detected by 2 failed assertions`).join("\n"))).toEqual([]);
    expect(mutationVerdictProblems("identity-cognition", `${ids("C", 50)}\n${ids("P", 12, "KILLED-PRECOMMIT")}\nALL MUTATIONS KILLED`)).toEqual([]);
  });
  it.each([
    ["a suite that did not run", "identity", ""],
    ["a missing mutation id", "identity", `${ids("I", 56)}\nALL MUTATIONS KILLED`],
    ["an extra mutation id", "identity", `${ids("I", 58)}\nALL MUTATIONS KILLED`],
    ["a survivor", "identity", `${ids("I", 56)}\nI57 SURVIVED     (0/3 failing) x\nALL MUTATIONS KILLED`],
    ["an apply failure counted as a kill", "identity", `${ids("I", 56)}\nI57 CANNOT APPLY: expected the target text once\nALL MUTATIONS KILLED`],
    ["an inconclusive run", "identity-cognition", `${ids("C", 61)}\nC62 INCONCLUSIVE (exit 1)\nALL MUTATIONS KILLED`],
    ["no final line", "identity", ids("I", 57)],
    ["a failed baseline", "identity", `BASELINE FAILED: x\n${ids("I", 57)}\nALL MUTATIONS KILLED`],
    ["an unknown suite", "memory", "ALL MUTATIONS KILLED"],
  ])("fails with %s", (_label, id, text) => { expect(mutationVerdictProblems(id, text).length).toBeGreaterThan(0); });
});

describe("CON-27 the CI gate over an empty evidence directory", () => {
  it("refuses the commit, naming every registered suite and gate as missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "kj-b1-gate-empty-"));
    try {
      const R = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
      const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/b1/ci-gate.ts", R, dir], { encoding: "utf8", timeout: 300_000 });
      expect(r.status).toBe(1);
      for (const suite of REGRESSION_SUITES) expect(r.stderr).toContain(`${suite.id}: no result for this suite`);
      for (const line of ["CON-47: collection missing", "G1: did not pass", "G9: did not pass", "EPH-26: did not pass",
        "G7: faculties did not run", "G7: identity did not run", "G7: identity-cognition did not run"]) expect(r.stderr).toContain(line);
      expect(r.stdout).not.toContain("CI gate passed");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
describe("CON-20 the inventory gate over a trace (G4 enforce, G5 discover)", () => {
  const header = JSON.stringify({ kind: "kerneljson:b1-trace/v1", token: { runId: "a".repeat(32), suite: "regression-enforce" }, pid: 1, processId: "00000000-0000-4000-8000-000000000000" });
  const event = (e: Record<string, unknown>) => JSON.stringify({ kind: "use", sequence: 1, role: "kj_worker", caller: "services/kernel/src/x.ts", via: "login",
    classification: "production", test: null, sql: "select 1", fingerprint: "0".repeat(64), sqlstate: null, message: null, ...e });
  const analyse = (lines: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "kj-b1-gate-"));
    try {
      const trace = join(dir, "trace"); mkdirSync(trace);
      writeFileSync(join(trace, "1-x.jsonl"), [header, ...lines].join("\n") + "\n");
      return spawnSync(process.execPath, ["scripts/b1/analyse-trace.mjs", trace, join(dir, "inventory.json"), "--fail-on-refusal"], { encoding: "utf8" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  it("passes production statements inside the manifest", () => {
    expect(analyse([event({ sql: "select id from public.tasks" })]).status).toBe(0);
  });
  it("fails a production operation outside the manifest (a manifest missing a grant the suite uses)", () => {
    const r = analyse([event({ role: "kj_door", sql: "delete from public.task_events" })]);
    expect(r.status).toBe(1); expect(r.stderr).toMatch(/not in the manifest/);
  });
  it("fails a refused production statement", () => {
    const r = analyse([event({ kind: "refused", sql: "select id from public.tasks", sqlstate: "42501", message: "permission denied" })]);
    expect(r.status).toBe(1);
  });
  it("does not count a declared probe, which the refusal multiset accounts for", () => {
    expect(analyse([event({ classification: "probe", test: "probe", sql: "delete from public.task_events", kind: "refused", sqlstate: "42501", message: "denied" })]).status).toBe(0);
  });
});
