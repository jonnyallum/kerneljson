/**
 * KJ-P7B-1 (ADR-0022 section 3) - the Kernel/P6-owned identity framing CEILING.
 *
 *   effective_scope = identity_framing_scope INTERSECT kernel_faculty_ceiling
 *
 * This is the Kernel side of that intersection: for an ALREADY-SELECTED, ALREADY-PINNED faculty (its id and
 * policyVersion, read from the persisted faculty pin), the identity document field paths any identity projection
 * may populate. It is a machine allow-list, never parsed from prose. It imports nothing from identity: identity
 * can read this table, never produce or widen it (B4). An unknown faculty or policy version has the empty ceiling,
 * which is NONE and fails closed wherever cognition is REQUIRED.
 */
export type IdentityFieldPath =
  | "classA.name"
  | "classA.constitution"
  | "classA.values"
  | "classA.operatorRelationship"
  | "classA.facultyFraming"
  | "classA.memoryPolicy"
  | "classC.persona"
  | "classC.communication"
  | "classC.behaviour";

const INTELLIGENCE_FACULTY_ROUTING_V1: readonly IdentityFieldPath[] = Object.freeze([
  "classA.name",
  "classA.constitution",
  "classA.values",
  "classA.operatorRelationship",
  "classA.facultyFraming",
  "classA.memoryPolicy",
  "classC.persona",
  "classC.communication",
  "classC.behaviour",
]);

const CEILINGS: ReadonlyMap<string, readonly IdentityFieldPath[]> = new Map([
  ["intelligence@faculty-routing/v1", INTELLIGENCE_FACULTY_ROUTING_V1],
  // The verifier (the independent reviewer) gets NO identity, structurally.
  ["verifier@faculty-routing/v1", Object.freeze([]) as readonly IdentityFieldPath[]],
]);

export function identityFramingCeiling(facultyId: string, policyVersion: string): readonly IdentityFieldPath[] {
  return CEILINGS.get(`${facultyId}@${policyVersion}`) ?? [];
}
