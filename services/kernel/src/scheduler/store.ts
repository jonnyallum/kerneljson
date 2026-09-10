import { randomUUID } from "node:crypto";
import {
  ScheduleFire,
  PersistedScheduleSpec,
  PersistedScheduleState,
  ScheduleBackfillRequest,
  ScheduleObservation,
  ScheduleLease,
  type FireState,
} from "./persistence.js";

/**
 * Phase S1 — durable store abstraction (repo-only; no live DB here).
 *
 * The runtime depends on this INTERFACE, not scattered SQL. The production
 * implementation (pg + the migration in supabase/migrations) enforces the core
 * invariant in the DB (unique (schedule_id, schedule_version, fire_window_key)
 * and bind-once). InMemoryScheduleStore below reproduces the SAME semantics so
 * the contract can be tested before Postgres/Docker exist. It is NOT production
 * persistence.
 */
export class FireBindingConflict extends Error {}
export class StoreError extends Error {}
/** Thrown when an ownership-sensitive mutation is attempted with a stale/invalid
 *  lease fence (another worker has taken ownership, epoch advanced). Fail-closed. */
export class StaleFenceError extends Error {}

/** Fencing token: the current lease owner + epoch. Ownership-sensitive
 *  ScheduleFire mutations require the CURRENT (owner, epoch). Enforced by the DB. */
export interface LeaseFence {
  owner: string;
  epoch: number;
}

export interface FireInput {
  idempotencyKey: string;
  scheduleId: string;
  version: string;
  fireWindowKey: string;
  fireIdentity: string;
  fireAtUtc: string;
  createdAt: string;
}

/**
 * The runtime scheduler store. STRUCTURAL FENCING (Phase S1-F2):
 * ownership-sensitive methods REQUIRE a `LeaseFence` at the type level, so ordinary
 * runtime code typed against this interface CANNOT perform a protected mutation
 * without a current lease token. The DB remains the final authority.
 *
 * Operation classification:
 *   OWNERSHIP-SENSITIVE (fence REQUIRED) — a claimed worker mutating fire state:
 *     - bindAdmission : binds the canonical child task; a stale worker must not bind.
 *     - transition    : moves fire lifecycle state; a stale worker must not e.g. FAIL it.
 *     - releaseLease  : must not release the new owner's lease (epoch required).
 *   AUTHORITY-SAFE / NON-LEASED (no fence):
 *     - createOrGetFire      : idempotent; the UNIQUE (schedule_id,version,fire_window)
 *                              constraint prevents a second truth regardless of who calls.
 *     - claimLease           : this is how ownership is ACQUIRED (you have no fence yet);
 *                              guarded by its own expiry/owner ON CONFLICT predicate.
 *     - setState             : schedule lifecycle, a human-owner/admin action, not a
 *                              per-fire worker mutation under a lease.
 *     - upsertSpecVersion    : immutable schedule definition (admin), not lease-scoped.
 *     - createBackfillRequest: governed by human approval + DB CHECKs (no self-approval).
 *     - recordObservation    : append-only telemetry, never authority.
 *   READS (never fenced): getSchedule, listFires, listObservations.
 */
export interface ScheduleStore {
  upsertSpecVersion(spec: PersistedScheduleSpec): Promise<void>;
  getSchedule(
    scheduleId: string,
  ): Promise<{ state: PersistedScheduleState; spec: PersistedScheduleSpec } | null>;
  setState(next: PersistedScheduleState): Promise<void>;

  /** Idempotent, AUTHORITY-SAFE: a repeated logical fire resolves to the existing row. */
  createOrGetFire(input: FireInput): Promise<{ fire: ScheduleFire; created: boolean }>;
  /** OWNERSHIP-SENSITIVE. Bind the admitted child task under the CURRENT lease fence.
   *  Same task = REPLAY; different task = FAIL CLOSED (bind-once). Stale fence = fail closed. */
  bindAdmission(
    idempotencyKey: string,
    b: { admissionRequestId: string; childTaskId: string; at: string },
    fence: LeaseFence,
  ): Promise<{ fire: ScheduleFire; replay: boolean }>;
  /** OWNERSHIP-SENSITIVE. Lifecycle transition under the CURRENT lease fence. */
  transition(idempotencyKey: string, to: FireState, fence: LeaseFence): Promise<ScheduleFire>;

  claimLease(
    scheduleId: string,
    owner: string,
    nowMs: number,
    ttlMs: number,
  ): Promise<ScheduleLease | null>;
  /** OWNERSHIP-SENSITIVE. Release requires owner+epoch; a stale-epoch release is a no-op. */
  releaseLease(scheduleId: string, owner: string, epoch: number): Promise<void>;

