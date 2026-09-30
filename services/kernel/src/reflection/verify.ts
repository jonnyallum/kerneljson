import { z } from "zod";
import {
  Evidence, ExecutionBinding, ExecutionPlan, IdentityCognitionPin, IdentityVersionRow,
  MISSION_RECIPE, Outcome, ReflectionProposalV1, ReflectionRequestV1, ReflectionSourceV1,
  Task, TaskStep, parseMissionObjective,
} from "../../../../packages/contracts/src/index.js";
import { validateFacultyPin } from "../faculty/policy.js";
import { verifyFacultyEvidence } from "../faculty/verify.js";
import { canonicalDigest, identityCoreDigestV1 } from "../identity/canonical.js";
import { verifyIdentityEvidence, type IdentityCompletionFacts } from "../identity/evidence-verify.js";
import { findSecretShapedContent } from "../identity/secret-scan.js";
import { SOURCES } from "../mission/evidence.js";
import { continuityDigestOf } from "../mission/cognition-digests.js";
import { verifyMissionCompletion } from "../mission/verify.js";
import { orderedSteps, planTask, projectStep } from "../planner/index.js";

/** Internal read-adapter input, NEVER an admission payload or a verification assertion.
 * K2/K3 must read these rows together, tenant-scoped, on the caller's transaction.
 * Raw source contents are transient; only the strict return value may be journalled. */
export interface ReflectionSourceFacts {
  task: unknown;
  outcome: unknown;
  plans: readonly unknown[];
  steps: readonly unknown[];
  evidence: readonly unknown[];
  binding: unknown;
  bindingEpoch: number | null;
  activation: { epoch: number; releaseId: string } | null;
  contractStartEpoch: number | null;
  facultyPins: readonly unknown[];
  latches: IdentityCompletionFacts["latches"];
  identityPins: readonly unknown[];
  modelCalls: readonly unknown[];
  identityVersions: readonly unknown[];
}

const fail = (): never => { throw new Error("REFLECTION_SOURCE_REFUSED"); };
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const MemoryReference = z.strictObject({
  status: z.enum(["ASSEMBLED", "UNAVAILABLE"]), assembly_id: z.uuid().nullable(), context_digest: Digest.nullable(),
  memories: z.array(z.strictObject({ memory_id: z.uuid(), version: z.number().int().positive() })).max(12),
  external_count: z.number().int().nonnegative(), used_tokens: z.number().int().nonnegative(),
});

export function verifyReflectionSource(
  tenantId: string, sourceTaskId: string, facts: ReflectionSourceFacts,
): ReflectionSourceV1 {
  // Existing predicates can include source values in diagnostics. Never let those
  // diagnostics escape this privacy boundary (including through an Error cause).
  try { return verifySource(tenantId, sourceTaskId, facts); } catch { return fail(); }
}

