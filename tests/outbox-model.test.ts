import { describe, it, expect } from "vitest";
import {
  computeBackoffMs,
  decideNextOutboxState,
  deriveNotificationId,
  intentsFromDecisions,
  recoverIfStaleSending,
} from "../services/kernel/src/alerting/outbox.js";
import { InMemoryNotificationOutboxStore } from "../services/kernel/src/alerting/outbox-store.js";
import { DEFAULT_DELIVERY_CONFIG } from "../services/kernel/src/alerting/outbox-types.js";
import type { AlertDecision } from "../services/kernel/src/alerting/types.js";
import type { DeliveryConfig, NotificationOutboxRow } from "../services/kernel/src/alerting/outbox-types.js";

/**
 * KJ-P2.1 deterministic tests — entirely synthetic, no Postgres, no Restate,
 * no Docker. Mirrors alerting-model.test.ts's split: this file exercises
 * outbox.ts's PURE core (identity derivation, intent extraction, the
 * delivery state machine) and InMemoryNotificationOutboxStore's own
 * contract; tests/alerting-model.test.ts covers the full engine ->
 * outbox -> delivery pipeline end to end.
 */

function mkDecision(overrides: Partial<AlertDecision> = {}): AlertDecision {
  return {
    kind: "NEW",
    severity: "P1",
    fingerprint: "fp-a",
    checkId: "scheduler.scheduleEnabled",
    entityId: "sched-1",
    message: "raw check message",
    notify: true,
    firstSeenAt: "2026-09-17T10:00:00.000Z",
    lastSeenAt: "2026-09-17T10:00:00.000Z",
    lastNotifiedAt: "2026-09-17T10:00:00.000Z",
    occurrenceCount: 1,
    ...overrides,
  };
}

function mkRow(overrides: Partial<NotificationOutboxRow> = {}): NotificationOutboxRow {
  return {
    notificationId: "nid-1",
    fingerprint: "fp-a",
    checkId: "scheduler.scheduleEnabled",
    entityId: "sched-1",
    firstSeenAt: "2026-09-17T10:00:00.000Z",
    lastSeenAt: "2026-09-17T10:00:00.000Z",
    kind: "NEW",
    occurrenceCount: 1,
    severity: "P1",
    message: "raw check message",
    durationMs: null,
    status: "PENDING",
    attemptCount: 0,
    createdAt: "2026-09-17T10:00:00.000Z",
    lastAttemptAt: null,
    nextAttemptAt: "2026-09-17T10:00:00.000Z",
    deliveredAt: null,
    lastError: null,
    ...overrides,
  };
}

describe("deriveNotificationId", () => {
  it("is stable for the same (fingerprint, firstSeenAt, kind, occurrenceCount)", () => {
    const a = deriveNotificationId("fp-a", "2026-09-17T10:00:00.000Z", "NEW", 1);
    const b = deriveNotificationId("fp-a", "2026-09-17T10:00:00.000Z", "NEW", 1);
    expect(a).toBe(b);
  });

  it("differs when any one field differs", () => {
    const base = deriveNotificationId("fp-a", "2026-09-17T10:00:00.000Z", "NEW", 1);
    expect(deriveNotificationId("fp-b", "2026-09-17T10:00:00.000Z", "NEW", 1)).not.toBe(base);
    expect(deriveNotificationId("fp-a", "2026-09-17T11:00:00.000Z", "NEW", 1)).not.toBe(base);
    expect(deriveNotificationId("fp-a", "2026-09-17T10:00:00.000Z", "ESCALATED", 1)).not.toBe(base);
    expect(deriveNotificationId("fp-a", "2026-09-17T10:00:00.000Z", "NEW", 2)).not.toBe(base);
  });

  it("a recurrence after recovery gets a DIFFERENT id from the original episode's NEW, even though fingerprint and occurrenceCount are both identical", () => {
    // Same fingerprint (same check/entity), same occurrenceCount (both reset
    // to 1), same kind (NEW) — only firstSeenAt differs, because reducer.ts
    // resets it on recurrence. This is exactly why firstSeenAt is part of
    // the identity, not just fingerprint+kind+occurrenceCount.
    const original = deriveNotificationId("fp-a", "2026-09-17T10:00:00.000Z", "NEW", 1);
    const recurrence = deriveNotificationId("fp-a", "2026-09-17T12:00:00.000Z", "NEW", 1);
    expect(recurrence).not.toBe(original);
  });
});