  createBackfillRequest(req: ScheduleBackfillRequest): Promise<ScheduleBackfillRequest>;
  recordObservation(obs: ScheduleObservation): Promise<void>;

  // Read-only introspection (tests / operators). Never fenced.
  listFires(scheduleId: string): Promise<ScheduleFire[]>;
  listObservations(scheduleId: string): Promise<ScheduleObservation[]>;
}

/**
 * PRIVILEGED unfenced mutations — NOT part of the runtime ScheduleStore interface.
 * Only bootstrap/migration/reconciliation and lease-independent CONTRACT TESTS may use
 * these (they need a concrete store reference, not a ScheduleStore). Ordinary runtime
 * code cannot reach them. The concrete stores implement this alongside ScheduleStore.
 */
export interface PrivilegedScheduleStore {
  bindAdmissionPrivileged(
    idempotencyKey: string,
    b: { admissionRequestId: string; childTaskId: string; at: string },
  ): Promise<{ fire: ScheduleFire; replay: boolean }>;
  transitionPrivileged(idempotencyKey: string, to: FireState): Promise<ScheduleFire>;
}

export class InMemoryScheduleStore implements ScheduleStore, PrivilegedScheduleStore {
  private specs = new Map<string, PersistedScheduleSpec>(); // key scheduleId|version
  private states = new Map<string, PersistedScheduleState>();
  private fires = new Map<string, ScheduleFire>(); // key idempotencyKey
  private leases = new Map<string, ScheduleLease>();
  private backfills: ScheduleBackfillRequest[] = [];
  private observations: ScheduleObservation[] = [];

