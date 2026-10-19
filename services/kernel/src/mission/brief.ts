import {
  BRIEF_RECONCILE_CHECKS,
  BriefAnalysis,
  BriefFacts,
  BriefReconciliation,
  Evidence,
  MISSION_RUNTIME_FAMILIES,
  MissionReview,
  ModelRequest,
  modelFamily,
  sameModel,
  type TraceRef,
} from "../../../../packages/contracts/src/index.js";
import { capabilityDigest } from "../../../../packages/capabilities/src/index.js";
import { escapeTelegramMarkdownV2 } from "../alerting/format.js";
import { parseRuntimeJson, sha256Text } from "./reconcile.js";

/**
 * The morning brief's kernel logic. Pure, deterministic, no I/O, and shared by the workflow and the
 * ledger's completion verifier so the two cannot drift.
 *
 * Every line of evidence the analyst sees carries a reference (`commit:owner/repo@1a2b3c4d5e6f`,
 * `pr:owner/repo#12`, `ci:owner/repo`, `kj:tasks`, `kj:canary`, `memory:1a2b3c4d`, or `scan` for the
 * repository listing as a whole). Every item in the brief must cite at least one, and every one it
 * cites must exist in the persisted evidence. The reviewer then judges whether each item's claim
 * follows from what it cites.
 */
export const BRIEF_SOURCES = {
  facts: "kerneljson:github-activity/v1",
  analyst: "kerneljson:runtime/analyst",
  reviewer: "kerneljson:runtime/reviewer",
  reconcile: "kerneljson:brief-reconcile/v1",
} as const;

export const BRIEF_ANALYST_MAX_TOKENS = 4096;
export const BRIEF_REVIEWER_MAX_TOKENS = 4096;

const short = (sha: string): string => sha.slice(0, 12);

/** Every reference the evidence supports. Memory references are the 8 character prefix the prompt shows. */
export function briefRefs(facts: BriefFacts, memoryIds: readonly string[]): Set<string> {
  const refs = new Set<string>(["scan", "kj:tasks"]);
  if (facts.kernel.lastCanary) refs.add("kj:canary");
  for (const r of facts.github.active) {
    refs.add(`repo:${r.repo}`);
    for (const c of r.commits) refs.add(`commit:${r.repo}@${short(c.sha)}`);
    for (const p of r.openPulls ?? []) refs.add(`pr:${r.repo}#${p.number}`);
    if (r.ci) refs.add(`ci:${r.repo}`);
  }
  for (const id of memoryIds) refs.add(`memory:${id.slice(0, 8)}`);
  return refs;
}

export function renderBriefFacts(facts: BriefFacts, factsDigest: string): string {
  const g = facts.github;
  const lines = [
    `EVIDENCE (read-only, digest ${factsDigest})`,
    `[scan] window ${g.windowStart} to ${g.windowEnd}; repositories visible: ${g.reposVisible}${g.reposVisibleTruncated ? " (only the 100 most recently pushed were scanned)" : ""}; pushed to in the window: ${g.active.length}${g.activeTruncated ? " (more were active; only these were read)" : ""}`,
  ];
  for (const r of g.active) {
    lines.push("", `[repo:${r.repo}] REPOSITORY ${r.repo} (${r.private ? "private" : "public"}, default branch ${r.defaultBranch}, last push ${r.pushedAt})`);
    if (r.commits.length === 0) lines.push("  no commits on the default branch in the window");
    for (const c of r.commits) lines.push(`  [commit:${r.repo}@${short(c.sha)}] ${c.date} ${c.author}: ${c.message}`);
    if (r.commitsTruncated) lines.push("  (more commits than shown)");
    if (r.openPulls === null) lines.push("  open pull requests: not readable with this token");
    else if (r.openPulls.length === 0) lines.push("  no open pull requests");
    for (const p of r.openPulls ?? [])
      lines.push(`  [pr:${r.repo}#${p.number}] open${p.draft ? " draft" : ""} PR #${p.number} by ${p.author}, updated ${p.updatedAt}: ${p.title}`);
    if (r.pullsTruncated) lines.push("  (more open pull requests than shown)");
    if (r.ci)
      lines.push(`  [ci:${r.repo}] latest workflow run "${r.ci.name}" on ${short(r.ci.headSha)}: ${r.ci.status}${r.ci.conclusion ? `/${r.ci.conclusion}` : ""} at ${r.ci.updatedAt}`);
    else lines.push("  no readable workflow runs on the default branch");
  }
  lines.push("", "KERNELJSON (its own ledger)");
  const t = facts.kernel.tasks;
  lines.push(
    `[kj:tasks] tasks created in the window, by recipe and status: ${t.length === 0 ? "none" : t.map((x) => `${x.recipe} ${x.status} x${x.count}`).join("; ")}`,
  );
  if (facts.kernel.lastCanary)
    lines.push(`[kj:canary] latest CLAUDE.md canary: ${facts.kernel.lastCanary.status}, created ${facts.kernel.lastCanary.createdAt}`);
  else lines.push("no canary task on record");
  return lines.join("\n");
}

