import { z } from "zod";
import { Id, Text, Timestamp } from "./common.js";

/**
 * KJ-P7A - Primary Identity contracts (ADR-0021).
 *
 * Durable KernelJSON state: who is speaking, in what voice, under what values. Never task, policy,
 * approval, capability, memory, faculty or scheduler authority - see ADR-0021 D1. Governance class is
 * derived by the database from which sections actually changed (see the migration's
 * identity_candidate_classify trigger); nothing here lets a caller assert it.
 */

const Digest = z.string().regex(/^[a-f0-9]{64}$/);

export const IDENTITY_GOVERNANCE_CLASSES = ["BOOTSTRAP", "A", "C", "D", "ROLLBACK"] as const;
export const IdentityGovernanceClass = z.enum(IDENTITY_GOVERNANCE_CLASSES);
export type IdentityGovernanceClass = z.infer<typeof IdentityGovernanceClass>;

/** Only OPERATOR_INSTRUCTION can ever reach activation. The other two are held forever as candidates. */
export const IDENTITY_ORIGINS = ["OPERATOR_INSTRUCTION", "MODEL_PROPOSAL", "SHARED_BRAIN"] as const;
export const IdentityOrigin = z.enum(IDENTITY_ORIGINS);
export type IdentityOrigin = z.infer<typeof IdentityOrigin>;

const ShortText = z.string().trim().min(1).max(4000);
// A single-line bullet, not a paragraph: bounds the worst-case document size (twenty 4000-char
// values/objectives would alone exceed the admission door's request body cap) and values/objectives
// are meant to read as short phrases, not prose, the same way a constitution's own values are.
const ListItem = z.string().trim().min(1).max(300);

/** Constitutional. Human approval always required to change; a Class C/D change must leave every
 *  byte of this section identical (enforced by class_a_digest comparison, not re-read here). */
export const IdentityClassA = z.strictObject({
  name: z.string().trim().min(1).max(100),
  constitution: ShortText,
  values: z.array(ListItem).min(1).max(20),
  operatorRelationship: ShortText,
  /** How this identity frames whichever P6 faculty the kernel already selected - never which
   *  faculty runs. See ADR-0021 D4: effective_scope = min(identity_framing_scope, kernel_faculty_ceiling). */
  facultyFraming: ShortText,
  /** How this identity frames canonical (P5) memory to a cognitive execution - may narrow, never widen. */
  memoryPolicy: ShortText,
});
export type IdentityClassA = z.infer<typeof IdentityClassA>;

/** Persona and interaction. Governed, rate-limited, cannot touch Class A bytes. */
export const IdentityClassC = z.strictObject({
  persona: ShortText,
  communication: ShortText,
  behaviour: ShortText,
  presentation: ShortText,
});
export type IdentityClassC = z.infer<typeof IdentityClassC>;

/** Mantras and vision. Governed, rate-limited, cannot touch Class A bytes. */
export const IdentityClassD = z.strictObject({
  objectives: z.array(ListItem).max(20),
  vision: ShortText,
});
export type IdentityClassD = z.infer<typeof IdentityClassD>;

export const IdentitySections = z.strictObject({
  classA: IdentityClassA,
  classC: IdentityClassC,
  classD: IdentityClassD,
});
export type IdentitySections = z.infer<typeof IdentitySections>;

/** What a proposer submits - no version (a candidate does not know one until it is activated), no
 *  governance class, no trust, no state. Those are computed or assigned by the kernel/database, never
 *  supplied. Mirrors ADR-0020's CandidateSubmission shape for the same reason. */
export const IdentityDocumentDraft = z.strictObject({
  id: Id,
  tenantId: Id,
  sections: IdentitySections,
});
export type IdentityDocumentDraft = z.infer<typeof IdentityDocumentDraft>;

/** The immutable, persisted, versioned document. */
export const IdentityDocument = IdentityDocumentDraft.extend({
  version: z.number().int().positive(),
});
export type IdentityDocument = z.infer<typeof IdentityDocument>;

const IdentityChangeReason = z.string().trim().min(1).max(500);

