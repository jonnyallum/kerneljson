import { describe, expect, it } from "vitest";
import { deliverRows, runDeliveryWorker } from "../services/kernel/src/alerting/delivery-worker.js";
import { escapeTelegramMarkdownV2, formatTelegramMessage } from "../services/kernel/src/alerting/format.js";
import { RecordingNotifier } from "../services/kernel/src/alerting/notifier.js";
import { isOperatorReplyCheckId, operatorReplyCheckId } from "../services/kernel/src/alerting/operator-reply.js";
import { InMemoryNotificationOutboxStore } from "../services/kernel/src/alerting/outbox-store.js";
import type { NotificationIntent, Notifier } from "../services/kernel/src/alerting/outbox-types.js";
import { enqueueReply, replyDecision } from "../services/kernel/src/channel/telegram/reply-outbox.js";
import { renderReply, type ReplyInput } from "../services/kernel/src/channel/telegram/replies.js";
import { DATE, STATUS } from "./support/telegram-fixture.js";

const T0 = new Date("2026-09-20T12:00:00.000Z");
const at = (seconds: number) => () => new Date(T0.getTime() + seconds * 1000);
const usage = () => renderReply({ kind: "USAGE" });

/** A row that looks like any other alert: it must keep getting the redacted summary. */
function alertIntent(checkId: string, message: string): NotificationIntent {
  return {
    notificationId: `n-${checkId}`,
    fingerprint: "f".repeat(32),
    checkId,
    entityId: "e",
    firstSeenAt: T0.toISOString(),
    lastSeenAt: T0.toISOString(),
    kind: "NEW",
    occurrenceCount: 1,
    severity: "P2",
    message,
    durationMs: null,
    createdAt: T0.toISOString(),
  };
}

