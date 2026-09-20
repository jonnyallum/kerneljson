import { createHash } from "node:crypto";
import {
  GithubFacts,
  ModelCallResult,
  ModelRequest,
  type FindingEvidence,
  type ModelErrorCode,
} from "../../packages/contracts/src/index.js";
import { capabilityDigest } from "../../packages/capabilities/src/index.js";
import { modelDigest, type ModelPort } from "../../packages/models/src/index.js";
import { sha256Text } from "../../services/kernel/src/mission/reconcile.js";

/**
 * Test doubles for the mission. The fake runtimes read what they need out of the PROMPT
 * (head sha, tree paths, analysis digest), exactly as a real model would, so these tests
 * exercise the real prompt contract instead of canned answers.
 */
export const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
export const REPO = "jonnyallum/kerneljson";

/** A stable, distinct git object id per path. `salt` yields the ids another commit would hold. */
export const shaFor = (path: string, salt = ""): string => createHash("sha1").update(`${salt}${path}`).digest("hex");

/** A citation as the analyst must write it: the path and the 12 character object id prefix. */
export const cite = (path: string, salt = ""): FindingEvidence => ({ path, blobSha: shaFor(path, salt).slice(0, 12) });

export function makeFacts(overrides: Partial<GithubFacts> = {}): GithubFacts {
  return GithubFacts.parse({
    repo: REPO,
    private: true,
    defaultBranch: "main",
    headSha: HEAD,
    headCommitDate: "2026-09-19T14:00:00Z",
    headCommitMessage: "docs(alerting): freeze KJ-P2.2A",
    language: "TypeScript",
    sizeKb: 4200,
    pushedAt: "2026-09-19T14:05:00Z",
    openIssues: 0,
    tree: [
      { path: "README.md", type: "blob" as const },
      { path: "ARCHITECTURE.md", type: "blob" as const },
      { path: "services", type: "tree" as const },
      { path: "services/kernel", type: "tree" as const },
      { path: "services/kernel/src/index.ts", type: "blob" as const },
      { path: "services/kernel/src/ledger.ts", type: "blob" as const },
      { path: "docs/operations/TELEGRAM_TRANSPORT.md", type: "blob" as const },
    ].map((e) => ({ ...e, sha: shaFor(e.path) })),
    treeTruncated: false,
    readme: { path: "README.md", sha256: "b".repeat(64), excerpt: "KernelJSON is a durable cognitive execution platform." },
    ...overrides,
  });
}

export function githubResult(facts: GithubFacts = makeFacts()) {
  return { facts, factsDigest: capabilityDigest(facts) };
}

export const CITED = ["services/kernel/src/ledger.ts", "README.md"];

export function analysisJson(
  opts: { headSha?: string; paths?: string[]; evidence?: FindingEvidence[]; findings?: number } = {},
): string {
  const evidence = opts.evidence ?? (opts.paths ?? CITED).map((p) => cite(p));
  const count = opts.findings ?? 1;
  return JSON.stringify({
    headSha: opts.headSha ?? HEAD,
    summary: "KernelJSON is a durable task kernel: a Restate workflow drives a ledger that only completes on verified evidence.",
    findings: Array.from({ length: count }, (_, i) => ({
      title: `Completion is evidence-bound${count > 1 ? ` (${i + 1})` : ""}`,
      detail: "The ledger re-verifies the plan, steps and evidence inside the transaction that commits COMPLETED.",
      evidence,
    })),
  });
}

export function reviewJson(opts: {
  analysisText: string;
  verdict?: "approve" | "approve_with_notes" | "reject";
  unsupported?: number[];
  echoDigest?: string;
}): string {
  return JSON.stringify({
    reviewedAnalysisSha256: opts.echoDigest ?? sha256Text(opts.analysisText),
    verdict: opts.verdict ?? "approve",
    unsupportedFindings: opts.unsupported ?? [],
    notes: ["Findings match the tree evidence."],
  });
}

export type FakeReply = string | { fail: ModelErrorCode };

