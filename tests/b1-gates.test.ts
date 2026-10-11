import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { mutationVerdictProblems } from "../scripts/b1/gates.js";
import { REGRESSION_SUITES } from "../scripts/b1/plans.js";
import { strictJson } from "../services/kernel/src/database/strict-json.js";
import {
  DEFINERS_FILE, DEFINER_PROBES_FILE, FUNCTION_PROBE, NEGATIVE_FILE, STATE_ROWS, collectLocalEvidence, expectedG8Rows, functionRowTwinProblems,
  g8SuiteProblems, verifyRecordedEvidence, type EvidenceEntry,
} from "../scripts/b1/g8.js";

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
        "G7: faculties did not run", "G7: identity did not run", "G7: identity-cognition did not run",
        "G8: regression-probes artifacts/local/b1-negative-probes.json: not verified against this run's record",
        "G8: regression-probes-discover artifacts/local/b1-definer-probes.json: not verified against this run's record",
        "G8: regression-definers-discover artifacts/local/b1-definers.json: not verified against this run's record"]) expect(r.stderr).toContain(line);
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

/**
 * CON-30, the G8 half (ADR-0023 27.12.15 gate table and "B1 evidence rows": evidence files collected by the runner with
 * SHA-256s; every row their test lists present and passed), for the primary suites and their discover twins, through the
 * functions the runner (stage-t.ts) and the CI gate (gate-suite.ts, ci-gate.ts) share. The good fixture is synthesised
 * from the expected rows at this checkout, so it holds exactly the rows the probe tables, the manifest, the relation
 * inventory and tests/b1-required.json list. "re-recorded" means the digest list is recomputed after the edit (an
 * adversary who also rewrites the record), so the row check is exercised on its own.
 */
const source = { json: (path: string) => strictJson(readFileSync(path, "utf8")) };
const EXPECTED = expectedG8Rows(source);
const R0 = "e".repeat(40);
const FUNCTION_ROWS: [string, string][] = [
  ["kj_worker", "kernel_private.activate_release(pg_catalog.uuid, pg_catalog.text, pg_catalog.int8, pg_catalog.jsonb)"],
  ["kj_worker", "kernel_private.set_identity_freeze(pg_catalog.uuid, pg_catalog.bool, pg_catalog.text)"],
  ["kj_door", "kernel_private.activate_release(pg_catalog.uuid, pg_catalog.text, pg_catalog.int8, pg_catalog.jsonb)"],
  ["kj_door", "kernel_private.set_identity_freeze(pg_catalog.uuid, pg_catalog.bool, pg_catalog.text)"],
];
type Row = Record<string, unknown>;
function goodEvidence(): Record<string, { contract: string; results?: Row[]; fixtures?: Row[]; [k: string]: unknown }> {
  const negative: Row[] = [...EXPECTED.negative].map(([id, e]) => {
    const [role, probe, sql] = JSON.parse(id) as string[];
    return { role, probe, sql, expected: e.expected, observed: e.kind === "grant" ? "OK" : e.expected, pass: true };
  });
  for (const [role, fn] of FUNCTION_ROWS) negative.push({ role, probe: FUNCTION_PROBE, sql: `has_function_privilege(${fn})`, expected: "false", observed: "false", pass: true });
  const probes: Row[] = [...EXPECTED.definerProbes.values()].map((e) => {
    const probe = e.sql === null ? STATE_ROWS.find(([n]) => n === e.row)![1] : JSON.parse([...EXPECTED.definerProbes].find(([, v]) => v === e)![0])[2];
    if (e.sql !== null) return { role: e.role, row: e.row, probe, sql: e.sql, expected: e.expected, observed: e.expected, stateUnchanged: true, pass: true };
    return { role: e.role, row: e.row, probe, observed: e.row === 27 ? [{ epoch: "7" }] : { epoch: "7", persisted: "2026-10-10 18:19:41+00", recent: true }, pass: true };
  });
  return {
    [NEGATIVE_FILE]: { contract: "kerneljson:b1-negative-probes/v1", results: negative },
    [DEFINER_PROBES_FILE]: { contract: "kerneljson:b1-definer-probes/v1", design: "424f85c283a543ba00a650ecc2ecc3a4346623df", results: probes },
    [DEFINERS_FILE]: { contract: "kerneljson:b1-definer-qualification/v1", design: EXPECTED.designSha, testedCommit: R0, environment: "fixture",
      fixtures: EXPECTED.fixtures.map((fixture) => ({ fixture, expected: "fragment", observedProblems: ["x fragment y"], failedOnPurpose: true, restored: true })) },
  };
}
/** A stage T working directory of one suite with the good files, and the digest list the runner records for it. */
function suiteDir(suite: string, edit: (files: ReturnType<typeof goodEvidence>) => void = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "kj-b1-g8-"));
  const files = goodEvidence();
  edit(files);
  mkdirSync(join(dir, "artifacts", "local"), { recursive: true });
  const wanted = suite.startsWith("regression-probes") ? [NEGATIVE_FILE, DEFINER_PROBES_FILE] : [DEFINERS_FILE];
  for (const f of wanted) writeFileSync(join(dir, f), JSON.stringify(files[f], null, 2) + "\n");
  return { dir, entries: collectLocalEvidence(dir, suite).entries };
}
const write = (dir: string, file: string, change: (v: { results?: Row[]; fixtures?: Row[]; [k: string]: unknown }) => void) => {
  const v = JSON.parse(readFileSync(join(dir, file), "utf8"));
  change(v);
  writeFileSync(join(dir, file), JSON.stringify(v, null, 2) + "\n");
};
/** The gate's G8 verdict on one suite directory: digests against the record, then every row. */
function gate(suite: string, dir: string, entries: unknown, R = R0) {
  const v = verifyRecordedEvidence(dir, entries, suite);
  const rows = g8SuiteProblems(suite, v.files, EXPECTED, R);
  return { problems: [...v.problems, ...rows.problems], functionRows: rows.functionRows };
}
const reRecorded = (suite: string, dir: string) => collectLocalEvidence(dir, suite).entries;
const cases: string[] = [];
afterAll(() => { for (const d of cases) rmSync(d, { recursive: true, force: true }); });
function make(suite: string, edit?: Parameters<typeof suiteDir>[1]) { const s = suiteDir(suite, edit); cases.push(s.dir); return s; }