const ANALYST_SYSTEM = [
  "You are the analyst runtime writing Jonny's KernelJSON morning brief.",
  "You see only the evidence provided: the last 24 hours of activity across his GitHub repositories and KernelJSON's own task state, plus any operator memory.",
  "Write what he needs to know this morning: what moved, what is stuck or failing (failed CI, stale or draft pull requests, failed tasks, a failed canary), and anything his operator memory says he cares about. Group related activity; do not list every commit.",
  "A quiet day is a valid brief: say so plainly and cite [scan].",
  "Every item must cite at least one reference, copied exactly from the square brackets in the evidence or the memory lines (for memory, write memory: followed by the 8 character id shown). Do not invent references, repositories, commits or numbers.",
  "Cite what the item actually rests on. An item that summarises a repository's activity as a whole cites that repository's [repo:...] reference; an item about a specific commit, pull request or run cites that one.",
  "Reply with ONE JSON object and nothing else, in exactly this shape:",
  '{"windowEnd": "<the window end from the evidence, copied exactly>", "headline": "<one sentence>", "items": [{"title": "<string>", "detail": "<string>", "refs": ["<reference>"]}]}',
  "Between 1 and 8 items, most important first. UK English, plain tone.",
  "Hard limits, or the brief is rejected: headline at most 200 characters; each title at most 80 characters; each detail at most 400 characters; each item 1 to 8 refs.",
].join("\n");

const REVIEWER_SYSTEM = [
  "You are the independent reviewer runtime for a KernelJSON morning brief.",
  "Check every item of the brief against the evidence. The kernel separately checks that each cited reference exists; your job is to judge whether what each item CLAIMS follows from the evidence it cites. An item that overstates, misreads or invents (a wrong count, a failure that did not happen, a cause the evidence does not show) is unsupported.",
  "Reply with ONE JSON object and nothing else, in exactly this shape:",
  '{"reviewedAnalysisSha256": "<the brief digest, copied exactly>", "verdict": "approve" | "approve_with_notes" | "reject", "unsupportedFindings": [<0-based indexes of unsupported items>], "notes": ["<short string>"]}',
  'Use "approve" only if every item is supported and unsupportedFindings is empty. A [repo:...] reference stands for everything listed under that repository.',
  'Items you list in unsupportedFindings are withheld from Jonny; the rest are delivered. Use "reject" only if the brief as a whole, including its headline, is misleading.',
  "Be concise: at most 3 notes, each one sentence under 160 characters. No text outside the JSON object.",
].join("\n");

interface Common {
  callId: string;
  taskId: string;
  stepId: string;
  trace: TraceRef;
  facts: BriefFacts;
  factsDigest: string;
}

export function briefAnalystRequest(input: Common & { memory?: string }): ModelRequest {
  const memory = input.memory && input.memory.length > 0 ? `${input.memory}\n\n` : "";
  return ModelRequest.parse({
    callId: input.callId,
    taskId: input.taskId,
    stepId: input.stepId,
    trace: input.trace,
    maxOutputTokens: BRIEF_ANALYST_MAX_TOKENS,
    messages: [
      { role: "system", content: ANALYST_SYSTEM },
      { role: "user", content: `${memory}${renderBriefFacts(input.facts, input.factsDigest)}` },
    ],
  });
}

