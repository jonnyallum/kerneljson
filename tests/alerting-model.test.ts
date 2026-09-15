import { describe, it, expect } from "vitest";
import { reduceCheck, reduceChecks } from "../services/kernel/src/alerting/reducer.js";
import { fingerprintFor, resolveEntityId } from "../services/kernel/src/alerting/fingerprint.js";
import { resolvePolicy } from "../services/kernel/src/alerting/policy.js";
import { runAlertEngine } from "../services/kernel/src/alerting/engine.js";
import { InMemoryAlertStateStore } from "../services/kernel/src/alerting/state-store.js";
import { RecordingNotifier } from "../services/kernel/src/alerting/notifier.js";
import type { CheckResult, DomainResult, HealthReport } from "../services/kernel/src/health/types.js";

/**
 * KJ-P1.2 deterministic tests. Entirely synthetic CheckResults and state rows —
 * no Postgres, no Restate, no Docker — mirroring the P1.1 collect/evaluate split:
 * `reducer.ts` is pure, so every episode-lifecycle rule is exhaustively testable
 * with plain data.
 */

const SCHEDULE_ID = "acab9ebc-dc92-5c3a-90d6-4d6f9ddb0a1b";

function mkCheck(id: string, status: CheckResult["status"], overrides?: Partial<CheckResult>): CheckResult {
  return {
    id,
    status,
    evidence: "test",
    message: `${id} is ${status}`,
    checkedAt: "2026-09-16T10:00:00.000Z",
    ...overrides,
  };
}

describe("fingerprint", () => {
  it("is stable for the same (checkId, entityId), regardless of severity or observed value", () => {
    const a = fingerprintFor("scheduler.noDuplicateFireWindow", SCHEDULE_ID);
    const b = fingerprintFor("scheduler.noDuplicateFireWindow", SCHEDULE_ID);
    expect(a).toBe(b);
  });

  it("differs for a different check id or a different entity", () => {
    const base = fingerprintFor("scheduler.noDuplicateFireWindow", SCHEDULE_ID);
    expect(fingerprintFor("scheduler.noZeroDelayLoop", SCHEDULE_ID)).not.toBe(base);
    expect(fingerprintFor("scheduler.noDuplicateFireWindow", "some-other-schedule")).not.toBe(base);
  });

  it("resolveEntityId is deterministic for the same inputs", () => {
    expect(resolveEntityId("scheduler.scheduleEnabled", SCHEDULE_ID)).toBe(
      resolveEntityId("scheduler.scheduleEnabled", SCHEDULE_ID),
    );
  });
});

describe("no alert for fully healthy checks", () => {
  it("a HEALTHY check with no prior state produces no row and no decision", () => {
    const { nextRow, decision } = reduceCheck(null, mkCheck("scheduler.scheduleEnabled", "HEALTHY"), SCHEDULE_ID, "2026-09-16T10:00:00Z");
    expect(nextRow).toBeNull();
    expect(decision).toBeNull();
  });
});

describe("first P0/P1 failure alerts immediately", () => {
  it("scheduler.noDuplicateFireWindow CRITICAL (policy: P0) is a NEW, notify:true decision on first sight", () => {
    const { nextRow, decision } = reduceCheck(
      null,
      mkCheck("scheduler.noDuplicateFireWindow", "CRITICAL"),
      SCHEDULE_ID,
      "2026-09-16T10:03:00Z",
    );
    expect(decision).not.toBeNull();
    expect(decision!.kind).toBe("NEW");
    expect(decision!.severity).toBe("P0");
    expect(decision!.notify).toBe(true);
    expect(nextRow!.currentState).toBe("OPEN");
    expect(nextRow!.occurrenceCount).toBe(1);
  });

  it("scheduler.nextWakeArmedAndFuture CRITICAL (policy: P1) is a NEW, notify:true decision on first sight", () => {
    const { decision } = reduceCheck(
      null,
      mkCheck("scheduler.nextWakeArmedAndFuture", "CRITICAL"),
      SCHEDULE_ID,
      "2026-09-16T10:03:00Z",
    );
    expect(decision!.severity).toBe("P1");
    expect(decision!.kind).toBe("NEW");
    expect(decision!.notify).toBe(true);
  });
});