describe("intentsFromDecisions", () => {
  it("keeps only notify:true decisions and stamps createdAt with the injected now", () => {
    const decisions = [mkDecision({ notify: true }), mkDecision({ notify: false, fingerprint: "fp-b" })];
    const intents = intentsFromDecisions(decisions, "2026-09-17T10:05:00.000Z");
    expect(intents).toHaveLength(1);
    expect(intents[0]!.fingerprint).toBe("fp-a");
    expect(intents[0]!.createdAt).toBe("2026-09-17T10:05:00.000Z");
  });

  it("carries durationMs only for RECOVERED, null otherwise", () => {
    const [recovered] = intentsFromDecisions([mkDecision({ kind: "RECOVERED", durationMs: 12345 })], "2026-09-17T10:05:00.000Z");
    expect(recovered!.durationMs).toBe(12345);
    const [fresh] = intentsFromDecisions([mkDecision({ kind: "NEW" })], "2026-09-17T10:05:00.000Z");
    expect(fresh!.durationMs).toBeNull();
  });

  it("re-deriving intents from the identical decision twice produces the identical notificationId (replay-safe)", () => {
    const decision = mkDecision();
    const [first] = intentsFromDecisions([decision], "2026-09-17T10:05:00.000Z");
    const [second] = intentsFromDecisions([decision], "2026-09-17T10:07:00.000Z"); // even with a different `now`
    expect(second!.notificationId).toBe(first!.notificationId);
  });
});

describe("computeBackoffMs", () => {
  const cfg: DeliveryConfig = { baseDelayMs: 1000, maxDelayMs: 8000, maxAttempts: 10, staleSendingMs: 60000 };
  it("doubles from the base delay and is capped", () => {
    expect(computeBackoffMs(1, cfg)).toBe(1000);
    expect(computeBackoffMs(2, cfg)).toBe(2000);
    expect(computeBackoffMs(3, cfg)).toBe(4000);
    expect(computeBackoffMs(4, cfg)).toBe(8000); // would be 8000 uncapped too
    expect(computeBackoffMs(5, cfg)).toBe(8000); // would be 16000 uncapped — capped
    expect(computeBackoffMs(50, cfg)).toBe(8000); // never exceeds the cap, however large attemptCount gets
  });
});

describe("decideNextOutboxState", () => {
  const cfg: DeliveryConfig = DEFAULT_DELIVERY_CONFIG;

  it("a successful attempt marks DELIVERED with deliveredAt set and clears lastError", () => {
    const row = mkRow({ attemptCount: 1, status: "SENDING", lastError: "PriorError" });
    const { row: next, eventOutcome, errorClass } = decideNextOutboxState(row, { ok: true }, "2026-09-17T10:01:00.000Z", cfg);
    expect(next.status).toBe("DELIVERED");
    expect(next.deliveredAt).toBe("2026-09-17T10:01:00.000Z");
    expect(next.lastError).toBeNull();
    expect(eventOutcome).toBe("DELIVERED");
    expect(errorClass).toBeNull();
  });

  it("a transient failure with attempts remaining goes back to PENDING with a bounded-backoff nextAttemptAt", () => {
    const row = mkRow({ attemptCount: 1, status: "SENDING" });
    const { row: next, eventOutcome } = decideNextOutboxState(
      row,
      { ok: false, permanent: false, errorClass: "TimeoutError" },
      "2026-09-17T10:01:00.000Z",
      { ...cfg, baseDelayMs: 5000, maxDelayMs: 300000 },
    );
    expect(next.status).toBe("PENDING");
    expect(next.nextAttemptAt).toBe(new Date(Date.parse("2026-09-17T10:01:00.000Z") + 5000).toISOString());
    expect(next.lastError).toBe("TimeoutError");
    expect(eventOutcome).toBe("TRANSIENT_FAILURE");
  });

  it("exhausting maxAttempts on a transient failure goes to POISON, event outcome still records TRANSIENT_FAILURE (that IS what happened on this attempt)", () => {
    const row = mkRow({ attemptCount: 3, status: "SENDING" });
    const { row: next, eventOutcome } = decideNextOutboxState(
      row,
      { ok: false, permanent: false, errorClass: "TimeoutError" },
      "2026-09-17T10:01:00.000Z",
      { ...cfg, maxAttempts: 3 },
    );
    expect(next.status).toBe("POISON");
    expect(eventOutcome).toBe("TRANSIENT_FAILURE");
  });

  it("a permanent failure goes straight to POISON regardless of remaining attempt budget", () => {
    const row = mkRow({ attemptCount: 1, status: "SENDING" });
    const { row: next, eventOutcome, errorClass } = decideNextOutboxState(
      row,
      { ok: false, permanent: true, errorClass: "PermanentDeliveryError" },
      "2026-09-17T10:01:00.000Z",
      { ...cfg, maxAttempts: 100 },
    );
    expect(next.status).toBe("POISON");
    expect(eventOutcome).toBe("PERMANENT_FAILURE");
    expect(errorClass).toBe("PermanentDeliveryError");
  });
});