export function briefReviewerRequest(input: Common & { analysisText: string; analysisDigest: string; memory?: string }): ModelRequest {
  return ModelRequest.parse({
    callId: input.callId,
    taskId: input.taskId,
    stepId: input.stepId,
    trace: input.trace,
    maxOutputTokens: BRIEF_REVIEWER_MAX_TOKENS,
    messages: [
      { role: "system", content: REVIEWER_SYSTEM },
      {
        role: "user",
        content: [
          `Brief digest (copy exactly): ${input.analysisDigest}`,
          "BRIEF (verbatim):",
          input.analysisText,
          "",
          ...(input.memory ? [input.memory, ""] : []),
          renderBriefFacts(input.facts, input.factsDigest),
        ].join("\n"),
      },
    ],
  });
}

function tryParse<T>(parse: (v: unknown) => T, text: string): T | null {
  try {
    return parse(parseRuntimeJson(text));
  } catch {
    return null;
  }
}
export const parseBrief = (text: string): BriefAnalysis | null => tryParse((v) => BriefAnalysis.parse(v), text);
const parseReview = (text: string): MissionReview | null => tryParse((v) => MissionReview.parse(v), text);

export interface BriefReconcileInput {
  facts: BriefFacts;
  /** The memory ids the analyst was given, from its own evidence. */
  memoryIds: readonly string[];
  analysisText: string;
  analystModel: string;
  analystProvider: string;
  reviewText: string;
  reviewerModel: string;
  reviewerProvider: string;
}

const runtimeAllowed = (model: string): boolean => (MISSION_RUNTIME_FAMILIES as readonly string[]).includes(modelFamily(model));

export function reconcileBrief(input: BriefReconcileInput): BriefReconciliation {
  const facts = BriefFacts.parse(input.facts);
  const brief = parseBrief(input.analysisText);
  const review = parseReview(input.reviewText);
  const refs = briefRefs(facts, input.memoryIds);
  const analysisDigest = sha256Text(input.analysisText);
  const items = brief?.items ?? [];
  const results: Record<(typeof BRIEF_RECONCILE_CHECKS)[number], boolean> = {
    brief_schema_valid: brief !== null,
    brief_window_matches_evidence: brief !== null && Date.parse(brief.windowEnd) === Date.parse(facts.github.windowEnd),
    brief_items_cited: brief !== null && items.every((i) => i.refs.length > 0),
    brief_refs_exist_in_evidence: brief !== null && items.every((i) => i.refs.every((r) => refs.has(r.trim()))),
    review_schema_valid: review !== null,
    review_binds_to_analysis: review !== null && review.reviewedAnalysisSha256 === analysisDigest,
    analyst_runtime_allowed: runtimeAllowed(input.analystModel),
    reviewer_runtime_allowed: runtimeAllowed(input.reviewerModel),
    reviewer_is_independent: !sameModel(input.analystModel, input.reviewerModel),
    review_verdict_acceptable: review !== null && review.verdict !== "reject",
    review_leaves_supported_items:
      review !== null &&
      brief !== null &&
      review.unsupportedFindings.every((i) => i < items.length) &&
      items.some((_, i) => !review.unsupportedFindings.includes(i)),
  };
  const checks = BRIEF_RECONCILE_CHECKS.map((name) => ({ name, passed: results[name] }));
  const analystFamily = modelFamily(input.analystModel);
  const reviewerFamily = modelFamily(input.reviewerModel);
  return BriefReconciliation.parse({
    decision: checks.every((c) => c.passed) ? "ACCEPTED" : "REJECTED",
    checks,
    itemCount: items.length,
    withheldItems: review ? [...new Set(review.unsupportedFindings)].sort((x, y) => x - y) : [],
    factsDigest: capabilityDigest(facts),
    analysisDigest,
    reviewDigest: sha256Text(input.reviewText),
    analystModel: input.analystModel,
    reviewerModel: input.reviewerModel,
    independence: {
      analystProvider: input.analystProvider,
      reviewerProvider: input.reviewerProvider,
      analystFamily,
      reviewerFamily,
      crossProvider: input.analystProvider !== input.reviewerProvider,
      crossFamily: analystFamily !== reviewerFamily,
    },
  });
}