/** The identity-change/v1 objective payload (JSON-encoded into IntentEnvelope.objective, the same
 *  pattern MISSION_RECIPE uses for `owner/repo [question]`). reason is operator-facing provenance,
 *  never interpreted by any guard.
 *
 *  Two kinds, not one shape with an optional field: PROPOSE carries a full draft document (the
 *  database classifies it as BOOTSTRAP/A/C/D from an actual diff against the head - see the
 *  migration's identity_candidate_classify trigger). ROLLBACK names a prior version by number only;
 *  the workflow reads that version's own persisted document back out of identity_versions rather
 *  than trusting a caller-supplied document to be that version's real content (ADR-0021 D7's
 *  "emergency HUMAN-approved rollback remains available throughout"). */
export const IdentityChangeRequest = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("PROPOSE"), document: IdentityDocumentDraft, reason: IdentityChangeReason }),
  z.strictObject({ kind: z.literal("ROLLBACK"), toVersion: z.number().int().positive(), reason: IdentityChangeReason }),
]);
export type IdentityChangeRequest = z.infer<typeof IdentityChangeRequest>;

export const IDENTITY_CHANGE_RECIPE = "identity-change/v1" as const;
export const IDENTITY_CHANGE_CRITERION =
  "The identity-change task completes only once a corresponding identity_activations row exists, bound to this exact task id, with a governance class independently derived by the database from the actual document diff";

/** Same pattern as parseMissionObjective for MISSION_RECIPE: the rich payload rides in
 *  IntentEnvelope.objective (the only free-form field IntentEnvelope has), JSON-encoded rather than
 *  directive-parsed because a whole document, not a short instruction, needs to travel through it.
 *  Malformed input is rejected at admission, never silently coerced into a harmless-looking change. */
export function parseIdentityChangeObjective(objective: string): IdentityChangeRequest {
  let raw: unknown;
  try {
    raw = JSON.parse(objective);
  } catch {
    throw new Error("identity-change/v1 objective must be a JSON-encoded IdentityChangeRequest");
  }
  return IdentityChangeRequest.parse(raw);
}

export const IdentityProfileRow = z.strictObject({
  id: Id,
  tenantId: Id,
  ownerPrincipalId: Id,
  name: z.string(),
  status: z.enum(["ACTIVE", "DISABLED"]),
  createdAt: Timestamp,
});
export type IdentityProfileRow = z.infer<typeof IdentityProfileRow>;

export const IdentityVersionRow = z.strictObject({
  id: Id,
  identityId: Id,
  tenantId: Id,
  version: z.number().int().positive(),
  document: IdentityDocument,
  identityCoreDigest: Digest,
  classADigest: Digest,
  governanceClass: IdentityGovernanceClass,
  candidateId: Id,
  createdByTask: Id,
  createdAt: Timestamp,
});
export type IdentityVersionRow = z.infer<typeof IdentityVersionRow>;

export const IdentityCandidateRow = z.strictObject({
  id: Id,
  identityId: Id,
  tenantId: Id,
  document: IdentityDocumentDraft,
  proposedDigest: Digest,
  origin: IdentityOrigin,
  governanceClass: IdentityGovernanceClass,
  proposedByTask: Id.nullable(),
  state: z.enum(["HELD", "APPROVED", "REJECTED", "APPLIED"]),
  createdAt: Timestamp,
  resolvedAt: Timestamp.nullable(),
});
export type IdentityCandidateRow = z.infer<typeof IdentityCandidateRow>;

export const IdentityActivationRow = z.strictObject({
  id: Id,
  identityId: Id,
  tenantId: Id,
  version: z.number().int().positive(),
  governanceClass: IdentityGovernanceClass,
  candidateId: Id,
  approvalId: Id.nullable(),
  requestTaskId: Id,
  activatedAt: Timestamp,
  createdBy: Text,
});
export type IdentityActivationRow = z.infer<typeof IdentityActivationRow>;

/** What a completed identity-change task's evidence must bind (ADR-0021 D9 - four digests, not one
 *  version number, for cross-provider proof; also the P7B pin shape, unused until P7B wires it). */
export const IdentityEvidence = z.strictObject({
  identityId: Id,
  identityVersion: z.number().int().positive(),
  identityCoreDigest: Digest,
  governanceClass: IdentityGovernanceClass,
  activationId: Id,
});
export type IdentityEvidence = z.infer<typeof IdentityEvidence>;
