import type { ScheduleSpec, SchedulerConfig } from "./spec.js";
import { MAX_BACKFILL_RUNS } from "./spec.js";
import type { FireWindow } from "./fire.js";

/**
 * Phase S1 — fail-closed policy resolution.
 *
 * These decide only WHETHER / HOW MANY admission requests to emit for already
 * computed fire windows. They never mint. Unknown policy values throw
 * (fail closed) even though the ScheduleSpec enums normally prevent them.
 */
export class UnknownPolicyError extends Error {}

/** May this schedule fire at all, in this runtime? */
export function canFire(
  spec: ScheduleSpec,
  opts: { productionRuntime: boolean },
): { ok: boolean; reason: string } {
  if (spec.state === "disabled") return { ok: false, reason: "state_disabled" };
  if (spec.state === "paused") return { ok: false, reason: "state_paused" };
  if (spec.state !== "enabled")
    return { ok: false, reason: `unknown_state_fail_closed:${String(spec.state)}` };
  // Production schedules are opt-in and cannot self-enable: the scheduler never
  // sets enabledForProduction; only an authorised human-owned spec update does.
  if (opts.productionRuntime && spec.enabledForProduction !== true)
    return { ok: false, reason: "production_not_enabled" };
  return { ok: true, reason: "enabled" };
}

/** Which missed windows to actually admit, per missed-run policy. */
export function resolveMissedRuns(
  spec: ScheduleSpec,
  missed: FireWindow[],
): { admit: FireWindow[]; note: string } {
  const ordered = [...missed].sort((a, b) => a.fireAtUtcMs - b.fireAtUtcMs);
  switch (spec.missedRunPolicy) {
    case "SKIP":
      return { admit: [], note: "skip_all_missed" };
    case "RUN_ONCE":
      return ordered.length
        ? { admit: [ordered[ordered.length - 1]!], note: "run_once_latest" }
        : { admit: [], note: "run_once_none" };
    case "BACKLOG_BOUNDED": {
      if (spec.maxBackfillRuns < 1)
        throw new UnknownPolicyError("BACKLOG_BOUNDED requires maxBackfillRuns>=1");
      if (ordered.length > spec.maxBackfillRuns) {
        const kept = ordered.slice(ordered.length - spec.maxBackfillRuns);
        return {
          admit: kept,
          note: `backlog_bounded_truncated:${ordered.length}->${kept.length}`,
        };
      }
      return { admit: ordered, note: "backlog_bounded_all" };
    }
    default:
      throw new UnknownPolicyError(
        `unknown missedRunPolicy: ${String(spec.missedRunPolicy)}`,
      );
  }
}

/** Explicit, audited backfill request. Rejects unbounded/over-cap requests. */
export function assertBackfillBounded(spec: ScheduleSpec, requestedRuns: number): void {
  if (!Number.isInteger(requestedRuns) || requestedRuns < 0)
    throw new UnknownPolicyError(`invalid backfill request: ${requestedRuns}`);
  if (spec.maxBackfillRuns > MAX_BACKFILL_RUNS)
    throw new UnknownPolicyError("maxBackfillRuns exceeds hard cap");
  if (requestedRuns > spec.maxBackfillRuns)
    throw new UnknownPolicyError(
      `backfill ${requestedRuns} exceeds schedule cap ${spec.maxBackfillRuns}`,
    );
}

export type OverlapAction = "PROCEED" | "SKIP" | "QUEUE" | "REPLACE";

/** Decide overlap handling given the count of still-running instances. */
export function resolveOverlap(
  spec: ScheduleSpec,
  ctx: { running: number },
): { action: OverlapAction; reason: string } {
  if (ctx.running <= 0) return { action: "PROCEED", reason: "no_overlap" };
  switch (spec.overlapPolicy) {
    case "FORBID":
      return { action: "SKIP", reason: "forbid_overlap" };
    case "QUEUE":
      return ctx.running >= spec.perScheduleConcurrency
        ? { action: "QUEUE", reason: "queued_concurrency_full" }
        : { action: "PROCEED", reason: "queue_within_concurrency" };
    case "REPLACE":
      return { action: "REPLACE", reason: "replace_running" };
    default:
      throw new UnknownPolicyError(
        `unknown overlapPolicy: ${String(spec.overlapPolicy)}`,
      );
  }
}

/** Global concurrency gate across all schedules. */
export function withinGlobalConcurrency(
  config: SchedulerConfig,
  globalRunning: number,
): boolean {
  return globalRunning < config.globalConcurrencyCap;
}