describe("repeated identical failure deduplicates", () => {
  it("the same CRITICAL check on a second run does not notify again", () => {
    const check = mkCheck("scheduler.noDuplicateFireWindow", "CRITICAL");
    const first = reduceCheck(null, check, SCHEDULE_ID, "2026-09-16T10:03:00Z");
    const second = reduceCheck(first.nextRow, check, SCHEDULE_ID, "2026-09-16T10:04:00Z");
    expect(second.decision).toBeNull(); // dedup: no decision handed to a notifier
    expect(second.nextRow!.occurrenceCount).toBe(2);
    expect(second.nextRow!.lastNotifiedAt).toBe(first.nextRow!.lastNotifiedAt); // unchanged
    const third = reduceCheck(second.nextRow, check, SCHEDULE_ID, "2026-09-16T10:08:00Z");
    expect(third.decision).toBeNull();
    expect(third.nextRow!.occurrenceCount).toBe(3);
    expect(third.nextRow!.lastSeenAt).toBe("2026-09-16T10:08:00Z");
  });
});

describe("worsening severity re-alerts", () => {
  it("P2 -> P1 on the same check re-notifies as ESCALATED", () => {
    const opened = reduceCheck(null, mkCheck("scheduler.nextWakeArmedAndFuture", "DEGRADED"), SCHEDULE_ID, "2026-09-16T10:00:00Z");
    expect(opened.decision!.severity).toBe("P2");
    const worsened = reduceCheck(opened.nextRow, mkCheck("scheduler.nextWakeArmedAndFuture", "CRITICAL"), SCHEDULE_ID, "2026-09-16T10:05:00Z");
    expect(worsened.decision).not.toBeNull();
    expect(worsened.decision!.kind).toBe("ESCALATED");
    expect(worsened.decision!.severity).toBe("P1");
    expect(worsened.decision!.notify).toBe(true);
    expect(worsened.nextRow!.severity).toBe("P1");
  });

  it("P1 -> P2 (improves but still unhealthy) is DEESCALATED, still notified, still OPEN", () => {
    const opened = reduceCheck(null, mkCheck("scheduler.nextWakeArmedAndFuture", "CRITICAL"), SCHEDULE_ID, "2026-09-16T10:00:00Z");
    const improved = reduceCheck(opened.nextRow, mkCheck("scheduler.nextWakeArmedAndFuture", "DEGRADED"), SCHEDULE_ID, "2026-09-16T10:05:00Z");
    expect(improved.decision!.kind).toBe("DEESCALATED");
    expect(improved.decision!.severity).toBe("P2");
    expect(improved.nextRow!.currentState).toBe("OPEN");
  });
});

describe("recovery emits one recovery", () => {
  it("OPEN -> HEALTHY produces exactly one RECOVERED decision with a duration", () => {
    const opened = reduceCheck(null, mkCheck("scheduler.noDuplicateFireWindow", "CRITICAL"), SCHEDULE_ID, "2026-09-16T10:00:00Z");
    const recovered = reduceCheck(opened.nextRow, mkCheck("scheduler.noDuplicateFireWindow", "HEALTHY"), SCHEDULE_ID, "2026-09-16T10:09:14Z");
    expect(recovered.decision!.kind).toBe("RECOVERED");
    expect(recovered.decision!.notify).toBe(true);
    expect(recovered.decision!.durationMs).toBe(Date.parse("2026-09-16T10:09:14Z") - Date.parse("2026-09-16T10:00:00Z"));
    expect(recovered.nextRow!.currentState).toBe("RECOVERED");
  });
});

describe("repeated healthy state does not spam recovery", () => {
  it("a second consecutive HEALTHY run after recovery produces no further decision", () => {
    const opened = reduceCheck(null, mkCheck("scheduler.noDuplicateFireWindow", "CRITICAL"), SCHEDULE_ID, "2026-09-16T10:00:00Z");
    const recovered = reduceCheck(opened.nextRow, mkCheck("scheduler.noDuplicateFireWindow", "HEALTHY"), SCHEDULE_ID, "2026-09-16T10:09:14Z");
    const stillHealthy = reduceCheck(recovered.nextRow, mkCheck("scheduler.noDuplicateFireWindow", "HEALTHY"), SCHEDULE_ID, "2026-09-16T10:10:00Z");
    expect(stillHealthy.decision).toBeNull();
    expect(stillHealthy.nextRow!.currentState).toBe("RECOVERED");
  });
});