/** Deterministic outcome summary, so the ledger can require the outcome to say exactly this. */
export const briefSummary = (brief: BriefAnalysis): string => `Brief accepted: ${brief.headline}`.slice(0, 500);

export const briefFailedChecks = (rec: BriefReconciliation): string[] => rec.checks.filter((c) => !c.passed).map((c) => c.name);

export const briefStepOutputs = {
  facts: (factsDigest: string) => ({ facts_digest: factsDigest }),
  runtime: (digest: string) => ({ output_digest: digest }),
  reconcile: (rec: BriefReconciliation) => ({ decision: rec.decision }),
};

interface Base {
  id: string;
  taskId: string;
  stepId: string;
  capturedAt: string;
}

export function briefFactsEvidence(args: Base & { facts: BriefFacts; factsDigest: string }): Evidence {
  return Evidence.parse({
    id: args.id,
    taskId: args.taskId,
    stepId: args.stepId,
    type: "TOOL_RECEIPT",
    source: BRIEF_SOURCES.facts,
    digest: args.factsDigest,
    capturedAt: args.capturedAt,
    metadata: {
      capability: "github.activity",
      content_sha256: args.factsDigest,
      github_digest: args.facts.githubDigest,
      active_repos: args.facts.github.active.length,
      facts: args.facts,
    },
  });
}

export function briefReconcileEvidence(args: Base & { rec: BriefReconciliation }): Evidence {
  return Evidence.parse({
    id: args.id,
    taskId: args.taskId,
    stepId: args.stepId,
    type: "DETERMINISTIC_RESULT",
    source: BRIEF_SOURCES.reconcile,
    digest: capabilityDigest(args.rec),
    capturedAt: args.capturedAt,
    metadata: args.rec,
  });
}

/** Telegram allows 4096 characters after MarkdownV2 escaping; stay clear of it. */
export const BRIEF_MESSAGE_LIMIT = 3800;

const UK_DATE = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });

/**
 * The text Jonny receives. Built only from an ACCEPTED brief, so every item in it was cited and
 * reviewed. Items that would push the escaped message past the limit are dropped from the end, with a
 * pointer to the full task, so the message can never be refused by Telegram for its length.
 */
export function briefMessage(
  brief: BriefAnalysis,
  args: { taskId: string; activeRepos: number; reviewerModel: string; withheldItems?: readonly number[] },
): string {
  const withheld = new Set(args.withheldItems ?? []);
  const kept = brief.items.filter((_, i) => !withheld.has(i));
  const head = [`Morning brief, ${UK_DATE.format(new Date(brief.windowEnd)).replace(",", "")}`, brief.headline];
  const foot = (dropped: number) =>
    [
      ...(dropped > 0 ? [`(${dropped} more item${dropped === 1 ? "" : "s"}: /task ${args.taskId})`] : []),
      ...(withheld.size > 0 ? [`${withheld.size} item${withheld.size === 1 ? "" : "s"} withheld: the reviewer found ${withheld.size === 1 ? "it" : "them"} unsupported.`] : []),
      `${args.activeRepos} active repo${args.activeRepos === 1 ? "" : "s"}; reviewed by ${args.reviewerModel}. Task ${args.taskId.slice(0, 8)}`,
    ].join("\n");
  const body = (n: number) => kept.slice(0, n).map((it, i) => `${i + 1}. ${it.title}\n${it.detail}`);
  for (let n = kept.length; n >= 0; n--) {
    const text = [...head, ...body(n), foot(kept.length - n)].join("\n\n");
    if (escapeTelegramMarkdownV2(text).length <= BRIEF_MESSAGE_LIMIT) return text;
  }
  return [head[0], foot(kept.length)].join("\n\n");
}
