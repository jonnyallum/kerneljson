import { z } from "zod";
import pg from "pg";
import { Id, Timestamp } from "../../../../packages/contracts/src/index.js";
import {
  ScheduleSpec,
  CalendarSpec,
  MissedRunPolicy,
  OverlapPolicy,
  NonexistentTimePolicy,
  MAX_BACKFILL_RUNS,
} from "./spec.js";
import { PersistedScheduleSpec, PersistedScheduleState } from "./persistence.js";
import type { ScheduleStore } from "./store.js";

/**
 * S1 canary — disabled-schedule seed (Gate 1.5).
 *
 * A DELIBERATELY NARROW, fail-closed mechanism to install the FIRST disabled
 * scheduler specification through the existing ScheduleStore domain interface
 * (upsertSpecVersion + setState), not a parallel raw-SQL admin path. It is
 * production-capable but is NOT executed here.
 *
 * Scheduler persistence is recipe-agnostic by design: a schedule defines
 * when / identity / policy / lifecycle only. The recipe (`claude_md_check/v1`)
 * and the approved CLAUDE.md digest are NOT stored here — they bind later via
 * the scheduler worker/runtime configuration (see canary-config.ts). This seed
 * therefore never references a recipe or a digest.
 *
 * Invariants enforced (fail closed):
 *   - lifecycle state = "disabled", enabledForProduction = false (FORCED, not inputs);
 *   - owner principal is HUMAN (declared AND verified against the authority DB);
 *   - tenant, principal, owner all already exist; (tenant, principal) membership exists;
 *   - a repeat with the exact same intended state is a clean no-op (idempotent);
 *   - a repeat with conflicting existing state FAILS (never overwrites/drifts);
 *   - it touches only spec + state rows — no fire, no admission, no execution, no Restate.
 */

export type CanarySeedCode =
  | "MALFORMED_INPUT"
  | "UNKNOWN_TENANT"
  | "UNKNOWN_PRINCIPAL"
  | "UNKNOWN_OWNER"
  | "OWNER_NOT_HUMAN"
  | "MISSING_TENANT_MEMBERSHIP"
  | "CONFLICTING_EXISTING_STATE";

export class CanarySeedError extends Error {
  constructor(
    readonly code: CanarySeedCode,
    message: string,
  ) {
    super(message);
    this.name = "CanarySeedError";
  }
}

/** Identity facts read from the authority DB (or a test stub). */
export interface IdentitySnapshot {
  tenantExists: boolean;
  principalExists: boolean;
  ownerExists: boolean;
  ownerKind: "HUMAN" | "SERVICE" | null;
  membershipExists: boolean; // (tenantId, principalId)
}

export interface IdentityGate {
  snapshot(ids: {
    tenantId: string;
    principalId: string;
    ownerId: string;
  }): Promise<IdentitySnapshot>;
}

/**
 * Explicit, narrow inputs. Note the ABSENCE of `state` and `enabledForProduction`:
 * the strict object rejects them, and the seed forces disabled / not-production.
 * `createdAt` is an explicit input so an idempotent re-run reproduces byte state.
 */
export const CanarySeedInput = z.strictObject({
  scheduleId: Id,
  version: z.string().min(1),
  tenantId: Id,
  principalId: Id,
  ownerId: Id,
  createdBy: Id,
  name: z.string().min(1).max(200),
  timezone: z.string().min(1),
  calendar: CalendarSpec,
  missedRunPolicy: MissedRunPolicy,
  overlapPolicy: OverlapPolicy,
  nonexistentTimePolicy: NonexistentTimePolicy,
  maxBackfillRuns: z.number().int().min(0).max(MAX_BACKFILL_RUNS),
  perScheduleConcurrency: z.number().int().min(1).max(50),
  createdAt: Timestamp,
});
export type CanarySeedInput = z.infer<typeof CanarySeedInput>;

export interface CanarySeedResult {
  scheduleId: string;
  installed: boolean;
  alreadyInstalled: boolean;
}

/** Deterministic key-sorted serialization for semantic equality (jsonb reorders keys). */
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
}

/** Compare the semantic (persisted) fields, ignoring synthetic kind flags and nothing else. */
function sameSpec(a: PersistedScheduleSpec, b: PersistedScheduleSpec): boolean {
  const project = (s: PersistedScheduleSpec) => ({
    scheduleId: s.scheduleId,
    version: s.version,
    tenantId: s.tenant.id,
    principalId: s.principal.id,
    ownerId: s.owner.id,
    name: s.name,
    timezone: s.timezone,
    calendar: s.calendar,
    missedRunPolicy: s.missedRunPolicy,
    overlapPolicy: s.overlapPolicy,
    nonexistentTimePolicy: s.nonexistentTimePolicy,
    maxBackfillRuns: s.maxBackfillRuns,
    perScheduleConcurrency: s.perScheduleConcurrency,
    enabledForProduction: s.enabledForProduction,
    createdAt: s.createdAt,
    createdBy: s.createdBy,
  });
  return stable(project(a)) === stable(project(b));
}

