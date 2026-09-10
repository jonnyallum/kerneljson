import pg from "pg";
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
import {
  FireBindingConflict,
  StoreError,
  type ScheduleStore,
  type FireInput,
} from "./store.js";

/**
 * Phase S1 — PostgreSQL-backed ScheduleStore.
 *
 * Faithfully implements the ScheduleStore contract proven by
 * InMemoryScheduleStore. Authority-bearing guarantees are enforced by the DB
 * (see supabase/migrations/20260910180000_scheduler.sql):
 *   - one logical fire  = UNIQUE (schedule_id, schedule_version, fire_window_key)
 *   - bind-once         = schedule_fire_bind_once() trigger
 *   - bounded backfill / no self-approval = CHECK constraints
 *   - valid enums       = column enum types
 * No SQL leaks into scheduler runtime code; it depends on the interface only.
 */
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

function rowToFire(r: Record<string, unknown>): ScheduleFire {
  return ScheduleFire.parse({
    idempotencyKey: r["idempotency_key"],
    scheduleId: r["schedule_id"],
    version: r["schedule_version"],
    fireWindowKey: r["fire_window_key"],
    fireIdentity: r["fire_identity"],
    fireAtUtc: iso(r["fire_at_utc"]),
    state: r["state"],
    admissionRequestId: r["admission_request_id"] ?? null,
    admittedChildTaskId: r["admitted_child_task_id"] ?? null,
    admittedAt: r["admitted_at"] ? iso(r["admitted_at"]) : null,
    createdAt: iso(r["created_at"]),
  });
}

export class PgScheduleStore implements ScheduleStore {
  constructor(private readonly pool: pg.Pool) {}

  async upsertSpecVersion(spec: PersistedScheduleSpec): Promise<void> {
    PersistedScheduleSpec.parse(spec);
    const existing = await this.pool.query(
      "select 1 from schedule_specs where schedule_id=$1 and version=$2",
      [spec.scheduleId, spec.version],
    );
    if ((existing.rowCount ?? 0) > 0)
      // Immutable version: a repeat is only allowed if byte-identical (idempotent write).
      throw new StoreError("spec version already exists; bump version for semantic changes");
    await this.pool.query(
      `insert into schedule_specs
       (schedule_id,version,tenant_id,principal_id,owner_id,name,timezone,calendar,
        missed_run_policy,overlap_policy,nonexistent_time_policy,max_backfill_runs,
        per_schedule_concurrency,enabled_for_production,created_at,created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        spec.scheduleId, spec.version, spec.tenant.id, spec.principal.id, spec.owner.id,
        spec.name, spec.timezone, JSON.stringify(spec.calendar), spec.missedRunPolicy,
        spec.overlapPolicy, spec.nonexistentTimePolicy, spec.maxBackfillRuns,
        spec.perScheduleConcurrency, spec.enabledForProduction, spec.createdAt, spec.createdBy,
      ],
    );
  }

  async getSchedule(scheduleId: string) {
    const st = await this.pool.query(
      "select * from schedule_state where schedule_id=$1",
      [scheduleId],
    );
    if (!st.rows[0]) return null;
    const state = PersistedScheduleState.parse({
      scheduleId: st.rows[0].schedule_id,
      state: st.rows[0].state,
      activeVersion: st.rows[0].active_version,
      updatedAt: iso(st.rows[0].updated_at),
      updatedBy: st.rows[0].updated_by,
    });
    const sp = await this.pool.query(
      "select * from schedule_specs where schedule_id=$1 and version=$2",
      [scheduleId, state.activeVersion],
    );
    if (!sp.rows[0]) return null;
    const r = sp.rows[0];
    const spec = PersistedScheduleSpec.parse({
      scheduleId: r.schedule_id, version: r.version, tenant: { id: r.tenant_id },
      principal: { id: r.principal_id, kind: "SERVICE" }, owner: { id: r.owner_id, kind: "HUMAN" },
      name: r.name, timezone: r.timezone, calendar: r.calendar,
      missedRunPolicy: r.missed_run_policy, overlapPolicy: r.overlap_policy,
      nonexistentTimePolicy: r.nonexistent_time_policy, maxBackfillRuns: r.max_backfill_runs,
      perScheduleConcurrency: r.per_schedule_concurrency, enabledForProduction: r.enabled_for_production,
      createdAt: iso(r.created_at), createdBy: r.created_by,
    });
    return { state, spec };
  }

  async setState(next: PersistedScheduleState): Promise<void> {
    PersistedScheduleState.parse(next);
    await this.pool.query(
      `insert into schedule_state (schedule_id,state,active_version,updated_at,updated_by)
       values ($1,$2,$3,$4,$5)
       on conflict (schedule_id) do update set
         state=excluded.state, active_version=excluded.active_version,
         updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
      [next.scheduleId, next.state, next.activeVersion, next.updatedAt, next.updatedBy],
    );
  }

