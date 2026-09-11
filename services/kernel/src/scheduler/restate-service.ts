import * as restate from "@restatedev/restate-sdk";
import type pg from "pg";
import { PgScheduleStore } from "./pg-store.js";
import { StaleFenceError } from "./store.js";
import { HttpAdmissionGateway } from "./http-admission.js";
import {
  ScheduleTimerDriver,
  type AdmissionGateway,
  type DurableTimerRuntime,
  type OutstandingWake,
  type StepJournal,
  type WakeResult,
} from "./durable-timer.js";

/**
 * Phase S1-R — the REAL Restate adapter for the S1 production scheduler.
 *
 * This is the ONLY file under `services/kernel/src/scheduler/` that imports
 * `@restatedev/restate-sdk`. Restate stays strictly behind the seams the scheduler
 * core defines (`DurableTimerRuntime`, `AdmissionGateway`, `StepJournal`): the wake
 * logic lives in `ScheduleTimerDriver` and knows nothing about Restate. Delete this
 * file and swap in a cron poller and the scheduler still works — Restate is
 * execution continuity, never a source of schedule or task truth.
 *
 * What Restate owns here, and ONLY this:
 *   1. the durable wait — `ctx.sleep(...)` — "wake at T for schedule S", surviving
 *      worker and Restate restarts;
 *   2. journaled continuation — each external step runs inside `ctx.run(...)`, so a
 *      crash mid-handler resumes without re-doing committed, journaled work.
 * Everything the wake then does (read spec/state, gate, claim lease, create the one
 * logical fire, admit, bind) is re-derived from Postgres and deduped/fenced there.
 */

export const SCHEDULE_DRIVER = "ScheduleDriver";

/** Marker carried by the TerminalError a stale-fence step raises, so the handler can
 *  recognise "fenced out, fail closed" without retrying. */
const FENCED_OUT = "S1R_FENCED_OUT_STALE_LEASE";

/** Input to one durable wake. `lastTickMs`/`nowMs` are the DETERMINISTIC window
 *  enumeration bounds (which civil slots are due); `sleepMs` is the real-world
 *  durable wait Restate performs before evaluating — the timer itself. Keeping the
 *  two separate lets the durability proof use a real short sleep while the fire
 *  window stays a fixed, reproducible civil time. */
export interface ScheduleFireRequest {
  lastTickMs: number;
  nowMs: number;
  sleepMs?: number;
}

export interface ScheduleDriverConfig {
  pool: pg.Pool;
  /** Base URL of the KernelJSON admission door (`POST {url}/v1/tasks`). */
  admissionUrl: string;
  /** Authorization header value for the admission door. A descriptor/token from the
   *  caller — never a literal secret in code. */
  authorization: string;
  /** Recipe the scheduled admission requests. */
  recipe: string;
  /** Lease owner id for this driver instance. Stable ⇒ re-invocations extend the
   *  same lease; a different owner (takeover) bumps the epoch and fences this one. */
  owner?: string;
  productionRuntime?: boolean;
  leaseTtlMs?: number;
  /** Override the admission seam. Defaults to a real `HttpAdmissionGateway` at
   *  `admissionUrl`. Tests inject a fault-decorated gateway (e.g. crash-after-admit)
   *  through this without adding fault logic to the core. */
  admissionGateway?: AdmissionGateway;
  /** When true, arm the next window as a durable delayed self-invocation (a
   *  self-perpetuating schedule). Off by default so qualification stays single-shot
   *  and every assertion maps to exactly one explicit wake. */
  armNext?: boolean;
}

/** The DurableTimerRuntime the scheduler uses when self-perpetuation is off: the
 *  durable wait is done inline by the handler's `ctx.sleep`, so there is no separate
 *  timer to arm. Holds no schedule/fire/task truth — the whole point of the seam. */
export class NoopDurableTimerRuntime implements DurableTimerRuntime {
  async scheduleWake(): Promise<void> {}
  async cancelWake(): Promise<void> {}
  async observe(): Promise<OutstandingWake[]> {
    return [];
  }
}

/** Minimal typed surface of the object, for the name-based self-send handle. The
 *  leading ctx arg mirrors the SDK's handler shape so the send client infers `fire`'s
 *  input as `ScheduleFireRequest` (the arg after ctx). */
export type ScheduleDriverApi = {
  fire: (ctx: restate.ObjectContext, req: ScheduleFireRequest) => Promise<WakeResult>;
};

