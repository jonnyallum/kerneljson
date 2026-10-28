import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { GithubReadError, GithubRunnerError, createGithubRunner } from "../packages/runtimes/src/index.js";
import { capabilityDigest } from "../packages/capabilities/src/index.js";
import { changeDigest, failedCodeChangeChecks, reconcileCodeChange } from "../services/kernel/src/mission/code-change-reconcile.js";

const REPO = "jonnyallum/pilot";
const R = `/repos/${REPO}`;
const TASK = "11111111-2222-4333-8444-555555555555";
const BRANCH = `kj/${TASK}`;
const BASE = "0123456789abcdef0123456789abcdef01234567";
const HEAD = "89abcdef0123456789abcdef0123456789abcdef";
const TOKEN = "github_pat_SYNTHETIC_RUNNER_TOKEN_000000000";

// As in github-read.test.ts: every call builds a fresh Response from a spec.
interface Spec { body: string | null; status: number; headers?: Record<string, string> }
type Route = Spec | ((url: URL, init: RequestInit) => Spec);
const json = (value: unknown, status = 200): Spec => ({ body: JSON.stringify(value), status, headers: { "content-type": "application/json" } });
const empty = (status: number): Spec => ({ body: null, status });

/** Routes keyed by `METHOD path`; the longest matching key wins, query strings are ignored. */
function router(routes: Record<string, Route>) {
  const calls: Array<{ method: string; url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    calls.push({ method, url: input, init });
    const url = new URL(input);
    const key = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => k === `${method} ${url.pathname}`);
    if (!key) return new Response(JSON.stringify({}), { status: 404 });
    const found = routes[key]!;
    const r = typeof found === "function" ? found(url, init) : found;
    return new Response(r.body, { status: r.status, headers: r.headers ?? {} });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const runner = (routes: Record<string, Route>) => {
  const r = router(routes);
  return { ...r, gh: createGithubRunner({ token: TOKEN, allowedRepos: [REPO], fetch: r.fetchImpl }) };
};

const run = (over: Record<string, unknown>) => ({
  id: 10, path: ".github/workflows/kj-code-change.yml@refs/heads/main", event: "workflow_dispatch", head_branch: "main",
  head_sha: BASE, display_title: `kj:${TASK} code`, status: "completed", conclusion: "success", ...over,
});
const codeRun = run({});
const testRun = run({ id: 11, path: ".github/workflows/kj-test.yml", head_branch: BRANCH, head_sha: HEAD, display_title: `kj:${TASK} test` });
const PATCH = "@@ -1,2 +1,4 @@\n-export const a = 1;\n+export const a = 1;\n+export const greet = (n: string) => `hi ${n}`;\n";
const compare = (files: unknown[]) => ({ status: "ahead", ahead_by: 1, behind_by: 0, files });
const file = { filename: "src/greet.ts", status: "modified", additions: 2, deletions: 1, sha: "f".repeat(40), patch: PATCH };

const errorOf = async (p: Promise<unknown>): Promise<Error> => p.then(() => { throw new Error("expected rejection"); }, (e: unknown) => e as Error);

describe("code-change/v1 GitHub runner client", () => {
  it("refuses an empty allowlist and a malformed token at construction", () => {
    expect(() => createGithubRunner({ token: TOKEN, allowedRepos: [] })).toThrow(/allowlist/);
    expect(() => createGithubRunner({ token: "bad token", allowedRepos: [REPO] })).toThrow();
  });

  it("refuses a repository outside the allowlist before sending anything", async () => {
    const { gh, calls } = runner({});
    for (const p of [
      gh.dispatchTest({ repo: "jonnyallum/other", taskId: TASK }),
      gh.findRun({ repo: "jonnyallum/other", taskId: TASK, kind: "code" }),
      gh.openDraftPr({ repo: "jonnyallum/other", taskId: TASK, defaultBranch: "main", expectedHeadSha: HEAD, title: "t", body: "" }),
    ]) {
      const e = await errorOf(p);
      expect(e).toBeInstanceOf(GithubRunnerError);
      expect((e as GithubRunnerError).code).toBe("NOT_ALLOWED");
    }
    expect(calls).toHaveLength(0);
  });

  it("dispatches the coding run from the default branch, token in the header only", async () => {
    const { gh, calls } = runner({
      [`GET ${R}`]: json({ full_name: REPO, default_branch: "main" }),
      [`POST ${R}/actions/workflows/kj-code-change.yml/dispatches`]: empty(204),
    });
    await gh.dispatchCode({ repo: REPO, taskId: TASK, baseSha: BASE, instructions: "Add a greet() helper." });
    const post = calls.find((c) => c.method === "POST")!;
    expect(JSON.parse(post.init.body as string)).toEqual({ ref: "main", inputs: { task_id: TASK, base_sha: BASE, instructions: "Add a greet() helper." } });
    expect(post.init.redirect).toBe("manual");
    expect((post.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    for (const c of calls) expect(c.url + String(c.init.body ?? "")).not.toContain(TOKEN);
  });

  it("refuses bad dispatch input without a request", async () => {
    const { gh, calls } = runner({});
    for (const p of [
      gh.dispatchCode({ repo: REPO, taskId: TASK, baseSha: "main", instructions: "Add a greet() helper." }),
      gh.dispatchCode({ repo: REPO, taskId: TASK, baseSha: BASE, instructions: "short" }),
      gh.dispatchCode({ repo: REPO, taskId: "../main", baseSha: BASE, instructions: "Add a greet() helper." }),
    ])
      await expect(p).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("dispatches the test run on the task branch", async () => {
    const { gh, calls } = runner({ [`POST ${R}/actions/workflows/kj-test.yml/dispatches`]: empty(204) });
    await gh.dispatchTest({ repo: REPO, taskId: TASK });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ ref: BRANCH, inputs: { task_id: TASK } });
  });

  it("classifies a refused write by status and never leaks the token", async () => {
    for (const [status, code] of [[403, "AUTH"], [422, "MALFORMED"], [404, "NOT_FOUND"], [503, "UPSTREAM"], [302, "RENAMED"]] as const) {
      const { gh } = runner({ [`POST ${R}/actions/workflows/kj-test.yml/dispatches`]: { body: `token ${TOKEN}`, status } });
      const e = await errorOf(gh.dispatchTest({ repo: REPO, taskId: TASK }));
      expect(e).toBeInstanceOf(GithubReadError);
      expect((e as GithubReadError).code).toBe(code);
      expect(String(e.message) + String(e.stack)).not.toContain(TOKEN);
    }
  });

  it("finds a run by its exact title, newest first, and null when absent", async () => {
    const other = run({ id: 99, display_title: "kj:99999999-2222-4333-8444-555555555555 code" });
    const { gh } = runner({ [`GET ${R}/actions/workflows/kj-code-change.yml/runs`]: json({ workflow_runs: [run({ id: 5 }), other, codeRun] }) });
    const found = await gh.findRun({ repo: REPO, taskId: TASK, kind: "code" });
    expect(found).toMatchObject({ id: 10, workflowPath: ".github/workflows/kj-code-change.yml", headBranch: "main" });
    const none = runner({ [`GET ${R}/actions/workflows/kj-test.yml/runs`]: json({ workflow_runs: [other] }) });
    expect(await none.gh.findRun({ repo: REPO, taskId: TASK, kind: "test" })).toBeNull();
  });

  const captureRoutes = (files: unknown[]): Record<string, Route> => ({
    [`GET ${R}/git/ref/heads/${BRANCH}`]: json({ object: { sha: HEAD } }),
    [`GET ${R}/compare/${BASE}...${HEAD}`]: json(compare(files)),
    [`GET ${R}/actions/runs/10`]: json(codeRun),
    [`GET ${R}/actions/runs/11`]: json(testRun),
  });
  const capture = (gh: ReturnType<typeof runner>["gh"]) =>
    gh.captureChange({ repo: REPO, taskId: TASK, baseSha: BASE, defaultBranch: "main", codeRunId: 10, testRunId: 11 });

  it("captures the change as evidence the reconciler accepts end to end", async () => {
    const { gh } = runner(captureRoutes([file]));
    const { facts, factsDigest, patch } = await capture(gh);
    expect(facts.files[0]).toMatchObject({ path: "src/greet.ts", patchSha256: createHash("sha256").update(PATCH).digest("hex") });
    expect(facts.patchBytes).toBe(Buffer.byteLength(patch));
    expect(patch).toContain("+++ src/greet.ts");
    expect(factsDigest).toBe(capabilityDigest(facts));
    const rec = reconcileCodeChange({
      taskId: TASK, repo: REPO, allowedRepos: [REPO], baseSha: BASE, defaultBranch: "main", facts,
      coderModel: "anthropic/claude-sonnet-5-5", reviewerModel: "x-ai/grok-4", reviewerProvider: "openrouter",
      reviewText: JSON.stringify({ reviewedChangeDigest: changeDigest(facts), verdict: "approve", scopeMatchesInstructions: true, concerns: [], notes: [] }),
    });
    expect(failedCodeChangeChecks(rec)).toEqual([]);
  });

  it("marks a full compare page as truncated and a patchless file as unlisted, so reconciliation refuses them", async () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ ...file, filename: `src/f${i}.ts` }));
    expect((await capture(runner(captureRoutes(many)).gh)).facts.filesTruncated).toBe(true);
    const binary = { ...file, filename: "img/logo.png", patch: undefined };
    expect((await capture(runner(captureRoutes([binary])).gh)).facts.files[0]!.patchSha256).toBeNull();
  });

  it("fails capture when the task branch does not exist", async () => {
    const { gh } = runner({});
    expect(((await errorOf(capture(gh))) as GithubReadError).code).toBe("NOT_FOUND");
  });

  const pr = (over: Record<string, unknown> = {}) => ({
    number: 7, html_url: `https://github.com/${REPO}/pull/7`, draft: true, head: { sha: HEAD, ref: BRANCH }, base: { ref: "main" }, ...over,
  });

  it("opens a draft PR for the reviewed head only", async () => {
    const { gh, calls } = runner({ [`GET ${R}/git/ref/heads/${BRANCH}`]: json({ object: { sha: HEAD } }), [`GET ${R}/pulls`]: json([]), [`POST ${R}/pulls`]: json(pr(), 201) });
    const out = await gh.openDraftPr({ repo: REPO, taskId: TASK, defaultBranch: "main", expectedHeadSha: HEAD, title: "kj: greet helper", body: "evidence" });
    expect(out).toEqual({ number: 7, url: `https://github.com/${REPO}/pull/7`, headSha: HEAD });
    const body = JSON.parse(calls.find((c) => c.method === "POST")!.init.body as string);
    expect(body).toMatchObject({ head: BRANCH, base: "main", draft: true, maintainer_can_modify: false });
  });

  it("returns the existing draft instead of opening a second one on retry", async () => {
    const { gh, calls } = runner({
      [`GET ${R}/git/ref/heads/${BRANCH}`]: json({ object: { sha: HEAD } }),
      [`GET ${R}/pulls`]: (url) => {
        expect(url.searchParams.get("head")).toBe(`jonnyallum:${BRANCH}`);
        return json([pr()]);
      },
    });
    const out = await gh.openDraftPr({ repo: REPO, taskId: TASK, defaultBranch: "main", expectedHeadSha: HEAD, title: "t", body: "" });
    expect(out.number).toBe(7);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("reads the base commit of the default branch", async () => {
    const { gh } = runner({
      [`GET ${R}`]: json({ full_name: REPO, default_branch: "main" }),
      [`GET ${R}/git/ref/heads/main`]: json({ object: { sha: BASE } }),
    });
    expect(await gh.baseCommit({ repo: REPO })).toEqual({ defaultBranch: "main", baseSha: BASE });
  });

  it("refuses to open a PR when the branch moved, without posting", async () => {
    const { gh, calls } = runner({ [`GET ${R}/git/ref/heads/${BRANCH}`]: json({ object: { sha: BASE } }), [`POST ${R}/pulls`]: json(pr(), 201) });
    const e = await errorOf(gh.openDraftPr({ repo: REPO, taskId: TASK, defaultBranch: "main", expectedHeadSha: HEAD, title: "t", body: "" }));
    expect((e as GithubRunnerError).code).toBe("HEAD_MOVED");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it.each([
    ["NOT_DRAFT", { draft: false }],
    ["NOT_DRAFT", { base: { ref: "release" } }],
    ["HEAD_MOVED", { head: { sha: BASE, ref: BRANCH } }],
  ])("reports %s when GitHub's answer is not the PR asked for", async (code, over) => {
    const { gh } = runner({ [`GET ${R}/git/ref/heads/${BRANCH}`]: json({ object: { sha: HEAD } }), [`GET ${R}/pulls`]: json([]), [`POST ${R}/pulls`]: json(pr(over), 201) });
    const e = await errorOf(gh.openDraftPr({ repo: REPO, taskId: TASK, defaultBranch: "main", expectedHeadSha: HEAD, title: "t", body: "" }));
    expect((e as GithubRunnerError).code).toBe(code);
  });

  it("has no method that merges, pushes or deletes", () => {
    const { gh } = runner({});
    expect(Object.keys(gh).sort()).toEqual(["baseCommit", "branchHead", "captureChange", "defaultBranch", "dispatchCode", "dispatchTest", "findRun", "getRun", "openDraftPr"]);
  });
});
