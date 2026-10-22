import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  CODE_CHANGE_CHECKS,
  CodeChangeReconciliation,
  codeChangeBranch,
  codeChangeRunTitle,
  parseCodeChangeObjective,
  refusedPathCategory,
  type ChangeFacts,
  type CodeChangeCheck,
} from "../packages/contracts/src/index.js";
import { changeDigest, failedCodeChangeChecks, reconcileCodeChange, type CodeChangeReconcileInput } from "../services/kernel/src/mission/code-change-reconcile.js";

const TASK = "11111111-2222-4333-8444-555555555555";
const BASE = "0123456789abcdef0123456789abcdef01234567";
const HEAD = "89abcdef0123456789abcdef0123456789abcdef";
const REPO = "jonnyallum/pilot";
const BRANCH = `kj/${TASK}`;
const P = "a".repeat(64);

const goodFacts = (): ChangeFacts => ({
  repo: REPO,
  defaultBranch: "main",
  baseSha: BASE,
  branch: BRANCH,
  headSha: HEAD,
  compareStatus: "ahead",
  aheadBy: 1,
  behindBy: 0,
  files: [{ path: "src/greet.ts", status: "modified", previousPath: null, additions: 3, deletions: 1, blobSha: "f".repeat(40), patchSha256: P }],
  filesTruncated: false,
  patchBytes: 180,
  codeRun: {
    id: 1, workflowPath: ".github/workflows/kj-code-change.yml", event: "workflow_dispatch", headBranch: "main",
    headSha: BASE, displayTitle: `kj:${TASK} code`, status: "completed", conclusion: "success",
  },
  testRun: {
    id: 2, workflowPath: ".github/workflows/kj-test.yml", event: "workflow_dispatch", headBranch: BRANCH,
    headSha: HEAD, displayTitle: `kj:${TASK} test`, status: "completed", conclusion: "success",
  },
});

const reviewFor = (facts: unknown, over: Record<string, unknown> = {}) =>
  JSON.stringify({ reviewedChangeDigest: changeDigest(facts), verdict: "approve", scopeMatchesInstructions: true, concerns: [], notes: [], ...over });

/** A passing input; `facts` mutations re-bind the review unless `review` is given, so each case breaks one thing. */
function input(mutate: (f: ChangeFacts) => void = () => {}, over: Partial<CodeChangeReconcileInput> = {}, review: Record<string, unknown> = {}): CodeChangeReconcileInput {
  const facts = goodFacts();
  mutate(facts);
  return {
    taskId: TASK, repo: REPO, allowedRepos: [REPO], baseSha: BASE, defaultBranch: "main", facts,
    coderModel: "anthropic/claude-sonnet-5-5", reviewText: reviewFor(facts, review),
    reviewerModel: "x-ai/grok-4", reviewerProvider: "openrouter", ...over,
  };
}

describe("code-change/v1 contract", () => {
  it("parses owner/repo then instructions, and refuses bad objectives", () => {
    expect(parseCodeChangeObjective(`  ${REPO}  Add a greet() helper and a test.  `)).toEqual({ repo: REPO, instructions: "Add a greet() helper and a test." });
    expect(() => parseCodeChangeObjective(REPO)).toThrow();
    expect(() => parseCodeChangeObjective(`${REPO} short`)).toThrow(/too short/);
    expect(() => parseCodeChangeObjective(`${REPO} ${"x".repeat(2001)}`)).toThrow(/too long/);
    expect(() => parseCodeChangeObjective(`not-a-slug do the thing please`)).toThrow();
    expect(() => parseCodeChangeObjective(`a/.. do the thing please`)).toThrow();
  });

  it("names branches and runs by task, and refuses a non-uuid task", () => {
    expect(codeChangeBranch(TASK)).toBe(BRANCH);
    expect(codeChangeRunTitle(TASK, "test")).toBe(`kj:${TASK} test`);
    expect(() => codeChangeBranch("../main")).toThrow();
    expect(() => codeChangeBranch("AAAAAAAA-2222-4333-8444-555555555555")).toThrow();
  });

  it.each([
    [".github/workflows/ci.yml", "ci_and_automation"],
    ["CODEOWNERS", "ci_and_automation"],
    ["web/.husky/pre-commit", "ci_and_automation"],
    ["infra/main.tf", "infrastructure"],
    ["Dockerfile", "infrastructure"],
    ["services/api/Dockerfile.prod", "infrastructure"],
    ["vercel.json", "infrastructure"],
    ["supabase/migrations/001.sql", "infrastructure"],
    [".env", "secrets"],
    ["config/.env.production", "secrets"],
    ["src/secrets.ts", "secrets"],
    ["certs/server.PEM", "secrets"],
    ["src/components/Checkout.tsx", "billing"],
    ["lib/stripe/client.ts", "billing"],
    ["package.json", "dependencies"],
    ["apps/web/pnpm-lock.yaml", "dependencies"],
    ["pyproject.toml", "dependencies"],
  ])("refuses %s as %s", (path, category) => {
    expect(refusedPathCategory(path)).toBe(category);
  });

  it.each(["src/greet.ts", "README.md", "docs/guide.md", "src/secretary.ts", "src/keyboard.ts", "tests/greet.test.ts", "src/infrastructure-notes.md"])(
    "allows %s",
    (path) => expect(refusedPathCategory(path)).toBeNull(),
  );
});

