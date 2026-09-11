import { randomUUID } from "node:crypto";
import { ScheduleSpec } from "./spec.js";
import {
  dueFireWindows,
  fireIdentity,
  idempotencyKey,
  type FireWindow,
} from "./fire.js";
import { canFire } from "./policy.js";
import type {
  PersistedScheduleSpec,
  PersistedScheduleState,
} from "./persistence.js";
import type { ScheduleStore, LeaseFence } from "./store.js";

/**
 * Phase S1-R — Restate boundary abstraction (DESIGN + INTERFACE, no Restate runtime).
 *
 * See docs/production/phase-s1-r/S1R_RESTATE_BOUNDARY_DESIGN_2026-09-10.md.
 *
 * The scheduler needs a DURABLE "wake me at UTC time T for schedule S" primitive
 * that survives process restarts, plus journaled continuation of the wake handler.
 * Restate provides that. But Restate must remain EXECUTION CONTINUITY, never a
 * second source of schedule/task truth:
 *
 *   - KernelJSON/Postgres owns ScheduleSpec, ScheduleState, ScheduleFire existence,
 *     fire idempotency identity, admission intent, lease/fence, task lifecycle.
 *   - Restate owns ONLY durable waiting, at-least-once wake delivery, and workflow
 *     continuation cursor. The timer is semantically empty: it carries "wake at T
 *     for S", never "what S means" — every wake re-derives meaning from Postgres.
 *
 * This module depends on the `DurableTimerRuntime` INTERFACE, not on
 * `@restatedev/restate-sdk`, so Restate is replaceable (a cron poller calling the
 * same handler is a valid, if less durable, substitute). The Restate-backed
 * implementation (`RestateDurableTimerRuntime`) is SPECIFIED / UNEXECUTED and lives
 * behind this interface; `InMemoryDurableTimerRuntime` below drives the pure tests.
 */

/** An outstanding durable wake for a schedule. Reconciliation reads these. */
export interface OutstandingWake {
  wakeKey: string;
  fireAtUtcMs: number;
}

/**
 * Narrow, replaceable durable-timer abstraction. The ONLY surface the scheduler
 * uses from the durable-execution runtime. Restate implements this; so can a cron.
 * Restate MUST NOT own schedule/fire/task truth — this interface exposes none.
 */
export interface DurableTimerRuntime {
  /** Durably schedule a wake for `scheduleId` at `fireAtUtcMs`. Idempotent per
   *  (scheduleId, wakeKey): scheduling the same next window twice = one timer. */
  scheduleWake(scheduleId: string, wakeKey: string, fireAtUtcMs: number): Promise<void>;
  /** Cancel an outstanding wake (schedule disabled/paused/cancelled/version-retired). */
  cancelWake(scheduleId: string, wakeKey: string): Promise<void>;
  /** Outstanding wakes for a schedule — used to reconcile on driver restart. */
  observe(scheduleId: string): Promise<OutstandingWake[]>;
}

export interface AdmissionRequestInput {
  /** = fireIdentity. KernelJSON Admission dedupes on this; a repeat returns the
   *  SAME canonical child task id. The scheduler/Restate never mint a task id. */
  admissionIdentity: string;
  scheduleId: string;
  version: string;
  fireWindowKey: string;
  fireAtUtc: string;
  at: string;
}

export interface AdmissionResult {
  childTaskId: string;
  deduped: boolean;
}

/**
 * The seam to KernelJSON Admission — the SOLE minter of canonical child tasks.
 * The driver obtains a `childTaskId` only from here; it has no minting capability
 * of its own. This is the structural guarantee that Restate cannot mint.
 *
 * REQUIREMENT: `admit` MUST be idempotent on `admissionIdentity` (= fireIdentity).
 */
export interface AdmissionGateway {
  admit(req: AdmissionRequestInput): Promise<AdmissionResult>;
}

/**
 * The journaling seam. In production the durable wake handler runs inside a Restate
 * invocation and every external I/O step (read truth, claim lease, create fire,
 * admit, bind) must be a journaled `ctx.run` action so a crash resumes mid-handler
 * without re-doing already-committed, already-journaled work. But the scheduler core
 * MUST NOT import `@restatedev/restate-sdk` (Restate stays replaceable), so it depends
 * on this one-method seam instead. `directJournal` runs each step inline — used by the
 * in-memory reference driver and every non-Restate test, so existing behaviour is
 * unchanged. The Restate service passes `{ run: (k, fn) => ctx.run(k, fn) }`.
 *
 * Only fields the driver actually consumes downstream (child task ids as strings,
 * `created`/`replay` booleans) cross this seam, so JSON journaling is lossless here.
 */
