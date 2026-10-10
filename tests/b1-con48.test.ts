import { describe, expect, it } from "vitest";
import { con48, con48Problems, type Con48Evidence } from "../scripts/b1/con48.js";
import { sqlFingerprint, type Refusal } from "../scripts/b1/refusal-accounting.js";
import { LOG_FIXTURE, LOG_PEEK } from "./support/b1-log-fixture.js";

/**
 * The CON-48 checker (scripts/b1/con48.ts) on a synthetic log in the pinned format: the positive fixture reconciles and
 * every one of the seven perturbations fails. The same checker runs in the CI gate over the log of the stage T run of
 * regression-probes on the pinned image.
 */
const runId = "c".repeat(32), markerPid = "40";
function evidence(): Con48Evidence {
  const lines = [`kjlog|${markerPid}|1|00000|postgres|postgres| LOG:  kj-t-begin ${runId}`];
  const expected: Refusal[] = [];
  let pid = 100;
  for (const fixture of LOG_FIXTURE) {
    let seq = 0; pid++;
    for (const sql of fixture.statements) {
      const head = (sev: string) => `kjlog|${pid}|${++seq}|42501|kj_worker|kj_b1_log| ${sev}:  `;
      lines.push(`${head("ERROR")}permission denied for table pg_authid`);
      if (sql === LOG_PEEK) lines.push(`${head("CONTEXT")}SQL function "kj_log_fixture_peek" statement 1`);
      const [first, ...rest] = sql.split("\n");
      lines.push(`${head("STATEMENT")}${first}`, ...rest.map((r) => `\t${r}`));
      expected.push({ test: fixture.name, role: "kj_worker", sqlstate: "42501", fingerprint: sqlFingerprint(sql), multiplicity: 1 });
    }
  }
  lines.push(`kjlog|${markerPid}|2|00000|postgres|postgres| LOG:  kj-t-end ${runId}`);
  return { log: lines.join("\n") + "\n", runId, markerPid, expected, trace: expected,
    traceSql: LOG_FIXTURE.flatMap((f) => f.statements.map((sql) => ({ test: f.name, sql }))) };
}
describe("CON-48 checker", () => {
  it("reconciles the positive fixture and fails every perturbation", () => {
    const r = con48(evidence());
    expect(r.positive).toEqual([]);
    expect(r.perturbations.map((p) => p.id)).toEqual(["P1", "P2", "P3", "P4", "P5", "P6", "P7"]);
    for (const p of r.perturbations) expect(p.failed, p.how).toBe(true);
    expect(con48Problems(evidence())).toEqual([]);
  });
  it("fails when the log lacks one literal variant", () => {
    const e = evidence();
    expect(con48Problems({ ...e, log: e.log.replace(/where rolname = 'x y'/, "where rolname = 'x  y'") }).length).toBeGreaterThan(0);
  });
  it("fails when the trace and the declared refusals disagree", () => {
    const e = evidence();
    expect(con48Problems({ ...e, trace: e.trace.slice(1) }).length).toBeGreaterThan(0);
  });
});
