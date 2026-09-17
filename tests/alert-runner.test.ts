import { describe, expect, it, vi } from "vitest";
import {
  runMonitor,
  type RunnerDeps,
} from "../services/kernel/src/alerting/runner.js";
import { InMemoryAlertStateStore } from "../services/kernel/src/alerting/state-store.js";
import { InMemoryNotificationOutboxStore } from "../services/kernel/src/alerting/outbox-store.js";
import { RecordingNotifier } from "../services/kernel/src/alerting/notifier.js";
import { loadMonitorConfig } from "../services/kernel/src/alerting/runner-config.js";
import {
  monitorTick,
  MONITOR_KEY,
} from "../services/kernel/src/alerting/runner-restate.js";
import { monitorReport } from "./support/alert-runner-fixture.js";

function fixture() {
  const outbox = new InMemoryNotificationOutboxStore();
  const store = new InMemoryAlertStateStore(outbox);
  const notifier = new RecordingNotifier();
  const collect = vi.fn(async () => monitorReport());
  let locked = false;
  const deps: RunnerDeps = {
    collect,
    notifier,
    transport: "test",
    canonicalScheduleId: "qualification",
    now: () => new Date("2026-09-16T12:00:00Z"),
    exclusive: async (run) => {
      if (locked) return false;
      locked = true;
      try {
        await run(store, outbox);
        return true;
      } finally {
        locked = false;
      }
    },
  };
  return { deps, store, outbox, notifier, collect };
}