export interface StepJournal {
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

/** Inline journal: run each step immediately, no durability. The default, so the
 *  in-memory driver and all pure/PG tests behave exactly as before this seam existed. */
export const directJournal: StepJournal = {
  run: (_key, fn) => fn(),
};

/** Combine the persisted (spec, state) into the runtime ScheduleSpec that the pure
 *  deterministic core (fire.ts/policy.ts) operates on. State (enabled/paused/
 *  disabled) lives in ScheduleState; the spec is the ACTIVE version's definition. */
export function runtimeSpecFrom(
  spec: PersistedScheduleSpec,
  state: PersistedScheduleState,
): ScheduleSpec {
  return ScheduleSpec.parse({
    scheduleId: spec.scheduleId,
    version: spec.version,
    tenant: spec.tenant,
    principal: spec.principal,
    owner: spec.owner,
    timezone: spec.timezone,
    calendar: spec.calendar,
    state: state.state,
    missedRunPolicy: spec.missedRunPolicy,
    maxBackfillRuns: spec.maxBackfillRuns,
    overlapPolicy: spec.overlapPolicy,
    perScheduleConcurrency: spec.perScheduleConcurrency,
    nonexistentTimePolicy: spec.nonexistentTimePolicy,
    enabledForProduction: spec.enabledForProduction,
    createdAt: spec.createdAt,
  });
}

const nowIso = (ms: number): string => new Date(ms).toISOString();

/** The single next fire window strictly at/after `fromMs`, or null. */
export function nextWindowAfter(spec: ScheduleSpec, fromMs: number): FireWindow | null {
  const horizonMs =
    spec.calendar.kind === "everyNMinutes"
      ? spec.calendar.n * 60_000 * 2 + 60_000
      : 9 * 86_400_000; // covers weekly + slack
  const ws = dueFireWindows(spec, fromMs, fromMs + horizonMs);
  return ws.length ? ws[0]! : null;
}

export interface WindowResult {
  childTaskId: string;
  created: boolean;
  replay: boolean;
}

export interface WakeResult {
  scheduleId: string;
  gated: boolean;
  reason: string;
  admittedChildTaskIds: string[];
  replays: number;
  createdFires: number;
  nextWakeAtMs: number | null;
}

/**
 * The durable wake handler, expressed against interfaces only. In production each
 * step below is a journaled Restate `ctx.run` action so a crash resumes mid-handler
 * without duplicating canonical work. Here it is plain async so the boundary can be
 * proven deterministically without a Restate runtime.
 *
 * Postgres-first, idempotent, fenced:
 *   getSchedule (truth) -> canFire (gate) -> claimLease (fence) -> for each due
 *   window: createOrGetFire (DB unique) -> admit (KJ mints/dedupes) ->
 *   bindAdmission (DB-fenced) -> scheduleWake (next).
 */
export class ScheduleTimerDriver {
  constructor(
    private readonly store: ScheduleStore,
    private readonly timers: DurableTimerRuntime,
    private readonly admission: AdmissionGateway,
    private readonly opts: {
      owner: string;
      productionRuntime: boolean;
      leaseTtlMs: number;
    },
    /** Journals each external I/O step. Defaults to inline execution; the Restate
     *  service injects a `ctx.run`-backed journal so replays skip committed steps. */
    private readonly journal: StepJournal = directJournal,
  ) {}

  async onWake(scheduleId: string, lastTickMs: number, nowMs: number): Promise<WakeResult> {
    const gatedResult = (reason: string): WakeResult => ({
      scheduleId,
      gated: true,
      reason,
      admittedChildTaskIds: [],
      replays: 0,
      createdFires: 0,
      nextWakeAtMs: null,
    });

    // Read truth (journaled): the wake re-derives everything from Postgres.
    const sched = await this.journal.run("getSchedule", () =>
      this.store.getSchedule(scheduleId),
    );
    if (!sched) return gatedResult("no_such_schedule");

    const spec = runtimeSpecFrom(sched.spec, sched.state);

    const gate = canFire(spec, { productionRuntime: this.opts.productionRuntime });
    if (!gate.ok) {
      // Disabled/paused/cancelled/not-enabled: no new work. Cancel outstanding
      // timers so an old wake cannot create work under a stopped schedule.
      for (const w of await this.timers.observe(scheduleId))
        await this.timers.cancelWake(scheduleId, w.wakeKey);
      return gatedResult(gate.reason);
    }

    const lease = await this.journal.run("claimLease", () =>
      this.store.claimLease(
        scheduleId,
        this.opts.owner,
        nowMs,
        this.opts.leaseTtlMs,
      ),
    );
    if (!lease) return gatedResult("lease_held_by_other");
    const fence: LeaseFence = { owner: lease.owner, epoch: lease.epoch };

    const windows = dueFireWindows(spec, lastTickMs, nowMs);
    const admitted: string[] = [];
    let replays = 0;
    let created = 0;
    for (const w of windows) {
      const res = await this.processWindowUnderFence(spec, w, fence, nowIso(nowMs));
      if (res.created) created++;
      if (res.replay) replays++;
      else admitted.push(res.childTaskId);
    }

    const next = nextWindowAfter(spec, nowMs);
    let nextWakeAtMs: number | null = null;
    if (next) {
      await this.timers.scheduleWake(
        scheduleId,
        idempotencyKey(spec, next.fireWindowKey),
        next.fireAtUtcMs,
      );
      nextWakeAtMs = next.fireAtUtcMs;
    }

    return {
      scheduleId,
      gated: false,
      reason: gate.reason,
      admittedChildTaskIds: admitted,
      replays,
      createdFires: created,
      nextWakeAtMs,
    };
  }