describe("recoverIfStaleSending", () => {
  const cfg: DeliveryConfig = { ...DEFAULT_DELIVERY_CONFIG, staleSendingMs: 120000 };

  it("returns null for a row that isn't SENDING", () => {
    const row = mkRow({ status: "PENDING" });
    expect(recoverIfStaleSending(row, "2026-09-17T10:10:00.000Z", cfg)).toBeNull();
  });

  it("returns null for a SENDING row still within the in-flight window (a live attempt, not abandoned)", () => {
    const row = mkRow({ status: "SENDING", lastAttemptAt: "2026-09-17T10:00:00.000Z" });
    expect(recoverIfStaleSending(row, "2026-09-17T10:01:00.000Z", cfg)).toBeNull(); // 60s < 120s threshold
  });

  it("recovers a SENDING row past the stale threshold back to PENDING, due immediately, logging AMBIGUOUS_RECOVERED", () => {
    const row = mkRow({ status: "SENDING", attemptCount: 1, lastAttemptAt: "2026-09-17T10:00:00.000Z" });
    const decision = recoverIfStaleSending(row, "2026-09-17T10:02:01.000Z", cfg); // 121s >= 120s threshold
    expect(decision).not.toBeNull();
    expect(decision!.row.status).toBe("PENDING");
    expect(decision!.row.nextAttemptAt).toBe("2026-09-17T10:02:01.000Z"); // retry immediately, not after another backoff
    expect(decision!.row.attemptCount).toBe(1); // the original attempt already counted; recovery doesn't double-count
    expect(decision!.eventOutcome).toBe("AMBIGUOUS_RECOVERED");
  });
});

describe("InMemoryNotificationOutboxStore", () => {
  it("enqueue is idempotent by notificationId — a replayed intent never creates a second row", async () => {
    const outbox = new InMemoryNotificationOutboxStore();
    const intent = { ...mkRow(), notificationId: "dup-1" };
    await outbox.enqueue([intent]);
    await outbox.enqueue([intent]); // simulates a Restate ctx.run retry / manual re-run
    expect(await outbox.getAll()).toHaveLength(1);
  });

  it("listDue only returns PENDING rows whose nextAttemptAt (== createdAt, at enqueue time) has arrived, oldest first", async () => {
    const outbox = new InMemoryNotificationOutboxStore();
    // enqueue always normalizes nextAttemptAt to createdAt for a fresh
    // intent — a real intent never arrives with a custom due time — so
    // controlling createdAt is exactly how this test controls when each row
    // becomes due.
    await outbox.enqueue([
      { ...mkRow(), notificationId: "future", createdAt: "2026-09-17T11:00:00.000Z" },
      { ...mkRow(), notificationId: "due-later", createdAt: "2026-09-17T10:05:00.000Z" },
      { ...mkRow(), notificationId: "due-first", createdAt: "2026-09-17T10:01:00.000Z" },
    ]);
    const due = await outbox.listDue("2026-09-17T10:10:00.000Z", 10);
    expect(due.map((r) => r.notificationId)).toEqual(["due-first", "due-later"]);
  });

  it("markSending only claims an eligible PENDING-and-due row, incrementing attemptCount, and refuses a row already SENDING", async () => {
    const outbox = new InMemoryNotificationOutboxStore();
    await outbox.enqueue([{ ...mkRow(), notificationId: "n1", createdAt: "2026-09-17T10:00:00.000Z" }]);
    const claimed = await outbox.markSending("n1", "2026-09-17T10:01:00.000Z");
    expect(claimed?.status).toBe("SENDING");
    expect(claimed?.attemptCount).toBe(1);
    const second = await outbox.markSending("n1", "2026-09-17T10:02:00.000Z");
    expect(second).toBeNull(); // already SENDING — a second claimant (or a re-run) must not double-claim
    expect(await outbox.markSending("does-not-exist", "2026-09-17T10:02:00.000Z")).toBeNull();
  });

  it("applyOutcome persists the row and logs one event per attempt", async () => {
    const outbox = new InMemoryNotificationOutboxStore();
    const row = mkRow({ notificationId: "n2", status: "DELIVERED", deliveredAt: "2026-09-17T10:01:00.000Z" });
    await outbox.applyOutcome(row, "DELIVERED", null, 1, "2026-09-17T10:01:00.000Z", "console");
    expect((await outbox.getAll())[0]?.status).toBe("DELIVERED");
    expect(outbox.events).toEqual([
      { notificationId: "n2", attemptNumber: 1, attemptedAt: "2026-09-17T10:01:00.000Z", outcome: "DELIVERED", errorClass: null, transport: "console" },
    ]);
  });

  it("listStaleSending finds only SENDING rows past the threshold, leaving fresh SENDING and non-SENDING rows alone", async () => {
    const outbox = new InMemoryNotificationOutboxStore();
    const dueAt = "2026-09-17T08:00:00.000Z"; // all three due well before any markSending call below
    await outbox.enqueue([
      { ...mkRow(), notificationId: "stale", createdAt: dueAt },
      { ...mkRow(), notificationId: "fresh", createdAt: dueAt },
      { ...mkRow(), notificationId: "pending", createdAt: dueAt },
    ]);
    await outbox.markSending("stale", "2026-09-17T09:00:00.000Z"); // 2h before the check below
    await outbox.markSending("fresh", "2026-09-17T10:59:00.000Z"); // 1 minute before the check below
    // "pending" is left PENDING (never claimed).
    const stale = await outbox.listStaleSending("2026-09-17T11:00:00.000Z", 120000); // 2-minute threshold
    expect(stale.map((r) => r.notificationId)).toEqual(["stale"]);
  });
});
