import { createHash } from "node:crypto";
import { z } from "zod";
import { GithubFacts, RepoSlug } from "../../contracts/src/index.js";
import { capabilityDigest } from "../../capabilities/src/index.js";

/**
 * KJ-P3 - read-only GitHub evidence for one repository at one commit.
 *
 * Four GET requests, bounded in size and time, no redirects, no writes. The result is
 * a `GithubFacts` object plus its canonical digest, which becomes the TOOL_RECEIPT the
 * rest of the mission is verified against. The token (optional, read-only) travels only
 * in the Authorization header and never appears in a result or an error.
 */
export type GithubReadCode =
  | "NOT_FOUND"
  | "AUTH"
  | "RATE_LIMITED"
  | "UPSTREAM"
  | "NETWORK"
  | "MALFORMED"
  | "TOO_LARGE"
  | "RENAMED";

export class GithubReadError extends Error {
  constructor(
    readonly code: GithubReadCode,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "GithubReadError";
  }
}

const API = "https://api.github.com";
const MAX_BYTES = 2_000_000;
const TREE_LIMIT = 1000;
const EXCERPT_CHARS = 6000;

const RepoResponse = z.object({
  full_name: z.string(),
  private: z.boolean(),
  default_branch: z.string().min(1).max(200),
  language: z.string().max(80).nullable(),
  size: z.number().int().nonnegative(),
  pushed_at: z.string().nullable(),
  open_issues_count: z.number().int().nonnegative(),
});
const CommitResponse = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  commit: z.object({
    committer: z.object({ date: z.string() }),
    message: z.string(),
  }),
});
const TreeResponse = z.object({
  truncated: z.boolean(),
  tree: z.array(
    z.object({
      path: z.string().min(1).max(300),
      type: z.string(),
    }),
  ),
});
const ReadmeResponse = z.object({
  path: z.string().min(1).max(300),
  encoding: z.string(),
  content: z.string(),
});

async function boundedText(response: Response): Promise<string> {
  if (!response.body) throw new GithubReadError("MALFORMED", false);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BYTES) {
        await reader.cancel();
        throw new GithubReadError("TOO_LARGE", false);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

const depth = (path: string): number => path.split("/").length;

export interface GithubReaderConfig {
  /** Optional read-only token, from jVault via the worker environment. */
  token?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export function createGithubReader(config: GithubReaderConfig = {}) {
  const send = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? 15_000;
  const token = config.token;
  if (token !== undefined && !/^[^\s]{8,512}$/.test(token))
    throw new Error("Invalid GitHub read token configuration");

  async function get(path: string, allowNotFound = false): Promise<unknown | null> {
    let response: Response;
    try {
      response = await send(`${API}${path}`, {
        method: "GET",
        // A 3xx (for example a renamed repository) is classified below, never followed.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "kerneljson-mission/1",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
    } catch {
      throw new GithubReadError("NETWORK", true);
    }
    if (!response.ok) {
      // Error bodies can echo request detail. Classify by status only; never read them.
      await response.body?.cancel().catch(() => {});
      const status = response.status;
      if (status === 404 && allowNotFound) return null;
      if (status === 404) throw new GithubReadError("NOT_FOUND", false);
      if (status === 301 || status === 302 || status === 307 || status === 308)
        throw new GithubReadError("RENAMED", false);
      if (status === 429 || (status === 403 && response.headers.get("x-ratelimit-remaining") === "0"))
        throw new GithubReadError("RATE_LIMITED", true);
      if (status === 401 || status === 403) throw new GithubReadError("AUTH", false);
      if (status >= 500) throw new GithubReadError("UPSTREAM", true);
      throw new GithubReadError("MALFORMED", false);
    }
    try {
      return JSON.parse(await boundedText(response)) as unknown;
    } catch (error) {
      if (error instanceof GithubReadError) throw error;
      throw new GithubReadError("MALFORMED", false);
    }
  }

  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const result = schema.safeParse(value);
    if (!result.success) throw new GithubReadError("MALFORMED", false);
    return result.data;
  };

  return async function read(input: { repo: string }): Promise<{ facts: GithubFacts; factsDigest: string }> {
    const slug = RepoSlug.parse(input.repo);
    const [owner, name] = slug.split("/") as [string, string];
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

    const repo = parse(RepoResponse, await get(base));
    // A renamed or transferred repository must not silently become a different subject.
    if (repo.full_name.toLowerCase() !== slug.toLowerCase())
      throw new GithubReadError("RENAMED", false);

    const commit = parse(
      CommitResponse,
      await get(`${base}/commits/${encodeURIComponent(repo.default_branch)}`),
    );
    const treeRaw = parse(
      TreeResponse,
      await get(`${base}/git/trees/${commit.sha}?recursive=1`),
    );
    const entries = treeRaw.tree
      .filter((e) => e.type === "blob" || e.type === "tree")
      .map((e) => ({ path: e.path, type: e.type as "blob" | "tree" }))
      .sort((a, b) => depth(a.path) - depth(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    let readme: GithubFacts["readme"] = null;
    const readmeRaw = await get(`${base}/readme`, true);
    if (readmeRaw !== null) {
      const parsed = parse(ReadmeResponse, readmeRaw);
      if (parsed.encoding === "base64") {
        const bytes = Buffer.from(parsed.content.replace(/\s/g, ""), "base64");
        readme = {
          path: parsed.path,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          excerpt: bytes.toString("utf8").slice(0, EXCERPT_CHARS),
        };
      }
    }

    const facts = GithubFacts.parse({
      repo: repo.full_name,
      private: repo.private,
      defaultBranch: repo.default_branch,
      headSha: commit.sha,
      headCommitDate: commit.commit.committer.date,
      headCommitMessage: commit.commit.message.split("\n")[0]!.slice(0, 300),
      language: repo.language,
      sizeKb: repo.size,
      pushedAt: repo.pushed_at,
      openIssues: repo.open_issues_count,
      tree: entries.slice(0, TREE_LIMIT),
      treeTruncated: treeRaw.truncated || entries.length > TREE_LIMIT,
      readme,
    });
    return { facts, factsDigest: capabilityDigest(facts) };
  };
}
