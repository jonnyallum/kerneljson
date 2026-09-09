import { createHash } from "node:crypto";
import {
  mapEmailToEstateAdmissionRequest,
  type EmailEnvelopeInput,
} from "./email-mapper.js";
import {
  classifyShadowAdmission,
  type LegacyActionSnapshot,
  type PriorShadowAdmission,
} from "./compare.js";
import {
  simulateWouldBeAdmission,
  type SimulatedAdmission,
} from "./simulate-admission.js";
import type { ShadowStoreWriter } from "./shadow-store.js";
import type {
  EstateAdmissionRequest,
  ShadowVerdict,
} from "./estate-admission-request.js";
import { SHADOW_CONSUMER } from "./identity.js";

export interface ShadowAdmissionResult {
  mode: "shadow";
  consumer: string;
  request?: EstateAdmissionRequest;
  simulated?: SimulatedAdmission;
  verdict: ShadowVerdict;
  reasons: string[];
  diff: Record<string, unknown>;
  run_id?: string;
  compare_id?: string;
  error?: string;
}

function inputHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Compatibility Admission Adapter — EMAIL channel, SHADOW ONLY.
 * Maps envelope → EstateAdmissionRequest, derives discovery/idempotency keys,
 * simulates would-be taskId via KJ stableId/digest helpers, classifies vs legacy,
 * persists to shadow store. NEVER calls Spawner / NewSystemRuntimeAdapter /
 * public.actions / mark-seen / task_admissions writers.
 */
export class CompatibilityAdmissionAdapter {
  private readonly priorByKey = new Map<string, PriorShadowAdmission>();

  constructor(private readonly store: ShadowStoreWriter) {}

  /** Test/helper: seed prior admission state for conflict fixtures. */
  seedPrior(prior: PriorShadowAdmission): void {
    this.priorByKey.set(prior.keyDigest, prior);
  }

  getPrior(keyDigest: string): PriorShadowAdmission | undefined {
    return this.priorByKey.get(keyDigest);
  }

  async admitEmailShadow(
    envelope: EmailEnvelopeInput,
    legacy?: LegacyActionSnapshot | null,
  ): Promise<ShadowAdmissionResult> {
    const started = Date.now();
    try {
      const request = mapEmailToEstateAdmissionRequest({
        ...envelope,
        legacy_action: legacy ?? envelope.legacy_action ?? null,
      });
      const simulated = simulateWouldBeAdmission(request);
      const prior = this.priorByKey.get(simulated.keyDigest) ?? null;
      const compared = classifyShadowAdmission({
        request,
        simulated,
        legacy: legacy ?? envelope.legacy_action ?? null,
        prior,
      });

      if (compared.verdict !== "CONFLICT" && compared.verdict !== "ERROR") {
        this.priorByKey.set(simulated.keyDigest, {
          keyDigest: simulated.keyDigest,
          requestDigest: simulated.requestDigest,
          wouldBeTaskId: simulated.wouldBeTaskId,
        });
      }

      const output = {
        mode: "shadow",
        channel: "email",
        estate_discovery_key: simulated.estate_discovery_key,
        idempotency_key: simulated.idempotencyKey,
        key_digest: simulated.keyDigest,
        request_digest: simulated.requestDigest,
        would_be_task_id: simulated.wouldBeTaskId,
        intent_id: simulated.intentId,
        recipe: simulated.recipe,
        objective: simulated.objective,
        needs_action: request.compatibility?.needs_action ?? null,
        verdict: compared.verdict,
        spawner_invoked: false,
        new_system_runtime_invoked: false,
        public_actions_written: false,
        task_admissions_written: false,
      };

      const persisted = await this.store.persist({
        input_hash: inputHash({
          estate_discovery_key: simulated.estate_discovery_key,
          request_digest: simulated.requestDigest,
        }),
        status: compared.verdict === "ERROR" ? "error" : "shadow_ok",
        latency_ms: Math.max(1, Date.now() - started),
        output,
        verdict: compared.verdict,
        diff: {
          ...compared.diff,
          reasons: compared.reasons,
          consumer: SHADOW_CONSUMER,
        },
      });

      return {
        mode: "shadow",
        consumer: SHADOW_CONSUMER,
        request,
        simulated,
        verdict: compared.verdict,
        reasons: compared.reasons,
        diff: compared.diff,
        run_id: persisted.run.id,
        compare_id: persisted.compare.id,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const persisted = await this.store.persist({
        input_hash: inputHash({ error: message }),
        status: "error",
        latency_ms: Math.max(1, Date.now() - started),
        output: {
          mode: "shadow",
          error: message,
          spawner_invoked: false,
          new_system_runtime_invoked: false,
          public_actions_written: false,
          task_admissions_written: false,
        },
        verdict: "ERROR",
        diff: { error: message, consumer: SHADOW_CONSUMER },
      });
      return {
        mode: "shadow",
        consumer: SHADOW_CONSUMER,
        verdict: "ERROR",
        reasons: [message],
        diff: { error: message },
        run_id: persisted.run.id,
        compare_id: persisted.compare.id,
        error: message,
      };
    }
  }
}