describe("KJ-P1.3 monitor", () => {
  it("reports a healthy run and all required metrics", async () => {
    const f = fixture();
    expect(await runMonitor(f.deps)).toEqual({
      startedAt: "2026-09-16T12:00:00.000Z",
      completedAt: "2026-09-16T12:00:00.000Z",
      durationMs: 0,
      overall: "HEALTHY",
      decisionCounts: { P0: 0, P1: 0, P2: 0, P3: 0 },
      notificationsQueued: 0,
      delivery: { recovered: 0, attempted: 0, delivered: 0, retried: 0, poisoned: 0 },
      result: "OK",
    });
  });
  it("propagates P0/P1, deduplicates later runs, then delivers one recovery per episode", async () => {
    const f = fixture();
    f.collect.mockResolvedValue(monitorReport("CRITICAL"));
    const opened = await runMonitor(f.deps);
    expect(opened.decisionCounts).toEqual({ P0: 1, P1: 1, P2: 0, P3: 0 });
    expect(opened.notificationsQueued).toBe(2);
    expect(opened.delivery.delivered).toBe(2); // queued and delivered in the same run
    const ongoing = await runMonitor(f.deps);
    expect(ongoing.notificationsQueued).toBe(0);
    expect(ongoing.delivery.delivered).toBe(0);
    f.collect.mockResolvedValue(monitorReport());
    const recovered = await runMonitor(f.deps);
    expect(recovered.notificationsQueued).toBe(2);
    expect(recovered.delivery.delivered).toBe(2);
    expect(f.notifier.sent.map((d) => d.kind)).toEqual([
      "NEW",
      "NEW",
      "RECOVERED",
      "RECOVERED",
    ]);
    const idle = await runMonitor(f.deps);
    expect(idle.notificationsQueued).toBe(0);
    expect(idle.delivery.attempted).toBe(0);
  });
  it("fails closed on DB unavailability before collecting or notifying", async () => {
    const f = fixture();
    f.deps.exclusive = async () => {
      throw Error("secret URL");
    };
    const result = await runMonitor(f.deps);
    expect(result.result).toBe("STATE_FAILED");
    expect(f.collect).not.toHaveBeenCalled();
    expect(f.notifier.sent).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("a failed state write emits nothing this run; retry evaluates and delivers", async () => {
    const f = fixture();
    f.collect.mockResolvedValue(monitorReport("CRITICAL"));
    const write = vi
      .spyOn(f.store, "putAll")
      .mockRejectedValueOnce(Error("write failed"));
    expect((await runMonitor(f.deps)).result).toBe("STATE_FAILED");
    expect(f.notifier.sent).toEqual([]);
    const retried = await runMonitor(f.deps);
    expect(retried.notificationsQueued).toBe(2);
    expect(retried.delivery.delivered).toBe(2);
    expect(write).toHaveBeenCalledTimes(2);
  });
  it("collection failure preserves episodes and never fabricates recovery", async () => {
    const f = fixture();
    f.collect.mockResolvedValueOnce(monitorReport("CRITICAL"));
    await runMonitor(f.deps);
    const before = await f.store.getAll();
    f.collect.mockRejectedValueOnce(Error("credential-bearing error"));
    expect((await runMonitor(f.deps)).result).toBe("COLLECTION_FAILED");
    expect(await f.store.getAll()).toEqual(before);
    expect(f.notifier.sent).toHaveLength(2);
  });
  it("a transient notifier failure retries with backoff instead of failing the whole run, and strips raw messages", async () => {
    const f = fixture();
    f.collect.mockResolvedValue(monitorReport("CRITICAL"));
    const notify = vi
      .fn()
      .mockRejectedValueOnce(Error("transport secret"))
      .mockResolvedValue(undefined);
    f.deps.notifier = { notify };
    const result = await runMonitor(f.deps);
    expect(result.result).toBe("OK"); // a transient delivery failure is normal, expected retry behaviour
    expect(result.delivery.attempted).toBe(2);
    expect(result.delivery.delivered).toBe(1);
    expect(result.delivery.retried).toBe(1);
    expect(JSON.stringify(notify.mock.calls)).not.toMatch(
      /sensitive|credential-like/,
    );
    // The failed one is not due again immediately (bounded backoff) — a
    // same-instant re-run doesn't attempt it a second time.
    const again = await runMonitor(f.deps);
    expect(again.delivery.attempted).toBe(0);
  });
  it("skips concurrent invocation without a second collection", async () => {
    const f = fixture();
    let finish!: () => void;
    f.collect.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return monitorReport();
    });
    const first = runMonitor(f.deps);
    expect((await runMonitor(f.deps)).result).toBe("OVERLAP_SKIPPED");
    finish();
    expect((await first).result).toBe("OK");
    expect(f.collect).toHaveBeenCalledTimes(1);
  });
  it("a crash immediately after the state+intent commit does not lose the notification — a later run's delivery phase still delivers it exactly once, with no duplicate episode", async () => {
    const f = fixture();
    f.collect.mockResolvedValue(monitorReport("CRITICAL"));
    const real = f.store.putAll.bind(f.store);
    vi.spyOn(f.store, "putAll").mockImplementationOnce(async (rows, intents) => {
      // The real write — including the KJ-P2.1 outbox intent — durably
      // completes BEFORE the simulated crash below. This is exactly the seam
      // KJ-P2.1 closes: intent persistence and delivery are decoupled, so a
      // crash here can no longer leave the notification permanently lost.
      await real(rows, intents);
      throw Error("lost commit acknowledgement / crash");
    });
    const crashed = await runMonitor(f.deps);
    expect(crashed.result).toBe("STATE_FAILED");
    expect(f.notifier.sent).toEqual([]); // delivery never got a chance to run this call
    expect((await f.outbox.getAll())).toHaveLength(2); // ...but both intents (P0 + P1) survived the crash

    const retry = await runMonitor(f.deps);
    expect(retry.notificationsQueued).toBe(0); // both episodes are already OPEN — correctly deduped, no new decisions
    expect(retry.delivery.delivered).toBe(2); // ...but the orphaned intents from the crashed run ARE delivered now
    expect(f.notifier.sent).toHaveLength(2);
    expect(f.notifier.sent.every((p) => p.kind === "NEW")).toBe(true);
    // Each episode counted once per run (crashed run's commit + this run's ONGOING bump), not twice.
    expect((await f.store.getAll()).map((r) => r.occurrenceCount)).toEqual([2, 2]);
  });
  it("retains the B1 gap at P3 without attempting notification", async () => {
    const f = fixture();
    const report = monitorReport();
    report.overall = "UNKNOWN";
    report.domains.legacyAuthority = {
      status: "UNKNOWN",
      checks: [
        {
          id: "legacyAuthority.b1FreezeObservable",
          status: "UNKNOWN",
          evidence: "known gap",
          message: "unavailable",
          checkedAt: report.checkedAt,
        },
      ],
    };
    f.collect.mockResolvedValue(report);
    const result = await runMonitor(f.deps);
    expect(result.decisionCounts.P3).toBe(1);
    expect(result.notificationsQueued).toBe(0);
    expect((await runMonitor(f.deps)).decisionCounts.P3).toBe(0);
  });
});

