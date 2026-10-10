import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The qualification workflow is fail-closed (ADR-0023 27.12.15 "CI gate over every registered suite"; brief P0): the
 * gate job needs every other job, runs even when one of them did not succeed, recomputes every result, and separately
 * refuses unless every needed job concluded `success`, so a skipped, cancelled or failed job never qualifies. No job
 * receives a secret, an environment or write permission, none continues on error, and none applies migrations outside
 * the governed entry point. Each rule has a failing fixture made by perturbing the committed workflow.
 */
const WORKFLOW = readFileSync(".github/workflows/qualification.yml", "utf8").replaceAll("\r\n", "\n");
function jobs(text: string): Map<string, string> {
  const body = text.slice(text.indexOf("\njobs:\n") + 7), out = new Map<string, string>();
  const heads = [...body.matchAll(/^ {2}([a-z0-9-]+):\n/gm)];
  heads.forEach((h, i) => out.set(h[1]!, body.slice(h.index!, heads[i + 1]?.index ?? body.length)));
  return out;
}
export function workflowProblems(text: string): string[] {
  const problems: string[] = [], all = jobs(text), gate = all.get("gate");
  if (!/^on: \[push, pull_request, workflow_dispatch\]$/m.test(text)) problems.push("triggers differ");
  if (!/^permissions:\n {2}contents: read\n(?! )/m.test(text)) problems.push("permissions are not contents: read only");
  if (/secrets\.|^\s*environment:|continue-on-error|pull_request_target/m.test(text)) problems.push("a secret, environment, continue-on-error or pull_request_target");
  if (/pnpm test\b|qualify-ci\.sh|supabase (db|migration)|migrate\(/.test(text)) problems.push("a job runs the suite or migrations outside the governed entry point");
  // YAML validity the runner depends on: an expression inside a flow mapping must be quoted, or GitHub rejects the whole
  // file and no job (the gate included) runs at all (observed: run 38053042825).
  for (const [i, line] of text.split("\n").entries()) {
    const flow = /^\s*(?:-\s+)?[A-Za-z_-]+: \{(.*)\}\s*$/.exec(line)?.[1];
    if (flow !== undefined && flow.replace(/'[^']*'|"[^"]*"/g, "").includes("${{")) problems.push(`line ${i + 1}: unquoted expression in a flow mapping`);
  }
  if (!gate) return [...problems, "no gate job"];
  const others = [...all.keys()].filter((k) => k !== "gate").sort();
  const needs = /needs: \[([^\]]*)\]/.exec(gate)?.[1]?.split(",").map((s) => s.trim()).sort() ?? [];
  if (JSON.stringify(needs) !== JSON.stringify(others)) problems.push(`gate needs ${needs.join(",")} but the jobs are ${others.join(",")}`);
  if (!/^ {4}if: always\(\)$/m.test(gate)) problems.push("gate does not run when a needed job fails or is skipped");
  if (!gate.includes('node --import tsx scripts/b1/ci-gate.ts "$GITHUB_SHA" "$E"')) problems.push("gate does not recompute the results");
  const needsStep = /- name: Every required job succeeded[^\n]*\n {8}if: always\(\)\n {8}env: \{NEEDS: '\$\{\{ toJSON\(needs\) \}\}'\}\n[\s\S]*?v\.result!=="success"[\s\S]*?Object\.keys\(n\)\.length!==([0-9]+)/.exec(gate);
  if (!needsStep) problems.push("gate does not require every needed job to conclude success");
  else if (Number(needsStep[1]) !== others.length) problems.push("the needs-result step counts a different number of jobs");
  for (const [id, job] of all) if (/\bif: /.test(job.replace(/^ {6}- if: always\(\)$|^ {8}if: always\(\)$|^ {4}if: always\(\)$/gm, "")))
    problems.push(`${id}: a conditional other than always() could skip qualification work`);
  return problems;
}
describe("the qualification workflow is fail-closed", () => {
  it("the committed workflow satisfies every rule", () => { expect(workflowProblems(WORKFLOW)).toEqual([]); });
  it.each([
    ["a needed job dropped from the gate", (w: string) => w.replace("needs: [static, base-regression,", "needs: [static,")],
    ["a job the gate does not need", (w: string) => w.replace("\n  gate:\n", "\n  extra:\n    runs-on: ubuntu-24.04\n    steps: []\n  gate:\n")],
    ["the gate skipped when a job fails", (w: string) => w.replace("    needs: [static, base-regression, runner-cases, stage-t, eph26, mutations, worker-image]\n    if: always()\n", "    needs: [static, base-regression, runner-cases, stage-t, eph26, mutations, worker-image]\n")],
    ["no needs-result step", (w: string) => w.replace("Every required job succeeded", "Report")],
    ["a needs-result step that accepts skipped", (w: string) => w.replace('v.result!=="success"', 'v.result==="failure"')],
    ["a job that continues on error", (w: string) => w.replace("    timeout-minutes: 45\n", "    timeout-minutes: 45\n    continue-on-error: true\n")],
    ["a secret", (w: string) => w.replace("CI: 'true'", "CI: 'true'\n  TOKEN: ${{ secrets.X }}")],
    ["write permission", (w: string) => w.replace("  contents: read\n", "  contents: write\n")],
    ["the whole suite outside the runner", (w: string) => w.replace("      - run: pnpm build\n", "      - run: pnpm build\n      - run: pnpm test\n")],
    ["an unquoted expression in a flow mapping (the file GitHub rejects)", (w: string) => w.replace("with: {name: 'gate-${{ github.sha }}',", "with: {name: gate-${{ github.sha }},")],
    ["a skip condition on a job", (w: string) => w.replace("  eph26:\n    runs-on", "  eph26:\n    if: github.event_name == 'push'\n    runs-on")],
  ])("fails with %s", (_label, perturb) => {
    const changed = perturb(WORKFLOW);
    expect(changed).not.toBe(WORKFLOW);
    expect(workflowProblems(changed).length).toBeGreaterThan(0);
  });
});