describe("recurrence after recovery alerts again", () => {
  it("a fresh failure after recovery opens a NEW episode (reset firstSeenAt/occurrenceCount) and notifies", () => {
    const opened = reduceCheck(null, mkCheck("scheduler.noDuplicateFireWindow", "CRITICAL"), SCHEDULE_ID, "2026-09-16T10:00:00Z");
    const recovered = reduceCheck(opened.nextRow, mkCheck("scheduler.noDuplicateFireWindow", "HEALTHY"), SCHEDULE_ID, "2026-09-16T10:09:00Z");
    const recurred = reduceCheck(recovered.nextRow, mkCheck("scheduler.noDuplicateFireWindow", "CRITICAL"), SCHEDULE_ID, "2026-09-16T11:00:00Z");
    expect(recurred.decision!.kind).toBe("NEW");
    expect(recurred.decision!.notify).toBe(true);
    expect(recurred.nextRow!.currentState).toBe("OPEN");
    expect(recurred.nextRow!.firstSeenAt).toBe("2026-09-16T11:00:00Z"); // reset, not the original 10:00
    expect(recurred.nextRow!.occurrenceCount).toBe(1); // reset, not carried over
  });
});

describe("known permanent UNKNOWN like B1 observability does not page repeatedly", () => {
  it("legacyAuthority.b1FreezeObservable UNKNOWN never notifies, first time or on repeat, but is still tracked", () => {
    const check = mkCheck("legacyAuthority.b1FreezeObservable", "UNKNOWN");
    const first = reduceCheck(null, check, SCHEDULE_ID, "2026-09-16T10:00:00Z");
    expect(first.decision).not.toBeNull(); // still tracked as a decision object...
    expect(first.decision!.notify).toBe(false); // ...but the policy forbids notifying
    expect(first.nextRow!.currentState).toBe("OPEN");
    const second = reduceCheck(first.nextRow, check, SCHEDULE_ID, "2026-09-16T10:30:00Z");
    expect(second.decision).toBeNull(); // dedup as usual — unchanged severity, ONGOING
    const third = reduceCheck(second.nextRow, check, SCHEDULE_ID, "2026-09-17T10:30:00Z");
    expect(third.decision).toBeNull();
    expect(third.nextRow!.occurrenceCount).toBe(3);
  });

  it("resolvePolicy confirms notify:false is an explicit policy decision for this check, not an accident", () => {
    const policy = resolvePolicy("legacyAuthority.b1FreezeObservable");
    expect(policy.notify).toBe(false);
    expect(policy.severityFor("UNKNOWN")).toBe("P3");
  });
});

describe("reduceChecks batches multiple checks against a lookup of existing rows", () => {
  it("returns one decision per newly-failing check and leaves healthy ones untouched", () => {
    const existing = new Map<string, never>();
    const { nextRows, decisions } = reduceChecks(
      [mkCheck("scheduler.scheduleEnabled", "HEALTHY"), mkCheck("database.reachable", "CRITICAL")],
      existing,
      SCHEDULE_ID,
      "2026-09-16T10:00:00Z",
    );
    expect(nextRows).toHaveLength(1);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.checkId).toBe("database.reachable");
    expect(decisions[0]!.severity).toBe("P1");
  });
});

describe("alert fingerprint is stable across many reduce calls", () => {
  it("the same fingerprint persists across an open -> escalate -> recover -> recur cycle", () => {
    const check = mkCheck("scheduler.nextWakeArmedAndFuture", "CRITICAL");
    const opened = reduceCheck(null, check, SCHEDULE_ID, "2026-09-16T10:00:00Z");
    const fp = opened.nextRow!.fingerprint;
    const escalated = reduceCheck(opened.nextRow, mkCheck("scheduler.nextWakeArmedAndFuture", "CRITICAL"), SCHEDULE_ID, "2026-09-16T10:05:00Z");
    expect(escalated.nextRow!.fingerprint).toBe(fp);
    const recovered = reduceCheck(escalated.nextRow, mkCheck("scheduler.nextWakeArmedAndFuture", "HEALTHY"), SCHEDULE_ID, "2026-09-16T10:10:00Z");
    expect(recovered.nextRow!.fingerprint).toBe(fp);
    const recurred = reduceCheck(recovered.nextRow, check, SCHEDULE_ID, "2026-09-16T11:00:00Z");
    expect(recurred.nextRow!.fingerprint).toBe(fp);
  });
});