function verifySource(tenantId: string, sourceTaskId: string, f: ReflectionSourceFacts): ReflectionSourceV1 {
  const task = Task.parse(f.task), outcome = Outcome.parse(f.outcome);
  if (task.id !== sourceTaskId || task.tenant.id !== tenantId || task.status !== "COMPLETED"
    || outcome.taskId !== task.id || outcome.status !== "COMPLETED" || outcome.completedAt !== task.completedAt) fail();
  if (f.plans.length !== 1) fail();
  const plan = ExecutionPlan.parse(f.plans[0]);
  if (plan.recipe !== MISSION_RECIPE || plan.taskId !== task.id
    || canonicalDigest(plan) !== canonicalDigest(planTask(task, MISSION_RECIPE))) fail();
  const nodes = orderedSteps(plan), steps = f.steps.map(s => TaskStep.parse(s));
  if (steps.length !== 4 || new Set(steps.map(s => s.id)).size !== 4
    || steps.some(s => s.taskId !== task.id || !nodes.some(n => n.id === s.id))) fail();
  for (const step of steps) {
    const expected = { ...projectStep(nodes.find(n => n.id === step.id)!), status: "COMPLETED", output: step.output };
    if (canonicalDigest(step) !== canonicalDigest(expected)) fail();
  }
  const records = f.evidence.map(e => Evidence.parse(e));
  if (records.length !== 4 || new Set(records.map(e => e.id)).size !== 4) fail();
  for (const e of records) {
    if (e.taskId !== task.id || !nodes.some(n => n.id === e.stepId)
      || Date.parse(e.capturedAt) < Date.parse(task.createdAt)
      || Date.parse(e.capturedAt) > Date.parse(outcome.completedAt)) fail();
  }
  const binding = ExecutionBinding.parse(f.binding);
  if (binding.taskId !== task.id || binding.tenantId !== tenantId
    || canonicalDigest(binding.principal) !== canonicalDigest(task.principal)
    || !Number.isSafeInteger(f.contractStartEpoch) || !Number.isSafeInteger(f.bindingEpoch)
    || f.contractStartEpoch! < 1 || f.bindingEpoch! < f.contractStartEpoch!
    || f.activation?.epoch !== f.bindingEpoch || f.activation?.releaseId !== binding.releaseId) fail();

  // The existing completion predicate expects the state immediately before the
  // terminal transition. Source status was independently required COMPLETED above;
  // this local view changes no persisted task and grants no completion authority.
  verifyMissionCompletion({ ...task, status: "VERIFYING" }, outcome, plan, steps,
    records.map(record => ({ record, step: steps.find(s => s.id === record.stepId) })));
  const pins = f.facultyPins.map(validateFacultyPin);
  if (pins.some(p => p.tenantId !== tenantId || p.taskId !== task.id)) fail();
  verifyFacultyEvidence(pins, records, true);
  const analystStepId = nodes[1]!.id;
  if (f.latches.some(l => l.tenant_id !== tenantId || l.task_id !== task.id)) fail();
  verifyIdentityEvidence({ contractStartEpoch: f.contractStartEpoch, bindingEpoch: f.bindingEpoch,
    analystStepId, latches: f.latches, pins: f.identityPins, modelCalls: f.modelCalls, evidence: records });
  // Successful canonical tasks have exactly one immutable analyst call binding.
  if (f.modelCalls.length !== 1) fail();

  const analyst = records.find(e => e.source === SOURCES.analyst)!;
  const reviewer = records.find(e => e.source === SOURCES.reviewer)!;
  if ("memory_context" in reviewer.metadata) fail();
  const runtime = (e: Evidence, operation: "RUNTIME_ANALYSE" | "RUNTIME_REVIEW") => {
    const pin = pins.find(p => p.operation === operation)!;
    if (pin.stepId !== e.stepId || e.metadata["output_digest"] !== e.digest) fail();
    return { stepId: e.stepId, callId: e.metadata["call_id"], provider: pin.provider, model: pin.model,
      responseModel: e.metadata["response_model"], requestDigest: e.metadata["request_digest"],
      outputDigest: e.digest, facultyDigest: pin.facultyDigest };
  };

  let identity: ReflectionSourceV1["cognition"]["identity"] = null;
  if (f.latches[0]!.mode === "REQUIRED") {
    if (f.identityVersions.length !== 1) fail();
    const pin = IdentityCognitionPin.parse(f.identityPins[0]);
    const version = IdentityVersionRow.parse(f.identityVersions[0]);
    const doc = version.document, faculty = pins.find(p => p.operation === "RUNTIME_ANALYSE")!;
    if (canonicalDigest(version) !== canonicalDigest(f.identityVersions[0])
      || version.id !== pin.identityVersionId || version.identityId !== pin.identityId
      || version.tenantId !== tenantId || doc.tenantId !== tenantId || doc.id !== pin.identityId
      || version.version !== pin.identityVersion || doc.version !== pin.identityVersion
      || version.identityCoreDigest !== pin.identityCoreDigest || version.classADigest !== pin.classADigest
      || identityCoreDigestV1(doc) !== pin.identityCoreDigest
      || identityCoreDigestV1(doc.sections.classA) !== pin.classADigest
      || pin.facultyDigest !== faculty.facultyDigest || pin.facultyVersion !== faculty.faculty.version) fail();
    // Check the stored projection against the pinned version, without rebuilding
    // prompts or reading HEAD, memory, environment or provider configuration.
    const { persona, communication, behaviour } = doc.sections.classC;
    const expectedProjection = { schema: pin.projectionSchema, profile: pin.projectionProfile,
      identity: { id: doc.id, version: doc.version, identityCoreDigest: pin.identityCoreDigest, digestContract: pin.digestContract },
      sections: { classA: doc.sections.classA, classC: { persona, communication, behaviour } } };
    if (identityCoreDigestV1(expectedProjection) !== pin.projectionDigest) fail();
    identity = { identityId: pin.identityId, versionId: pin.identityVersionId, version: pin.identityVersion,
      coreDigest: pin.identityCoreDigest, classADigest: pin.classADigest, projectionDigest: pin.projectionDigest };
  } else if (f.identityVersions.length) fail();

  const memoryRaw = analyst.metadata["memory_context"];
  const memory = memoryRaw === undefined ? null : MemoryReference.parse(memoryRaw);
  if (memory && ((memory.assembly_id === null) !== (memory.context_digest === null)
    || (memory.status === "UNAVAILABLE" && memory.assembly_id !== null)
    || (memory.assembly_id === null && (memory.memories.length > 0 || memory.used_tokens !== 0 || memory.external_count !== 0)))) fail();
  const objective = parseMissionObjective(task.objective), faculty = pins.find(p => p.operation === "RUNTIME_ANALYSE")!;
  const continuity = continuityDigestOf({
    mission: { recipe: MISSION_RECIPE, question: objective.question, contractDigest: canonicalDigest(objective.contract),
      repo: objective.repo, factsDigest: records.find(e => e.source === SOURCES.github)!.digest! },
    faculty: { id: faculty.faculty.id, version: faculty.faculty.version, digest: faculty.facultyDigest },
    identity: identity ? { mode: "REQUIRED", identityCoreDigest: identity.coreDigest,
      projectionProfile: "ANALYST_INTELLIGENCE_V1", projectionDigest: identity.projectionDigest } : null,
    memory: memory?.context_digest ? { assemblyDigest: memory.context_digest } : null,
    assemblyDigest: Digest.parse(analyst.metadata["assembly_digest"]),
  });
  if (continuity !== analyst.metadata["continuity_digest"]) fail();
  const source = ReflectionSourceV1.parse({
    schema: "kerneljson:reflection-source/v1", tenantId, sourceTaskId,
    taskDigest: canonicalDigest(task), planDigest: canonicalDigest(plan), outcomeDigest: canonicalDigest(outcome),
    bindingDigest: canonicalDigest(binding), releaseEpoch: f.bindingEpoch, releaseId: binding.releaseId,
    contractStartEpoch: f.contractStartEpoch,
    evidence: records.map(e => ({ id: e.id, stepId: e.stepId, digest: e.digest })).sort((a, b) => a.id < b.id ? -1 : 1),
    analyst: runtime(analyst, "RUNTIME_ANALYSE"), reviewer: runtime(reviewer, "RUNTIME_REVIEW"),
    cognition: { mode: f.latches[0]!.mode, identity },
    memoryAssemblyId: memory?.assembly_id ?? null, memoryAssemblyDigest: memory?.context_digest ?? null,
    assemblyDigest: analyst.metadata["assembly_digest"], continuityDigest: analyst.metadata["continuity_digest"],
  });
  if (source.analyst.callId === source.reviewer.callId || findSecretShapedContent(source)) fail();
  return source;
}