/** A ModelPort that answers `reply(promptText)` and produces a valid, self-consistent receipt. */
export function fakeRuntime(config: {
  model: string;
  responseModel?: string;
  /** The port label on the receipt, for example `deepseek` or `openrouter` (the default). */
  provider?: string;
  reply: (prompt: string) => FakeReply;
}): ModelPort {
  const provider = config.provider ?? "openrouter";
  return {
    async generate(raw) {
      const request = ModelRequest.parse(raw);
      const prompt = request.messages.map((m) => m.content).join("\n");
      const base = {
        callId: request.callId,
        taskId: request.taskId,
        stepId: request.stepId,
        trace: request.trace,
        provider,
        model: config.model,
        requestDigest: modelDigest({ provider, model: config.model, request }),
        finishedAt: new Date().toISOString(),
        durationMs: 3,
      };
      const out = config.reply(prompt);
      if (typeof out !== "string")
        return ModelCallResult.parse({
          status: "FAILED",
          receipt: { ...base, status: "FAILED", error: { code: out.fail, retryable: true, mayHaveRun: false, httpStatus: 429 } },
        });
      return ModelCallResult.parse({
        status: "SUCCEEDED",
        text: out,
        receipt: {
          ...base,
          status: "SUCCEEDED",
          providerRequestId: "gen-test-0001",
          responseModel: config.responseModel ?? config.model,
          usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 },
          outputDigest: modelDigest(out),
        },
      });
    },
  };
}

/**
 * Claude-like analyst: reads the head sha and, for each path it cites, the path and the object id
 * prefix straight from the prompt's tree list, exactly as the prompt tells a real model to.
 * A path missing from the prompt gets an all-zero prefix.
 */
export function fakeClaude(
  over: {
    headSha?: string;
    paths?: string[];
    evidence?: FindingEvidence[];
    findings?: number;
    responseModel?: string;
    reply?: FakeReply;
    model?: string;
    provider?: string;
  } = {},
) {
  return fakeRuntime({
    model: over.model ?? "anthropic/claude-test",
    ...(over.responseModel ? { responseModel: over.responseModel } : {}),
    ...(over.provider ? { provider: over.provider } : {}),
    reply: (prompt) => {
      if (over.reply !== undefined) return over.reply;
      const head = /head sha: ([0-9a-f]{40})/.exec(prompt)?.[1] ?? "";
      const prefixes = new Map([...prompt.matchAll(/^[fd] ([0-9a-f]{12}) (.+)$/gm)].map((m) => [m[2]!, m[1]!] as const));
      const evidence =
        over.evidence ?? (over.paths ?? CITED).map((path) => ({ path, blobSha: prefixes.get(path) ?? "0".repeat(12) }));
      return analysisJson({ headSha: over.headSha ?? head, evidence, ...(over.findings ? { findings: over.findings } : {}) });
    },
  });
}

/** Grok-like reviewer: copies the analysis digest and the verbatim analysis out of the prompt. */
export function fakeGrok(over: { verdict?: "approve" | "approve_with_notes" | "reject"; unsupported?: number[]; echoDigest?: string; responseModel?: string; reply?: FakeReply; model?: string; provider?: string } = {}) {
  return fakeRuntime({
    model: over.model ?? "x-ai/grok-test",
    ...(over.responseModel ? { responseModel: over.responseModel } : {}),
    ...(over.provider ? { provider: over.provider } : {}),
    reply: (prompt) => {
      if (over.reply !== undefined) return over.reply;
      const analysisText = /ANALYSIS \(verbatim\):\n([\s\S]*?)\n\nEVIDENCE/.exec(prompt)?.[1] ?? "";
      return reviewJson({
        analysisText,
        ...(over.verdict ? { verdict: over.verdict } : {}),
        ...(over.unsupported ? { unsupported: over.unsupported } : {}),
        ...(over.echoDigest ? { echoDigest: over.echoDigest } : {}),
      });
    },
  });
}
