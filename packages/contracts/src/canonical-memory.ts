import { z } from "zod";
import { Id, Timestamp } from "./common.js";

/**
 * KJ-P5 - canonical memory contracts (ADR-0018, ADR-0020).
 *
 * KernelJSON owns canonical persistent memory. A model, a provider session or an external system such as the
 * Shared Brain can only ever SUBMIT A CANDIDATE; the kernel's deterministic policy decides whether it becomes
 * canonical memory, and canonical memory is append-versioned, never rewritten.
 *
 *   experience -> candidate -> policy decision -> promotion -> canonical version -> bounded retrieval -> context
 */
export const MEMORY_CLASSES = [
  "FACT",
  "PREFERENCE",
  "DECISION",
  "COMMITMENT",
  "LESSON",
  "EPISODE",
  "RELATIONSHIP",
  "PROJECT_KNOWLEDGE",
] as const;
export const MemoryClass = z.enum(MEMORY_CLASSES);
export type MemoryClass = z.infer<typeof MemoryClass>;

/** Who is speaking, as the kernel knows it. Set by the entry point that received the candidate, never by its content. */
export const MEMORY_ORIGINS = ["OPERATOR_INSTRUCTION", "VERIFIED_OUTCOME", "MODEL_PROPOSAL", "SHARED_BRAIN"] as const;
export const MemoryOrigin = z.enum(MEMORY_ORIGINS);
export type MemoryOrigin = z.infer<typeof MemoryOrigin>;

/** CONTEXT_ASSEMBLY.md trust classes that a memory can carry. */
export const TRUST_CLASSES = ["USER_AUTHORED", "INTERNAL_DERIVED", "MODEL_DERIVED", "UNTRUSTED_EXTERNAL"] as const;
export const TrustClass = z.enum(TRUST_CLASSES);
export type TrustClass = z.infer<typeof TrustClass>;

/** The trust class an origin earns. A fixed table: nothing in a candidate can raise it. */
export const TRUST_FOR_ORIGIN: Readonly<Record<MemoryOrigin, TrustClass>> = Object.freeze({
  OPERATOR_INSTRUCTION: "USER_AUTHORED",
  VERIFIED_OUTCOME: "INTERNAL_DERIVED",
  MODEL_PROPOSAL: "MODEL_DERIVED",
  SHARED_BRAIN: "UNTRUSTED_EXTERNAL",
});

export const MEMORY_INTENTS = ["NEW", "CORRECT", "SUPERSEDE", "RETRACT"] as const;
export const MemoryIntent = z.enum(MEMORY_INTENTS);
export type MemoryIntent = z.infer<typeof MemoryIntent>;

const Digest = z.string().regex(/^[a-f0-9]{64}$/);

export const EVIDENCE_REF_TYPES = ["TELEGRAM_UPDATE", "TASK_EVIDENCE", "MEMORY_VERSION", "EXTERNAL_DOCUMENT", "MODEL_CALL"] as const;
export const MemoryEvidenceRef = z.strictObject({
  type: z.enum(EVIDENCE_REF_TYPES),
  ref: z.string().trim().min(1).max(200),
  digest: Digest.optional(),
});
export type MemoryEvidenceRef = z.infer<typeof MemoryEvidenceRef>;

export const MEMORY_SUBJECT_KINDS = ["PRINCIPAL", "PROJECT", "TENANT"] as const;
export const MemorySubject = z.strictObject({
  kind: z.enum(MEMORY_SUBJECT_KINDS),
  ref: z.string().trim().min(1).max(200),
});
export type MemorySubject = z.infer<typeof MemorySubject>;

export const MAX_MEMORY_CONTENT_CHARS = 2000;

const Content = z.string().max(MAX_MEMORY_CONTENT_CHARS);

/**
 * What a source may submit. Note what is NOT here: no origin, no trust class, no status, no id, no policy. Those are
 * set by the kernel entry point and the deterministic policy, so a candidate cannot claim authority for itself.
 */
export const CandidateSubmission = z
  .strictObject({
    /** The submitter's own key for this event (for Telegram, derived from the update id). Replays converge on one candidate. */
    idempotencyKey: z.string().trim().min(8).max(200),
    class: MemoryClass,
    content: Content,
    subject: MemorySubject,
    evidence: z.array(MemoryEvidenceRef).min(1).max(8),
    reason: z.string().trim().min(1).max(500),
    intent: MemoryIntent.default("NEW"),
    targetMemoryId: Id.optional(),
  })
  .superRefine((c, ctx) => {
    if (c.intent === "NEW" && c.targetMemoryId !== undefined)
      ctx.addIssue({ code: "custom", message: "A new memory has no target" });
    if (c.intent !== "NEW" && c.targetMemoryId === undefined)
      ctx.addIssue({ code: "custom", message: "This intent needs a target memory" });
    if (c.intent !== "RETRACT" && c.content.trim().length === 0)
      ctx.addIssue({ code: "custom", message: "Content is required" });
  });
