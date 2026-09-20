import {
  GithubFacts,
  ModelRequest,
  type TraceRef,
} from "../../../../packages/contracts/src/index.js";

/**
 * KJ-P3 - prompt construction for the two runtimes. Pure. Runtimes get no tools and no
 * credentials: they see only the evidence rendered here and answer with one JSON object.
 * Repository text (README, commit message, paths) is untrusted input inside the prompt;
 * that is safe because the kernel never acts on runtime output, it only verifies it.
 */
export const ANALYST_MAX_TOKENS = 4096;
export const REVIEWER_MAX_TOKENS = 2048;

export function renderFacts(facts: GithubFacts, factsDigest: string): string {
  const tree = facts.tree.map((e) => `${e.type === "tree" ? "d" : "f"} ${e.path}`).join("\n");
  return [
    `EVIDENCE (GitHub, read-only, digest ${factsDigest})`,
    `repo: ${facts.repo}`,
    `private: ${facts.private}`,
    `default branch: ${facts.defaultBranch}`,
    `head sha: ${facts.headSha}`,
    `head commit: ${facts.headCommitDate} ${facts.headCommitMessage}`,
    `language: ${facts.language ?? "unknown"}`,
    `size kb: ${facts.sizeKb}`,
    `open issues: ${facts.openIssues}`,
    `tree${facts.treeTruncated ? " (TRUNCATED: only these paths are verifiable)" : ""}:`,
    tree,
    facts.readme
      ? `readme (${facts.readme.path}, sha256 ${facts.readme.sha256}), first characters:\n${facts.readme.excerpt}`
      : "readme: none",
  ].join("\n");
}

const ANALYST_SYSTEM = [
  "You are the analyst runtime in a KernelJSON repository-analysis mission.",
  "You see only the evidence provided. Do not invent files, commits or facts.",
  "Cite only paths that appear in the tree list, exactly as written.",
  "Reply with ONE JSON object and nothing else, in exactly this shape:",
  '{"headSha": "<the head sha from the evidence>", "summary": "<string>", "findings": [{"title": "<string>", "detail": "<string>", "paths": ["<tree path>"]}]}',
  "Hard limits. Output that breaks any of them is rejected outright, so stay well inside them:",
  "summary at most 1500 characters; AT MOST 8 findings; each title at most 100 characters;",
  "each detail at most 500 characters; each finding cites 1 to 8 tree paths. Be concise.",
].join("\n");

const REVIEWER_SYSTEM = [
  "You are the independent reviewer runtime in a KernelJSON repository-analysis mission.",
  "Check every finding of the analysis against the evidence. Trust nothing that the evidence does not show.",
  "Reply with ONE JSON object and nothing else, in exactly this shape:",
  '{"reviewedAnalysisSha256": "<the analysis digest, copied exactly>", "verdict": "approve" | "approve_with_notes" | "reject", "unsupportedFindings": [<0-based indexes of findings the evidence does not support>], "notes": ["<short string>"]}',
  'Use "approve" only if every finding is supported by the evidence and unsupportedFindings is empty.',
].join("\n");

interface Common {
  callId: string;
  taskId: string;
  stepId: string;
  trace: TraceRef;
  facts: GithubFacts;
  factsDigest: string;
}

export function analystRequest(input: Common & { question: string }): ModelRequest {
  return ModelRequest.parse({
    callId: input.callId,
    taskId: input.taskId,
    stepId: input.stepId,
    trace: input.trace,
    maxOutputTokens: ANALYST_MAX_TOKENS,
    messages: [
      { role: "system", content: ANALYST_SYSTEM },
      {
        role: "user",
        content: `Question: ${input.question}\n\n${renderFacts(input.facts, input.factsDigest)}`,
      },
    ],
  });
}

export function reviewerRequest(
  input: Common & { analysisText: string; analysisDigest: string },
): ModelRequest {
  return ModelRequest.parse({
    callId: input.callId,
    taskId: input.taskId,
    stepId: input.stepId,
    trace: input.trace,
    maxOutputTokens: REVIEWER_MAX_TOKENS,
    messages: [
      { role: "system", content: REVIEWER_SYSTEM },
      {
        role: "user",
        content: [
          `Analysis digest (copy exactly): ${input.analysisDigest}`,
          "ANALYSIS (verbatim):",
          input.analysisText,
          "",
          renderFacts(input.facts, input.factsDigest),
        ].join("\n"),
      },
    ],
  });
}