describe("KJ-P4A operator replies keep their text; every other row keeps the redacted summary", () => {
  it("an operator reply reaches the transport as written", async () => {
    const outbox = new InMemoryNotificationOutboxStore();
    const notifier = new RecordingNotifier();
    await enqueueReply(outbox, 100, usage(), DATE);
    const summary = await runDeliveryWorker({ outbox, notifier, transport: "telegram", now: at(1) });
    expect(summary).toMatchObject({ delivered: 1, result: "OK" });
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]!.message).toBe(usage());
    expect(notifier.sent[0]!.checkId).toBe("OPERATOR.reply.100");
  });

  it("negative control: an ordinary alert whose message carries a URL still reaches the transport as the synthetic summary", async () => {
    const outbox = new InMemoryNotificationOutboxStore();
    const notifier = new RecordingNotifier();
    await outbox.enqueue([alertIntent("execution.workerHealthy", "GET https://api.example.com/?token=SECRETVALUE failed")]);
    await runDeliveryWorker({ outbox, notifier, transport: "telegram", now: at(1) });
    expect(notifier.sent[0]!.message).toBe("execution.workerHealthy: NEW (P2)");
    expect(JSON.stringify(notifier.sent)).not.toContain("SECRETVALUE");
  });

  it("negative control: look-alike check ids do not earn the exception", async () => {
    const lookalikes = [
      "OPERATOR.reply.abc", "OPERATOR.reply.", "OPERATOR.reply.1.extra", "operator.reply.1", "XOPERATOR.reply.1",
      `OPERATOR.reply.${"1".repeat(21)}`, "OPERATOR.reply.1\nMISSION.x", "MISSION.repoAnalysis.d10442d5.completed", " OPERATOR.reply.1",
    ];
    for (const id of lookalikes) expect(isOperatorReplyCheckId(id), JSON.stringify(id)).toBe(false);
    expect(isOperatorReplyCheckId("OPERATOR.reply.1")).toBe(true);
    expect(isOperatorReplyCheckId(operatorReplyCheckId(123456789))).toBe(true);

    const outbox = new InMemoryNotificationOutboxStore();
    const notifier = new RecordingNotifier();
    await outbox.enqueue(lookalikes.filter((id) => !id.includes("\n")).map((id, i) => ({ ...alertIntent(id, "HOSTILE TEXT"), notificationId: `x-${i}`, fingerprint: String(i).repeat(32).slice(0, 32) })));
    await runDeliveryWorker({ outbox, notifier, transport: "telegram", now: at(1), limit: 50 });
    expect(notifier.sent.length).toBeGreaterThan(0);
    expect(JSON.stringify(notifier.sent)).not.toContain("HOSTILE TEXT");
  });

  it("formats an operator reply as plain escaped text, and an alert exactly as before", () => {
    const reply = replyDecision(7, usage(), DATE);
    const payload = { ...alertIntent(reply.checkId, reply.message), notificationId: "abcdef0123456789" };
    const text = formatTelegramMessage(payload);
    expect(text).toBe(escapeTelegramMarkdownV2(usage()));
    expect(text).not.toMatch(/Occurrences|ID:|At:/);
    const alert = formatTelegramMessage(alertIntent("execution.workerHealthy", "synthetic"));
    expect(alert).toMatch(/Occurrences: 1/);
    expect(alert).toMatch(/ID:/);
  });

  it("every reply survives MarkdownV2 escaping intact, so Telegram never rejects one for a stray character", () => {
    const inputs: ReplyInput[] = [
      { kind: "USAGE" },
      { kind: "RATE_LIMITED", perMinute: 10 },
      { kind: "CAP_EXCEEDED", used: 5, cap: 5 },
      { kind: "ADMITTED", command: "REVIEW", repo: "jonnyallum/kerneljson", findings: 3, taskId: "d10442d5-f208-859d-af74-c4d16a9d379f", used: 1, cap: 5 },
      { kind: "ADMISSION_FAILED", reason: "UNAVAILABLE" },
      { kind: "STATUS", status: STATUS, missionsToday: 1, cap: 5, asOf: "2026-09-20T12:00:00.000Z" },
      { kind: "TASK_NOT_FOUND", taskId: "d10442d5-f208-859d-af74-c4d16a9d379f" },
      { kind: "TASK_UNAVAILABLE" },
    ];
    for (const input of inputs) {
      const text = renderReply(input);
      const escaped = escapeTelegramMarkdownV2(text);
      // Every MarkdownV2-special character is backslash-escaped, and un-escaping gives the text back.
      expect(escaped.replace(/\\([\s\S])/g, "$1"), input.kind).toBe(text);
      expect(escaped.replace(/\\[\s\S]/g, "")).not.toMatch(/[_*[\]()~`>#+\-=|{}.!]/);
    }
  });
});

describe("KJ-P4A a reply is enqueued exactly once per update", () => {
  it("derives its identity from the update alone: a replay enqueues nothing new", async () => {
    const outbox = new InMemoryNotificationOutboxStore();
    const a = await enqueueReply(outbox, 55, usage(), DATE);
    const b = await enqueueReply(outbox, 55, usage(), DATE);
    expect(a.notificationId).toBe(b.notificationId);
    expect(await outbox.getAll()).toHaveLength(1);
    const c = await enqueueReply(outbox, 56, usage(), DATE);
    expect(c.notificationId).not.toBe(a.notificationId);
    expect(await outbox.getAll()).toHaveLength(2);
  });

  it("uses Telegram's own message date, never the processing time, as its timestamp", () => {
    const d = replyDecision(1, usage(), 1_700_000_000);
    expect(d.firstSeenAt).toBe("2023-11-14T22:13:20.000Z");
    expect(replyDecision(1, usage(), 1_700_000_000)).toEqual(d);
  });
});

describe("KJ-P4A deliver-now path (no wait for the monitor's tick)", () => {
  const failing: Notifier = { notify: async () => { throw new Error("telegram down"); } };

  it("delivers exactly the rows it is given", async () => {
    const outbox = new InMemoryNotificationOutboxStore();
    const notifier = new RecordingNotifier();
    const a = await enqueueReply(outbox, 1, usage(), DATE);
    await enqueueReply(outbox, 2, usage(), DATE);
    const s = await deliverRows({ outbox, notifier, transport: "telegram", now: at(1) }, [a.notificationId]);
    expect(s).toMatchObject({ attempted: 1, delivered: 1, result: "OK" });
    expect(notifier.sent.map((p) => p.checkId)).toEqual(["OPERATOR.reply.1"]);
    const rows = await outbox.getAll();
    expect(rows.find((r) => r.checkId === "OPERATOR.reply.2")!.status).toBe("PENDING");
  });

  it("never sends a row the monitor already claimed, and never sends a delivered one again", async () => {
    const outbox = new InMemoryNotificationOutboxStore();
    const notifier = new RecordingNotifier();
    const a = await enqueueReply(outbox, 1, usage(), DATE);
    await outbox.markSending(a.notificationId, at(0)().toISOString()); // the monitor got there first
    expect((await deliverRows({ outbox, notifier, transport: "telegram", now: at(1) }, [a.notificationId])).attempted).toBe(0);
    expect(notifier.sent).toHaveLength(0);

    const b = await enqueueReply(outbox, 2, usage(), DATE);
    await deliverRows({ outbox, notifier, transport: "telegram", now: at(1) }, [b.notificationId]);
    await deliverRows({ outbox, notifier, transport: "telegram", now: at(2) }, [b.notificationId]);
    expect(notifier.sent).toHaveLength(1);
  });

  it("two concurrent callers send a reply once", async () => {
    const outbox = new InMemoryNotificationOutboxStore();
    const notifier = new RecordingNotifier();
    const a = await enqueueReply(outbox, 1, usage(), DATE);
    await Promise.all([
      deliverRows({ outbox, notifier, transport: "telegram", now: at(1) }, [a.notificationId]),
      deliverRows({ outbox, notifier, transport: "telegram", now: at(1) }, [a.notificationId]),
    ]);
    expect(notifier.sent).toHaveLength(1);
  });

  it("a failed send stays PENDING on the outbox's own backoff, and a later call delivers it", async () => {
    const outbox = new InMemoryNotificationOutboxStore();
    const a = await enqueueReply(outbox, 1, usage(), DATE);
    const s = await deliverRows({ outbox, notifier: failing, transport: "telegram", now: at(1) }, [a.notificationId]);
    expect(s).toMatchObject({ attempted: 1, retried: 1, delivered: 0 });
    const [row] = await outbox.getAll();
    expect(row!.status).toBe("PENDING");
    expect(row!.lastError).toBe("Error");
    expect(row!.lastError).not.toMatch(/telegram down/);
    // Not yet due: nothing happens. Once due, it is delivered.
    const notifier = new RecordingNotifier();
    expect((await deliverRows({ outbox, notifier, transport: "telegram", now: at(2) }, [a.notificationId])).attempted).toBe(0);
    expect((await deliverRows({ outbox, notifier, transport: "telegram", now: at(600) }, [a.notificationId])).delivered).toBe(1);
  });

  it("does NOT recover stale SENDING rows: that stays the monitor's job, under its exclusive lock", async () => {
    const outbox = new InMemoryNotificationOutboxStore();
    const notifier = new RecordingNotifier();
    const stale = await enqueueReply(outbox, 1, usage(), DATE);
    await outbox.markSending(stale.notificationId, at(0)().toISOString());
    const other = await enqueueReply(outbox, 2, usage(), DATE);
    // Five minutes later, well past the stale threshold.
    await deliverRows({ outbox, notifier, transport: "telegram", now: at(300) }, [other.notificationId]);
    expect((await outbox.getAll()).find((r) => r.notificationId === stale.notificationId)!.status).toBe("SENDING");
    // The control: the monitor's worker is the one that recovers it.
    const recovered = await runDeliveryWorker({ outbox, notifier, transport: "telegram", now: at(300) });
    expect(recovered.recovered).toBe(1);
  });
});