describe("reduceChecks / runAlertEngine end-to-end", () => {
  function mkReport(overrides: Partial<Record<string, CheckResult["status"]>>): HealthReport {
    const checks: CheckResult[] = Object.entries(overrides).map(([id, status]) => mkCheck(id, status!));
    const populated: DomainResult = { status: "HEALTHY", checks };
    const empty: DomainResult = { status: "HEALTHY", checks: [] };
    return {
      overall: "HEALTHY",
      checkedAt: "2026-09-16T10:00:00.000Z",
      release: "abc123",
      domains: {
        authority: empty,
        admission: empty,
        scheduler: populated,
        execution: empty,
        restate: empty,
        database: empty,
        evidence: empty,
        releaseParity: empty,
        productionConfig: empty,
        legacyAuthority: empty,
      },
      criticalIssues: 0,
      degradedIssues: 0,
      unknownChecks: 0,
      lastFireAtUtc: null,
      nextWakeAtUtc: null,
    };
  }

  it("a fully healthy report produces zero decisions and writes zero rows", async () => {
    const report = mkReport({ "scheduler.scheduleEnabled": "HEALTHY" });
    const store = new InMemoryAlertStateStore();
    const notifier = new RecordingNotifier();
    const { decisions } = await runAlertEngine(report, { store, notifier, canonicalScheduleId: SCHEDULE_ID });
    expect(decisions).toHaveLength(0);
    expect(notifier.sent).toHaveLength(0);
    expect(await store.getAll()).toHaveLength(0);
  });

  it("runs across two engine invocations dedupe correctly via the persisted store", async () => {
    const store = new InMemoryAlertStateStore();
    const notifier = new RecordingNotifier();
    const failing = mkReport({ "scheduler.noDuplicateFireWindow": "CRITICAL" });
    await runAlertEngine(failing, { store, notifier, canonicalScheduleId: SCHEDULE_ID, now: () => new Date("2026-09-16T10:00:00Z") });
    await runAlertEngine(failing, { store, notifier, canonicalScheduleId: SCHEDULE_ID, now: () => new Date("2026-09-16T10:05:00Z") });
    expect(notifier.sent).toHaveLength(1); // only the first run notified
    expect(notifier.sent[0]!.kind).toBe("NEW");
    const rows = await store.getAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrenceCount).toBe(2);
  });

  it("recovering across engine invocations emits exactly one RECOVERED via the notifier", async () => {
    const store = new InMemoryAlertStateStore();
    const notifier = new RecordingNotifier();
    const failing = mkReport({ "scheduler.noDuplicateFireWindow": "CRITICAL" });
    const healthy = mkReport({ "scheduler.noDuplicateFireWindow": "HEALTHY" });
    await runAlertEngine(failing, { store, notifier, canonicalScheduleId: SCHEDULE_ID, now: () => new Date("2026-09-16T10:00:00Z") });
    await runAlertEngine(healthy, { store, notifier, canonicalScheduleId: SCHEDULE_ID, now: () => new Date("2026-09-16T10:09:14Z") });
    await runAlertEngine(healthy, { store, notifier, canonicalScheduleId: SCHEDULE_ID, now: () => new Date("2026-09-16T10:15:00Z") });
    const kinds = notifier.sent.map((d) => d.kind);
    expect(kinds).toEqual(["NEW", "RECOVERED"]); // the second healthy run adds nothing
  });

  it("mirrors the P1.2 finish-line scenario: P1 scheduler wake alert, then RECOVERED with duration", async () => {
    const store = new InMemoryAlertStateStore();
    const notifier = new RecordingNotifier();
    const failing = mkReport({ "scheduler.nextWakeArmedAndFuture": "CRITICAL" });
    const healthy = mkReport({ "scheduler.nextWakeArmedAndFuture": "HEALTHY" });
    await runAlertEngine(failing, { store, notifier, canonicalScheduleId: SCHEDULE_ID, now: () => new Date("2026-09-16T10:03:00Z") });
    await runAlertEngine(failing, { store, notifier, canonicalScheduleId: SCHEDULE_ID, now: () => new Date("2026-09-16T10:08:00Z") });
    await runAlertEngine(healthy, { store, notifier, canonicalScheduleId: SCHEDULE_ID, now: () => new Date("2026-09-16T10:17:14Z") });

    expect(notifier.sent).toHaveLength(2);
    const [firstAlert, recoveredAlert] = notifier.sent;
    expect(firstAlert!.severity).toBe("P1");
    expect(firstAlert!.firstSeenAt).toBe("2026-09-16T10:03:00.000Z");
    expect(recoveredAlert!.kind).toBe("RECOVERED");
    expect(recoveredAlert!.durationMs).toBe(Date.parse("2026-09-16T10:17:14Z") - Date.parse("2026-09-16T10:03:00Z"));

    const rows = await store.getAll();
    expect(rows[0]!.occurrenceCount).toBe(2); // 10:03 + 10:08, before recovery
  });
});
