import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CODE_CHANGE_LIMITS,
  CODE_CHANGE_TEST_WORKFLOW,
  CODE_CHANGE_WORKFLOW,
  ChangeFacts,
  RepoSlug,
  RunFacts,
  codeChangeBranch,
  codeChangeRunTitle,
  type ChangedFile,
} from "../../contracts/src/index.js";
import { capabilityDigest } from "../../capabilities/src/index.js";
import { GithubReadError, createGithubGet, parseGithub } from "./github-read.js";

/**
 * Mission #2 - the worker's GitHub client for `code-change/v1`.
 *
 * The only writes it can make are: dispatch the two fixed workflows, and open a DRAFT pull request from a
 * task branch into the default branch. It has no call that merges, pushes, deletes, edits settings or
 * touches another repository. Every method refuses a repository outside the configured allowlist before
 * any request is sent. Its token is expected to be a fine-grained token for the pilot repository only,
 * with Actions read/write, Contents read and Pull requests read/write: Contents read means GitHub itself
 * refuses a merge even if this code were changed to ask for one.
 *
 * Reads go through the same bounded GET as the read-only GitHub capabilities. The token travels only in
 * the Authorization header and never appears in a result or an error; errors are classified by status.
 */
export type GithubRunnerCode = "NOT_ALLOWED" | "HEAD_MOVED" | "NOT_DRAFT" | "BAD_INPUT";

export class GithubRunnerError extends Error {
  constructor(readonly code: GithubRunnerCode) {
    super(code);
    this.name = "GithubRunnerError";
  }
}

const API = "https://api.github.com";

export interface GithubRunnerConfig {
  /** Fine-grained token for the allowlisted repositories, from jVault via the worker environment. */
  token: string;
  /** The repositories this worker may change. Anything else is refused before a request is sent. */
  allowedRepos: readonly string[];
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

const RepoResponse = z.object({ full_name: z.string(), default_branch: z.string().min(1).max(200) });
const RunResponse = z.object({
  id: z.number().int().positive(),
  path: z.string(),
  event: z.string(),
  head_branch: z.string().nullable(),
  head_sha: z.string(),
  display_title: z.string(),
  status: z.string().nullable(),
  conclusion: z.string().nullable(),
});
const RunsResponse = z.object({ workflow_runs: z.array(RunResponse) });
const RefResponse = z.object({ object: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }) });
const CompareResponse = z.object({
  status: z.enum(["ahead", "behind", "diverged", "identical"]),
  ahead_by: z.number().int().nonnegative(),
  behind_by: z.number().int().nonnegative(),
  files: z
    .array(
      z.object({
        filename: z.string(),
        status: z.string(),
        additions: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative(),
        sha: z.string().nullable().optional(),
        patch: z.string().optional(),
        previous_filename: z.string().optional(),
      }),
    )
    .default([]),
});
const PullResponse = z.object({
  number: z.number().int().positive(),
  html_url: z.string().url(),
  draft: z.boolean(),
  head: z.object({ sha: z.string(), ref: z.string() }),
  base: z.object({ ref: z.string() }),
});

/** GitHub's compare API lists at most this many files; a full page means the list may be incomplete. */
const COMPARE_FILE_CAP = 300;

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

function toRunFacts(run: z.infer<typeof RunResponse>): RunFacts {
  return RunFacts.parse({
    id: run.id,
    // `path` can carry an `@ref` suffix; the workflow file is what matters.
    workflowPath: run.path.split("@")[0],
    event: run.event,
    headBranch: run.head_branch ?? "",
    headSha: run.head_sha,
    displayTitle: run.display_title.slice(0, 300),
    status: run.status ?? "unknown",
    conclusion: run.conclusion,
  });
}

