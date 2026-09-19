import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { InMemoryNotificationOutboxStore } from "../services/kernel/src/alerting/outbox-store.js";
import { RecordingNotifier } from "../services/kernel/src/alerting/notifier.js";
import { runDeliveryWorker } from "../services/kernel/src/alerting/delivery-worker.js";
import { formatTelegramMessage } from "../services/kernel/src/alerting/format.js";
import {
  TEST_NOTIFICATION_CHECK_ID,
  assertValidTestLabel,
  buildTestDecision,
  enqueueTestNotification,
} from "../services/kernel/src/alerting/test-notification.js";
import { CONFIRM_FLAG, UsageError, parseArgs } from "../services/kernel/src/alerting/test-notification-cli.js";

const NOW = () => new Date("2026-09-19T12:00:00.000Z");

describe("KJ-P2.2B operator test notification", () => {
  it("queues exactly one clearly-labelled P3 NEW intent through intentsFromDecisions", async () => {
    const outbox = new InMemoryNotificationOutboxStore();
    const { notificationId } = await enqueueTestNotification(outbox, "activation-2026-09-19", NOW);
    const rows = await outbox.getAll();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.notificationId).toBe(notificationId);
    expect(row.severity).toBe("P3");
    expect(row.kind).toBe("NEW");
    expect(row.checkId).toBe(TEST_NOTIFICATION_CHECK_ID);
    expect(row.checkId.startsWith("TEST.")).toBe(true);
    expect(row.message).toMatch(/^TEST notification/);
    expect(row.status).toBe("PENDING");
    expect(row.attemptCount).toBe(0);
  });

  it("re-running with the same label queues nothing further, even at a later time", async () => {
    const outbox = new InMemoryNotificationOutboxStore();
    const first = await enqueueTestNotification(outbox, "same-label", NOW);
    const later = () => new Date("2026-09-19T18:30:00.000Z");
    const second = await enqueueTestNotification(outbox, "same-label", later);
    expect(second.notificationId).toBe(first.notificationId);
    expect(await outbox.getAll()).toHaveLength(1);
  });

  it("a different label is a deliberate, distinct second test", async () => {
    const outbox = new InMemoryNotificationOutboxStore();
    const a = await enqueueTestNotification(outbox, "one", NOW);
    const b = await enqueueTestNotification(outbox, "two", NOW);
    expect(a.notificationId).not.toBe(b.notificationId);
    expect(await outbox.getAll()).toHaveLength(2);
  });

  it("is never a P0/P1/P2 and never an ESCALATED/RECOVERED event", () => {
    const d = buildTestDecision("x", NOW().toISOString());
    expect(d.severity).toBe("P3");
    expect(d.kind).toBe("NEW");
    expect(d.notify).toBe(true);
  });

  it("rejects labels that could smuggle anything other than a short identifier", () => {
    for (const bad of ["", "has space", "semi;colon", "a".repeat(41), "new\nline", "back`tick", "$(x)"]) {
      expect(() => assertValidTestLabel(bad), JSON.stringify(bad)).toThrow();
    }
    expect(() => assertValidTestLabel("ok.label_1-2")).not.toThrow();
  });

  it("flows through the real delivery worker to exactly one notify(), and a second run does not re-send", async () => {
    const outbox = new InMemoryNotificationOutboxStore();
    await enqueueTestNotification(outbox, "pipeline", NOW);
    const notifier = new RecordingNotifier();
    const summary = await runDeliveryWorker({ outbox, notifier, transport: "telegram", now: NOW });
    expect(summary).toMatchObject({ attempted: 1, delivered: 1, retried: 0, poisoned: 0, result: "OK" });
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]!.severity).toBe("P3");
    const again = await runDeliveryWorker({ outbox, notifier, transport: "telegram", now: NOW });
    expect(again.attempted).toBe(0);
    expect(notifier.sent).toHaveLength(1);
    expect(outbox.events).toHaveLength(1);
    expect(outbox.events[0]).toMatchObject({ outcome: "DELIVERED", transport: "telegram" });
  });

  it("the delivered Telegram text is unmistakably a test", async () => {
    const outbox = new InMemoryNotificationOutboxStore();
    await enqueueTestNotification(outbox, "wording", NOW);
    const notifier = new RecordingNotifier();
    await runDeliveryWorker({ outbox, notifier, transport: "telegram", now: NOW });
    const text = formatTelegramMessage(notifier.sent[0]!);
    expect(text).toContain("TEST");
    expect(text).toContain("P3");
  });

  it("is structurally unable to reach business tables: the module imports no store, ledger, admission or scheduler code", () => {
    const raw = readFileSync("services/kernel/src/alerting/test-notification.ts", "utf8");
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const imports = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["./fingerprint.js", "./outbox-store.js", "./outbox.js", "./types.js"].sort());
    expect(src).not.toMatch(/state-store|pg-state-store|ledger|admission|schedule|fetch\(|api\.telegram\.org|insert into/i);
  });

  describe("CLI is disabled unless explicitly invoked", () => {
    it("refuses without the confirmation flag", () => {
      expect(() => parseArgs(["--label", "x"])).toThrow(UsageError);
      expect(() => parseArgs([])).toThrow(/refusing to run/);
    });
    it("refuses without a label, and with an invalid one", () => {
      expect(() => parseArgs([CONFIRM_FLAG])).toThrow(/--label/);
      expect(() => parseArgs([CONFIRM_FLAG, "--label", "bad label"])).toThrow(UsageError);
    });
    it("accepts the flag plus a valid label", () => {
      expect(parseArgs([CONFIRM_FLAG, "--label", "go-live"])).toEqual({ label: "go-live" });
    });
  });
});
