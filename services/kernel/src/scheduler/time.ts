/**
 * Phase S1 — DST-correct civil<->UTC resolution over IANA timezones.
 *
 * No naive local-datetime arithmetic. Uses the ICU data behind Intl (Node >=22)
 * to probe the UTC offset at instants and to detect the two irregular cases:
 *   - gap  (spring-forward): a civil time that does not exist
 *   - fold (autumn):          a civil time that exists twice
 *
 * A scheduler must never turn one civil slot into two fires, so fold resolves to
 * the single earliest instant and the fire-window key is keyed on the civil slot.
 */

export interface Civil {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
}

const _dtfCache = new Map<string, Intl.DateTimeFormat>();

function dtf(tz: string): Intl.DateTimeFormat {
  let f = _dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    _dtfCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== "string" || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock components of a UTC instant, observed in tz. */
export function wallParts(utcMs: number, tz: string): Civil & { second: number } {
  const parts = dtf(tz).formatToParts(new Date(utcMs));
  const g = (t: string): number => {
    const p = parts.find((x) => x.type === t);
    return p ? Number(p.value) : NaN;
  };
  let hour = g("hour");
  if (hour === 24) hour = 0; // some ICU builds render midnight as 24
  return {
    year: g("year"),
    month: g("month"),
    day: g("day"),
    hour,
    minute: g("minute"),
    second: g("second"),
  };
}

/** Offset in ms (wallAsUTC - utc) at the given instant. */
function offsetMsAt(utcMs: number, tz: string): number {
  const w = wallParts(utcMs, tz);
  const asUTC = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUTC - utcMs;
}

export type CivilResolution =
  | { kind: "unique"; instant: number }
  | { kind: "fold"; instants: [number, number] }
  | { kind: "gap"; shiftForwardInstant: number };

/**
 * Resolve a civil wall-clock time in tz to UTC instant(s), detecting gap/fold.
 * Probes offsets +/- one day around the target to bracket any transition.
 */
export function resolveCivil(c: Civil, tz: string): CivilResolution {
  const target = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, 0);
  const probeOffsets = [
    offsetMsAt(target - 86_400_000, tz),
    offsetMsAt(target, tz),
    offsetMsAt(target + 86_400_000, tz),
  ];
  const valid: number[] = [];
  const seenOff = new Set<number>();
  for (const off of probeOffsets) {
    if (seenOff.has(off)) continue;
    seenOff.add(off);
    const inst = target - off;
    const w = wallParts(inst, tz);
    if (
      w.year === c.year &&
      w.month === c.month &&
      w.day === c.day &&
      w.hour === c.hour &&
      w.minute === c.minute
    ) {
      valid.push(inst);
    }
  }
  const uniq = Array.from(new Set(valid)).sort((a, b) => a - b);
  if (uniq.length === 1) return { kind: "unique", instant: uniq[0]! };
  if (uniq.length >= 2)
    return { kind: "fold", instants: [uniq[0]!, uniq[uniq.length - 1]!] };
  // Gap: nothing maps to this civil time. Shift forward by using the smaller
  // (post-transition) offset, which lands the fire at the next real wall time.
  const offsetsAsc = Array.from(seenOff).sort((a, b) => a - b);
  return { kind: "gap", shiftForwardInstant: target - offsetsAsc[0]! };
}

/** Calendar weekday (0=Sun..6=Sat) of a civil date — tz-independent. */
export function civilWeekday(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Civil date (in tz) of a UTC instant, as {year,month,day}. */
export function civilDateInTz(
  utcMs: number,
  tz: string,
): { year: number; month: number; day: number } {
  const w = wallParts(utcMs, tz);
  return { year: w.year, month: w.month, day: w.day };
}

/** Next civil date after {y,m,d} using calendar arithmetic. */
export function nextCivilDate(y: number, m: number, d: number): {
  year: number;
  month: number;
  day: number;
} {
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}
