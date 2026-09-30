import {
  Evidence,
  IdentityCognitionPin,
  IdentityRuntimeProvenance,
  ModelCallBinding,
} from "../../../../packages/contracts/src/index.js";
import { canonicalDigest, identityCoreCanonicalV1, identityCoreDigestV1 } from "./canonical.js";

/**
 * KJ-P7B-1 (ADR-0022 sections 4.7 and 10, D1 erratum) - identity completion verification. PURE: it receives
 * persisted database facts only (the release oracle, latches, pins, MODEL_CALLED bindings and evidence) and imports
 * only contracts and canonical. It never rebuilds a prompt and never reads the environment. It verifies evidence;
 * Ledger.write remains the completion authority and turns any throw here into CompletionVerificationError.
 */
export const ANALYST_SOURCE = "kerneljson:runtime/analyst";
export const REVIEWER_SOURCE = "kerneljson:runtime/reviewer";

export interface IdentityCompletionFacts {
  /** identity_cognition_contract_v1.first_release_epoch, or null when no marker exists. */
  contractStartEpoch: number | null;
  /** execution_bindings.release_epoch for the task, or null when the task has no binding. */
  bindingEpoch: number | null;
  /** The plan's RUNTIME_ANALYSE step. */
  analystStepId: string;
  latches: ReadonlyArray<{ tenant_id: string; task_id: string; step_id: string; mode: string; release_epoch: number | string }>;
  pins: readonly unknown[];
  /** Payloads of this task's MODEL_CALLED events. */
  modelCalls: readonly unknown[];
  evidence: readonly unknown[];
}

const COGNITION_KEYS = ["identity", "identity_cognition_mode", "assembly_digest", "continuity_digest"] as const;

export function isLegacyTask(contractStartEpoch: number | null, bindingEpoch: number | null): boolean {
  return contractStartEpoch === null || bindingEpoch === null || bindingEpoch < contractStartEpoch;
}

export function provenanceOf(pin: IdentityCognitionPin): IdentityRuntimeProvenance {
  return IdentityRuntimeProvenance.parse({
    identity_id: pin.identityId,
    identity_version_id: pin.identityVersionId,
    identity_version: pin.identityVersion,
    identity_core_digest: pin.identityCoreDigest,
    class_a_digest: pin.classADigest,
    projection_profile: pin.projectionProfile,
    projection_digest: pin.projectionDigest,
  });
}

function fail(reason: string): never {
  throw new Error(`Identity completion verification failed: ${reason}`);
}

export function verifyIdentityEvidence(facts: IdentityCompletionFacts): void {
  const records = facts.evidence.map((e) => Evidence.parse(e));
  const runtime = records.filter((e) => e.source === ANALYST_SOURCE || e.source === REVIEWER_SOURCE);
  const bindings = facts.modelCalls.map((b) => ModelCallBinding.parse((b as { binding?: unknown } | null)?.binding));

  if (isLegacyTask(facts.contractStartEpoch, facts.bindingEpoch)) {
    // A legacy task keeps its pre-P7B contract: no latch, no pin, no call binding, no cognition metadata.
    if (facts.latches.length || facts.pins.length || bindings.length) fail("legacy task carries cognition state");
    if (runtime.some((e) => COGNITION_KEYS.some((k) => k in e.metadata))) fail("legacy task carries cognition evidence");
    return;
  }

  // Contract task: exactly one latch, on the analyst step, bound to the task's own release epoch.
  if (facts.latches.length !== 1) fail(`expected exactly one cognition latch, found ${facts.latches.length}`);
  const latch = facts.latches[0]!;
  if (latch.step_id !== facts.analystStepId) fail("the latch is not on the analyst step");
  if (Number(latch.release_epoch) !== facts.bindingEpoch) fail("latch release epoch differs from the execution binding");
  if (latch.mode !== "NONE" && latch.mode !== "REQUIRED") fail("unknown latch mode");

  const analyst = runtime.filter((e) => e.source === ANALYST_SOURCE);
  if (analyst.length !== 1 || analyst[0]!.stepId !== facts.analystStepId) fail("expected exactly one analyst runtime record on the analyst step");
  const a = analyst[0]!.metadata;
  if (a["identity_cognition_mode"] !== latch.mode) fail("analyst evidence mode differs from the latch");

  // D1 erratum: runtime evidence == the immutable MODEL_CALLED binding for this analyst call.
  const matching = bindings.filter((b) => b.call_id === a["call_id"]);
  if (bindings.some((b) => b.step_id !== facts.analystStepId)) fail("a model-call binding is not on the analyst step");
  if (matching.length !== 1) fail(`expected exactly one MODEL_CALLED binding for the analyst call, found ${matching.length}`);
  const bound = matching[0]!;
  if (bound.task_id !== analyst[0]!.taskId || bound.step_id !== facts.analystStepId) fail("model-call binding names another task or step");
  if (bound.status !== "SUCCEEDED") fail("the analyst call binding did not succeed");
  for (const [field, value] of [
    ["request_digest", bound.request_digest],
    ["assembly_digest", bound.assembly_digest],
    ["continuity_digest", bound.continuity_digest],
    ["provider", bound.provider],
    ["model", bound.model],
  ] as const)
    if (a[field] !== value) fail(`analyst evidence ${field} differs from the MODEL_CALLED binding`);
  if (bound.identity_cognition_mode !== latch.mode) fail("model-call binding mode differs from the latch");

  if (latch.mode === "NONE") {
    if (facts.pins.length !== 0) fail("a NONE latch has an identity pin");
    if (a["identity"] !== null) fail("NONE analyst evidence must carry identity: null");
  } else {
    if (facts.pins.length !== 1) fail(`a REQUIRED latch needs exactly one identity pin, found ${facts.pins.length}`);
    const raw = facts.pins[0];
    const pin = IdentityCognitionPin.parse(raw);
    if (canonicalDigest(pin) !== canonicalDigest(raw)) fail("identity pin is not in canonical form");
    if (pin.taskId !== latch.task_id || pin.stepId !== latch.step_id || pin.tenantId !== latch.tenant_id) fail("identity pin names another step or tenant");
    if (identityCoreDigestV1(pin.projection) !== pin.projectionDigest
      || Buffer.byteLength(identityCoreCanonicalV1(pin.projection), "utf8") !== pin.projectionBytes)
      fail("identity pin projection digest or size does not verify");
    if (canonicalDigest(a["identity"] ?? null) !== canonicalDigest(provenanceOf(pin))) fail("analyst identity evidence differs from the canonical pin");
  }

  // The reviewer never carries identity.
  for (const r of runtime.filter((e) => e.source === REVIEWER_SOURCE)) {
    if ("identity" in r.metadata) fail("reviewer evidence carries identity");
    if (r.metadata["identity_cognition_mode"] !== "NONE") fail("reviewer evidence must record identity_cognition_mode NONE");
  }
}
