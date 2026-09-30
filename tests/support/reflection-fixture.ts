import { readFileSync } from "node:fs";
import { Evidence, IdentityCognitionPin, IdentityDocument, IdentityVersionRow, MISSION_RECIPE, Outcome, Task, parseMissionObjective } from "../../packages/contracts/src/index.js";
import { FacultyPin } from "../../packages/contracts/src/faculty.js";
import { capabilityDigest } from "../../packages/capabilities/src/index.js";
import { kernelSubmission } from "../../evals/fixtures/kernel.js";
import { compileIntent } from "../../services/kernel/src/compiler/index.js";
import { orderedSteps, planTask, projectStep } from "../../services/kernel/src/planner/index.js";
import { githubEvidence, reconcileEvidence, SOURCES, stepOutputs } from "../../services/kernel/src/mission/evidence.js";
import { missionSummary, parseAnalysis, reconcileMission, sha256Text } from "../../services/kernel/src/mission/reconcile.js";
import { coreTeamTemplates } from "../../services/kernel/src/faculty/templates.js";
import { facultyEvidence } from "../../services/kernel/src/faculty/policy.js";
import { canonicalDigest, identityCoreDigestV1 } from "../../services/kernel/src/identity/canonical.js";
import { continuityDigestOf } from "../../services/kernel/src/mission/cognition-digests.js";
import { projectIdentity, projectionBytes, projectionDigest } from "../../services/kernel/src/identity/projection.js";
import { identityFramingCeiling } from "../../services/kernel/src/faculty/identity-ceiling.js";
import { provenanceOf } from "../../services/kernel/src/identity/evidence-verify.js";
import { analysisJson, makeFacts, REPO, reviewJson } from "./mission-fixture.js";