describe("code-change/v1 reconciliation", () => {
  it("accepts the evidence of a well-formed change", () => {
    const rec = reconcileCodeChange(input());
    expect(failedCodeChangeChecks(rec)).toEqual([]);
    expect(rec.decision).toBe("ACCEPTED");
    expect(rec).toMatchObject({ headSha: HEAD, fileCount: 1, changedLines: 4, refusedCategories: [] });
    expect(rec.checks.map((c) => c.name)).toEqual([...CODE_CHANGE_CHECKS]);
  });

  it("is deterministic", () => {
    expect(reconcileCodeChange(input())).toEqual(reconcileCodeChange(input()));
  });

  // Every check is made to fail on purpose, alone where the evidence allows it.
  const alone: Array<[CodeChangeCheck, string, () => CodeChangeReconcileInput]> = [
    ["repository_allowlisted", "repo not allowlisted", () => input(undefined, { allowedRepos: ["jonnyallum/other"] })],
    ["repository_allowlisted", "facts for another repo", () => input((f) => { f.repo = "jonnyallum/other"; })],
    ["branch_is_task_branch", "another branch", () => input((f) => { f.branch = "feature/x"; f.testRun.headBranch = "feature/x"; })],
    ["base_matches_evidence", "base moved", () => input(undefined, { baseSha: HEAD })],
    ["base_matches_evidence", "default branch differs", () => input((f) => { f.defaultBranch = "develop"; })],
    ["branch_descends_from_base", "diverged", () => input((f) => { f.compareStatus = "diverged"; f.behindBy = 2; })],
    ["change_not_empty", "no files", () => input((f) => { f.files = []; })],
    ["change_fully_listed", "truncated list", () => input((f) => { f.filesTruncated = true; })],
    ["change_fully_listed", "file without patch", () => input((f) => { f.files[0]!.patchSha256 = null; })],
    ["change_within_size", "too many files", () => input((f) => { f.files = Array.from({ length: 21 }, (_, i) => ({ ...f.files[0]!, path: `src/f${i}.ts`, additions: 1, deletions: 0 })); })],
    ["change_within_size", "too many lines", () => input((f) => { f.files[0]!.additions = 801; })],
    ["change_within_size", "patch too large", () => input((f) => { f.patchBytes = 100_001; })],
    ["change_avoids_refused_paths", "CI path", () => input((f) => { f.files[0]!.path = ".github/workflows/x.yml"; })],
    ["change_avoids_refused_paths", "rename away from a manifest", () => input((f) => { f.files[0] = { ...f.files[0]!, status: "renamed", previousPath: "package.json", path: "src/pkg.json" }; })],
    ["change_deletes_no_files", "deletion", () => input((f) => { f.files[0] = { ...f.files[0]!, status: "removed", blobSha: null, additions: 0, deletions: 4 }; })],
    ["code_run_bound_to_task", "other workflow", () => input((f) => { f.codeRun.workflowPath = ".github/workflows/ci.yml"; })],
    ["code_run_bound_to_task", "push event", () => input((f) => { f.codeRun.event = "push"; })],
    ["code_run_bound_to_task", "run from the task branch", () => input((f) => { f.codeRun.headBranch = BRANCH; })],
    ["code_run_bound_to_task", "another task's run", () => input((f) => { f.codeRun.displayTitle = "kj:99999999-2222-4333-8444-555555555555 code"; })],
    ["code_run_bound_to_task", "coding run failed", () => input((f) => { f.codeRun.conclusion = "failure"; })],
    ["test_run_bound_to_head", "tested another commit", () => input((f) => { f.testRun.headSha = BASE; })],
    ["test_run_bound_to_head", "test run still going", () => input((f) => { f.testRun.status = "in_progress"; })],
    ["test_run_bound_to_head", "other workflow", () => input((f) => { f.testRun.workflowPath = ".github/workflows/kj-code-change.yml"; })],
    ["tests_passed", "tests failed", () => input((f) => { f.testRun.conclusion = "failure"; })],
    ["review_binds_to_change", "review of other evidence", () => input(undefined, {}, { reviewedChangeDigest: "b".repeat(64) })],
    ["reviewer_runtime_allowed", "unlisted family", () => input(undefined, { reviewerModel: "openai/gpt-5" })],
    ["reviewer_is_independent", "same family", () => input(undefined, { reviewerModel: "anthropic/claude-opus-5-5" })],
    ["reviewer_is_independent", "bare coder name", () => input(undefined, { coderModel: "claude-sonnet-5-5", reviewerModel: "anthropic/claude-opus-5-5" })],
    ["reviewer_is_independent", "unknown coder family", () => input(undefined, { coderModel: "acme/coder-1" })],
    ["review_scope_matches", "out of scope", () => input(undefined, {}, { scopeMatchesInstructions: false })],
    ["review_verdict_acceptable", "rejected", () => input(undefined, {}, { verdict: "reject" })],
    ["review_verdict_acceptable", "approve with a blocking concern", () => input(undefined, {}, { concerns: ["drops input validation"] })],
  ];

  it.each(alone)("fails only %s when: %s", (check, _why, make) => {
    const rec = reconcileCodeChange(make());
    expect(failedCodeChangeChecks(rec)).toEqual([check]);
    expect(rec.decision).toBe("REJECTED");
  });

  it("covers every check with a deliberate failure", () => {
    const covered = new Set<string>([...alone.map(([c]) => c), "change_facts_valid", "review_schema_valid"]);
    expect([...CODE_CHANGE_CHECKS].filter((c) => !covered.has(c))).toEqual([]);
  });

  it("rejects facts that do not match the schema", () => {
    const i = input();
    const rec = reconcileCodeChange({ ...i, facts: { ...(i.facts as object), injected: true } });
    expect(failedCodeChangeChecks(rec)).toContain("change_facts_valid");
    expect(rec.decision).toBe("REJECTED");
    expect(reconcileCodeChange({ ...i, facts: null }).decision).toBe("REJECTED");
  });

  it("rejects a review that is not the schema", () => {
    for (const reviewText of ["approve", "{}", reviewFor(goodFacts(), { verdict: "lgtm" }), reviewFor(goodFacts(), { extra: 1 })]) {
      const rec = reconcileCodeChange({ ...input(), reviewText });
      expect(failedCodeChangeChecks(rec)).toContain("review_schema_valid");
      expect(rec.decision).toBe("REJECTED");
    }
  });

  it("reports refused categories for the failure notice", () => {
    const rec = reconcileCodeChange(input((f) => { f.files = [{ ...f.files[0]!, path: ".env" }, { ...f.files[0]!, path: "Dockerfile" }]; }));
    expect(rec.refusedCategories).toEqual(["infrastructure", "secrets"]);
  });

  it("cannot be forged into ACCEPTED with a failing check", () => {
    const rec = reconcileCodeChange(input((f) => { f.testRun.conclusion = "failure"; }));
    expect(CodeChangeReconciliation.safeParse({ ...rec, decision: "ACCEPTED" }).success).toBe(false);
    const reordered = { ...rec, checks: [...rec.checks].reverse() };
    expect(CodeChangeReconciliation.safeParse(reordered).success).toBe(false);
  });
});

