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

export interface ScheduleStore {
  upsertSpecVersion(spec: PersistedScheduleSpec): Promise<void>;
  getSchedule(
    scheduleId: string,
  ): Promise<{ state: PersistedScheduleState; spec: PersistedScheduleSpec } | null>;
  setState(next: PersistedScheduleState): Promise<void>;

  /** Idempotent: a repeated logical fire resolves to the existing row. */
  createOrGetFire(input: FireInput): Promise<{ fire: ScheduleFire; created: boolean }>;
  /** Bind the admitted child task. Same task = REPLAY; different task = FAIL CLOSED.
   *  Ownership-sensitive: pass `fence` to require the current lease owner+epoch. */
  bindAdmission(
    idempotencyKey: string,
    b: { admissionRequestId: string; childTaskId: string; at: string },
    fence?: LeaseFence,
  ): Promise<{ fire: ScheduleFire; replay: boolean }>;
  /** Ownership-sensitive lifecycle transition. Pass `fence` to require current owner+epoch. */
  transition(idempotencyKey: string, to: FireState, fence?: LeaseFence): Promise<ScheduleFire>;

  claimLease(
    scheduleId: string,
    owner: string,
    nowMs: number,
    ttlMs: number,
  ): Promise<ScheduleLease | null>;
  /** Release the lease. Pass `epoch` to fence: a stale-epoch release is a no-op. */
  releaseLease(scheduleId: string, owner: string, epoch?: number): Promise<void>;

  createBackfillRequest(req: ScheduleBackfillRequest): Promise<ScheduleBackfillRequest>;
  recordObservation(obs: ScheduleObservation): Promise<void>;

  // Read-only introspection (tests / operators).
  listFires(scheduleId: string): Promise<ScheduleFire[]>;
  listObservations(scheduleId: string): Promise<ScheduleObservation[]>;
}

export class InMemoryScheduleStore implements ScheduleStore {
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

  async transition(idempotencyKey: string, to: FireState, fence?: LeaseFence): Promise<ScheduleFire> {
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

  async releaseLease(scheduleId: string, owner: string, epoch?: number): Promise<void> {
    const cur = this.leases.get(scheduleId);
    if (cur && cur.owner === owner && (epoch === undefined || cur.epoch === epoch))
      this.leases.delete(scheduleId);
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