/** Kernel-assigned values, allocated once in the future completion transaction.
 * Caller authentication/membership is a K3 read-adapter responsibility. */
export interface ReflectionProposalIdentity {
  id: string; reflectionTaskId: string; tenantId: string; requesterId: string; createdAt: string;
}

export function buildReflectionProposal(
  request: ReflectionRequestV1, facts: ReflectionSourceFacts, identity: ReflectionProposalIdentity,
): ReflectionProposalV1 {
  try {
    const parsed = ReflectionRequestV1.parse(request);
    const source = verifyReflectionSource(identity.tenantId, parsed.sourceTaskId, facts);
    const proposal = ReflectionProposalV1.parse({
      ...identity, schema: "kerneljson:reflection-proposal/v1", policyVersion: "reflection-review/v1",
      focus: parsed.focus, source, sourceManifestDigest: canonicalDigest(source),
      observations: ["CANONICAL_COMPLETION_VERIFIED", "ANALYST_RECEIPT_BOUND", "REVIEWER_ISOLATED"],
      evaluationRequest: parsed.focus === "REVIEW_EXECUTION" ? "REVIEW_SINGLE_EXECUTION" : "BENCHMARK_ANALYST_ROUTE",
      proposalDigest: "0".repeat(64),
    });
    const { proposalDigest: _excluded, ...body } = proposal;
    proposal.proposalDigest = canonicalDigest(body);
    return verifyReflectionProposal(proposal);
  } catch { throw new Error("REFLECTION_PROPOSAL_REFUSED"); }
}

/** Integrity/shape check only; source qualification requires verifyReflectionSource. */
export function verifyReflectionProposal(raw: unknown): ReflectionProposalV1 {
  try {
    const proposal = ReflectionProposalV1.parse(raw);
    const { proposalDigest, ...body } = proposal;
    if (canonicalDigest(proposal.source) !== proposal.sourceManifestDigest
      || canonicalDigest(body) !== proposalDigest || findSecretShapedContent(proposal)) fail();
    return proposal;
  } catch { throw new Error("REFLECTION_PROPOSAL_REFUSED"); }
}