export async function installDisabledCanary(
  store: ScheduleStore,
  gate: IdentityGate,
  rawInput: unknown,
): Promise<CanarySeedResult> {
  const parsed = CanarySeedInput.safeParse(rawInput);
  if (!parsed.success)
    throw new CanarySeedError("MALFORMED_INPUT", "canary seed input failed validation");
  const input = parsed.data;

  // Validate the full ScheduleSpec with lifecycle FORCED safe. ScheduleSpec enforces
  // owner HUMAN (declared), a valid IANA timezone and a valid calendar.
  const declared = ScheduleSpec.safeParse({
    scheduleId: input.scheduleId,
    version: input.version,
    tenant: { id: input.tenantId },
    principal: { id: input.principalId, kind: "SERVICE" }, // declared; DB truth verified below
    owner: { id: input.ownerId, kind: "HUMAN" }, // REQUIRED HUMAN (enforced here + by the gate)
    timezone: input.timezone,
    calendar: input.calendar,
    state: "disabled", // FORCED
    missedRunPolicy: input.missedRunPolicy,
    maxBackfillRuns: input.maxBackfillRuns,
    overlapPolicy: input.overlapPolicy,
    perScheduleConcurrency: input.perScheduleConcurrency,
    nonexistentTimePolicy: input.nonexistentTimePolicy,
    enabledForProduction: false, // FORCED
    createdAt: input.createdAt,
  });
  if (!declared.success)
    throw new CanarySeedError("MALFORMED_INPUT", "canary schedule spec failed validation");

  // Verify identity TRUTH against the authority DB — declared kind is not trusted.
  const snap = await gate.snapshot({
    tenantId: input.tenantId,
    principalId: input.principalId,
    ownerId: input.ownerId,
  });
  if (!snap.tenantExists)
    throw new CanarySeedError("UNKNOWN_TENANT", "tenant does not exist");
  if (!snap.principalExists)
    throw new CanarySeedError("UNKNOWN_PRINCIPAL", "principal does not exist");
  if (!snap.ownerExists)
    throw new CanarySeedError("UNKNOWN_OWNER", "owner principal does not exist");
  if (snap.ownerKind !== "HUMAN")
    throw new CanarySeedError("OWNER_NOT_HUMAN", "owner principal is not HUMAN");
  if (!snap.membershipExists)
    throw new CanarySeedError(
      "MISSING_TENANT_MEMBERSHIP",
      "principal has no membership in the tenant",
    );

  const spec = PersistedScheduleSpec.parse({
    scheduleId: input.scheduleId,
    version: input.version,
    tenant: { id: input.tenantId },
    principal: { id: input.principalId, kind: "SERVICE" },
    owner: { id: input.ownerId, kind: "HUMAN" },
    name: input.name,
    timezone: input.timezone,
    calendar: input.calendar,
    missedRunPolicy: input.missedRunPolicy,
    overlapPolicy: input.overlapPolicy,
    nonexistentTimePolicy: input.nonexistentTimePolicy,
    maxBackfillRuns: input.maxBackfillRuns,
    perScheduleConcurrency: input.perScheduleConcurrency,
    enabledForProduction: false,
    createdAt: input.createdAt,
    createdBy: input.createdBy,
  });
  const state = PersistedScheduleState.parse({
    scheduleId: input.scheduleId,
    state: "disabled",
    activeVersion: input.version,
    updatedAt: input.createdAt,
    updatedBy: input.createdBy,
  });

  // Idempotency / conflict against any existing schedule for this id.
  const existing = await store.getSchedule(input.scheduleId);
  if (existing) {
    const stateMatches =
      existing.state.state === "disabled" &&
      existing.state.activeVersion === input.version;
    if (stateMatches && sameSpec(existing.spec, spec))
      return { scheduleId: input.scheduleId, installed: false, alreadyInstalled: true };
    throw new CanarySeedError(
      "CONFLICTING_EXISTING_STATE",
      "a different schedule/spec already exists for this id; refusing to overwrite",
    );
  }

  // Install: immutable spec, then disabled lifecycle. No fire/admission/lease/execution.
  await store.upsertSpecVersion(spec);
  await store.setState(state);
  return { scheduleId: input.scheduleId, installed: true, alreadyInstalled: false };
}

/** Authority-DB identity gate (READ-ONLY SELECTs only). Production implementation. */
export class PgIdentityGate implements IdentityGate {
  constructor(private readonly pool: pg.Pool) {}
  async snapshot(ids: {
    tenantId: string;
    principalId: string;
    ownerId: string;
  }): Promise<IdentitySnapshot> {
    const t = await this.pool.query("select 1 from public.tenants where id=$1", [ids.tenantId]);
    const p = await this.pool.query("select 1 from public.principals where id=$1", [
      ids.principalId,
    ]);
    const o = await this.pool.query("select kind from public.principals where id=$1", [
      ids.ownerId,
    ]);
    const m = await this.pool.query(
      "select 1 from public.tenant_memberships where tenant_id=$1 and principal_id=$2",
      [ids.tenantId, ids.principalId],
    );
    const ownerKind = (o.rows[0]?.["kind"] as "HUMAN" | "SERVICE" | undefined) ?? null;
    return {
      tenantExists: (t.rowCount ?? 0) > 0,
      principalExists: (p.rowCount ?? 0) > 0,
      ownerExists: (o.rowCount ?? 0) > 0,
      ownerKind,
      membershipExists: (m.rowCount ?? 0) > 0,
    };
  }
}
