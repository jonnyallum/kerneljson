import { it, expect, describe } from "vitest";
import { randomUUID } from "node:crypto";
import {
  ScheduleSpec,
  SchedulerConfig,
  dueFireWindows,
  fireIdentity,
  idempotencyKey,
  canFire,
  resolveMissedRuns,
  resolveOverlap,
  assertBackfillBounded,
  withinGlobalConcurrency,
  UnknownPolicyError,
  wallParts,
  type FireWindow,
} from "../services/kernel/src/scheduler/index.js";

const FIXED_ID = "11111111-1111-4111-a111-111111111111";

function mkSpec(over: Record<string, unknown> = {}): ScheduleSpec {
  return ScheduleSpec.parse({
    scheduleId: FIXED_ID,
    version: "v1",
    tenant: { id: randomUUID() },
    principal: { id: randomUUID(), kind: "SERVICE" },
    owner: { id: randomUUID(), kind: "HUMAN" },
    timezone: "Europe/London",
    calendar: { kind: "dailyAt", hour: 1, minute: 30 },
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

const mkWin = (t: number): FireWindow => ({
  fireWindowKey: `k@${t}`,
  fireAtUtcMs: t,
  fireAtUtcIso: new Date(t).toISOString(),
  civilSlot: "slot",
  note: "unique",
});

describe("contract / fail-closed", () => {
  it("rejects an invalid IANA timezone", () => {
    expect(() => mkSpec({ timezone: "Mars/Olympus" })).toThrow();
  });
  it("rejects unbounded backfill (over hard cap) at parse time", () => {
    expect(() =>
      mkSpec({ missedRunPolicy: "BACKLOG_BOUNDED", maxBackfillRuns: 100000 }),
    ).toThrow();
  });
  it("rejects BACKLOG_BOUNDED with maxBackfillRuns=0", () => {
    expect(() =>
      mkSpec({ missedRunPolicy: "BACKLOG_BOUNDED", maxBackfillRuns: 0 }),
    ).toThrow();
  });
  it("owner must be HUMAN", () => {
    expect(() => mkSpec({ owner: { id: randomUUID(), kind: "SERVICE" } })).toThrow();
  });
  it("defaults to disabled and not-production when omitted", () => {
    const s = ScheduleSpec.parse({
      scheduleId: randomUUID(),
      version: "v1",
      tenant: { id: randomUUID() },
      principal: { id: randomUUID(), kind: "SERVICE" },
      owner: { id: randomUUID(), kind: "HUMAN" },
      timezone: "Europe/London",
      calendar: { kind: "everyNMinutes", n: 5 },
      missedRunPolicy: "SKIP",
      maxBackfillRuns: 0,
      overlapPolicy: "FORBID",
      perScheduleConcurrency: 1,
      createdAt: "2026-09-10T00:00:00Z",
    });
    expect(s.state).toBe("disabled");
    expect(s.enabledForProduction).toBe(false);
  });
});

describe("fire identity / idempotency", () => {
  it("same (spec, window) → same identity and idempotency key (retry no re-mint)", () => {
    const s = mkSpec();
    const k = "dailyAt/01:30|Europe/London|2026-09-10";
    expect(fireIdentity(s, k)).toBe(fireIdentity(s, k));
    expect(idempotencyKey(s, k)).toBe(`${FIXED_ID}|v1|${k}`);
  });
  it("different version → different fire identity", () => {
    const k = "dailyAt/01:30|Europe/London|2026-09-10";
    expect(fireIdentity(mkSpec({ version: "v1" }), k)).not.toBe(
      fireIdentity(mkSpec({ version: "v2" }), k),
    );
  });
  it("dueFireWindows is deterministic for the same window", () => {
    const s = mkSpec();
    const from = Date.UTC(2026, 5, 1);
    const to = Date.UTC(2026, 5, 3);
    expect(dueFireWindows(s, from, to)).toEqual(dueFireWindows(s, from, to));
  });
});

describe("enable / pause / disable / production self-enable", () => {
  it("disabled → no fire", () => {
    expect(canFire(mkSpec({ state: "disabled" }), { productionRuntime: false }).ok).toBe(false);
  });
  it("paused → no fire", () => {
    expect(canFire(mkSpec({ state: "paused" }), { productionRuntime: false }).ok).toBe(false);
  });
  it("production schedule cannot self-enable (enabled but not enabledForProduction)", () => {
    const s = mkSpec({ state: "enabled", enabledForProduction: false });
    expect(canFire(s, { productionRuntime: true }).ok).toBe(false);
    expect(canFire(s, { productionRuntime: true }).reason).toBe("production_not_enabled");
  });
  it("production fire allowed only when explicitly enabledForProduction", () => {
    const s = mkSpec({ state: "enabled", enabledForProduction: true });
    expect(canFire(s, { productionRuntime: true }).ok).toBe(true);
  });
  it("unknown state fails closed", () => {
    const s = { ...mkSpec(), state: "zombie" } as unknown as ScheduleSpec;
    expect(canFire(s, { productionRuntime: false }).ok).toBe(false);
  });
});

describe("Europe/London DST", () => {
  const tz = "Europe/London";
  it("normal day: dailyAt 01:30 fires once at the correct instant", () => {
    const s = mkSpec({ calendar: { kind: "dailyAt", hour: 1, minute: 30 } });
    const wins = dueFireWindows(s, Date.UTC(2026, 5, 15), Date.UTC(2026, 5, 16));
    expect(wins.length).toBe(1);
    const w = wallParts(wins[0]!.fireAtUtcMs, tz);
    expect([w.hour, w.minute]).toEqual([1, 30]);
    expect(wins[0]!.note).toBe("unique");
  });
  it("spring-forward gap (2026-03-29 01:30) SHIFT_FORWARD lands at 02:30 wall", () => {
    const s = mkSpec({ nonexistentTimePolicy: "SHIFT_FORWARD" });
    const wins = dueFireWindows(s, Date.UTC(2026, 2, 29), Date.UTC(2026, 2, 30));
    const w29 = wins.find((x) => x.civilSlot.includes("2026-03-29"));
    expect(w29).toBeTruthy();
    expect(w29!.note).toBe("gap_shifted");
    const wall = wallParts(w29!.fireAtUtcMs, tz);
    expect([wall.hour, wall.minute]).toEqual([2, 30]);
  });
  it("spring-forward gap SKIP produces no fire that day", () => {
    const s = mkSpec({ nonexistentTimePolicy: "SKIP" });
    const wins = dueFireWindows(s, Date.UTC(2026, 2, 29), Date.UTC(2026, 2, 30));
    expect(wins.find((x) => x.civilSlot.includes("2026-03-29"))).toBeUndefined();
  });
  it("autumn fold (2026-10-25 01:30) fires exactly once at the earliest instant", () => {
    const s = mkSpec();
    const wins = dueFireWindows(s, Date.UTC(2026, 9, 25), Date.UTC(2026, 9, 26));
    const w25 = wins.filter((x) => x.civilSlot.includes("2026-10-25"));
    expect(w25.length).toBe(1);
    expect(w25[0]!.note).toBe("fold_first");
    const wall = wallParts(w25[0]!.fireAtUtcMs, tz);
    expect([wall.hour, wall.minute]).toEqual([1, 30]);
    // earliest of the two 01:30 instants is the BST one (00:30Z)
    expect(new Date(w25[0]!.fireAtUtcMs).toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });
  it("everyNMinutes is a fixed UTC interval (DST-immune): 15-min over 1h = 4 fires", () => {
    const s = mkSpec({ calendar: { kind: "everyNMinutes", n: 15 } });
    const from = Date.UTC(2026, 0, 1, 0, 0);
    const wins = dueFireWindows(s, from, from + 60 * 60_000);
    expect(wins.length).toBe(4);
  });
});

describe("missed-run policy", () => {
  const missed = [mkWin(1000), mkWin(2000), mkWin(3000)];
  it("SKIP admits nothing", () => {
    expect(resolveMissedRuns(mkSpec({ missedRunPolicy: "SKIP" }), missed).admit).toEqual([]);
  });
  it("RUN_ONCE admits only the latest", () => {
    const r = resolveMissedRuns(mkSpec({ missedRunPolicy: "RUN_ONCE" }), missed);
    expect(r.admit.map((w) => w.fireAtUtcMs)).toEqual([3000]);
  });
  it("BACKLOG_BOUNDED truncates to the cap (most recent kept)", () => {
    const s = mkSpec({ missedRunPolicy: "BACKLOG_BOUNDED", maxBackfillRuns: 2 });
    const r = resolveMissedRuns(s, missed);
    expect(r.admit.map((w) => w.fireAtUtcMs)).toEqual([2000, 3000]);
    expect(r.note).toContain("truncated");
  });
  it("explicit backfill over the schedule cap is rejected", () => {
    const s = mkSpec({ missedRunPolicy: "BACKLOG_BOUNDED", maxBackfillRuns: 3 });
    expect(() => assertBackfillBounded(s, 4)).toThrow(UnknownPolicyError);
    expect(() => assertBackfillBounded(s, 3)).not.toThrow();
  });
  it("unknown missed policy fails closed", () => {
    const s = { ...mkSpec(), missedRunPolicy: "WHENEVER" } as unknown as ScheduleSpec;
    expect(() => resolveMissedRuns(s, missed)).toThrow(UnknownPolicyError);
  });
});

describe("overlap policy", () => {
  it("no overlap → PROCEED", () => {
    expect(resolveOverlap(mkSpec(), { running: 0 }).action).toBe("PROCEED");
  });
  it("FORBID → SKIP when running", () => {
    expect(resolveOverlap(mkSpec({ overlapPolicy: "FORBID" }), { running: 1 }).action).toBe("SKIP");
  });
  it("QUEUE → PROCEED under concurrency, QUEUE at cap", () => {
    const s = mkSpec({ overlapPolicy: "QUEUE", perScheduleConcurrency: 2 });
    expect(resolveOverlap(s, { running: 1 }).action).toBe("PROCEED");
    expect(resolveOverlap(s, { running: 2 }).action).toBe("QUEUE");
  });
  it("REPLACE → REPLACE when running", () => {
    expect(resolveOverlap(mkSpec({ overlapPolicy: "REPLACE" }), { running: 1 }).action).toBe("REPLACE");
  });
  it("unknown overlap policy fails closed", () => {
    const s = { ...mkSpec(), overlapPolicy: "STAMPEDE" } as unknown as ScheduleSpec;
    expect(() => resolveOverlap(s, { running: 1 })).toThrow(UnknownPolicyError);
  });
});

describe("global concurrency", () => {
  it("gates at the global cap", () => {
    const cfg = SchedulerConfig.parse({ globalConcurrencyCap: 3 });
    expect(withinGlobalConcurrency(cfg, 2)).toBe(true);
    expect(withinGlobalConcurrency(cfg, 3)).toBe(false);
  });
});