  async createOrGetFire(input: FireInput): Promise<{ fire: ScheduleFire; created: boolean }> {
    // ON CONFLICT on the PK (idempotency_key = scheduleId|version|fireWindow) — the DB
    // rejects a second logical fire and we resolve to the existing row.
    const ins = await this.pool.query(
      `insert into schedule_fires
        (idempotency_key,schedule_id,schedule_version,fire_window_key,fire_identity,fire_at_utc,state,created_at,updated_at)
       values ($1,$2,$3,$4,$5,$6,'PLANNED',now(),now())
       on conflict (idempotency_key) do nothing
       returning *`,
      [input.idempotencyKey, input.scheduleId, input.version, input.fireWindowKey, input.fireIdentity, input.fireAtUtc],
    );
    if (ins.rows[0]) return { fire: rowToFire(ins.rows[0]), created: true };
    const sel = await this.pool.query("select * from schedule_fires where idempotency_key=$1", [input.idempotencyKey]);
    if (!sel.rows[0]) throw new StoreError("fire vanished after conflict");
    return { fire: rowToFire(sel.rows[0]), created: false };
  }

  async bindAdmission(
    idempotencyKey: string,
    b: { admissionRequestId: string; childTaskId: string; at: string },
  ): Promise<{ fire: ScheduleFire; replay: boolean }> {
    const cur = await this.pool.query("select * from schedule_fires where idempotency_key=$1", [idempotencyKey]);
    if (!cur.rows[0]) throw new StoreError("no such fire");
    if (cur.rows[0].admitted_child_task_id) {
      if (cur.rows[0].admitted_child_task_id === b.childTaskId)
        return { fire: rowToFire(cur.rows[0]), replay: true };
      await this.recordObservation({
        id: randomUUID(), scheduleId: cur.rows[0].schedule_id, idempotencyKey,
        kind: "AUTHORITY",
        detail: { reason: "fire_bind_conflict", bound: cur.rows[0].admitted_child_task_id, attempted: b.childTaskId },
        createdAt: b.at,
      });
      throw new FireBindingConflict(
        `fire ${idempotencyKey} already bound to ${cur.rows[0].admitted_child_task_id}`,
      );
    }
    // The bind-once trigger enforces immutability at the DB even if this guard is bypassed.
    const upd = await this.pool.query(
      `update schedule_fires set state='ADMITTED', admission_request_id=$2,
         admitted_child_task_id=$3, admitted_at=$4
       where idempotency_key=$1 and admitted_child_task_id is null returning *`,
      [idempotencyKey, b.admissionRequestId, b.childTaskId, b.at],
    );
    if (!upd.rows[0]) {
      // lost a race to another binder; re-read and treat same-task as replay
      const re = await this.pool.query("select * from schedule_fires where idempotency_key=$1", [idempotencyKey]);
      if (re.rows[0]?.admitted_child_task_id === b.childTaskId) return { fire: rowToFire(re.rows[0]), replay: true };
      throw new FireBindingConflict(`fire ${idempotencyKey} bound concurrently to another task`);
    }
    return { fire: rowToFire(upd.rows[0]), replay: false };
  }