  async upsertSpecVersion(spec: PersistedScheduleSpec): Promise<void> {
    const key = `${spec.scheduleId}|${spec.version}`;
    const existing = this.specs.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(spec))
      throw new StoreError("spec version is immutable; bump version for semantic changes");
    this.specs.set(key, PersistedScheduleSpec.parse(spec));
  }

  async getSchedule(scheduleId: string) {
    const state = this.states.get(scheduleId);
    if (!state) return null;
    const spec = this.specs.get(`${scheduleId}|${state.activeVersion}`);
    if (!spec) return null;
    return { state, spec };
  }

  async setState(next: PersistedScheduleState): Promise<void> {
    this.states.set(next.scheduleId, PersistedScheduleState.parse(next));
  }

  async createOrGetFire(input: FireInput): Promise<{ fire: ScheduleFire; created: boolean }> {
    const existing = this.fires.get(input.idempotencyKey);
    if (existing) return { fire: existing, created: false };
    // Guard against identity collision under a different window key (should never happen).
    for (const f of this.fires.values())
      if (f.fireIdentity === input.fireIdentity && f.fireWindowKey !== input.fireWindowKey)
        throw new StoreError("fire identity collision across distinct windows");
    const fire = ScheduleFire.parse({
      idempotencyKey: input.idempotencyKey,
      scheduleId: input.scheduleId,
      version: input.version,
      fireWindowKey: input.fireWindowKey,
      fireIdentity: input.fireIdentity,
      fireAtUtc: input.fireAtUtc,
      state: "PLANNED",
      admissionRequestId: null,
      admittedChildTaskId: null,
      admittedAt: null,
      createdAt: input.createdAt,
    });
    this.fires.set(fire.idempotencyKey, fire);
    return { fire, created: true };
  }

  private assertFence(scheduleId: string, fence?: LeaseFence): void {
    if (!fence) return; // fencing is opt-in per call
    const l = this.leases.get(scheduleId);
    if (!l || l.owner !== fence.owner || l.epoch !== fence.epoch)
      throw new StaleFenceError(`stale/invalid lease fence for ${scheduleId}`);
  }

  async bindAdmission(
    idempotencyKey: string,
    b: { admissionRequestId: string; childTaskId: string; at: string },
    fence: LeaseFence,
  ): Promise<{ fire: ScheduleFire; replay: boolean }> {
    return this.bindImpl(idempotencyKey, b, fence);
  }
  /** PRIVILEGED: unfenced bind for bootstrap / lease-independent contract tests. */
  async bindAdmissionPrivileged(
    idempotencyKey: string,
    b: { admissionRequestId: string; childTaskId: string; at: string },
  ): Promise<{ fire: ScheduleFire; replay: boolean }> {
    return this.bindImpl(idempotencyKey, b, undefined);
  }
  private async bindImpl(
    idempotencyKey: string,
    b: { admissionRequestId: string; childTaskId: string; at: string },
    fence?: LeaseFence,
  ): Promise<{ fire: ScheduleFire; replay: boolean }> {
    const fire = this.fires.get(idempotencyKey);
    if (!fire) throw new StoreError("no such fire");
    this.assertFence(fire.scheduleId, fence);
    if (fire.admittedChildTaskId !== null) {
      if (fire.admittedChildTaskId === b.childTaskId) return { fire, replay: true };
      // FAIL CLOSED: never overwrite a bound child task; surface an authority observation.
      await this.recordObservation({
        id: randomUUID(),
        scheduleId: fire.scheduleId,
        idempotencyKey,
        kind: "AUTHORITY",
        detail: {
          reason: "fire_bind_conflict",
          bound: fire.admittedChildTaskId,
          attempted: b.childTaskId,
        },
        createdAt: b.at,
      });
      throw new FireBindingConflict(
        `fire ${idempotencyKey} already bound to ${fire.admittedChildTaskId}, refusing ${b.childTaskId}`,
      );
    }
    const next: ScheduleFire = {
      ...fire,
      state: "ADMITTED",
      admissionRequestId: b.admissionRequestId,
      admittedChildTaskId: b.childTaskId,
      admittedAt: b.at,
    };
    this.fires.set(idempotencyKey, ScheduleFire.parse(next));
    return { fire: next, replay: false };
  }

  async transition(idempotencyKey: string, to: FireState, fence: LeaseFence): Promise<ScheduleFire> {
    return this.transitionImpl(idempotencyKey, to, fence);
  }
  /** PRIVILEGED: unfenced transition for bootstrap / lease-independent contract tests. */
  async transitionPrivileged(idempotencyKey: string, to: FireState): Promise<ScheduleFire> {
    return this.transitionImpl(idempotencyKey, to, undefined);
  }
  private async transitionImpl(idempotencyKey: string, to: FireState, fence?: LeaseFence): Promise<ScheduleFire> {
    const fire = this.fires.get(idempotencyKey);
    if (!fire) throw new StoreError("no such fire");
    this.assertFence(fire.scheduleId, fence);
    if (fire.admittedChildTaskId !== null && to !== "ADMITTED")
      throw new StoreError("cannot move an admitted fire out of ADMITTED");
    const next = ScheduleFire.parse({ ...fire, state: to });
    this.fires.set(idempotencyKey, next);
    return next;
  }

  async claimLease(
    scheduleId: string,
    owner: string,
    nowMs: number,
    ttlMs: number,
  ): Promise<ScheduleLease | null> {
    const cur = this.leases.get(scheduleId);
    const nowIso = new Date(nowMs).toISOString();
    const held = cur && Date.parse(cur.expiresAt) > nowMs && cur.owner !== owner;
    if (held) return null; // someone else holds a live lease
    const epoch = (cur?.epoch ?? -1) + 1;
    const lease = ScheduleLease.parse({
      scheduleId,
      owner,
      epoch,
      acquiredAt: nowIso,
      expiresAt: new Date(nowMs + ttlMs).toISOString(),
    });
    if (cur && Date.parse(cur.expiresAt) <= nowMs && cur.owner !== owner) {
      await this.recordObservation({
        id: randomUUID(),
        scheduleId,
        idempotencyKey: null,
        kind: "LEASE_RECOVERED",
        detail: { from: cur.owner, to: owner, epoch },
        createdAt: nowIso,
      });
    }
    this.leases.set(scheduleId, lease);
    return lease;
  }

  async releaseLease(scheduleId: string, owner: string, epoch: number): Promise<void> {
    const cur = this.leases.get(scheduleId);
    if (cur && cur.owner === owner && cur.epoch === epoch) this.leases.delete(scheduleId);
  }

  async createBackfillRequest(req: ScheduleBackfillRequest): Promise<ScheduleBackfillRequest> {
    const parsed = ScheduleBackfillRequest.parse(req); // enforces bounded + no self-approval
    this.backfills.push(parsed);
    return parsed;
  }

  async recordObservation(obs: ScheduleObservation): Promise<void> {
    this.observations.push(ScheduleObservation.parse(obs));
  }

  async listFires(scheduleId: string): Promise<ScheduleFire[]> {
    return [...this.fires.values()].filter((f) => f.scheduleId === scheduleId);
  }
  async listObservations(scheduleId: string): Promise<ScheduleObservation[]> {
    return this.observations.filter((o) => o.scheduleId === scheduleId);
  }
}