export function createGithubRunner(config: GithubRunnerConfig) {
  if (!/^[^\s]{8,512}$/.test(config.token)) throw new Error("Invalid GitHub runner token configuration");
  const allowed = new Set(config.allowedRepos.map((r) => RepoSlug.parse(r).toLowerCase()));
  if (allowed.size === 0) throw new Error("The code-change repository allowlist is empty");
  const send = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? 15_000;
  const get = createGithubGet({ token: config.token, ...(config.fetch ? { fetch: config.fetch } : {}), timeoutMs });

  /** Refuses before any request: the allowlist is the boundary, not GitHub's permissions alone. */
  function base(repo: string): string {
    const slug = RepoSlug.parse(repo);
    if (!allowed.has(slug.toLowerCase())) throw new GithubRunnerError("NOT_ALLOWED");
    const [owner, name] = slug.split("/") as [string, string];
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  }

  /** The only non-GET requests this client makes. Same classification as the bounded GET; bodies of errors are never read. */
  async function post(path: string, body: unknown, expect: number): Promise<unknown | null> {
    let response: Response;
    try {
      response = await send(`${API}${path}`, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "kerneljson-mission/1",
          authorization: `Bearer ${config.token}`,
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new GithubReadError("NETWORK", true);
    }
    if (response.status !== expect) {
      await response.body?.cancel().catch(() => {});
      const status = response.status;
      if (status === 429 || (status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after"))))
        throw new GithubReadError("RATE_LIMITED", true);
      if (status === 404) throw new GithubReadError("NOT_FOUND", false);
      if (status === 301 || status === 302 || status === 307 || status === 308) throw new GithubReadError("RENAMED", false);
      if (status === 401 || status === 403) throw new GithubReadError("AUTH", false);
      if (status >= 500) throw new GithubReadError("UPSTREAM", true);
      throw new GithubReadError("MALFORMED", false);
    }
    if (expect === 204) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    try {
      return JSON.parse(await response.text()) as unknown;
    } catch {
      throw new GithubReadError("MALFORMED", false);
    }
  }

  async function defaultBranch(repo: string): Promise<string> {
    const r = parseGithub(RepoResponse, await get(base(repo)));
    if (r.full_name.toLowerCase() !== RepoSlug.parse(repo).toLowerCase()) throw new GithubReadError("RENAMED", false);
    return r.default_branch;
  }

  async function dispatch(repo: string, workflow: string, ref: string, inputs: Record<string, string>): Promise<void> {
    await post(`${base(repo)}/actions/workflows/${workflow}/dispatches`, { ref, inputs }, 204);
  }

  /** The newest run of a workflow carrying this task's exact title, or null if none has appeared yet. */
  async function findRun(repo: string, taskId: string, kind: "code" | "test"): Promise<RunFacts | null> {
    const workflow = kind === "code" ? CODE_CHANGE_WORKFLOW : CODE_CHANGE_TEST_WORKFLOW;
    const title = codeChangeRunTitle(taskId, kind);
    const q = new URLSearchParams({ event: "workflow_dispatch", per_page: "30" });
    const runs = parseGithub(RunsResponse, await get(`${base(repo)}/actions/workflows/${workflow}/runs?${q}`));
    const mine = runs.workflow_runs.filter((r) => r.display_title === title).sort((a, b) => b.id - a.id);
    return mine[0] ? toRunFacts(mine[0]) : null;
  }

  async function getRun(repo: string, runId: number): Promise<RunFacts> {
    if (!Number.isSafeInteger(runId) || runId <= 0) throw new GithubRunnerError("BAD_INPUT");
    return toRunFacts(parseGithub(RunResponse, await get(`${base(repo)}/actions/runs/${runId}`)));
  }

  async function branchHead(repo: string, taskId: string): Promise<string | null> {
    const raw = await get(`${base(repo)}/git/ref/heads/${codeChangeBranch(taskId)}`, true);
    return raw === null ? null : parseGithub(RefResponse, raw).object.sha;
  }

  return {
    defaultBranch,

    /** Start the coding run from the default branch's own workflow file; the instructions travel as an input. */
    async dispatchCode(input: { repo: string; taskId: string; baseSha: string; instructions: string }): Promise<void> {
      codeChangeBranch(input.taskId);
      if (!/^[0-9a-f]{40}$/.test(input.baseSha)) throw new GithubRunnerError("BAD_INPUT");
      if (input.instructions.length < CODE_CHANGE_LIMITS.minInstructionChars || input.instructions.length > CODE_CHANGE_LIMITS.maxInstructionChars)
        throw new GithubRunnerError("BAD_INPUT");
      const ref = await defaultBranch(input.repo);
      await dispatch(input.repo, CODE_CHANGE_WORKFLOW, ref, { task_id: input.taskId, base_sha: input.baseSha, instructions: input.instructions });
    },

    /** Start the test run ON the task branch, so GitHub reports the exact commit it tested. */
    async dispatchTest(input: { repo: string; taskId: string }): Promise<void> {
      await dispatch(input.repo, CODE_CHANGE_TEST_WORKFLOW, codeChangeBranch(input.taskId), { task_id: input.taskId });
    },

    findRun: (input: { repo: string; taskId: string; kind: "code" | "test" }) => findRun(input.repo, input.taskId, input.kind),
    getRun: (input: { repo: string; runId: number }) => getRun(input.repo, input.runId),
    branchHead: (input: { repo: string; taskId: string }) => branchHead(input.repo, input.taskId),

    /**
     * Capture the produced change as evidence: the branch head, the compare against the captured base (by SHA,
     * so it cannot move underneath), and both runs re-read by id. The patch text is returned separately for
     * the reviewer; the facts carry its digest and size.
     */
    async captureChange(input: {
      repo: string;
      taskId: string;
      baseSha: string;
      defaultBranch: string;
      codeRunId: number;
      testRunId: number;
    }): Promise<{ facts: ChangeFacts; factsDigest: string; patch: string }> {
      const repoBase = base(input.repo);
      if (!/^[0-9a-f]{40}$/.test(input.baseSha)) throw new GithubRunnerError("BAD_INPUT");
      const branch = codeChangeBranch(input.taskId);
      const head = await branchHead(input.repo, input.taskId);
      if (head === null) throw new GithubReadError("NOT_FOUND", false);
      const compare = parseGithub(CompareResponse, await get(`${repoBase}/compare/${input.baseSha}...${head}?per_page=100`));
      const parts: string[] = [];
      const files: ChangedFile[] = compare.files.map((f) => {
        if (f.patch !== undefined) parts.push(`--- ${f.previous_filename ?? f.filename}\n+++ ${f.filename}\n${f.patch}\n`);
        return {
          path: f.filename,
          status: f.status as ChangedFile["status"],
          previousPath: f.previous_filename ?? null,
          additions: f.additions,
          deletions: f.deletions,
          blobSha: f.status === "removed" ? null : (f.sha ?? null),
          patchSha256: f.patch === undefined ? null : sha256(f.patch),
        };
      });
      const patch = parts.join("");
      const facts = ChangeFacts.parse({
        repo: RepoSlug.parse(input.repo),
        defaultBranch: input.defaultBranch,
        baseSha: input.baseSha,
        branch,
        headSha: head,
        compareStatus: compare.status,
        aheadBy: compare.ahead_by,
        behindBy: compare.behind_by,
        files,
        filesTruncated: compare.files.length >= COMPARE_FILE_CAP,
        patchBytes: Buffer.byteLength(patch, "utf8"),
        codeRun: await getRun(input.repo, input.codeRunId),
        testRun: await getRun(input.repo, input.testRunId),
      });
      return { facts, factsDigest: capabilityDigest(facts), patch };
    },

    /**
     * Open the draft PR, only for the reconciled head. The branch is re-read first and must still be the
     * reviewed commit; GitHub's answer must be a draft from the task branch into the default branch at that
     * commit, or it is reported as an error (the PR is then left for Jonny to close, never merged).
     */
    async openDraftPr(input: {
      repo: string;
      taskId: string;
      defaultBranch: string;
      expectedHeadSha: string;
      title: string;
      body: string;
    }): Promise<{ number: number; url: string; headSha: string }> {
      const repoBase = base(input.repo);
      const branch = codeChangeBranch(input.taskId);
      if (input.title.length < 1 || input.title.length > 200 || input.body.length > 60_000) throw new GithubRunnerError("BAD_INPUT");
      if ((await branchHead(input.repo, input.taskId)) !== input.expectedHeadSha) throw new GithubRunnerError("HEAD_MOVED");
      const pr = parseGithub(
        PullResponse,
        await post(
          `${repoBase}/pulls`,
          { title: input.title, body: input.body, head: branch, base: input.defaultBranch, draft: true, maintainer_can_modify: false },
          201,
        ),
      );
      if (!pr.draft || pr.head.ref !== branch || pr.base.ref !== input.defaultBranch) throw new GithubRunnerError("NOT_DRAFT");
      if (pr.head.sha !== input.expectedHeadSha) throw new GithubRunnerError("HEAD_MOVED");
      return { number: pr.number, url: pr.html_url, headSha: pr.head.sha };
    },
  };
}

export type GithubRunner = ReturnType<typeof createGithubRunner>;
