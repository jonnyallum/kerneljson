import { ModelRequest, type IdentityCognitionPin, type MissionContract } from "../../../../packages/contracts/src/index.js";
import type { FacultyPin } from "../../../../packages/contracts/src/faculty.js";
import { projectFacultyRequest } from "../faculty/policy.js";
import { canonicalDigest, canonicalStringify } from "../identity/canonical.js";
import { IdentityCognitionRefusal, countIdentityBlocks, renderIdentityBlock } from "../identity/projection.js";
import { analystRequest } from "./prompts.js";
import { assemblyDigestOf, continuityDigestOf } from "./cognition-digests.js";

/**
 * KJ-P7B-1 (ADR-0022 section 5) - THE one canonical analyst assembler. It is the only place the analyst provider
 * request is composed and the only code that may place identity bytes into any request.
 *
 *   analystRequest(...)  ->  (REQUIRED only) identity block at the start of the system message  ->  projectFacultyRequest
 *
 * so a REQUIRED system message is: faculty authority header, identity block, the unchanged analyst contract. The
 * user message is never touched. LEGACY and NONE produce exactly the pre-P7B request, byte for byte.
 */
export type AnalystCognition =
  | { kind: "LEGACY" }
  | { kind: "NONE" }
  | { kind: "REQUIRED"; pin: IdentityCognitionPin };

export interface AnalystAssemblyInput {
  request: Parameters<typeof analystRequest>[0];
  recipe: string;
  repo: string;
  facultyPin: FacultyPin | null;
  cognition: AnalystCognition;
  /** The P5 task-id-free memory assembly digest actually used, or null. */
  memoryAssemblyDigest: string | null;
}

export interface AssembledAnalystRequest {
  /** The full ModelRequest handed unchanged to ModelPort.generate. */
  request: ModelRequest;
  /** canonicalStringify(request): for deterministic regression and request construction, NOT "what the model sees". */
  requestBytes: string;
  /** ADR-0021 D9 assembly_digest: messages + maxOutputTokens only. */
  assemblyDigest: string;
  continuityDigest: string;
}

export function assembleAnalystRequest(input: AnalystAssemblyInput): AssembledAnalystRequest {
  const { cognition, facultyPin } = input;
  if (cognition.kind !== "LEGACY" && !facultyPin) throw new IdentityCognitionRefusal("IDENTITY_FACULTY_PIN_REQUIRED");
  const base = analystRequest(input.request);
  let request: ModelRequest = base;
  if (cognition.kind === "REQUIRED") {
    const [system, user] = base.messages;
    if (base.messages.length !== 2 || system?.role !== "system" || user?.role !== "user")
      throw new IdentityCognitionRefusal("IDENTITY_ASSEMBLY_SHAPE_REFUSED");
    if (cognition.pin.taskId !== base.taskId || cognition.pin.stepId !== base.stepId)
      throw new IdentityCognitionRefusal("IDENTITY_PIN_BINDING_REFUSED");
    const block = renderIdentityBlock(cognition.pin.projection, cognition.pin.projectionDigest);
    request = ModelRequest.parse({ ...base, messages: [{ role: "system", content: block + system.content }, user] });
  }
  if (facultyPin) request = projectFacultyRequest(facultyPin, request);
  // Exactly one identity block, in the system message, when REQUIRED; none otherwise. Only the system message is an
  // identity channel: the user message carries untrusted repository evidence, whose text is never counted.
  const blocks = countIdentityBlocks(request.messages[0]!.content);
  if (blocks !== (cognition.kind === "REQUIRED" ? 1 : 0)) throw new IdentityCognitionRefusal("IDENTITY_ASSEMBLY_BLOCK_COUNT");
  const assemblyDigest = assemblyDigestOf(request);
  const { question, contract, factsDigest } = input.request;
  const continuityDigest = continuityDigestOf({
    mission: { recipe: input.recipe, question, contractDigest: canonicalDigest(contract satisfies MissionContract), repo: input.repo, factsDigest },
    faculty: facultyPin ? { id: facultyPin.faculty.id, version: facultyPin.faculty.version, digest: facultyPin.facultyDigest } : null,
    identity:
      cognition.kind === "REQUIRED"
        ? {
            mode: "REQUIRED",
            identityCoreDigest: cognition.pin.identityCoreDigest,
            projectionProfile: cognition.pin.projectionProfile,
            projectionDigest: cognition.pin.projectionDigest,
          }
        : null,
    memory: input.memoryAssemblyDigest ? { assemblyDigest: input.memoryAssemblyDigest } : null,
    assemblyDigest,
  });
  return { request, requestBytes: canonicalStringify(request), assemblyDigest, continuityDigest };
}
