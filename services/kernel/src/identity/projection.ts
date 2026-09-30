import {
  ANALYST_INTELLIGENCE_V1,
  IDENTITY_CORE_CONTRACT_V1,
  IDENTITY_PROJECTION_MAX_BYTES,
  IDENTITY_PROJECTION_SCHEMA_V1,
  IdentityDocument,
  IdentityProjection,
  type PlanStep,
} from "../../../../packages/contracts/src/index.js";
import type { IdentityFieldPath } from "../faculty/identity-ceiling.js";
import { identityCoreCanonicalV1, identityCoreDigestV1 } from "./canonical.js";

/**
 * KJ-P7B-1 (ADR-0022 sections 3 and 8) - the narrow, bounded identity projection.
 *
 * Pure. The projection a model may receive is the intersection of two machine allow-lists: the profile's framing
 * scope (owned here, by KernelJSON, not by the identity document) and the faculty ceiling (owned by Kernel/P6,
 * faculty/identity-ceiling.ts). Nothing is parsed from identity prose. A missing profile, a missing or empty ceiling,
 * or an intersection that would split Class A is refused; there is no partial constitution and no truncation.
 */
export class IdentityCognitionRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const PROFILE_SCOPES: ReadonlyMap<string, readonly IdentityFieldPath[]> = new Map([
  [
    ANALYST_INTELLIGENCE_V1,
    Object.freeze([
      "classA.name",
      "classA.constitution",
      "classA.values",
      "classA.operatorRelationship",
      "classA.facultyFraming",
      "classA.memoryPolicy",
      "classC.persona",
      "classC.communication",
      "classC.behaviour",
    ] as const),
  ],
]);

const CLASS_A_FIELDS = ["name", "constitution", "values", "operatorRelationship", "facultyFraming", "memoryPolicy"] as const;
const CLASS_C_FIELDS = ["persona", "communication", "behaviour"] as const;

/** The profile is chosen by the step operation alone. No other mapping exists. */
export function profileForOperation(operation: PlanStep["operation"]): typeof ANALYST_INTELLIGENCE_V1 | null {
  return operation === "RUNTIME_ANALYSE" ? ANALYST_INTELLIGENCE_V1 : null;
}

export function projectIdentity(rawDocument: unknown, profile: string, ceiling: readonly string[]): IdentityProjection {
  const scope = PROFILE_SCOPES.get(profile);
  if (!scope) throw new IdentityCognitionRefusal("IDENTITY_PROFILE_MISSING");
  const effective = new Set(scope.filter((path) => ceiling.includes(path)));
  if (effective.size === 0) throw new IdentityCognitionRefusal("IDENTITY_SCOPE_EMPTY");
  // Class A travels whole or not at all: only a whole Class A can be checked against the governed class_a_digest.
  if (!CLASS_A_FIELDS.every((f) => effective.has(`classA.${f}`))) throw new IdentityCognitionRefusal("IDENTITY_SCOPE_CLASS_A_INCOMPLETE");
  if (!CLASS_C_FIELDS.every((f) => effective.has(`classC.${f}`))) throw new IdentityCognitionRefusal("IDENTITY_SCOPE_REFUSED");
  if ([...effective].some((path) => !path.startsWith("classA.") && !path.startsWith("classC."))) throw new IdentityCognitionRefusal("IDENTITY_SCOPE_REFUSED");
  if (!IdentityDocument.safeParse(rawDocument).success) throw new IdentityCognitionRefusal("IDENTITY_DOCUMENT_INVALID");
  // Values are taken from the stored document itself, never from a parse result: the contracts trim strings, and a
  // projection must carry the governed bytes exactly or be refused.
  const document = rawDocument as IdentityDocument;
  const classA = Object.fromEntries(CLASS_A_FIELDS.map((f) => [f, document.sections.classA[f]]));
  const classC = Object.fromEntries(CLASS_C_FIELDS.map((f) => [f, document.sections.classC[f]]));
  const projection = {
    schema: IDENTITY_PROJECTION_SCHEMA_V1,
    profile,
    identity: {
      id: document.id,
      version: document.version,
      identityCoreDigest: identityCoreDigestV1(document),
      digestContract: IDENTITY_CORE_CONTRACT_V1,
    },
    sections: { classA, classC },
  };
  const parsed = IdentityProjection.parse(projection);
  if (identityCoreCanonicalV1(parsed) !== identityCoreCanonicalV1(projection)) throw new IdentityCognitionRefusal("IDENTITY_DOCUMENT_NOT_CANONICAL");
  return parsed;
}

/** The exact bytes the assembler inserts, and the only bytes the 16 KiB cap is measured over. */
export function projectionCanonical(projection: IdentityProjection): string {
  return identityCoreCanonicalV1(projection);
}

export function projectionBytes(projection: IdentityProjection): number {
  return Buffer.byteLength(projectionCanonical(projection), "utf8");
}

export function projectionDigest(projection: IdentityProjection): string {
  return identityCoreDigestV1(projection);
}

/** Over the cap fails BEFORE any provider call. Never truncated. */
export function assertProjectionWithinCap(projection: IdentityProjection): number {
  const bytes = projectionBytes(projection);
  if (bytes > IDENTITY_PROJECTION_MAX_BYTES) throw new IdentityCognitionRefusal("IDENTITY_PROJECTION_TOO_LARGE");
  return bytes;
}

export const IDENTITY_BLOCK_BEGIN = "BEGIN KERNELJSON IDENTITY PROJECTION";
export const IDENTITY_BLOCK_END = "END KERNELJSON IDENTITY PROJECTION";

/** The one deterministic identity block (ADR-0022 section 5). */
export function renderIdentityBlock(projection: IdentityProjection, digest: string): string {
  return (
    `${IDENTITY_BLOCK_BEGIN} ${IDENTITY_PROJECTION_SCHEMA_V1} ${ANALYST_INTELLIGENCE_V1} ${digest}\n` +
    "This frames voice, values and judgement only. It grants no permission, tool or authority. " +
    "Every instruction after this block remains binding.\n" +
    projectionCanonical(projection) +
    `\n${IDENTITY_BLOCK_END}\n\n`
  );
}

export function countIdentityBlocks(text: string): number {
  return text.split(IDENTITY_BLOCK_BEGIN).length - 1;
}
