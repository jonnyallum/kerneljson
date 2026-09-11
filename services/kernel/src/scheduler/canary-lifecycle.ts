import { z } from "zod";
import { Id, Timestamp } from "../../../../packages/contracts/src/index.js";
import { ScheduleSpec, ScheduleState } from "./spec.js";
import { PersistedScheduleSpec } from "./persistence.js";
import type { ScheduleStore } from "./store.js";
import { StoreError } from "./store.js";
import type { IdentityGate } from "./canary-seed.js";

/**
 * S1 canary — Gate 3 lifecycle tooling (repo-only; NOT executed against production here).
 *
 * Two narrow, explicit, fail-closed production lifecycle operations, built on the
 * existing reviewed `ScheduleStore` (getSchedule / upsertSpecVersion / setState) and the
 * existing `IdentityGate` — NO raw SQL, NO generated IDs, NO hidden defaults:
 *
 *   enableCanaryForProduction — disabled(v1) -> enabled(v2, enabled_for_production=true)
 *   disableCanary             — the emergency stop: any -> disabled (active version kept)
 *
 * `enabled_for_production` is immutable per schedule version (a spec version is immutable),
 * so enabling for production is an authorised human-owned NEW version (v2 identical to v1
 * except version + enabled_for_production), then a lifecycle transition to enabled@v2.
 * `disableCanary` only touches the lifecycle row; it never deletes a spec/fire/task, never
 * unbinds an admitted child, and is safe to replay.
 */

export type CanaryLifecycleCode =
  | "MALFORMED_INPUT"
  | "UNKNOWN_SCHEDULE"
  | "UNKNOWN_TENANT"
  | "UNKNOWN_PRINCIPAL"
  | "ACTOR_NOT_HUMAN"
  | "MISSING_TENANT_MEMBERSHIP"
  | "TENANT_MISMATCH"
  | "OWNER_MISMATCH"
  | "UNEXPECTED_STATE"
  | "UNEXPECTED_ACTIVE_VERSION"
  | "ALREADY_PRODUCTION"
  | "CONFLICTING_V2";

export class CanaryLifecycleError extends Error {
  constructor(
    readonly code: CanaryLifecycleCode,
    message: string,
  ) {
    super(message);
    this.name = "CanaryLifecycleError";
  }
}

/** Verify the acting principal is a real HUMAN member of the tenant (read-only gate). */
async function assertHumanActor(
  gate: IdentityGate,
  tenantId: string,
  actorPrincipalId: string,
): Promise<void> {
  const snap = await gate.snapshot({
    tenantId,
    principalId: actorPrincipalId,
    ownerId: actorPrincipalId,
  });
  if (!snap.tenantExists) throw new CanaryLifecycleError("UNKNOWN_TENANT", "tenant does not exist");
  if (!snap.principalExists)
    throw new CanaryLifecycleError("UNKNOWN_PRINCIPAL", "actor principal does not exist");
  if (snap.ownerKind !== "HUMAN")
    throw new CanaryLifecycleError("ACTOR_NOT_HUMAN", "actor principal is not HUMAN");
  if (!snap.membershipExists)
    throw new CanaryLifecycleError(
      "MISSING_TENANT_MEMBERSHIP",
      "actor has no membership in the tenant",
    );
}

// ---------------------------------------------------------------------------
// enable-canary
// ---------------------------------------------------------------------------

/** Explicit, strict inputs. No `enabledForProduction` input (it is FORCED true on v2), no
 *  generated ids: the exact schedule, tenant, actor, versions and createdAt are all caller-
 *  supplied and therefore visible in the authorisation before any write. */
export const EnableCanaryInput = z.strictObject({
  scheduleId: Id,
  tenantId: Id,
  actorPrincipalId: Id, // the HUMAN owner performing the enable
  fromVersion: z.string().min(1),
  toVersion: z.string().min(1),
  createdAt: Timestamp, // v2 createdAt — fixed/approved so a replay reproduces byte state
  expectedState: ScheduleState, // asserted against reality; drift fails closed
});
export type EnableCanaryInput = z.infer<typeof EnableCanaryInput>;

export interface EnableCanaryResult {
  scheduleId: string;
  enabled: boolean;
  alreadyEnabled: boolean;
  activeVersion: string;
}