/** Lines of shell inside `run:` steps. Interpolating `${{ }}` there is a script-injection path. */
function runLines(workflow: string): string[] {
  const out: string[] = [];
  const lines = workflow.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*(?:- )?)run:\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    if (m[2] !== "|" && m[2] !== ">") { out.push(m[2]!); continue; }
    // A block scalar continues while lines are indented deeper than the `run:` key itself.
    const keyColumn = m[1]!.length;
    while (i + 1 < lines.length && (lines[i + 1]!.trim() === "" || lines[i + 1]!.search(/\S/) > keyColumn)) out.push(lines[++i]!);
  }
  return out;
}

describe("code-change/v1 workflow templates", () => {
  // Comments describe the jobs in words like "contents: write"; judge the YAML, not the prose.
  const uncommented = (path: string) => readFileSync(path, "utf8").replace(/^\s*#.*$/gm, "");
  const code = uncommented("infrastructure/github/kj-code-change.yml");
  const test = uncommented("infrastructure/github/kj-test.yml");
  const [codeJob, publishJob] = code.split(/^ {2}publish:$/m) as [string, string];

  it("the injection scanner catches an interpolated input (negative case)", () => {
    const bad = "steps:\n  - name: x\n    run: |\n      echo hi\n      echo ${{ inputs.instructions }}\n  - run: echo ${{ github.head_ref }}\n";
    expect(runLines(bad).filter((l) => l.includes("${{"))).toHaveLength(2);
  });

  it.each([["kj-code-change.yml", code], ["kj-test.yml", test]])("%s never interpolates expressions into shell", (_n, wf) => {
    expect(runLines(wf).length).toBeGreaterThan(3);
    expect(runLines(wf).filter((l) => l.includes("${{"))).toEqual([]);
  });

  it("titles runs exactly as the kernel looks for them", () => {
    expect(code).toContain("run-name: kj:${{ inputs.task_id }} code");
    expect(test).toContain("run-name: kj:${{ inputs.task_id }} test");
    expect(codeChangeRunTitle("X", "code")).toBe("kj:X code");
  });

  it("grants nothing by default and keeps the key away from the write token", () => {
    for (const wf of [code, test]) expect(wf).toMatch(/^permissions: \{\}$/m);
    expect(publishJob).toBeDefined();
    expect(codeJob).toMatch(/permissions:\n\s+contents: read\n/);
    expect(codeJob).not.toMatch(/contents: write/);
    expect(publishJob).toMatch(/permissions:\n\s+contents: write\n/);
    expect(publishJob).not.toMatch(/secrets\./);
    expect(test).not.toMatch(/secrets\./);
    expect(code.match(/secrets\.[A-Z_]+/g)).toEqual(["secrets.KJ_CODER_ANTHROPIC_KEY"]);
    expect(codeJob).toContain("persist-credentials: false");
    expect(test).toContain("persist-credentials: false");
  });

  it("gives the coding agent file tools only and a turn cap", () => {
    expect(codeJob).toContain('--allowedTools "Read,Edit,Write,Glob,Grep"');
    expect(codeJob).toContain('--disallowedTools "Bash,WebFetch,WebSearch"');
    expect(codeJob).toMatch(/--max-turns "\$MAX_TURNS"/);
    expect(codeJob).toMatch(/timeout-minutes: \d+/);
  });

  it("pins every action to a full commit, not a movable tag", () => {
    const unpinned = (wf: string) => [...wf.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)].map((m) => m[1]!).filter((u) => !/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/.test(u));
    expect(unpinned("steps:\n  - uses: actions/checkout@v4\n  - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020\n")).toEqual(["actions/checkout@v4"]);
    for (const wf of [code, test]) {
      expect(wf).toMatch(/uses:/);
      expect(unpinned(wf)).toEqual([]);
    }
  });

  it("publishes only to the task branch, refuses CI paths, never forces or merges", () => {
    expect(publishJob).toContain('git push origin "HEAD:refs/heads/kj/$TASK_ID"');
    expect(publishJob).toContain("\\.github/");
    expect(code).not.toMatch(/--force|push -f|\+HEAD|gh pr merge|\/merge/);
    expect(test).toContain('[[ "$REF" == "refs/heads/kj/$TASK_ID" ]]');
  });
});