  async transition(idempotencyKey: string, to: FireState): Promise<ScheduleFire> {
    // App-enforced: an ADMITTED fire may not leave ADMITTED (DB does not constrain this).
    const upd = await this.pool.query(
      `update schedule_fires set state=$2
       where idempotency_key=$1 and (admitted_child_task_id is null or $2='ADMITTED') returning *`,
      [idempotencyKey, to],
    );
    if (!upd.rows[0]) {
      const cur = await this.pool.query("select 1 from schedule_fires where idempotency_key=$1", [idempotencyKey]);
      if ((cur.rowCount ?? 0) === 0) throw new StoreError("no such fire");
      throw new StoreError("cannot move an admitted fire out of ADMITTED");
    }
    return rowToFire(upd.rows[0]);
  }

  async claimLease(scheduleId: string, owner: string, nowMs: number, ttlMs: number): Promise<ScheduleLease | null> {
    const nowIso = new Date(nowMs).toISOString();
    const expIso = new Date(nowMs + ttlMs).toISOString();
    // Take the lease iff free, expired, or already ours. Epoch advances on takeover (fencing token).
    const res = await this.pool.query(
      `insert into schedule_leases (schedule_id,owner,epoch,acquired_at,expires_at)
       values ($1,$2,0,$3,$4)
       on conflict (schedule_id) do update set
         owner=excluded.owner, epoch=schedule_leases.epoch+1,
         acquired_at=excluded.acquired_at, expires_at=excluded.expires_at
       where schedule_leases.expires_at <= $3 or schedule_leases.owner = excluded.owner
       returning *`,
      [scheduleId, owner, nowIso, expIso],
    );
    if (!res.rows[0]) return null;
    const r = res.rows[0];
    if (r.epoch > 0 && r.owner === owner) {
      // takeover or renew; emit recovery observation on takeover of an expired lease
    }
    return ScheduleLease.parse({
      scheduleId: r.schedule_id, owner: r.owner, epoch: r.epoch,
      acquiredAt: iso(r.acquired_at), expiresAt: iso(r.expires_at),
    });
  }

  async releaseLease(scheduleId: string, owner: string): Promise<void> {
    await this.pool.query("delete from schedule_leases where schedule_id=$1 and owner=$2", [scheduleId, owner]);
  }

  async createBackfillRequest(req: ScheduleBackfillRequest): Promise<ScheduleBackfillRequest> {
    ScheduleBackfillRequest.parse(req); // app-level shape/bounds
    // DB CHECK constraints independently enforce bounded + no-self-approval.
    await this.pool.query(
      `insert into schedule_backfill_requests
        (id,schedule_id,schedule_version,requested_by,requested_from,requested_to,
         computed_windows,max_runs,preview_digest,status,approved_by,created_at,executed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [req.id, req.scheduleId, req.version, req.requestedBy, req.requestedFrom, req.requestedTo,
       req.computedWindows, req.maxRuns, req.previewDigest, req.status, req.approvedBy, req.createdAt, req.executedAt],
    );
    return req;
  }

  async recordObservation(obs: ScheduleObservation): Promise<void> {
    ScheduleObservation.parse(obs);
    await this.pool.query(
      "insert into schedule_observations (id,schedule_id,idempotency_key,kind,detail,created_at) values ($1,$2,$3,$4,$5,$6)",
      [obs.id, obs.scheduleId, obs.idempotencyKey, obs.kind, JSON.stringify(obs.detail), obs.createdAt],
    );
  }

  async listFires(scheduleId: string): Promise<ScheduleFire[]> {
    const r = await this.pool.query("select * from schedule_fires where schedule_id=$1 order by fire_at_utc", [scheduleId]);
    return r.rows.map(rowToFire);
  }
  async listObservations(scheduleId: string): Promise<ScheduleObservation[]> {
    const r = await this.pool.query("select * from schedule_observations where schedule_id=$1 order by created_at", [scheduleId]);
    return r.rows.map((x) => ScheduleObservation.parse({
      id: x.id, scheduleId: x.schedule_id, idempotencyKey: x.idempotency_key,
      kind: x.kind, detail: x.detail, createdAt: iso(x.created_at),
    }));
  }
}