export const reflectionId = (n: number) => `90000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const reflectionAt = "2026-09-30T10:00:00.000Z";
export function reflectionFixture(mode: "NONE" | "REQUIRED" = "NONE") {
  const task = Task.parse({ ...compileIntent({ ...kernelSubmission, recipe: MISSION_RECIPE,
    intent: { ...kernelSubmission.intent, objective: REPO } }).task, status: "COMPLETED", completedAt: reflectionAt });
  const plan = planTask(task, MISSION_RECIPE), nodes = orderedSteps(plan);
  const faculties = coreTeamTemplates(task.tenant.id, "test:reflection");
  const facultyPins = ["RUNTIME_ANALYSE", "RUNTIME_REVIEW"].map((operation, i) => {
    const faculty = faculties.find(f => f.id === (i === 0 ? "intelligence" : "verifier"))!;
    return FacultyPin.parse({ tenantId: task.tenant.id, taskId: task.id, stepId: nodes[i + 1]!.id,
      operation, faculty, facultyDigest: capabilityDigest(faculty),
      routingReason: i === 0 ? "repo-analysis/analyst" : "repo-analysis/independent-reviewer",
      provider: i === 0 ? "deepseek" : "openrouter", model: i === 0 ? "deepseek-v4-flash" : "x-ai/grok-test",
      policyVersion: faculty.policyVersion });
  });
  const identityPins: IdentityCognitionPin[] = [], identityVersions: IdentityVersionRow[] = [];
  if (mode === "REQUIRED") {
    const corpus = JSON.parse(readFileSync("tests/fixtures/identity-core-v1.vectors.json", "utf8")) as {
      vectors: Array<{ name: string; inputJson: string }>;
    };
    const doc = IdentityDocument.parse({ ...JSON.parse(corpus.vectors.find(v => v.name === "kernel-v1-activated")!.inputJson), tenantId: task.tenant.id });
    const projection = projectIdentity(doc, "ANALYST_INTELLIGENCE_V1", identityFramingCeiling("intelligence", "faculty-routing/v1"));
    const pin = IdentityCognitionPin.parse({ tenantId: task.tenant.id, taskId: task.id, stepId: nodes[1]!.id,
      identityId: doc.id, identityVersionId: reflectionId(10), identityVersion: doc.version,
      identityCoreDigest: identityCoreDigestV1(doc), classADigest: identityCoreDigestV1(doc.sections.classA),
      digestContract: "kerneljson:identity-core/v1", projectionSchema: "kerneljson:identity-projection/v1",
      projectionProfile: "ANALYST_INTELLIGENCE_V1", projection, projectionBytes: projectionBytes(projection),
      projectionDigest: projectionDigest(projection), facultyId: "intelligence", facultyVersion: facultyPins[0]!.faculty.version,
      facultyDigest: facultyPins[0]!.facultyDigest, mode });
    identityPins.push(pin);
    identityVersions.push(IdentityVersionRow.parse({ id: pin.identityVersionId, identityId: doc.id, tenantId: doc.tenantId,
      version: doc.version, document: doc, identityCoreDigest: pin.identityCoreDigest, classADigest: pin.classADigest,
      governanceClass: "BOOTSTRAP", candidateId: reflectionId(11), createdByTask: reflectionId(12), createdAt: reflectionAt }));
  }
  const facts = makeFacts(), factsDigest = capabilityDigest(facts), analysis = analysisJson(), review = reviewJson({ analysisText: analysis });
  const base = (i: number) => ({ id: reflectionId(i + 1), taskId: task.id, stepId: nodes[i]!.id, capturedAt: reflectionAt });
  const runtime = (i: number, text: string, subject: string) => Evidence.parse({ ...base(i), type: "ARTIFACT",
    source: i === 1 ? SOURCES.analyst : SOURCES.reviewer, digest: sha256Text(text),
    metadata: { role: i === 1 ? "analyst" : "reviewer", provider: facultyPins[i - 1]!.provider,
      model: facultyPins[i - 1]!.model, response_model: facultyPins[i - 1]!.model,
      call_id: reflectionId(20 + i), request_digest: "a".repeat(64), output_digest: sha256Text(text),
      text, subject_digest: subject, faculty: facultyEvidence(facultyPins[i - 1]!),
      identity_cognition_mode: i === 1 ? mode : "NONE",
      ...(i === 1 ? { identity: identityPins[0] ? provenanceOf(identityPins[0]) : null,
        assembly_digest: "b".repeat(64), continuity_digest: "c".repeat(64) } : {}) } });
  const rec = reconcileMission({ facts, contract: parseMissionObjective(task.objective).contract,
    analysisText: analysis, analystModel: facultyPins[0]!.model, analystProvider: facultyPins[0]!.provider,
    reviewText: review, reviewerModel: facultyPins[1]!.model, reviewerProvider: facultyPins[1]!.provider });
  const evidence = [githubEvidence({ ...base(0), facts, factsDigest }), runtime(1, analysis, factsDigest),
    runtime(2, review, sha256Text(analysis)), reconcileEvidence({ ...base(3), rec })];
  const outputs = [stepOutputs.github(facts, factsDigest), stepOutputs.runtime(sha256Text(analysis)),
    stepOutputs.runtime(sha256Text(review)), stepOutputs.reconcile(rec)];
  const steps = nodes.map((node, i) => ({ ...projectStep(node), status: "COMPLETED" as const, output: outputs[i]! }));
  const refs = evidence.map(e => e.id);
  const outcome = Outcome.parse({ taskId: task.id, status: "COMPLETED", evidenceRefs: refs,
    acceptanceResults: task.acceptanceCriteria.map(criterion => ({ criterion, passed: true, evidenceRefs: refs })),
    summary: missionSummary(parseAnalysis(analysis)!), completedAt: reflectionAt });
  const fixture = { task, outcome, plans: [plan], steps, evidence, facultyPins, identityPins, identityVersions,
    binding: { taskId: task.id, tenantId: task.tenant.id, principal: task.principal,
      service: "MissionWorkflowV1", version: "v1", routingId: "test", controls: ["cancel"],
      releaseId: "fixture-release", executionKey: task.id, boundAt: task.createdAt, definitionDigest: "d".repeat(64) },
    bindingEpoch: 13, contractStartEpoch: 13, activation: { epoch: 13, releaseId: "fixture-release" },
    latches: [{ tenant_id: task.tenant.id, task_id: task.id, step_id: nodes[1]!.id, mode, release_epoch: 13 }],
    modelCalls: [{ binding: { contract: "kerneljson:model-call-binding/v1", task_id: task.id, step_id: nodes[1]!.id,
      call_id: reflectionId(21), provider: facultyPins[0]!.provider, model: facultyPins[0]!.model,
      status: "SUCCEEDED", request_digest: "a".repeat(64), assembly_digest: "b".repeat(64),
      continuity_digest: "c".repeat(64), identity_cognition_mode: mode } }],
  };
  refreshReflectionContinuity(fixture);
  return fixture;
}

export function refreshReflectionContinuity(f: { task: Task; evidence: Evidence[]; facultyPins: FacultyPin[];
  identityPins: IdentityCognitionPin[]; modelCalls: Array<{ binding: { continuity_digest: string } }> }) {
  const objective = parseMissionObjective(f.task.objective), faculty = f.facultyPins[0]!, pin = f.identityPins[0];
  const memory = f.evidence[1]!.metadata["memory_context"] as { context_digest?: string } | undefined;
  const value = continuityDigestOf({ mission: { recipe: MISSION_RECIPE, repo: objective.repo, question: objective.question,
    contractDigest: canonicalDigest(objective.contract), factsDigest: f.evidence[0]!.digest! },
    faculty: { id: faculty.faculty.id, version: faculty.faculty.version, digest: faculty.facultyDigest },
    identity: pin ? { mode: "REQUIRED", identityCoreDigest: pin.identityCoreDigest, projectionProfile: pin.projectionProfile,
      projectionDigest: pin.projectionDigest } : null,
    memory: memory?.context_digest ? { assemblyDigest: memory.context_digest } : null, assemblyDigest: "b".repeat(64) });
  f.evidence[1]!.metadata["continuity_digest"] = value;
  f.modelCalls[0]!.binding.continuity_digest = value;
}