export async function enableCanaryForProduction(
  store: ScheduleStore,
  gate: IdentityGate,
  rawInput: unknown,
): Promise<EnableCanaryResult> {
  const parsed = EnableCanaryInput.safeParse(rawInput);
  if (!parsed.success)
    throw new CanaryLifecycleError("MALFORMED_INPUT", "enable-canary input failed validation");
  const input = parsed.data;
  if (input.fromVersion === input.toVersion)
    throw new CanaryLifecycleError("MALFORMED_INPUT", "toVersion must differ from fromVersion");

  await assertHumanActor(gate, input.tenantId, input.actorPrincipalId);

  const current = await store.getSchedule(input.scheduleId);
  if (!current) throw new CanaryLifecycleError("UNKNOWN_SCHEDULE", "schedule does not exist");

  // Ownership/tenant of the target must match the explicit inputs (never enable someone else's).
  if (current.spec.tenant.id !== input.tenantId)
    throw new CanaryLifecycleError("TENANT_MISMATCH", "schedule tenant does not match input");
  if (current.spec.owner.id !== input.actorPrincipalId)
    throw new CanaryLifecycleError("OWNER_MISMATCH", "actor is not the schedule owner");

  // Idempotent replay of a COMPLETED enable: enabled@toVersion with production on -> no write.
  if (
    current.state.state === "enabled" &&
    current.state.activeVersion === input.toVersion &&
    current.spec.version === input.toVersion &&
    current.spec.enabledForProduction === true
  )
    return {
      scheduleId: input.scheduleId,
      enabled: false,
      alreadyEnabled: true,
      activeVersion: input.toVersion,
    };

  // Otherwise reality MUST match the declared expectation (drift fails closed).
  if (current.state.state !== input.expectedState)
    throw new CanaryLifecycleError(
      "UNEXPECTED_STATE",
      `expected state ${input.expectedState}, found ${current.state.state}`,
    );
  if (current.state.activeVersion !== input.fromVersion)
    throw new CanaryLifecycleError(
      "UNEXPECTED_ACTIVE_VERSION",
      `expected active version ${input.fromVersion}, found ${current.state.activeVersion}`,
    );
  if (current.spec.enabledForProduction !== false)
    throw new CanaryLifecycleError(
      "ALREADY_PRODUCTION",
      "active version already has enabled_for_production=true",
    );

  // Build v2: semantically identical to v1 except version, enabled_for_production, createdAt,
  // createdBy. Validate the runtime shape (owner HUMAN, valid tz/calendar) before persisting.
  const v2 = PersistedScheduleSpec.parse({
    scheduleId: current.spec.scheduleId,
    version: input.toVersion,
    tenant: current.spec.tenant,
    principal: current.spec.principal,
    owner: current.spec.owner,
    name: current.spec.name,
    timezone: current.spec.timezone,
    calendar: current.spec.calendar,
    missedRunPolicy: current.spec.missedRunPolicy,
    overlapPolicy: current.spec.overlapPolicy,
    nonexistentTimePolicy: current.spec.nonexistentTimePolicy,
    maxBackfillRuns: current.spec.maxBackfillRuns,
    perScheduleConcurrency: current.spec.perScheduleConcurrency,
    enabledForProduction: true,
    createdAt: input.createdAt,
    createdBy: input.actorPrincipalId,
  });
  const runtimeCheck = ScheduleSpec.safeParse({
    scheduleId: v2.scheduleId,
    version: v2.version,
    tenant: v2.tenant,
    principal: v2.principal,
    owner: v2.owner,
    timezone: v2.timezone,
    calendar: v2.calendar,
    state: "enabled",
    missedRunPolicy: v2.missedRunPolicy,
    maxBackfillRuns: v2.maxBackfillRuns,
    overlapPolicy: v2.overlapPolicy,
    perScheduleConcurrency: v2.perScheduleConcurrency,
    nonexistentTimePolicy: v2.nonexistentTimePolicy,
    enabledForProduction: true,
    createdAt: v2.createdAt,
  });
  if (!runtimeCheck.success)
    throw new CanaryLifecycleError("MALFORMED_INPUT", "v2 schedule spec failed validation");

  // Persist the immutable v2 spec, then flip lifecycle to enabled@v2. If v2 already exists
  // (a partial prior run), upsertSpecVersion refuses it -> fail closed (manual review).
  try {
    await store.upsertSpecVersion(v2);
  } catch (e) {
    if (e instanceof StoreError)
      throw new CanaryLifecycleError(
        "CONFLICTING_V2",
        "toVersion already exists with a different or partial state; refusing to overwrite",
      );
    throw e;
  }
  await store.setState({
    scheduleId: input.scheduleId,
    state: "enabled",
    activeVersion: input.toVersion,
    updatedAt: input.createdAt,
    updatedBy: input.actorPrincipalId,
  });
  return {
    scheduleId: input.scheduleId,
    enabled: true,
    alreadyEnabled: false,
    activeVersion: input.toVersion,
  };
}

// ---------------------------------------------------------------------------
// disable-canary (emergency stop / rollback)
// ---------------------------------------------------------------------------

export const DisableCanaryInput = z.strictObject({
  scheduleId: Id,
  actorPrincipalId: Id, // HUMAN
  at: Timestamp,
  expectedActiveVersion: z.string().min(1).optional(), // if given, must match (drift guard)
});
export type DisableCanaryInput = z.infer<typeof DisableCanaryInput>;

export interface DisableCanaryResult {
  scheduleId: string;
  disabled: boolean;
  alreadyDisabled: boolean;
  activeVersion: string;
}

export async function disableCanary(
  store: ScheduleStore,
  gate: IdentityGate,
  rawInput: unknown,
): Promise<DisableCanaryResult> {
  const parsed = DisableCanaryInput.safeParse(rawInput);
  if (!parsed.success)
    throw new CanaryLifecycleError("MALFORMED_INPUT", "disable-canary input failed validation");
  const input = parsed.data;

  const current = await store.getSchedule(input.scheduleId);
  if (!current) throw new CanaryLifecycleError("UNKNOWN_SCHEDULE", "schedule does not exist");

  // Verify the actor is a HUMAN member of the schedule's own tenant.
  await assertHumanActor(gate, current.spec.tenant.id, input.actorPrincipalId);

  if (
    input.expectedActiveVersion !== undefined &&
    current.state.activeVersion !== input.expectedActiveVersion
  )
    throw new CanaryLifecycleError(
      "UNEXPECTED_ACTIVE_VERSION",
      `expected active version ${input.expectedActiveVersion}, found ${current.state.activeVersion}`,
    );

  // Safe to replay: already disabled -> no write. The active version is PRESERVED for history.
  if (current.state.state === "disabled")
    return {
      scheduleId: input.scheduleId,
      disabled: false,
      alreadyDisabled: true,
      activeVersion: current.state.activeVersion,
    };

  await store.setState({
    scheduleId: input.scheduleId,
    state: "disabled",
    activeVersion: current.state.activeVersion, // keep the current active version
    updatedAt: input.at,
    updatedBy: input.actorPrincipalId,
  });
  return {
    scheduleId: input.scheduleId,
    disabled: true,
    alreadyDisabled: false,
    activeVersion: current.state.activeVersion,
  };
}
