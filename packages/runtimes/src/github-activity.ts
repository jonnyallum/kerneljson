import { z } from "zod";
import {
  BRIEF_MAX_ACTIVE_REPOS,
  BRIEF_MAX_COMMITS,
  BRIEF_MAX_PULLS,
  BRIEF_WINDOW_HOURS,
  GithubActivity,
  RepoSlug,
  type BriefActiveRepo,
} from "../../contracts/src/index.js";
import { capabilityDigest } from "../../capabilities/src/index.js";
import { GithubReadError, createGithubGet, parseGithub, type GithubReaderConfig } from "./github-read.js";

/**
 * Read-only GitHub activity for the morning brief: every repository the read token can see that was
 * pushed to inside the window, with its recent commits on the default branch, its open pull requests
 * and its latest default-branch workflow run.
 *
 * GET only, through the same bounded client as `github.read`. One listing request, then at most three
 * requests per active repository. A repository whose pull requests or workflow runs the token may not
 * read is reported with those fields empty rather than failing the brief; anything else (no token, a
 * rate limit, an upstream outage) fails it, so a brief never silently covers less than it claims.
 */
const PER_PAGE = 100;
const CONCURRENCY = 5;

const RepoListing = z.array(
  z.object({
    full_name: z.string(),
    private: z.boolean(),
    default_branch: z.string().min(1).max(200),
    pushed_at: z.string().nullable(),
    archived: z.boolean().optional(),
  }),
);
const Commits = z.array(
  z.object({
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    author: z.object({ login: z.string() }).nullable().optional(),
    commit: z.object({
      author: z.object({ name: z.string().optional(), date: z.string() }).nullable(),
      committer: z.object({ date: z.string() }).nullable(),
      message: z.string(),
    }),
  }),
);
const Pulls = z.array(
  z.object({
    number: z.number().int().positive(),
    title: z.string(),
    draft: z.boolean().optional(),
    updated_at: z.string(),
    user: z.object({ login: z.string() }).nullable(),
  }),
);
const Runs = z.object({
  workflow_runs: z.array(
    z.object({
      id: z.number().int().positive(),
      name: z.string().nullable(),
      status: z.string().nullable(),
      conclusion: z.string().nullable(),
      head_sha: z.string().regex(/^[0-9a-f]{40}$/),
      updated_at: z.string(),
    }),
  ),
});

async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

export function createGithubActivityReader(config: GithubReaderConfig = {}) {
  const get = createGithubGet(config);
  const now = (): Date => new Date();

  return async function readActivity(input: { windowEnd?: string } = {}): Promise<{ activity: GithubActivity; activityDigest: string }> {
    if (!config.token) throw new GithubReadError("AUTH", false);
    const end = input.windowEnd ? new Date(input.windowEnd) : now();
    const start = new Date(end.getTime() - BRIEF_WINDOW_HOURS * 3_600_000);
    const since = start.toISOString();

    const listing = parseGithub(RepoListing, await get(`/user/repos?per_page=${PER_PAGE}&sort=pushed&direction=desc`));
    const recent = listing.filter(
      (r) => !r.archived && r.pushed_at !== null && Date.parse(r.pushed_at) >= start.getTime() && RepoSlug.safeParse(r.full_name).success,
    );

    const active = await pool(recent.slice(0, BRIEF_MAX_ACTIVE_REPOS), CONCURRENCY, async (r): Promise<BriefActiveRepo> => {
      const [owner, name] = r.full_name.split("/") as [string, string];
      const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
      const branch = encodeURIComponent(r.default_branch);
      // 409 is GitHub's answer for an empty repository.
      const commitsRaw = await get(`${base}/commits?sha=${branch}&since=${encodeURIComponent(since)}&per_page=${BRIEF_MAX_COMMITS + 1}`, true, [409]);
      const commits = commitsRaw === null ? [] : parseGithub(Commits, commitsRaw);
      const pullsRaw = await get(`${base}/pulls?state=open&sort=updated&direction=desc&per_page=${BRIEF_MAX_PULLS + 1}`, true, [403]);
      const pulls = pullsRaw === null ? null : parseGithub(Pulls, pullsRaw);
      const runsRaw = await get(`${base}/actions/runs?branch=${branch}&per_page=1`, true, [403]);
      const run = runsRaw === null ? undefined : parseGithub(Runs, runsRaw).workflow_runs[0];
      return {
        repo: r.full_name,
        private: r.private,
        defaultBranch: r.default_branch,
        pushedAt: r.pushed_at!,
        commits: commits.slice(0, BRIEF_MAX_COMMITS).map((c) => ({
          sha: c.sha,
          date: c.commit.committer?.date ?? c.commit.author?.date ?? r.pushed_at!,
          author: (c.author?.login ?? c.commit.author?.name ?? "unknown").slice(0, 100),
          message: c.commit.message.split("\n")[0]!.slice(0, 200),
        })),
        commitsTruncated: commits.length > BRIEF_MAX_COMMITS,
        openPulls:
          pulls === null
            ? null
            : pulls.slice(0, BRIEF_MAX_PULLS).map((p) => ({
                number: p.number,
                title: p.title.slice(0, 200),
                author: (p.user?.login ?? "unknown").slice(0, 100),
                draft: p.draft ?? false,
                updatedAt: p.updated_at,
              })),
        pullsTruncated: pulls !== null && pulls.length > BRIEF_MAX_PULLS,
        ci: run
          ? {
              runId: run.id,
              name: (run.name ?? "workflow").slice(0, 200),
              status: (run.status ?? "unknown").slice(0, 40),
              conclusion: run.conclusion === null ? null : run.conclusion.slice(0, 40),
              headSha: run.head_sha,
              updatedAt: run.updated_at,
            }
          : null,
      };
    });

    const result = GithubActivity.safeParse({
      windowStart: since,
      windowEnd: end.toISOString(),
      reposVisible: listing.length,
      reposVisibleTruncated: listing.length >= PER_PAGE,
      active,
      activeTruncated: recent.length > BRIEF_MAX_ACTIVE_REPOS,
    });
    if (!result.success) throw new GithubReadError("MALFORMED", false);
    return { activity: result.data, activityDigest: capabilityDigest(result.data) };
  };
}