/**
 * The narrow REAL `DurableTimerRuntime` backed by Restate: arming a wake is a durable
 * delayed self-invocation of the `fire` handler. Restate persists the delayed send,
 * so the wake survives restart. `cancelWake` is best-effort — a superfluous wake is
 * harmless because the handler re-reads state and `canFire` gates a paused/disabled
 * schedule to no admission. `observe` returns none: outstanding wakes live in
 * Restate, and reconciliation re-arms from the Postgres fire cursor, never from here.
 */
export class RestateDurableTimerRuntime implements DurableTimerRuntime {
  constructor(private readonly ctx: restate.ObjectContext) {}
  async scheduleWake(
    scheduleId: string,
    _wakeKey: string,
    fireAtUtcMs: number,
  ): Promise<void> {
    const delay = Math.max(0, fireAtUtcMs - (await this.ctx.date.now()));
    this.ctx
      .objectSendClient<ScheduleDriverApi>({ name: SCHEDULE_DRIVER }, scheduleId)
      .fire(
        { lastTickMs: fireAtUtcMs - 1, nowMs: fireAtUtcMs, sleepMs: 0 },
        restate.rpc.sendOpts({ delay }),
      );
  }
  async cancelWake(): Promise<void> {}
  async observe(): Promise<OutstandingWake[]> {
    return [];
  }
}

/**
 * Build the `ScheduleDriver` Virtual Object. Keyed by `scheduleId`: Restate serialises
 * exclusive handlers per key, giving single-writer-per-schedule on top of the DB lease
 * fence. `createScheduleDriverService(cfg)` closes over the pg pool + admission URL,
 * exactly like `createTaskWorkflow(ledger)`.
 */
export function createScheduleDriverService(cfg: ScheduleDriverConfig) {
  const store = new PgScheduleStore(cfg.pool);
  const admission =
    cfg.admissionGateway ??
    new HttpAdmissionGateway(cfg.admissionUrl, {
      authorization: cfg.authorization,
      recipe: cfg.recipe,
    });

  return restate.object({
    name: SCHEDULE_DRIVER,
    handlers: {
      fire: async (
        ctx: restate.ObjectContext,
        req: ScheduleFireRequest,
      ): Promise<WakeResult> => {
        const scheduleId = ctx.key;

        // (1) Durable timer: the ONE thing Restate owns. A worker or Restate restart
        // during this wait resumes it; the wake is delivered at-least-once.
        if (req.sleepMs && req.sleepMs > 0) await ctx.sleep(req.sleepMs);

        // (2) Journaled continuation: every external step is a ctx.run, so a crash
        // after (say) admission commits but before bind resumes and converges to the
        // SAME canonical task — never a second one.
        const journal: StepJournal = {
          run: async <T>(key: string, fn: () => Promise<T>): Promise<T> =>
            ctx.run(key, async () => {
              try {
                return await fn();
              } catch (e) {
                // A stale lease fence will NEVER become current for THIS continuation,
                // so make it TERMINAL: ctx.run must stop retrying and fail closed. Any
                // other error (a DB blip, an admission-door outage) stays retryable so
                // Restate re-runs the step until Postgres/KernelJSON is back.
                if (e instanceof StaleFenceError)
                  throw new restate.TerminalError(FENCED_OUT, { errorCode: 409 });
                throw e;
              }
            }),
        };

        const timers: DurableTimerRuntime = cfg.armNext
          ? new RestateDurableTimerRuntime(ctx)
          : new NoopDurableTimerRuntime();

        const driver = new ScheduleTimerDriver(
          store,
          timers,
          admission,
          {
            owner: cfg.owner ?? "restate-driver",
            productionRuntime: cfg.productionRuntime ?? false,
            leaseTtlMs: cfg.leaseTtlMs ?? 3_600_000,
          },
          journal,
        );

        // The wake re-derives everything from Postgres; Postgres/KernelJSON wins.
        try {
          return await driver.onWake(scheduleId, req.lastTickMs, req.nowMs);
        } catch (err) {
          if (err instanceof restate.TerminalError && err.message.includes(FENCED_OUT)) {
            // Another owner took the lease (epoch N+1) while this continuation held
            // epoch N. Postgres already rejected the fenced mutation (UPDATE 0) — S1-F2
            // held, canonical truth is unharmed. Fail CLOSED and STOP: return a fenced
            // result rather than rethrow, so Restate does NOT retry a doomed, stale
            // bind. The current owner reconciles the fire on its next wake.
            return {
              scheduleId,
              gated: true,
              reason: "fenced_out_stale_lease",
              admittedChildTaskIds: [],
              replays: 0,
              createdFires: 0,
              nextWakeAtMs: null,
            };
          }
          throw err;
        }
      },
    },
  });
}