describe("CON-30 G8 evidence: recorded digests, every row their test lists present exactly once and passed", () => {
  it("the expected rows are derived from the committed sources: 229 static negative rows, 62 definer probes, 28 fixtures", () => {
    expect(EXPECTED.negative.size).toBe(229);
    expect(EXPECTED.definerProbes.size).toBe(62);
    expect(EXPECTED.fixtures).toHaveLength(28);
    expect(new Set(EXPECTED.fixtures).size).toBe(28);
  });
  it.each(["regression-probes", "regression-probes-discover", "regression-definers", "regression-definers-discover"])("accepts complete, passed, recorded evidence: %s", (suite) => {
    const { dir, entries } = make(suite);
    expect(gate(suite, dir, entries).problems).toEqual([]);
    expect(collectLocalEvidence(dir, suite).problems).toEqual([]);
  });
  it("reviewer bypass 1: a negative-probe row deleted is refused by digest, and by row when re-recorded", () => {
    const { dir, entries } = make("regression-probes");
    let removed: Row = {};
    write(dir, NEGATIVE_FILE, (v) => { removed = v.results!.splice(5, 1)[0]!; });
    expect(gate("regression-probes", dir, entries).problems).toContain(`${NEGATIVE_FILE}: differs from the recorded digest`);
    const id = JSON.stringify([removed.role, removed.probe, removed.sql]);
    expect(gate("regression-probes", dir, reRecorded("regression-probes", dir)).problems).toContain(`${NEGATIVE_FILE}: missing row ${id}`);
  });
  it("reviewer bypass 2: definer probes cut from 62 rows to 1 are refused, 61 rows missing", () => {
    const { dir } = make("regression-probes");
    write(dir, DEFINER_PROBES_FILE, (v) => { v.results = v.results!.slice(0, 1); });
    const problems = gate("regression-probes", dir, reRecorded("regression-probes", dir)).problems;
    expect(problems.filter((p) => p.startsWith(`${DEFINER_PROBES_FILE}: missing row `))).toHaveLength(61);
  });
  it("reviewer bypass 3: a discover-twin definers fixture marked failed is refused", () => {
    const { dir } = make("regression-definers-discover");
    let name = "";
    write(dir, DEFINERS_FILE, (v) => { v.fixtures![3]!.failedOnPurpose = false; name = String(v.fixtures![3]!.fixture); });
    const problems = gate("regression-definers-discover", dir, reRecorded("regression-definers-discover", dir)).problems;
    expect(problems).toContain(`${DEFINERS_FILE}: row not passed ${JSON.stringify(name)}`);
    expect(problems).toContain(`${DEFINERS_FILE}: failedOnPurpose differs from recomputation ${JSON.stringify(name)}`);
  });
  it("a row altered with the row count unchanged: digest differs; re-recorded, an unexpected and a missing row", () => {
    const { dir, entries } = make("regression-probes");
    write(dir, NEGATIVE_FILE, (v) => { v.results![7]!.sql = `${String(v.results![7]!.sql)} /* altered */`; });
    expect(gate("regression-probes", dir, entries).problems).toContain(`${NEGATIVE_FILE}: differs from the recorded digest`);
    const problems = gate("regression-probes", dir, reRecorded("regression-probes", dir)).problems;
    expect(problems.some((p) => p.startsWith(`${NEGATIVE_FILE}: unexpected row `) && p.includes("/* altered */"))).toBe(true);
    expect(problems.some((p) => p.startsWith(`${NEGATIVE_FILE}: missing row `))).toBe(true);
  });
  it("an observed outcome altered with the pass flag kept: the row is not passed and the flag differs from recomputation", () => {
    const { dir } = make("regression-probes");
    let id = "";
    write(dir, NEGATIVE_FILE, (v) => { const r = v.results!.find((x) => x.expected === "42501")!; r.observed = "OK"; id = JSON.stringify([r.role, r.probe, r.sql]); });
    const problems = gate("regression-probes", dir, reRecorded("regression-probes", dir)).problems;
    expect(problems).toContain(`${NEGATIVE_FILE}: row not passed ${id}`);
    expect(problems).toContain(`${NEGATIVE_FILE}: pass flag differs from recomputation ${id}`);
  });
  it("a forged pass flag (a state change recorded, pass kept true): the flag is recomputed, never trusted", () => {
    const { dir } = make("regression-probes");
    write(dir, DEFINER_PROBES_FILE, (v) => { const r = v.results!.find((x) => x.row === 3)!; r.stateUnchanged = false; });
    const problems = gate("regression-probes", dir, reRecorded("regression-probes", dir)).problems;
    expect(problems.some((p) => p.startsWith(`${DEFINER_PROBES_FILE}: row not passed `))).toBe(true);
    // the matching 27.9.5 row of the negative file depends on stateUnchanged too
    expect(problems.some((p) => p.startsWith(`${NEGATIVE_FILE}: row not passed `) && p.includes("27.9.5 row 3"))).toBe(true);
  });
  it("rows 25 to 27 are recomputed from their observed values", () => {
    const { dir } = make("regression-probes");
    write(dir, DEFINER_PROBES_FILE, (v) => {
      v.results!.find((x) => x.row === 25)!.observed = { epoch: "999999", persisted: "x", recent: true };
      v.results!.find((x) => x.row === 27)!.observed = [{ epoch: "8" }];
    });
    const problems = gate("regression-probes", dir, reRecorded("regression-probes", dir)).problems;
    expect(problems.filter((p) => p.startsWith(`${DEFINER_PROBES_FILE}: row not passed `))).toHaveLength(2);
  });
  it("an incorrect recorded digest is refused", () => {
    const { dir, entries } = make("regression-probes");
    const bad: EvidenceEntry[] = entries.map((e) => e.path === NEGATIVE_FILE ? { ...e, sha256: (e.sha256[0] === "0" ? "1" : "0") + e.sha256.slice(1) } : e);
    expect(gate("regression-probes", dir, bad).problems).toEqual([`${NEGATIVE_FILE}: differs from the recorded digest`, `${NEGATIVE_FILE}: missing`]);
  });
  it("a duplicate row identity is refused", () => {
    const { dir } = make("regression-probes");
    write(dir, NEGATIVE_FILE, (v) => { v.results![9] = { ...v.results![8]! }; });
    const problems = gate("regression-probes", dir, reRecorded("regression-probes", dir)).problems;
    expect(problems.some((p) => p.startsWith(`${NEGATIVE_FILE}: duplicate row `))).toBe(true);
    expect(problems.some((p) => p.startsWith(`${NEGATIVE_FILE}: missing row `))).toBe(true);
  });
  it("an extra unexpected row is refused", () => {
    const { dir } = make("regression-probes");
    write(dir, NEGATIVE_FILE, (v) => { v.results!.push({ ...v.results![0]!, probe: "unexpected extra row" }); });
    expect(gate("regression-probes", dir, reRecorded("regression-probes", dir)).problems.some((p) => p.startsWith(`${NEGATIVE_FILE}: unexpected row `) && p.includes("unexpected extra row"))).toBe(true);
  });
  it("a definers fixture duplicated over another is refused", () => {
    const { dir } = make("regression-definers");
    write(dir, DEFINERS_FILE, (v) => { v.fixtures![27] = { ...v.fixtures![26]! }; });
    const problems = gate("regression-definers", dir, reRecorded("regression-definers", dir)).problems;
    expect(problems.some((p) => p.startsWith(`${DEFINERS_FILE}: duplicate row `))).toBe(true);
    expect(problems.some((p) => p.startsWith(`${DEFINERS_FILE}: missing row `))).toBe(true);
  });
  it.each(["regression-probes", "regression-probes-discover"])("missing evidence in %s: deleted with its entry kept, or deleted with its entry", (suite) => {
    const a = make(suite);
    rmSync(join(a.dir, DEFINER_PROBES_FILE));
    expect(gate(suite, a.dir, a.entries).problems).toContain(`${DEFINER_PROBES_FILE}: missing`);
    expect(gate(suite, a.dir, reRecorded(suite, a.dir)).problems).toContain(`${DEFINER_PROBES_FILE}: missing`);
    expect(collectLocalEvidence(a.dir, suite).problems).toEqual([`${DEFINER_PROBES_FILE}: missing`]);
  });
  it("cross-run substitution: another run's file is refused by digest; a record without digests is refused", () => {
    const one = make("regression-probes"), other = make("regression-probes-discover", (f) => {
      (f[DEFINER_PROBES_FILE]!.results!.find((x) => x.row === 25)!.observed as Row).persisted = "2026-10-10 18:19:39+00";
    });
    writeFileSync(join(one.dir, DEFINER_PROBES_FILE), readFileSync(join(other.dir, DEFINER_PROBES_FILE)));
    expect(gate("regression-probes", one.dir, one.entries).problems).toContain(`${DEFINER_PROBES_FILE}: differs from the recorded digest`);
    expect(gate("regression-probes", one.dir, undefined).problems).toContain("evidence not recorded by the runner");
  });
  it("discover-twin corruption is refused like the primary's", () => {
    const { dir, entries } = make("regression-probes-discover");
    write(dir, NEGATIVE_FILE, (v) => { v.results![0]!.observed = "42809"; });
    expect(gate("regression-probes-discover", dir, entries).problems).toContain(`${NEGATIVE_FILE}: differs from the recorded digest`);
    expect(gate("regression-probes-discover", dir, reRecorded("regression-probes-discover", dir)).problems.some((p) => p.startsWith(`${NEGATIVE_FILE}: row not passed `))).toBe(true);
  });
  it("an unrecorded file under artifacts/local is refused", () => {
    const { dir, entries } = make("regression-probes");
    writeFileSync(join(dir, "artifacts", "local", "extra.json"), "{}\n");
    expect(gate("regression-probes", dir, entries).problems).toContain("artifacts/local/extra.json: unrecorded file");
  });
  it.each([
    ["not JSON", (t: string) => t.slice(0, 40)],
    ["a duplicate JSON key", (t: string) => t.replace('"contract":', '"contract": "x", "contract":')],
    ["an extra top-level key", (t: string) => t.replace('"contract":', '"extra": 1, "contract":')],
    ["another contract", (t: string) => t.replace("kerneljson:b1-negative-probes/v1", "kerneljson:b1-negative-probes/v2")],
  ])("a malformed file (%s) is refused", (_label, change) => {
    const { dir } = make("regression-probes");
    writeFileSync(join(dir, NEGATIVE_FILE), change(readFileSync(join(dir, NEGATIVE_FILE), "utf8")));
    expect(gate("regression-probes", dir, reRecorded("regression-probes", dir)).problems.some((p) => p.startsWith(`${NEGATIVE_FILE}: malformed`))).toBe(true);
  });
  it("evidence of another release: b1-definers.json testedCommit is not R (CI gate binding)", () => {
    const { dir, entries } = make("regression-definers");
    expect(gate("regression-definers", dir, entries, "f".repeat(40)).problems).toEqual([`${DEFINERS_FILE}: testedCommit ${R0} is not R`]);
    // the runner, which has no R from the environment it trusts, does not apply this binding
    expect(g8SuiteProblems("regression-definers", verifyRecordedEvidence(dir, entries, "regression-definers").files, EXPECTED, null).problems).toEqual([]);
  });
  it("INTERIM function rows: a granted function presented as outside the manifest, and a duplicate, are refused", () => {
    const granted = [...EXPECTED.granted.kj_worker][0]!;
    const { dir } = make("regression-probes", (f) => {
      f[NEGATIVE_FILE]!.results!.push({ role: "kj_worker", probe: FUNCTION_PROBE, sql: `has_function_privilege(${granted})`, expected: "false", observed: "false", pass: true });
      f[NEGATIVE_FILE]!.results!.push({ ...f[NEGATIVE_FILE]!.results!.find((r) => r.probe === FUNCTION_PROBE)! });
    });
    const problems = gate("regression-probes", dir, reRecorded("regression-probes", dir)).problems;
    expect(problems.some((p) => p.startsWith(`${NEGATIVE_FILE}: unexpected row `) && p.includes(granted))).toBe(true);
    expect(problems.some((p) => p.startsWith(`${NEGATIVE_FILE}: duplicate row `) && p.includes(FUNCTION_PROBE))).toBe(true);
  });
  it("INTERIM function rows: a row removed from the discover twin only differs across the twins", () => {
    const p = make("regression-probes"), d = make("regression-probes-discover", (f) => {
      const rows = f[NEGATIVE_FILE]!.results!; rows.splice(rows.findIndex((r) => r.probe === FUNCTION_PROBE), 1);
    });
    expect(functionRowTwinProblems(gate("regression-probes", p.dir, p.entries).functionRows, gate("regression-probes-discover", d.dir, d.entries).functionRows))
      .toEqual(["INTERIM function-outside-manifest rows differ between regression-probes and regression-probes-discover"]);
  });
  it("KNOWN GAP, UNRESOLVED BLOCKER (not detection): the same function row removed from BOTH twins and re-recorded is NOT refused by the interim rule", () => {
    // This test documents a limitation and must not be read as G8 detecting the deletion. The function rows come from
    // the live catalogue and no committed source lists them, so the interim rule cannot know a row is missing. Final G8
    // needs a release-bound function inventory (R2.7.10 proposal). When that exists, this test must be inverted.
    const drop = (f: ReturnType<typeof goodEvidence>) => { const rows = f[NEGATIVE_FILE]!.results!; rows.splice(rows.findIndex((r) => r.probe === FUNCTION_PROBE), 1); };
    const p = make("regression-probes", drop), d = make("regression-probes-discover", drop);
    const gp = gate("regression-probes", p.dir, p.entries), gd = gate("regression-probes-discover", d.dir, d.entries);
    expect([...gp.problems, ...gd.problems, ...functionRowTwinProblems(gp.functionRows, gd.functionRows)]).toEqual([]);
    expect(gp.functionRows).toHaveLength(FUNCTION_ROWS.length - 1);
  });
  it("the three state rows the verifier names are still literals of the frozen negative test", () => {
    const text = readFileSync("tests/runtime-roles-negative.integration.test.ts", "utf8");
    for (const [row, probe] of STATE_ROWS) expect(text).toContain(`row: ${row}, probe: "${probe}"`);
  });
});
