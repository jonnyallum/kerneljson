import { it, expect, describe } from "vitest";
import { randomUUID } from "node:crypto";
import {
  ScheduleSpec,
  AdmissionSink,
  tick,
  dueFireWindows,
  fireIdentity,
  resolveMissedRuns,
  resolveOverlap,
  assertBackfillBounded,
  UnknownPolicyError,
  wallParts,
} from "../services/kernel/src/scheduler/index.js";

/**
 * Phase S1 — accelerated in-memory simulations.
 *
 * EXECUTED (no Docker/Restate needed): everything in this file runs in-process
 * against a fake clock and an in-memory AdmissionSink that models KJ Admission
 * dedupe on the fire identity. The invariant under test throughout:
 *
 *   NO (scheduleId, version, fireWindow) is admitted more than once.
 *
 * SPECIFIED / UNEXECUTED here (needs Docker Postgres + Restate; see S1 report):
 * durable persistence, real Restate timers, real child execution/retry engine,
 * evidence-per-fire persistence. Child-retry and "long-running" below are modelled
 * at the admission/decision layer only, not by a real execution engine.
 */

const H = 3_600_000;

function mkSpec(over: Record<string, unknown> = {}): ScheduleSpec {
  return ScheduleSpec.parse({
    scheduleId: over.scheduleId ?? randomUUID(),
    version: "v1",
    tenant: { id: randomUUID() },
    principal: { id: randomUUID(), kind: "SERVICE" },
    owner: { id: randomUUID(), kind: "HUMAN" },
    timezone: "Europe/London",
    calendar: { kind: "everyNMinutes", n: 60 },
    state: "enabled",
    missedRunPolicy: "SKIP",
    maxBackfillRuns: 0,
    overlapPolicy: "FORBID",
    perScheduleConcurrency: 1,
    nonexistentTimePolicy: "SHIFT_FORWARD",
    enabledForProduction: false,
    createdAt: "2026-09-10T00:00:00Z",
    ...over,
  });
}

