import { stableId } from "../compiler/index.js";
import type { ScheduleSpec } from "./spec.js";
import {
  resolveCivil,
  civilDateInTz,
  civilWeekday,
  nextCivilDate,
} from "./time.js";

/**
 * Phase S1 — deterministic fire windows and fire identity.
 *
 * Idempotency identity = scheduleId | version | fireWindowKey.
 * The same (spec, window) always yields the same admission-request identity, so
 * a scheduler retry, a duplicate worker wake, or a replay after restart cannot
 * mint two canonical child tasks: KernelJSON Admission dedupes on this identity.
 */
export interface FireWindow {
  fireWindowKey: string;
  fireAtUtcMs: number;
  fireAtUtcIso: string;
  civilSlot: string;
  note: "utc_interval" | "unique" | "fold_first" | "gap_shifted";
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** scheduleId | version | fireWindow — the required idempotency identity. */
export function idempotencyKey(spec: ScheduleSpec, fireWindowKey: string): string {
  return `${spec.scheduleId}|${spec.version}|${fireWindowKey}`;
}

/** Content-derived, cross-process-stable admission-request identity. */
export function fireIdentity(spec: ScheduleSpec, fireWindowKey: string): string {
  return stableId([
    "kj-schedule-fire/v1",
    spec.scheduleId,
    spec.version,
    fireWindowKey,
  ]);
}

/**
 * Enumerate the fire windows due in [fromUtcMs, toUtcMs). Pure and deterministic.
 * Does NOT apply missed-run/overlap/enable policy — that is policy.ts. This is
 * only "which civil/UTC slots fall in this window, resolved for DST".
 */
export function dueFireWindows(
  spec: ScheduleSpec,
  fromUtcMs: number,
  toUtcMs: number,
): FireWindow[] {
  const out: FireWindow[] = [];
  if (!(toUtcMs > fromUtcMs)) return out;
  const cal = spec.calendar;
  const tz = spec.timezone;

  if (cal.kind === "everyNMinutes") {
    const step = cal.n * 60_000;
    const first = Math.ceil(fromUtcMs / step) * step;
    for (let t = first; t < toUtcMs; t += step) {
      out.push({
        fireWindowKey: `everyNMinutes/${cal.n}@${t}`,
        fireAtUtcMs: t,
        fireAtUtcIso: new Date(t).toISOString(),
        civilSlot: new Date(t).toISOString(),
        note: "utc_interval",
      });
    }
    return out;
  }

  // Calendar (dailyAt / weeklyAt): walk civil dates spanning the window.
  const dayMs = 86_400_000;
  const start = civilDateInTz(fromUtcMs - 2 * dayMs, tz);
  const days = Math.floor((toUtcMs - fromUtcMs) / dayMs) + 4;
  let { year, month, day } = start;
  const seenSlots = new Set<string>();
  for (let i = 0; i < days; i++) {
    const consider =
      cal.kind === "dailyAt" ||
      (cal.kind === "weeklyAt" && civilWeekday(year, month, day) === cal.weekday);
    if (consider) {
      const civil = { year, month, day, hour: cal.hour, minute: cal.minute };
      const civilSlot = `${tz}|${year}-${pad(month)}-${pad(day)}T${pad(cal.hour)}:${pad(cal.minute)}`;
      const res = resolveCivil(civil, tz);
      let fireAt: number | null = null;
      let note: FireWindow["note"] = "unique";
      if (res.kind === "unique") {
        fireAt = res.instant;
        note = "unique";
      } else if (res.kind === "fold") {
        fireAt = res.instants[0]; // fire once, at the earliest instant
        note = "fold_first";
      } else {
        // gap
        if (spec.nonexistentTimePolicy === "SHIFT_FORWARD") {
          fireAt = res.shiftForwardInstant;
          note = "gap_shifted";
        }
        // SKIP: this civil slot does not exist; fireAt stays null (no fire).
      }
      if (
        fireAt !== null &&
        fireAt >= fromUtcMs &&
        fireAt < toUtcMs &&
        !seenSlots.has(civilSlot)
      ) {
        seenSlots.add(civilSlot);
        out.push({
          fireWindowKey: `${cal.kind}/${pad(cal.hour)}:${pad(cal.minute)}|${tz}|${year}-${pad(month)}-${pad(day)}`,
          fireAtUtcMs: fireAt,
          fireAtUtcIso: new Date(fireAt).toISOString(),
          civilSlot,
          note,
        });
      }
    }
    ({ year, month, day } = nextCivilDate(year, month, day));
  }
  out.sort((a, b) => a.fireAtUtcMs - b.fireAtUtcMs);
  return out;
}
