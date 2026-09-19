import { describe, it, expect } from "vitest";
import { GithubReadError, createGithubReader } from "../packages/runtimes/src/index.js";
import { capabilityDigest } from "../packages/capabilities/src/index.js";

const SLUG = "jonnyallum/kerneljson";
const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const TOKEN = "github_pat_SYNTHETIC_TEST_TOKEN_0000000000";

// A route is a spec, and every call builds a FRESH Response. Never clone one: a cloned body is a
// tee, and awaiting cancel() on one branch never resolves while its twin is unread.
interface Spec { body: string | null; status: number; headers: Record<string, string> }
type Route = Spec;
const raw = (body: string | null, status = 200, headers: Record<string, string> = {}): Spec => ({ body, status, headers });
const json = (value: unknown, status = 200, headers: Record<string, string> = {}): Spec =>
  raw(JSON.stringify(value), status, { "content-type": "application/json", ...headers });

const repo = { full_name: SLUG, private: true, default_branch: "main", language: "TypeScript", size: 4200, pushed_at: "2026-09-19T14:05:00Z", open_issues_count: 2 };
const commit = { sha: HEAD, commit: { committer: { date: "2026-09-19T14:00:00Z" }, message: "first line\n\nbody that must not leak in" } };
const tree = (entries: Array<{ path: string; type: string }>, truncated = false) => ({ truncated, tree: entries });
const readme = (text: string) => ({ path: "README.md", encoding: "base64", content: Buffer.from(text).toString("base64") });

