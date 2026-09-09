import { capabilityDigest } from "../../capabilities/src/index.js";
import { stableId } from "../../../services/kernel/src/compiler/index.js";
import type { EstateAdmissionRequest } from "./estate-admission-request.js";
import {
  SHADOW_EMAIL_RECIPE,
  deriveIdempotencyKey,
  deriveKeyDigest,
} from "./identity.js";

export interface SimulatedAdmission {
  idempotencyKey: string;
  keyDigest: string;
  requestDigest: string;
  intentId: string;
  wouldBeTaskId: string;
  recipe: typeof SHADOW_EMAIL_RECIPE;
  objective: string;
  estate_discovery_key: string;
  tenantId: string;
  principalId: string;
}

/**
 * Pure would-be KJ admission simulation.
 * Reuses stableId + capabilityDigest algorithms from KJ; NEVER writes task_admissions,
 * NEVER calls Spawner / NewSystemRuntimeAdapter / public.actions.
 */
export function simulateWouldBeAdmission(
  request: EstateAdmissionRequest,
): SimulatedAdmission {
  const tenantId = request.tenant_ref.id;
  const principalId = request.principal_ref.id;
  const idempotencyKey = deriveIdempotencyKey({
    tenantId,
    principalId,
    estate_discovery_key: request.estate_discovery_key,
  });
  const keyDigest = deriveKeyDigest(idempotencyKey);
  const recipe = SHADOW_EMAIL_RECIPE;
  const requestDigest = capabilityDigest({
    recipe,
    objective: request.objective,
  });
  const intentId = stableId(["gateway/v1", tenantId, principalId, keyDigest]);
  const wouldBeTaskId = stableId({
    tenant: tenantId,
    intentId,
    recipe,
  });
  return {
    idempotencyKey,
    keyDigest,
    requestDigest,
    intentId,
    wouldBeTaskId,
    recipe,
    objective: request.objective,
    estate_discovery_key: request.estate_discovery_key,
    tenantId,
    principalId,
  };
}
