import {
  GithubFacts,
  ModelRequest,
  type MissionContract,
  type TraceRef,
} from "../../../../packages/contracts/src/index.js";

/**
 * KJ-P3 - prompt construction for the two runtimes. Pure. Runtimes get no tools and no
 * credentials: they see only the evidence rendered here and answer with one JSON object.
 * Repository text (README, commit message, paths) is untrusted input inside the prompt;
 * that is safe because the kernel never acts on runtime output, it only verifies it.
 */
export const ANALYST_MAX_TOKENS = 6144;
export const REVIEWER_MAX_TOKENS = 2048;

export function renderFacts(facts: GithubFacts, factsDigest: string): string {
  const tree = facts.tree.map((e) => `${e.type === "tree" ? "d" : "f"} ${e.sha.slice(0, 12)} ${e.path}`).join("\n");
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
    `tree (kind, git object id prefix, path)${facts.treeTruncated ? " (TRUNCATED: only these paths are verifiable)" : ""}:`,
    tree,
    facts.readme
      ? `readme (${facts.readme.path}, sha256 ${facts.readme.sha256}), first characters:\n${facts.readme.excerpt}`
      : "readme: none",
  ].join("\n");
}

/** The count the kernel will enforce, stated to the runtime. The reconciler is what enforces it. */
export function findingsInstruction(contract: MissionContract): string {
  return contract.requestedFindings !== null
    ? `Return EXACTLY ${contract.requestedFindings} findings: no more and no fewer.`
    : `Return between ${contract.minFindings} and ${contract.maxFindings} findings; more than ${contract.maxFindings} is rejected.`;
}

export function analystSystem(contract: MissionContract): string {
  return [
    "You are the analyst runtime in a KernelJSON repository-analysis mission.",
    "You see only the evidence provided. Do not invent files, commits or facts.",
    "Every finding must cite at least one tree entry as evidence. Copy its path exactly as written and its git object id prefix exactly as shown beside it; the kernel checks both against the captured commit.",
    "Reply with ONE JSON object and nothing else, in exactly this shape:",
    '{"headSha": "<the head sha from the evidence>", "summary": "<string>", "findings": [{"title": "<string>", "detail": "<string>", "evidence": [{"path": "<tree path>", "blobSha": "<its 12 character git object id prefix>"}]}]}',
    findingsInstruction(contract),
    "Hard limits. Output that breaks any of them is rejected outright, so stay well inside them:",
    "summary at most 1500 characters; each title at most 100 characters; each detail at most 500 characters;",
    "each finding cites 1 to 8 evidence entries. Be concise.",
  ].join("\n");
}

const REVIEWER_SYSTEM = [
  "You are the independent reviewer runtime in a KernelJSON repository-analysis mission.",
  "Check every finding of the analysis against the evidence. Trust nothing that the evidence does not show.",
  "Each finding cites tree entries; the kernel separately checks that those citations exist at the captured commit. Your job is different: judge whether what the finding CLAIMS is supported by what the evidence shows. A finding whose cited files are unrelated to its claim, or whose claim goes beyond the evidence, is unsupported.",
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

export function analystRequest(input: Common & { question: string; contract: MissionContract }): ModelRequest {
  return ModelRequest.parse({
    callId: input.callId,
    taskId: input.taskId,
    stepId: input.stepId,
    trace: input.trace,
    maxOutputTokens: ANALYST_MAX_TOKENS,
    messages: [
      { role: "system", content: analystSystem(input.contract) },
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
