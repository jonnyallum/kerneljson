import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { ScheduleSpec, nextWindowAfter } from "../services/kernel/src/scheduler/index.js";

/**
 * S1B-FIX regression — nextWindowAfter must return the first fire window STRICTLY
 * AFTER `fromMs`, never `fromMs` itself.
 *
 * Root cause (found live during S1B qualification, 2026-09-14): dueFireWindows'
 * [from,to) contract is correct for enumerating due/backlog windows (inclusive of
 * `from`), but nextWindowAfter's callers always pass the window that WAS JUST FIRED as
 * `fromMs` — most critically the self-rearm path (RestateDurableTimerRuntime.
 * scheduleWake sets the next invocation's own `nowMs` to exactly the fired window's
 * `fireAtUtcMs`). Querying dueFireWindows starting AT that exact boundary returned the
 * SAME window again for every calendar kind (everyNMinutes' `ceil`, dailyAt/weeklyAt's
 * `>=`), so nextWindowAfter never advanced, the computed re-arm delay was always 0
 * against real time, and a real armNext=true schedule looped several times per second
 * against a disposable Restate instance. These tests pin the fix (`durable-timer.ts`:
 * query from `fromMs + 1`) so no calendar kind can regress to that behaviour.
 */

const iso = (ms: number): string => new Date(ms).toISOString();

function spec(overrides: {
  calendar: ScheduleSpec["calendar"];
  timezone?: string;
}): ScheduleSpec {
  const humanId = randomUUID();
  return ScheduleSpec.parse({
    scheduleId: randomUUID(),
    version: "v1",
    tenant: { id: randomUUID() },
    principal: { id: randomUUID(), kind: "SERVICE" },
    owner: { id: humanId, kind: "HUMAN" },
    timezone: overrides.timezone ?? "UTC",
    calendar: overrides.calendar,
    state: "enabled",
    missedRunPolicy: "SKIP",
    maxBackfillRuns: 10,
    overlapPolicy: "FORBID",
    perScheduleConcurrency: 1,
    nonexistentTimePolicy: "SHIFT_FORWARD",
    enabledForProduction: false,
    createdAt: iso(0),
  });
}