describe("S1 simulation: admission idempotency (EXECUTED)", () => {
  it("24h normal operation: hourly schedule ticked hourly = 24 admits, 0 duplicates", () => {
    const spec = mkSpec({ calendar: { kind: "everyNMinutes", n: 60 } });
    const sink = new AdmissionSink();
    const T0 = Date.UTC(2026, 5, 1, 0, 0, 0);
    let dupes = 0;
    for (let i = 0; i < 24; i++) {
      const r = tick(spec, {
        lastTickMs: T0 + i * H,
        nowMs: T0 + i * H + 1,
        productionRuntime: false,
        sink,
      });
      dupes += r.duplicatesSuppressed;
    }
    expect(sink.count()).toBe(24);
    expect(dupes).toBe(0);
  });

  it("restart across a fire boundary: same sink, overlapping re-tick admits each window once", () => {
    const spec = mkSpec({ calendar: { kind: "everyNMinutes", n: 60 } });
    const sink = new AdmissionSink();
    const T0 = Date.UTC(2026, 5, 1, 0, 0, 0);
    // run first 12h in one tick
    tick(spec, { lastTickMs: T0 - 1, nowMs: T0 + 12 * H, productionRuntime: false, sink });
    const after12 = sink.count();
    // "restart": in-memory tick cursor lost; re-tick an interval that OVERLAPS the last 2h
    const r = tick(spec, { lastTickMs: T0 + 10 * H, nowMs: T0 + 14 * H, productionRuntime: false, sink });
    // the 11h & 12h windows are replayed but deduped; 13h & 14h are new
    expect(r.duplicatesSuppressed).toBeGreaterThanOrEqual(1);
    expect(sink.count()).toBe(after12 + 2); // only 13h and 14h added (14h boundary is < to? see below)
  });

  it("same-fire replay: replaying the identical interval changes nothing", () => {
    const spec = mkSpec();
    const sink = new AdmissionSink();
    const T0 = Date.UTC(2026, 5, 1, 3, 0, 0);
    const args = { lastTickMs: T0 - 1, nowMs: T0 + 1, productionRuntime: false, sink };
    tick(spec, args);
    const first = sink.count();
    const r = tick(spec, args); // exact replay
    expect(sink.count()).toBe(first);
    expect(r.admitted.length).toBe(0);
    expect(r.duplicatesSuppressed).toBe(1);
  });

  it("response lost after admission commit: retry does not double-admit", () => {
    const spec = mkSpec();
    const sink = new AdmissionSink();
    const T0 = Date.UTC(2026, 5, 1, 4, 0, 0);
    // admission commits to the durable sink, but the caller's ack is 'lost'
    tick(spec, { lastTickMs: T0 - 1, nowMs: T0 + 1, productionRuntime: false, sink });
    // retry the same window
    const r = tick(spec, { lastTickMs: T0 - 1, nowMs: T0 + 1, productionRuntime: false, sink });
    expect(sink.count()).toBe(1);
    expect(r.duplicatesSuppressed).toBe(1);
  });

  it("duplicate worker wake: two ticks for the same interval = one admission", () => {
    const spec = mkSpec();
    const sink = new AdmissionSink();
    const T0 = Date.UTC(2026, 5, 1, 5, 0, 0);
    const a = { lastTickMs: T0 - 1, nowMs: T0 + 1, productionRuntime: false, sink };
    tick(spec, a);
    tick(spec, a);
    expect(sink.count()).toBe(1);
  });

  it("repeated child failure: retrying a child never re-mints via the fire identity", () => {
    // Models KJ retry lifecycle reusing the SAME admission identity (a real child
    // execution/retry engine is KJ-owned and not implemented here).
    const spec = mkSpec();
    const sink = new AdmissionSink();
    const T0 = Date.UTC(2026, 5, 1, 6, 0, 0);
    const win = dueFireWindows(spec, T0 - 1, T0 + 1)[0]!;
    const identity = fireIdentity(spec, win.fireWindowKey);
    // first admission
    sink.admit({ identity, idempotencyKey: "k", scheduleId: spec.scheduleId, version: spec.version, fireWindowKey: win.fireWindowKey, fireAtUtcMs: win.fireAtUtcMs });
    // simulate 5 child failures + naive re-fires of the SAME identity
    let readmits = 0;
    for (let i = 0; i < 5; i++) {
      if (sink.admit({ identity, idempotencyKey: "k", scheduleId: spec.scheduleId, version: spec.version, fireWindowKey: win.fireWindowKey, fireAtUtcMs: win.fireAtUtcMs }).admitted) readmits++;
    }
    expect(sink.count()).toBe(1);
    expect(readmits).toBe(0);
  });

  it("DST spring-forward: daily 01:30 admits once at 02:30 wall (SHIFT_FORWARD)", () => {
    const spec = mkSpec({ calendar: { kind: "dailyAt", hour: 1, minute: 30 }, nonexistentTimePolicy: "SHIFT_FORWARD" });
    const sink = new AdmissionSink();
    tick(spec, { lastTickMs: Date.UTC(2026, 2, 29), nowMs: Date.UTC(2026, 2, 30), productionRuntime: false, sink });
    expect(sink.count()).toBe(1);
    const req = sink.identities().length;
    expect(req).toBe(1);
    // confirm the admitted instant lands at 02:30 London wall
    const wins = dueFireWindows(spec, Date.UTC(2026, 2, 29), Date.UTC(2026, 2, 30));
    const w = wallParts(wins[0]!.fireAtUtcMs, "Europe/London");
    expect([w.hour, w.minute]).toEqual([2, 30]);
  });

  it("DST autumn repeat: daily 01:30 on the fold day admits exactly once", () => {
    const spec = mkSpec({ calendar: { kind: "dailyAt", hour: 1, minute: 30 } });
    const sink = new AdmissionSink();
    // tick twice over the fold day to also prove no double
    const a = { lastTickMs: Date.UTC(2026, 9, 25), nowMs: Date.UTC(2026, 9, 26), productionRuntime: false, sink };
    tick(spec, a);
    tick(spec, a);
    expect(sink.count()).toBe(1);
  });
});

