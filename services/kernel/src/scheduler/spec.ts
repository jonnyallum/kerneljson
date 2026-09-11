import { z } from "zod";
import {
  Id,
  Timestamp,
  PrincipalRef,
  TenantRef,
} from "../../../../packages/contracts/src/index.js";
import { isValidTimeZone } from "./time.js";

/**
 * Phase S1 — production ScheduleSpec (MVP prep).
 *
 * DESIGN LAW: a schedule decides only WHEN an admission request is emitted.
 * It never decides that canonical work exists — KernelJSON Admission does.
 * This module is additive and isolated: nothing else in the kernel imports it,
 * so it is fully removable. The existing bounded interval `ScheduleSubmission`
 * (packages/contracts/src/schedule.ts) is untouched.
 *
 * Hard cap on backfill so a misconfigured schedule cannot admit unbounded work.
 */
export const MAX_BACKFILL_RUNS = 100;

/** Calendar recurrence. everyNMinutes is a fixed UTC interval (DST-immune). */
export const CalendarSpec = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("everyNMinutes"),
    n: z.number().int().min(1).max(1440),
  }),
  z.strictObject({
    kind: z.literal("dailyAt"),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
  z.strictObject({
    kind: z.literal("weeklyAt"),
    // 0=Sunday .. 6=Saturday (calendar weekday, tz-independent for a civil date)
    weekday: z.number().int().min(0).max(6),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
]);
export type CalendarSpec = z.infer<typeof CalendarSpec>;

export const MissedRunPolicy = z.enum(["SKIP", "RUN_ONCE", "BACKLOG_BOUNDED"]);
export type MissedRunPolicy = z.infer<typeof MissedRunPolicy>;

export const OverlapPolicy = z.enum(["FORBID", "QUEUE", "REPLACE"]);
export type OverlapPolicy = z.infer<typeof OverlapPolicy>;

/** DST gap (nonexistent civil time, e.g. spring-forward) handling. */
export const NonexistentTimePolicy = z.enum(["SKIP", "SHIFT_FORWARD"]);
export type NonexistentTimePolicy = z.infer<typeof NonexistentTimePolicy>;

export const ScheduleState = z.enum(["enabled", "paused", "disabled"]);
export type ScheduleState = z.infer<typeof ScheduleState>;

export const ScheduleSpec = z
  .strictObject({
    scheduleId: Id,
    version: z.string().min(1),
    tenant: TenantRef,
    principal: PrincipalRef,
    // Human owner accountable for the schedule (must be a real human).
    owner: PrincipalRef.refine((p) => p.kind === "HUMAN", "owner must be HUMAN"),
    timezone: z
      .string()
      .min(1)
      .refine(isValidTimeZone, "invalid IANA timezone"),
    calendar: CalendarSpec,
    // Lifecycle. Fail-safe default: a fresh spec is disabled.
    state: ScheduleState.default("disabled"),
    missedRunPolicy: MissedRunPolicy,
    maxBackfillRuns: z.number().int().min(0).max(MAX_BACKFILL_RUNS),
    overlapPolicy: OverlapPolicy,
    perScheduleConcurrency: z.number().int().min(1).max(50),
    nonexistentTimePolicy: NonexistentTimePolicy.default("SHIFT_FORWARD"),
    // Production schedules are disabled by default and cannot self-enable.
    enabledForProduction: z.boolean().default(false),
    createdAt: Timestamp,
  })
  .refine(
    (s) => s.missedRunPolicy !== "BACKLOG_BOUNDED" || s.maxBackfillRuns >= 1,
    "BACKLOG_BOUNDED requires maxBackfillRuns >= 1",
  );
export type ScheduleSpec = z.infer<typeof ScheduleSpec>;

/** Scheduler-wide runtime config (not part of an individual spec). */
export const SchedulerConfig = z.strictObject({
  globalConcurrencyCap: z.number().int().min(1).max(500),
});
export type SchedulerConfig = z.infer<typeof SchedulerConfig>;