function router(routes: Record<string, Route>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: string, init: RequestInit) => {
    calls.push({ url: input, init });
    const path = new URL(input).pathname;
    const key = Object.keys(routes).sort((x, y) => y.length - x.length).find((k) => path === k || path.startsWith(`${k}/`));
    if (!key) return json({}, 404);
    const r = routes[key]!;
    return new Response(r.body, { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const happy = (over: Record<string, Route> = {}) =>
  router({
    [`/repos/jonnyallum/kerneljson`]: json(repo),
    [`/repos/jonnyallum/kerneljson/commits/main`]: json(commit),
    [`/repos/jonnyallum/kerneljson/git/trees/${HEAD}`]: json(tree([
      { path: "services/kernel/src/index.ts", type: "blob" },
      { path: "README.md", type: "blob" },
      { path: "services", type: "tree" },
      { path: "vendor/lib", type: "commit" },
    ])),
    [`/repos/jonnyallum/kerneljson/readme`]: json(readme("# KernelJSON\nA durable kernel.")),
    ...over,
  });

const codeOf = async (p: Promise<unknown>): Promise<GithubReadError> => p.then(() => { throw new Error("expected rejection"); }, (e: unknown) => e as GithubReadError);

describe("KJ-P3 GitHub evidence reader", () => {
  it("returns bounded facts and their canonical digest", async () => {
    const { fetchImpl } = happy();
    const { facts, factsDigest } = await createGithubReader({ fetch: fetchImpl })({ repo: SLUG });
    expect(facts).toMatchObject({ repo: SLUG, headSha: HEAD, defaultBranch: "main", private: true, language: "TypeScript", openIssues: 2, treeTruncated: false });
    expect(facts.headCommitMessage).toBe("first line");
    expect(factsDigest).toBe(capabilityDigest(facts));
    expect(facts.readme).toMatchObject({ path: "README.md", excerpt: "# KernelJSON\nA durable kernel." });
  });

  it("keeps only blobs and trees, shallowest first, and drops submodule entries", async () => {
    const { facts } = await createGithubReader({ fetch: happy().fetchImpl })({ repo: SLUG });
    expect(facts.tree.map((e) => e.path)).toEqual(["README.md", "services", "services/kernel/src/index.ts"]);
  });

  it("flags a truncated tree, from GitHub or from its own cap", async () => {
    const fromGithub = happy({ [`/repos/jonnyallum/kerneljson/git/trees/${HEAD}`]: json(tree([{ path: "a", type: "blob" }], true)) });
    expect((await createGithubReader({ fetch: fromGithub.fetchImpl })({ repo: SLUG })).facts.treeTruncated).toBe(true);
    const many = Array.from({ length: 1200 }, (_, i) => ({ path: `f${String(i).padStart(4, "0")}`, type: "blob" }));
    const capped = happy({ [`/repos/jonnyallum/kerneljson/git/trees/${HEAD}`]: json(tree(many)) });
    const { facts } = await createGithubReader({ fetch: capped.fetchImpl })({ repo: SLUG });
    expect(facts.tree).toHaveLength(1000);
    expect(facts.treeTruncated).toBe(true);
  });

  it("records no readme when the repository has none", async () => {
    const r = happy({ [`/repos/jonnyallum/kerneljson/readme`]: json({}, 404) });
    expect((await createGithubReader({ fetch: r.fetchImpl })({ repo: SLUG })).facts.readme).toBeNull();
  });

  it("makes only read-only GETs to api.github.com, never following a redirect", async () => {
    const r = happy();
    await createGithubReader({ fetch: r.fetchImpl })({ repo: SLUG });
    expect(r.calls.length).toBe(4);
    for (const c of r.calls) {
      expect(new URL(c.url).origin).toBe("https://api.github.com");
      expect(c.init.method).toBe("GET");
      expect(c.init.redirect).toBe("manual");
      expect(c.init.body).toBeUndefined();
    }
  });

  it("sends the token only as an Authorization header, and never returns it", async () => {
    const r = happy();
    const result = await createGithubReader({ token: TOKEN, fetch: r.fetchImpl })({ repo: SLUG });
    for (const c of r.calls) expect((c.init.headers as Record<string, string>)["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    const anon = happy();
    await createGithubReader({ fetch: anon.fetchImpl })({ repo: SLUG });
    for (const c of anon.calls) expect((c.init.headers as Record<string, string>)["authorization"]).toBeUndefined();
  });

  it("classifies failures by status only, as terminal or retryable", async () => {
    const cases: Array<[string, Route, string, boolean]> = [
      ["404", json({}, 404), "NOT_FOUND", false],
      ["401", json({ message: "Bad credentials " + TOKEN }, 401), "AUTH", false],
      ["403 forbidden", json({}, 403), "AUTH", false],
      ["403 rate limit", json({}, 403, { "x-ratelimit-remaining": "0" }), "RATE_LIMITED", true],
      ["429", json({}, 429), "RATE_LIMITED", true],
      ["500", json({}, 500), "UPSTREAM", true],
      ["301", raw(null, 301, { location: "https://api.github.com/x" }), "RENAMED", false],
    ];
    for (const [name, route, code, retryable] of cases) {
      const r = happy({ [`/repos/jonnyallum/kerneljson`]: route });
      const err = await codeOf(createGithubReader({ token: TOKEN, fetch: r.fetchImpl })({ repo: SLUG }));
      expect(err, name).toBeInstanceOf(GithubReadError);
      expect([err.code, err.retryable], name).toEqual([code, retryable]);
      expect(err.message, name).not.toContain(TOKEN);
    }
  });

  it("treats a network failure as retryable and never surfaces the underlying error", async () => {
    const boom = (async () => { throw new Error(`connect ECONNRESET api.github.com ${TOKEN}`); }) as unknown as typeof fetch;
    const err = await codeOf(createGithubReader({ token: TOKEN, fetch: boom })({ repo: SLUG }));
    expect([err.code, err.retryable]).toEqual(["NETWORK", true]);
    expect(err.message).not.toContain(TOKEN);
  });

  it("refuses a repository whose canonical name differs from the one requested (rename or transfer)", async () => {
    const r = happy({ [`/repos/jonnyallum/kerneljson`]: json({ ...repo, full_name: "someone-else/kerneljson" }) });
    expect((await codeOf(createGithubReader({ fetch: r.fetchImpl })({ repo: SLUG }))).code).toBe("RENAMED");
  });

  it("rejects an oversized or malformed response", async () => {
    const big = happy({ [`/repos/jonnyallum/kerneljson`]: raw("x".repeat(2_100_000)) });
    expect((await codeOf(createGithubReader({ fetch: big.fetchImpl })({ repo: SLUG }))).code).toBe("TOO_LARGE");
    const junk = happy({ [`/repos/jonnyallum/kerneljson`]: raw("<html>") });
    expect((await codeOf(createGithubReader({ fetch: junk.fetchImpl })({ repo: SLUG }))).code).toBe("MALFORMED");
    const shape = happy({ [`/repos/jonnyallum/kerneljson/commits/main`]: json({ sha: "not-a-sha" }) });
    expect((await codeOf(createGithubReader({ fetch: shape.fetchImpl })({ repo: SLUG }))).code).toBe("MALFORMED");
  });

  it("validates the slug before any network call", async () => {
    const r = happy();
    for (const bad of ["../x/y", "a/b/c", "a/..", "x", ""]) await expect(createGithubReader({ fetch: r.fetchImpl })({ repo: bad })).rejects.toBeTruthy();
    expect(r.calls).toHaveLength(0);
  });

  it("refuses a malformed token at construction, without echoing it", () => {
    expect(() => createGithubReader({ token: "has space" })).toThrow("Invalid GitHub read token configuration");
  });
});
