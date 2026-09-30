import { z } from "zod";
import { Id } from "./common.js";
import { IdentityClassA, IdentityClassC } from "./primary-identity.js";

/**
 * KJ-P7B-1 - identity cognition binding contracts (ADR-0022, D1 erratum).
 *
 * Identity frames how ONE cognitive execution (the mission analyst) speaks and judges. Nothing here selects a
 * faculty, widens memory, changes policy or admission, or creates authority. Every shape is strict: an extra or
 * missing key is a refusal, never a guess.
 */

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Label = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/);

export const IDENTITY_CORE_CONTRACT_V1 = "kerneljson:identity-core/v1" as const;
export const IDENTITY_PROJECTION_SCHEMA_V1 = "kerneljson:identity-projection/v1" as const;
export const ANALYST_INTELLIGENCE_V1 = "ANALYST_INTELLIGENCE_V1" as const;
export const IDENTITY_COGNITION_CONTRACT_V1 = "kerneljson:identity-cognition/v1" as const;
export const ANALYST_CONTINUITY_V1 = "kerneljson:analyst-continuity/v1" as const;
export const MODEL_CALL_BINDING_V1 = "kerneljson:model-call-binding/v1" as const;
/** 16 KiB of UTF-8 over canonicalStringify(IdentityProjection) - ADR-0022 section 8. No truncation, ever. */
export const IDENTITY_PROJECTION_MAX_BYTES = 16384;

/** The exact bounded projection ANALYST_INTELLIGENCE_V1 inserts: Class A whole, three Class C fields, no Class D. */
export const IdentityProjection = z.strictObject({
  schema: z.literal(IDENTITY_PROJECTION_SCHEMA_V1),
  profile: z.literal(ANALYST_INTELLIGENCE_V1),
  identity: z.strictObject({
    id: Id,
    version: z.number().int().positive(),
    identityCoreDigest: Digest,
    digestContract: z.literal(IDENTITY_CORE_CONTRACT_V1),
  }),
  sections: z.strictObject({
    classA: IdentityClassA,
    classC: IdentityClassC.omit({ presentation: true }),
  }),
});
export type IdentityProjection = z.infer<typeof IdentityProjection>;

/** The durable REQUIRED pin (ADR-0022 section 8). Exactly these 18 keys; the database CHECK requires the same. */
export const IdentityCognitionPin = z.strictObject({
  tenantId: Id,
  taskId: Id,
  stepId: Id,
  identityId: Id,
  identityVersionId: Id,
  identityVersion: z.number().int().positive(),
  identityCoreDigest: Digest,
  classADigest: Digest,
  digestContract: z.literal(IDENTITY_CORE_CONTRACT_V1),
  projectionSchema: z.literal(IDENTITY_PROJECTION_SCHEMA_V1),
  projectionProfile: z.literal(ANALYST_INTELLIGENCE_V1),
  projection: IdentityProjection,
  projectionBytes: z.number().int().positive().max(IDENTITY_PROJECTION_MAX_BYTES),
  projectionDigest: Digest,
  facultyId: z.literal("intelligence"),
  facultyVersion: z.number().int().positive(),
  facultyDigest: Digest,
  mode: z.literal("REQUIRED"),
});
export type IdentityCognitionPin = z.infer<typeof IdentityCognitionPin>;

export const IdentityCognitionMode = z.enum(["NONE", "REQUIRED"]);
export type IdentityCognitionMode = z.infer<typeof IdentityCognitionMode>;

export const IdentityCognitionLatch = z.strictObject({
  tenantId: Id,
  taskId: Id,
  stepId: Id,
  mode: IdentityCognitionMode,
  releaseEpoch: z.number().int().positive(),
});
export type IdentityCognitionLatch = z.infer<typeof IdentityCognitionLatch>;

/**
 * What the latch step returns and Restate journals. It is REPLAY MATERIAL ONLY: the database row is canonical, and
 * IdentityPort.authorize re-reads it before every provider call and fails closed on any disagreement (section 4.6).
 */
export const IdentityCognitionState = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("LEGACY"), taskId: Id, stepId: Id, releaseEpoch: z.number().int().nonnegative().nullable() }),
  z.strictObject({
    kind: z.literal("CONTRACT"),
    contractStartEpoch: z.number().int().positive(),
    latch: IdentityCognitionLatch,
    pin: IdentityCognitionPin.nullable(),
  }),
]);
export type IdentityCognitionState = z.infer<typeof IdentityCognitionState>;

/** The identity provenance an analyst runtime evidence record carries in REQUIRED mode (ADR-0022 section 10). */
export const IdentityRuntimeProvenance = z.strictObject({
  identity_id: Id,
  identity_version_id: Id,
  identity_version: z.number().int().positive(),
  identity_core_digest: Digest,
  class_a_digest: Digest,
  projection_profile: z.literal(ANALYST_INTELLIGENCE_V1),
  projection_digest: Digest,
});
export type IdentityRuntimeProvenance = z.infer<typeof IdentityRuntimeProvenance>;

/**
 * D1 erratum: the immutable MODEL_CALLED call binding. Only non-secret identifiers and digests: never the request,
 * its messages, memory text, projection text, credentials or a provider body.
 */
export const ModelCallBinding = z.strictObject({
  contract: z.literal(MODEL_CALL_BINDING_V1),
  task_id: Id,
  step_id: Id,
  call_id: Id,
  provider: Label,
  model: Label,
  status: z.enum(["SUCCEEDED", "FAILED"]),
  request_digest: Digest,
  assembly_digest: Digest,
  continuity_digest: Digest,
  identity_cognition_mode: IdentityCognitionMode,
});
export type ModelCallBinding = z.infer<typeof ModelCallBinding>;