describe("S1 simulation: policy decisions (EXECUTED)", () => {
  it("2h outage + missed-run policy over a 30-min schedule", () => {
    const base = mkSpec({ calendar: { kind: "everyNMinutes", n: 30 } });
    const T0 = Date.UTC(2026, 5, 1, 0, 0, 0);
    // scheduler was down 2h: windows piled up in (T0, T0+2h]
    const missed = dueFireWindows(base, T0, T0 + 2 * H); // 4 windows at :30 intervals
    expect(missed.length).toBe(4);
    expect(resolveMissedRuns({ ...base, missedRunPolicy: "SKIP" } as ScheduleSpec, missed).admit.length).toBe(0);
    expect(resolveMissedRuns({ ...base, missedRunPolicy: "RUN_ONCE" } as ScheduleSpec, missed).admit.length).toBe(1);
    const bb = ScheduleSpec.parse({ ...base, missedRunPolicy: "BACKLOG_BOUNDED", maxBackfillRuns: 2 });
    expect(resolveMissedRuns(bb, missed).admit.length).toBe(2); // bounded
  });

  it("long-running overlap: FORBID / QUEUE / REPLACE decisions while a prior run is active", () => {
    expect(resolveOverlap(mkSpec({ overlapPolicy: "FORBID" }), { running: 1 }).action).toBe("SKIP");
    const q = mkSpec({ overlapPolicy: "QUEUE", perScheduleConcurrency: 2 });
    expect(resolveOverlap(q, { running: 1 }).action).toBe("PROCEED");
    expect(resolveOverlap(q, { running: 2 }).action).toBe("QUEUE");
    expect(resolveOverlap(mkSpec({ overlapPolicy: "REPLACE" }), { running: 3 }).action).toBe("REPLACE");
  });

  it("bounded backlog cannot exceed the cap; explicit over-cap backfill is rejected", () => {
    const spec = ScheduleSpec.parse({ ...mkSpec(), missedRunPolicy: "BACKLOG_BOUNDED", maxBackfillRuns: 3 });
    expect(() => assertBackfillBounded(spec, 3)).not.toThrow();
    expect(() => assertBackfillBounded(spec, 4)).toThrow(UnknownPolicyError);
  });

  it("invalid timezone and unknown policy fail closed", () => {
    expect(() => mkSpec({ timezone: "Nowhere/Nowhere" })).toThrow();
    const badOverlap = { ...mkSpec(), overlapPolicy: "STAMPEDE" } as unknown as ScheduleSpec;
    expect(() => resolveOverlap(badOverlap, { running: 1 })).toThrow(UnknownPolicyError);
    const badMissed = { ...mkSpec(), missedRunPolicy: "WHENEVER" } as unknown as ScheduleSpec;
    expect(() => resolveMissedRuns(badMissed, [])).toThrow(UnknownPolicyError);
  });

  it("disabled / paused / production-not-enabled produce zero admissions via tick", () => {
    const T0 = Date.UTC(2026, 5, 1, 7, 0, 0);
    for (const over of [{ state: "disabled" }, { state: "paused" }]) {
      const sink = new AdmissionSink();
      tick(mkSpec(over), { lastTickMs: T0 - 1, nowMs: T0 + 1, productionRuntime: false, sink });
      expect(sink.count()).toBe(0);
    }
    // enabled but not enabledForProduction, in a production runtime => no admission
    const sink = new AdmissionSink();
    tick(mkSpec({ state: "enabled", enabledForProduction: false }), { lastTickMs: T0 - 1, nowMs: T0 + 1, productionRuntime: true, sink });
    expect(sink.count()).toBe(0);
  });
});