describe("nextWindowAfter: strictly-after boundary contract (S1B-FIX)", () => {
  it("everyNMinutes: fromMs exactly on a boundary returns the NEXT boundary, not the same one", () => {
    const s = spec({ calendar: { kind: "everyNMinutes", n: 1 } });
    const boundary = Date.UTC(2026, 8, 14, 0, 5, 0); // an exact minute boundary
    const next = nextWindowAfter(s, boundary);
    expect(next).not.toBeNull();
    expect(next!.fireAtUtcMs).toBeGreaterThan(boundary);
    expect(next!.fireAtUtcMs).toBe(boundary + 60_000); // exactly the following minute
  });

  it("dailyAt: fromMs equals the just-fired boundary returns the NEXT day's instant, not the same one", () => {
    const s = spec({ calendar: { kind: "dailyAt", hour: 1, minute: 30 } });
    const firedAt = Date.UTC(2026, 8, 14, 1, 30, 0); // 2026-09-14 01:30 UTC
    const next = nextWindowAfter(s, firedAt);
    expect(next).not.toBeNull();
    expect(next!.fireAtUtcMs).toBeGreaterThan(firedAt);
    expect(next!.fireAtUtcMs).toBe(Date.UTC(2026, 8, 15, 1, 30, 0)); // the following day
  });

  it("weeklyAt: fromMs equals the just-fired boundary returns the NEXT week's instant, not the same one", () => {
    // 2026-09-14 is a Monday (weekday=1).
    const s = spec({ calendar: { kind: "weeklyAt", weekday: 1, hour: 9, minute: 0 } });
    const firedAt = Date.UTC(2026, 8, 14, 9, 0, 0);
    const next = nextWindowAfter(s, firedAt);
    expect(next).not.toBeNull();
    expect(next!.fireAtUtcMs).toBeGreaterThan(firedAt);
    expect(next!.fireAtUtcMs).toBe(Date.UTC(2026, 8, 21, 9, 0, 0)); // the following Monday
  });

  it("everyNMinutes: immediately-before-boundary input still returns that upcoming boundary (unaffected by the fix)", () => {
    const s = spec({ calendar: { kind: "everyNMinutes", n: 1 } });
    const boundary = Date.UTC(2026, 8, 14, 0, 5, 0);
    const next = nextWindowAfter(s, boundary - 1);
    expect(next!.fireAtUtcMs).toBe(boundary); // the boundary itself is still reachable
  });

  it("everyNMinutes: immediately-after-boundary input returns the FOLLOWING boundary, not the one just passed", () => {
    const s = spec({ calendar: { kind: "everyNMinutes", n: 1 } });
    const boundary = Date.UTC(2026, 8, 14, 0, 5, 0);
    const next = nextWindowAfter(s, boundary + 1);
    expect(next!.fireAtUtcMs).toBe(boundary + 60_000);
  });

  it("dailyAt: immediately-before-boundary input still returns that upcoming instant", () => {
    const s = spec({ calendar: { kind: "dailyAt", hour: 1, minute: 30 } });
    const firedAt = Date.UTC(2026, 8, 14, 1, 30, 0);
    const next = nextWindowAfter(s, firedAt - 1);
    expect(next!.fireAtUtcMs).toBe(firedAt);
  });

  it("dailyAt: immediately-after-boundary input returns the FOLLOWING day, not the one just passed", () => {
    const s = spec({ calendar: { kind: "dailyAt", hour: 1, minute: 30 } });
    const firedAt = Date.UTC(2026, 8, 14, 1, 30, 0);
    const next = nextWindowAfter(s, firedAt + 1);
    expect(next!.fireAtUtcMs).toBe(Date.UTC(2026, 8, 15, 1, 30, 0));
  });

  it("weeklyAt: immediately-before/after-boundary inputs behave correctly", () => {
    const s = spec({ calendar: { kind: "weeklyAt", weekday: 1, hour: 9, minute: 0 } });
    const firedAt = Date.UTC(2026, 8, 14, 9, 0, 0);
    expect(nextWindowAfter(s, firedAt - 1)!.fireAtUtcMs).toBe(firedAt);
    expect(nextWindowAfter(s, firedAt + 1)!.fireAtUtcMs).toBe(Date.UTC(2026, 8, 21, 9, 0, 0));
  });

  it("invariant: nextWindowAfter(spec, fireAtUtcMs).fireAtUtcMs > fireAtUtcMs for every schedule kind, across several consecutive real fires (not just the first)", () => {
    const cases: { name: string; s: ScheduleSpec; start: number }[] = [
      { name: "everyNMinutes/5", s: spec({ calendar: { kind: "everyNMinutes", n: 5 } }), start: Date.UTC(2026, 8, 14, 0, 0, 0) },
      { name: "dailyAt", s: spec({ calendar: { kind: "dailyAt", hour: 3, minute: 15 } }), start: Date.UTC(2026, 8, 14, 3, 15, 0) },
      { name: "weeklyAt", s: spec({ calendar: { kind: "weeklyAt", weekday: 3, hour: 12, minute: 0 } }), start: Date.UTC(2026, 8, 16, 12, 0, 0) }, // 2026-09-16 is Wednesday
    ];
    for (const { name, s, start } of cases) {
      let current = start;
      for (let i = 0; i < 5; i++) {
        const next = nextWindowAfter(s, current);
        expect(next, `${name} iteration ${i}`).not.toBeNull();
        expect(next!.fireAtUtcMs, `${name} iteration ${i}: must strictly advance`).toBeGreaterThan(current);
        current = next!.fireAtUtcMs; // simulate the self-rearm path feeding its own output back in
      }
    }
  });

  it("simulates the exact self-rearm loop shape and proves it terminates advancing, not looping (the defect's precise reproduction, now fixed)", () => {
    const s = spec({ calendar: { kind: "everyNMinutes", n: 1 } });
    const w1 = Date.UTC(2026, 8, 14, 0, 0, 0);
    // RestateDurableTimerRuntime.scheduleWake always feeds the NEXT invocation's nowMs
    // as exactly the window just fired — this is the precise input shape that broke.
    const w2 = nextWindowAfter(s, w1)!.fireAtUtcMs;
    const w3 = nextWindowAfter(s, w2)!.fireAtUtcMs;
    const w4 = nextWindowAfter(s, w3)!.fireAtUtcMs;
    expect(new Set([w1, w2, w3, w4]).size).toBe(4); // four DISTINCT windows, not one repeated
    expect([w2 - w1, w3 - w2, w4 - w3]).toEqual([60_000, 60_000, 60_000]);
  });
});
