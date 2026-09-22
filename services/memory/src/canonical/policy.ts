import type { CandidateSubmission, MemoryClass, MemoryOrigin } from "../../../../packages/contracts/src/index.js";

/**
 * KJ-P5 - the deterministic promotion policy. A pure function of (origin, candidate, target): no clock, no
 * randomness, no model, no I/O. The ORIGIN is set by the kernel entry point that received the candidate and is
 * never read from the candidate, so a candidate cannot claim authority for itself.
 *
 * | origin                | what it may become                                                                        |
 * |-----------------------|-------------------------------------------------------------------------------------------|
 * | OPERATOR_INSTRUCTION  | any class canonical at once, except RELATIONSHIP (identity-adjacent), which needs approval |
 * | VERIFIED_OUTCOME      | EPISODE canonical at once; LESSON and DECISION need approval; nothing else                 |
 * | MODEL_PROPOSAL        | never: candidate-only, held                                                                |
 * | SHARED_BRAIN          | never: candidate-only, held                                                                |
 *
 * Content that looks like a credential is refused whatever the origin: a memory is context handed to models and
 * shown in chat, so a secret must never be stored there.
 */
export const POLICY_VERSION = "kj-memory-policy/1";

export type PolicyOutcome = "ALLOW" | "REQUIRE_APPROVAL" | "HOLD" | "REFUSE";

export interface PolicyDecisionResult {
  decision: PolicyOutcome;
  ruleId: string;
  reason: string;
  /** True when the memory is identity-adjacent and so needs a human to approve it. */
  protected: boolean;
}

export interface PolicyInput {
  origin: MemoryOrigin;
  candidate: Pick<CandidateSubmission, "class" | "content" | "intent" | "evidence">;
  /** The class of the memory this candidate would correct, supersede or retract, when there is one. */
  targetClass?: MemoryClass | undefined;
}

/** Shapes of credentials. No backslashes on purpose, so the source survives any tooling. */
export const SECRET_SHAPES: ReadonlyArray<readonly [string, RegExp]> = [
  ["api-key", /sk-[A-Za-z0-9_-]{20,}/],
  ["github-token", /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/],
  ["aws-access-key", /AKIA[0-9A-Z]{16}/],
  ["slack-token", /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ["telegram-bot-token", /[0-9]{6,12}:[A-Za-z0-9_-]{35}/],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["jwt", /eyJ[A-Za-z0-9_-]{10,}[.]eyJ[A-Za-z0-9_-]{10,}[.][A-Za-z0-9_-]{10,}/],
  ["bearer-credential", /[Bb]earer [A-Za-z0-9._~+/-]{20,}/],
  ["url-with-password", /[a-z][a-z0-9+.-]*:[/][/][^ /:@]+:[^ /@]+@/],
  ["assigned-secret", /(password|passwd|secret|api[_-]?key|token)[ ]*[:=][ ]*[A-Za-z0-9_+/=-]{12,}/i],
];

export function looksLikeSecret(text: string): string | null {
  for (const [name, re] of SECRET_SHAPES) if (re.test(text)) return name;
  return null;
}

export function decidePromotion(input: PolicyInput): PolicyDecisionResult {
  const { origin, candidate } = input;
  const isProtected = candidate.class === "RELATIONSHIP" || input.targetClass === "RELATIONSHIP";

  const secret = looksLikeSecret(candidate.content);
  if (secret !== null)
    return { decision: "REFUSE", ruleId: "no-secrets", reason: `content looks like a credential (${secret}); a memory is never a place for one`, protected: false };

  if (origin === "MODEL_PROPOSAL")
    return { decision: "HOLD", ruleId: "model-candidate-only", reason: "model output can only ever be a candidate", protected: isProtected };
  if (origin === "SHARED_BRAIN")
    return { decision: "HOLD", ruleId: "shared-brain-candidate-only", reason: "external knowledge can only ever be a candidate", protected: isProtected };

  if (origin === "VERIFIED_OUTCOME") {
    if (!candidate.evidence.some((e) => e.type === "TASK_EVIDENCE"))
      return { decision: "REFUSE", ruleId: "outcome-needs-task-evidence", reason: "a verified-outcome candidate must cite task evidence", protected: false };
    if (candidate.intent !== "NEW")
      return { decision: "REFUSE", ruleId: "outcome-new-only", reason: "a verified outcome can only propose a new memory", protected: false };
    if (candidate.class === "EPISODE")
      return { decision: "ALLOW", ruleId: "outcome-episode", reason: "a verified task outcome may be recorded as an episode", protected: false };
    if (candidate.class === "LESSON" || candidate.class === "DECISION")
      return { decision: "REQUIRE_APPROVAL", ruleId: "outcome-lesson-approval", reason: "a lesson or decision drawn from an outcome needs a human to approve it", protected: false };
    return { decision: "REFUSE", ruleId: "outcome-class", reason: "a verified outcome can only propose an EPISODE, LESSON or DECISION", protected: false };
  }

  // OPERATOR_INSTRUCTION: an explicit instruction from an authenticated human channel.
  if (isProtected)
    return { decision: "REQUIRE_APPROVAL", ruleId: "relationship-approval", reason: "relationship memory is identity-adjacent and needs approval", protected: true };
  return { decision: "ALLOW", ruleId: "operator-instruction", reason: "an explicit instruction from the authenticated operator", protected: false };
}