  /**
   * The fenced continuation unit — the ONLY place fire ownership state is mutated.
   * Requires a current LeaseFence; a stale/wrong fence fails closed at the DB
   * (StaleFenceError). Safe to run twice (double wake / replay / late continuation):
   * createOrGetFire is idempotent, admit dedupes on fireIdentity, bind is bind-once.
   */
  async processWindowUnderFence(
    spec: ScheduleSpec,
    w: FireWindow,
    fence: LeaseFence,
    atIso: string,
  ): Promise<WindowResult> {
    const idem = idempotencyKey(spec, w.fireWindowKey);
    const identity = fireIdentity(spec, w.fireWindowKey);

    const { fire, created } = await this.journal.run(`fire:${idem}`, () =>
      this.store.createOrGetFire({
        idempotencyKey: idem,
        scheduleId: spec.scheduleId,
        version: spec.version,
        fireWindowKey: w.fireWindowKey,
        fireIdentity: identity,
        fireAtUtc: w.fireAtUtcIso,
        createdAt: atIso,
      }),
    );

    if (fire.admittedChildTaskId !== null)
      return { childTaskId: fire.admittedChildTaskId, created, replay: true };

    // KernelJSON Admission mints (or dedupes) the canonical child task. The
    // scheduler NEVER mints. admit is idempotent on fireIdentity, so calling it
    // from a stale continuation — or re-calling it on a Restate replay after a
    // crash that committed the admission but not the journal — returns the SAME
    // canonical id; the fenced bind below is what fails closed for a stale owner.
    const adm = await this.journal.run(`admit:${identity}`, () =>
      this.admission.admit({
        admissionIdentity: identity,
        scheduleId: spec.scheduleId,
        version: spec.version,
        fireWindowKey: w.fireWindowKey,
        fireAtUtc: w.fireAtUtcIso,
        at: atIso,
      }),
    );

    const bound = await this.journal.run(`bind:${idem}`, () =>
      this.store.bindAdmission(
        idem,
        { admissionRequestId: identity, childTaskId: adm.childTaskId, at: atIso },
        fence,
      ),
    );
    return {
      childTaskId: bound.fire.admittedChildTaskId ?? adm.childTaskId,
      created,
      replay: bound.replay,
    };
  }
}

/**
 * In-memory reference DurableTimerRuntime for the pure boundary tests. Models the
 * durable timer store (outstanding wakes) with idempotent scheduling. It holds NO
 * schedule/fire/task truth — only "wake at T" entries — which is the whole point.
 */
export class InMemoryDurableTimerRuntime implements DurableTimerRuntime {
  private readonly wakes = new Map<string, Map<string, number>>();

  async scheduleWake(scheduleId: string, wakeKey: string, fireAtUtcMs: number): Promise<void> {
    let m = this.wakes.get(scheduleId);
    if (!m) {
      m = new Map();
      this.wakes.set(scheduleId, m);
    }
    m.set(wakeKey, fireAtUtcMs); // idempotent per (scheduleId, wakeKey)
  }

  async cancelWake(scheduleId: string, wakeKey: string): Promise<void> {
    this.wakes.get(scheduleId)?.delete(wakeKey);
  }

  async observe(scheduleId: string): Promise<OutstandingWake[]> {
    const m = this.wakes.get(scheduleId);
    if (!m) return [];
    return [...m.entries()].map(([wakeKey, fireAtUtcMs]) => ({ wakeKey, fireAtUtcMs }));
  }
}

/**
 * In-memory reference AdmissionGateway modelling KernelJSON Admission's durable
 * dedupe: idempotent on admissionIdentity (= fireIdentity), returning the SAME
 * child task id on repeat. Records counts so tests can prove exactly-once.
 */
export class InMemoryAdmissionGateway implements AdmissionGateway {
  private readonly minted = new Map<string, string>(); // admissionIdentity -> childTaskId
  private admitCallCount = 0;

  async admit(req: AdmissionRequestInput): Promise<AdmissionResult> {
    this.admitCallCount++;
    const existing = this.minted.get(req.admissionIdentity);
    if (existing) return { childTaskId: existing, deduped: true };
    const childTaskId = randomUUID();
    this.minted.set(req.admissionIdentity, childTaskId);
    return { childTaskId, deduped: false };
  }

  /** Distinct canonical child tasks minted (= distinct fire identities admitted). */
  mintedCount(): number {
    return this.minted.size;
  }

  /** Total admit calls (>= mintedCount when duplicates/replays occur). */
  admitCalls(): number {
    return this.admitCallCount;
  }

  childTaskIdFor(admissionIdentity: string): string | undefined {
    return this.minted.get(admissionIdentity);
  }
}
