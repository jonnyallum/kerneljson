import type { EstateAdmissionRequest, ShadowVerdict } from "./estate-admission-request.js";
import type { SimulatedAdmission } from "./simulate-admission.js";
import { normalizeLiveSourceRef } from "./identity.js";

export interface LegacyActionSnapshot {
  id?: string;
  source?: string;
  source_ref?: string;
  title?: string;
  state?: string;
}

export interface PriorShadowAdmission {
  keyDigest: string;
  requestDigest: string;
  wouldBeTaskId: string;
}

export interface CompareResult {
  verdict: ShadowVerdict;
  reasons: string[];
  diff: Record<string, unknown>;
}

/**
 * Classify shadow admission vs optional legacy action + prior shadow replay state.
 *
 * Phase 4.1 Option C: when normalised live source_ref equals estate_discovery_key,
 * raw bracket/case/whitespace provenance variance is NOT ACCEPTABLE_DIFFERENCE —
 * it is MATCH (intentional collapse).
 */
export function classifyShadowAdmission(input: {
  request: EstateAdmissionRequest;
  simulated: SimulatedAdmission;
  legacy?: LegacyActionSnapshot | null;
  prior?: PriorShadowAdmission | null;
}): CompareResult {
  const reasons: string[] = [];
  const diff: Record<string, unknown> = {};
  const { request, simulated, legacy, prior } = input;

  if (prior) {
    if (prior.keyDigest === simulated.keyDigest) {
      if (prior.requestDigest !== simulated.requestDigest) {
        return {
          verdict: "CONFLICT",
          reasons: [
            "Same idempotency keyDigest with different requestDigest (changed payload replay)",
          ],
          diff: {
            prior_request_digest: prior.requestDigest,
            request_digest: simulated.requestDigest,
            prior_task_id: prior.wouldBeTaskId,
            would_be_task_id: simulated.wouldBeTaskId,
          },
        };
      }
      if (prior.wouldBeTaskId !== simulated.wouldBeTaskId) {
        return {
          verdict: "ERROR",
          reasons: ["Idempotent replay produced different would-be taskId"],
          diff: {
            prior_task_id: prior.wouldBeTaskId,
            would_be_task_id: simulated.wouldBeTaskId,
          },
        };
      }
      reasons.push("Idempotent replay: same keyDigest + requestDigest → same would-be taskId");
    }
  }

  const needsAction = request.compatibility?.needs_action;
  if (!legacy) {
    if (needsAction === false) {
      return {
        verdict: "ACCEPTABLE_DIFFERENCE",
        reasons: [
          ...reasons,
          "Non-actionable email with no legacy action snapshot (live would not mint)",
        ],
        diff: { needs_action: false },
      };
    }
    return {
      verdict: "ACCEPTABLE_DIFFERENCE",
      reasons: [
        ...reasons,
        "No legacy action snapshot supplied — compare-only identity recorded",
      ],
      diff: {
        estate_discovery_key: simulated.estate_discovery_key,
        would_be_task_id: simulated.wouldBeTaskId,
      },
    };
  }

  if (legacy.source && legacy.source !== "email-triage") {
    return {
      verdict: "MATERIAL_DIFFERENCE",
      reasons: [`Legacy source=${legacy.source} is not email-triage`],
      diff: { legacy_source: legacy.source },
    };
  }

  if (legacy.source_ref) {
    const normalisedLegacy = normalizeLiveSourceRef(legacy.source_ref);
    if (normalisedLegacy !== simulated.estate_discovery_key) {
      return {
        verdict: "MATERIAL_DIFFERENCE",
        reasons: [
          "Normalised legacy source_ref does not match estate_discovery_key",
        ],
        diff: {
          legacy_source_ref: legacy.source_ref,
          normalised_legacy: normalisedLegacy,
          estate_discovery_key: simulated.estate_discovery_key,
        },
      };
    }
    if (legacy.source_ref !== simulated.estate_discovery_key) {
      // Option C qualified: brackets/case/whitespace are provenance-only.
      reasons.push(
        "Option C: raw live source_ref provenance collapsed to normalised discovery key (MATCH)",
      );
      diff.live_source_ref_raw = legacy.source_ref;
      diff.normalised_discovery_key = simulated.estate_discovery_key;
      if (request.raw_message_id) {
        diff.raw_message_id = request.raw_message_id;
      }
    }
  }

  if (legacy.title && legacy.title !== simulated.objective) {
    const legacyNorm = legacy.title.trim();
    const objNorm = simulated.objective.trim();
    if (legacyNorm !== objNorm) {
      const legacyCore = legacyNorm.replace(/^Email triage:\s*/i, "");
      const objCore = objNorm.replace(/^Email triage:\s*/i, "");
      if (legacyCore !== objCore && !objCore.includes("[REDACTED_SECRET]")) {
        return {
          verdict: "MATERIAL_DIFFERENCE",
          reasons: ["Objective/title mismatch vs legacy action"],
          diff: { legacy_title: legacy.title, objective: simulated.objective },
        };
      }
      reasons.push("Objective scrubbing differs from legacy title (secret redaction)");
      diff.legacy_title = legacy.title;
      diff.objective = simulated.objective;
      return { verdict: "ACCEPTABLE_DIFFERENCE", reasons, diff };
    }
  }

  if (needsAction === false && legacy.source_ref) {
    return {
      verdict: "MATERIAL_DIFFERENCE",
      reasons: [
        "Triage says non-actionable but legacy action snapshot exists",
      ],
      diff: { needs_action: false, legacy_source_ref: legacy.source_ref },
    };
  }

  return {
    verdict: "MATCH",
    reasons: reasons.length
      ? reasons
      : ["Discovery key, objective, and legacy snapshot align"],
    diff: {
      estate_discovery_key: simulated.estate_discovery_key,
      would_be_task_id: simulated.wouldBeTaskId,
      ...(legacy.id ? { legacy_action_id: legacy.id } : {}),
      ...(diff.live_source_ref_raw
        ? {
            live_source_ref_raw: diff.live_source_ref_raw,
            normalised_discovery_key: diff.normalised_discovery_key,
            ...(diff.raw_message_id ? { raw_message_id: diff.raw_message_id } : {}),
          }
        : {}),
    },
  };
}
