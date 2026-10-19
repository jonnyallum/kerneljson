import { GithubActivity, KernelState, type BriefActiveRepo } from "../../packages/contracts/src/index.js";
import { capabilityDigest } from "../../packages/capabilities/src/index.js";
import { sha256Text } from "../../services/kernel/src/mission/reconcile.js";
import { fakeRuntime, type FakeReply } from "./mission-fixture.js";

/**
 * Doubles for the morning brief. Like the mission fixture, the fake runtimes read what they need out
 * of the PROMPT (window end, references, the brief digest), so the tests exercise the real prompt.
 */
export const WINDOW_END = "2026-10-20T06:00:00.000Z";
export const WINDOW_START = "2026-10-19T06:00:00.000Z";
export const SHA_A = "1".repeat(40);
export const SHA_B = "2".repeat(40);

export function makeRepo(over: Partial<BriefActiveRepo> = {}): BriefActiveRepo {
  return {
    repo: "jonnyallum/kerneljson",
    private: true,
    defaultBranch: "main",
    pushedAt: "2026-10-19T21:00:00Z",
    commits: [
      { sha: SHA_A, date: "2026-10-19T20:00:00Z", author: "jonnyallum", message: "feat(brief): add morning brief" },
      { sha: SHA_B, date: "2026-10-19T21:00:00Z", author: "jonnyallum", message: "test(brief): cover the reconciler" },
    ],
    commitsTruncated: false,
    openPulls: [{ number: 56, title: "Morning brief mission", author: "jonnyallum", draft: false, updatedAt: "2026-10-19T21:05:00Z" }],
    pullsTruncated: false,
    ci: { runId: 99, name: "ci", status: "completed", conclusion: "failure", headSha: SHA_B, updatedAt: "2026-10-19T21:10:00Z" },
    ...over,
  };
}

export function makeActivity(over: Partial<GithubActivity> = {}): GithubActivity {
  return GithubActivity.parse({
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    reposVisible: 40,
    reposVisibleTruncated: false,
    active: [makeRepo(), makeRepo({ repo: "jonnyallum/agent-hub-conductor", openPulls: null, ci: null, commits: [] })],
    activeTruncated: false,
    ...over,
  });
}

export const activityResult = (activity: GithubActivity = makeActivity()) => ({ activity, activityDigest: capabilityDigest(activity) });

export const KERNEL: KernelState = KernelState.parse({
  tasks: [{ recipe: "claude_md_check/v1", status: "COMPLETED", count: 1 }],
  lastCanary: { taskId: "11111111-1111-4111-8111-111111111111", status: "COMPLETED", createdAt: "2026-10-19T08:00:00.000Z" },
});

/** The references the evidence lines carry, in prompt order. */
export const promptRefs = (prompt: string): string[] =>
  [...prompt.matchAll(/^\s*\[((?:commit|pr|ci):[^\]]+|kj:[a-z]+|scan)\]/gm)].map((m) => m[1]!);

export function briefJson(opts: { windowEnd?: string; items?: Array<{ refs: string[] }>; headline?: string } = {}): string {
  return JSON.stringify({
    windowEnd: opts.windowEnd ?? WINDOW_END,
    headline: opts.headline ?? "CI is failing on kerneljson after last night's brief work; one PR is open.",
    items: (opts.items ?? [{ refs: ["ci:jonnyallum/kerneljson", "pr:jonnyallum/kerneljson#56"] }]).map((it, i) => ({
      title: `Item ${i + 1}: kerneljson CI failing`,
      detail: "The latest default-branch run failed on the brief test commit, with PR #56 still open.",
      refs: it.refs,
    })),
  });
}

/** DeepSeek-like analyst: copies the window end and cites references straight from the prompt. */
export function fakeBriefAnalyst(over: { refs?: string[]; items?: Array<{ refs: string[] }>; windowEnd?: string; reply?: FakeReply; model?: string; responseModel?: string; provider?: string; memory?: boolean } = {}) {
  return fakeRuntime({
    model: over.model ?? "deepseek-flash",
    provider: over.provider ?? "deepseek",
    ...(over.responseModel ? { responseModel: over.responseModel } : {}),
    reply: (prompt) => {
      if (over.reply !== undefined) return over.reply;
      const end = /window (\S+) to (\S+);/.exec(prompt)?.[2] ?? "";
      const refs = promptRefs(prompt);
      const memory = over.memory ? [...prompt.matchAll(/^- \[[A-Z_]+\/[A-Z_]+ v\d+ ([0-9a-f]{8})\]/gm)].map((m) => `memory:${m[1]}`) : [];
      const items = over.items ?? [{ refs: over.refs ?? refs.filter((r) => r.startsWith("ci:") || r.startsWith("pr:")).slice(0, 2) }, ...(memory.length ? [{ refs: memory }] : [])];
      return briefJson({ windowEnd: over.windowEnd ?? end, items });
    },
  });
}

/** Sonnet-like reviewer: copies the brief digest and the verbatim brief out of the prompt. */
export function fakeBriefReviewer(over: { verdict?: "approve" | "approve_with_notes" | "reject"; unsupported?: number[]; echoDigest?: string; reply?: FakeReply; model?: string; responseModel?: string } = {}) {
  return fakeRuntime({
    model: over.model ?? "anthropic/claude-sonnet-test",
    ...(over.responseModel ? { responseModel: over.responseModel } : {}),
    reply: (prompt) => {
      if (over.reply !== undefined) return over.reply;
      const briefText = /BRIEF \(verbatim\):\n([\s\S]*?)\n\n/.exec(prompt)?.[1] ?? "";
      return JSON.stringify({
        reviewedAnalysisSha256: over.echoDigest ?? sha256Text(briefText),
        verdict: over.verdict ?? "approve",
        unsupportedFindings: over.unsupported ?? [],
        notes: [],
      });
    },
  });
}