describe("monitor continuation and config", () => {
  it("defaults off with a five-minute proposal and forbids memory", () => {
    expect(loadMonitorConfig({})).toEqual({
      enabled: false,
      cadenceMs: 300000,
    });
    expect(() =>
      loadMonitorConfig({
        ALERT_RUNNER_ENABLED: "true",
        ALERT_STATE_STORE: "memory",
      }),
    ).toThrow();
  });
  it.each(["0", "59999", "86400001", "NaN", "1e5", "-1", "1.5"])(
    "rejects unsafe cadence %s",
    (value) => {
      expect(() =>
        loadMonitorConfig({ ALERT_RUNNER_CADENCE_MS: value }),
      ).toThrow();
    },
  );
  it("rejects ambiguous enabled flags", () => {
    expect(() => loadMonitorConfig({ ALERT_RUNNER_ENABLED: "yes" })).toThrow();
  });
  it("rejects duplicate/out-of-order wakes and keeps one chain", async () => {
    const f = fixture();
    let next = 0;
    const advance = vi.fn((n: number) => {
      next = n;
    });
    const run = vi.fn(() => runMonitor(f.deps));
    const ctx = { key: MONITOR_KEY, getNext: async () => next, run, advance };
    const cfg = { enabled: true, cadenceMs: 300000 };
    await monitorTick(ctx, { sequence: 0 }, cfg);
    expect((await monitorTick(ctx, { sequence: 0 }, cfg)).result).toBe(
      "DUPLICATE_OR_OUT_OF_ORDER",
    );
    expect((await monitorTick(ctx, { sequence: 9 }, cfg)).result).toBe(
      "DUPLICATE_OR_OUT_OF_ORDER",
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(advance).toHaveBeenCalledExactlyOnceWith(1, 300000);
  });
  it("rearms after a reported failure but not before a long run completes", async () => {
    const advance = vi.fn();
    let finish!: (r: Awaited<ReturnType<typeof runMonitor>>) => void;
    const promise = monitorTick(
      {
        key: MONITOR_KEY,
        getNext: async () => null,
        run: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
        advance,
      },
      { sequence: 0 },
      { enabled: true, cadenceMs: 300000 },
    );
    await Promise.resolve();
    expect(advance).not.toHaveBeenCalled();
    const f = fixture();
    f.collect.mockRejectedValue(Error("failed"));
    finish(await runMonitor(f.deps));
    await promise;
    expect(advance).toHaveBeenCalledExactlyOnceWith(1, 300000);
  });
  it("does no work when disabled and rejects noncanonical keys", async () => {
    const run = vi.fn();
    const advance = vi.fn();
    const ctx = { key: MONITOR_KEY, getNext: async () => 0, run, advance };
    expect(
      (
        await monitorTick(
          ctx,
          { sequence: 0 },
          { enabled: false, cadenceMs: 300000 },
        )
      ).result,
    ).toBe("DISABLED");
    await expect(
      monitorTick(
        { ...ctx, key: "other" },
        { sequence: 0 },
        { enabled: true, cadenceMs: 300000 },
      ),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();
  });
});