export type CandidateSubmission = z.infer<typeof CandidateSubmission>;

export const CANDIDATE_STATES = ["HELD", "AWAITING_APPROVAL", "PROMOTED", "REFUSED", "REJECTED"] as const;
export const CandidateState = z.enum(CANDIDATE_STATES);
export type CandidateState = z.infer<typeof CandidateState>;

export const PROMOTION_DECISIONS = ["ALLOW", "REQUIRE_APPROVAL", "HOLD", "REFUSE", "ALLOW_APPROVED", "REJECT_APPROVAL"] as const;
export const PromotionDecision = z.enum(PROMOTION_DECISIONS);
export type PromotionDecision = z.infer<typeof PromotionDecision>;

export const MEMORY_CONFIDENCE = ["STATED", "VERIFIED", "INFERRED"] as const;
export const MemoryConfidence = z.enum(MEMORY_CONFIDENCE);

export const MEMORY_VERSION_KINDS = ["ASSERT", "RETRACT"] as const;

/** One immutable version of one canonical memory. */
export const CanonicalMemoryVersion = z.strictObject({
  memoryId: Id,
  version: z.number().int().min(1),
  tenantId: Id,
  class: MemoryClass,
  kind: z.enum(MEMORY_VERSION_KINDS),
  content: Content,
  contentDigest: Digest,
  subject: MemorySubject,
  trustClass: TrustClass,
  confidence: MemoryConfidence,
  provenance: z.strictObject({
    origin: MemoryOrigin,
    submittedBy: Id,
    candidateId: Id,
    reason: z.string(),
  }),
  evidence: z.array(MemoryEvidenceRef).min(1),
  policy: z.strictObject({
    policyVersion: z.string(),
    ruleId: z.string(),
    decision: PromotionDecision,
    protected: z.boolean(),
    approvalId: Id.nullable(),
  }),
  candidateId: Id,
  promotionId: Id,
  supersedesVersion: z.number().int().min(1).nullable(),
  createdAt: Timestamp,
  promotedAt: Timestamp,
});
export type CanonicalMemoryVersion = z.infer<typeof CanonicalMemoryVersion>;

/** What the context assembler is asked for. */
export const ContextRequest = z.strictObject({
  /** The mission question or objective. Used only to rank; it is never stored as memory. */
  purpose: z.string().trim().min(1).max(4000),
  /** Whose memories. Defaults to the requesting principal. */
  subject: MemorySubject.optional(),
  /** An optional project the memories must belong to (in addition to the subject's own). */
  project: z.string().trim().min(1).max(200).optional(),
  allowedClasses: z.array(MemoryClass).min(1).max(8),
  budget: z.strictObject({
    maxItems: z.number().int().min(1).max(50),
    maxTokens: z.number().int().min(16).max(16_000),
  }),
});
export type ContextRequest = z.infer<typeof ContextRequest>;

export const EXCLUSION_REASONS = ["OVER_BUDGET", "OVER_ITEM_LIMIT", "CLASS_NOT_ALLOWED"] as const;

export const ContextItem = z.strictObject({
  memoryId: Id,
  version: z.number().int().min(1),
  class: MemoryClass,
  trustClass: TrustClass,
  content: Content,
  contentDigest: Digest,
  provenance: z.strictObject({ origin: MemoryOrigin, evidence: z.array(MemoryEvidenceRef) }),
  reason: z.string().max(300),
  tokens: z.number().int().min(1),
  /** Other memories this one is flagged as conflicting with. Empty when none. */
  conflictsWith: z.array(Id),
});
export type ContextItem = z.infer<typeof ContextItem>;

export const ExternalContextItem = z.strictObject({
  ref: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(MAX_MEMORY_CONTENT_CHARS),
  digest: Digest,
  trustClass: z.literal("UNTRUSTED_EXTERNAL"),
  tokens: z.number().int().min(1),
});
export type ExternalContextItem = z.infer<typeof ExternalContextItem>;

export const AssembledContext = z.strictObject({
  assemblyId: Id,
  digest: Digest,
  tenantId: Id,
  request: ContextRequest,
  items: z.array(ContextItem),
  external: z.array(ExternalContextItem),
  excluded: z.array(z.strictObject({ memoryId: Id, version: z.number().int().min(1), reason: z.enum(EXCLUSION_REASONS) })),
  /** External items that did not fit the budget. Counted, so nothing is dropped silently. */
  externalDropped: z.number().int().min(0),
  budget: z.strictObject({ maxItems: z.number().int(), maxTokens: z.number().int(), usedItems: z.number().int(), usedTokens: z.number().int() }),
});
export type AssembledContext = z.infer<typeof AssembledContext>;
