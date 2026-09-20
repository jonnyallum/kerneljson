import { createHash } from "node:crypto";
import { InMemoryNotificationOutboxStore } from "../../services/kernel/src/alerting/outbox-store.js";
import type { AdmitResult, DoorClient, ReadResult } from "../../services/kernel/src/channel/telegram/door-client.js";
import { idempotencyKeyFor } from "../../services/kernel/src/channel/telegram/door-client.js";
import { InMemoryInboxStore } from "../../services/kernel/src/channel/telegram/inbox-store.js";
import { pollOnce, type OperatorDeps, type OperatorLimits } from "../../services/kernel/src/channel/telegram/operator.js";
import type { StatusReader } from "../../services/kernel/src/channel/telegram/status.js";
import type { RawUpdate, UpdateSource } from "../../services/kernel/src/channel/telegram/updates.js";
import type { SystemStatus } from "../../services/kernel/src/channel/telegram/views.js";

/** Jonny's private chat. In a private chat the chat id and the sender's user id are the same number. */
export const CHAT = "6543210987";
export const NOW = new Date("2026-09-20T12:00:00.000Z");
/** Telegram's own `date` (unix seconds) for a message sent at NOW. */
export const DATE = Math.floor(NOW.getTime() / 1000);

export interface MsgOptions {
  chatId?: number;
  chatType?: string;
  fromId?: number | null;
  isBot?: boolean;
  extra?: Record<string, unknown>;
  date?: number;
}

/** A Telegram `message` update as the Bot API delivers it. */
export function msg(updateId: number, text: string | undefined, o: MsgOptions = {}): RawUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 1000,
      date: o.date ?? DATE,
      ...(text === undefined ? {} : { text }),
      chat: { id: o.chatId ?? Number(CHAT), type: o.chatType ?? "private" },
      ...(o.fromId === null ? {} : { from: { id: o.fromId ?? Number(CHAT), is_bot: o.isBot ?? false } }),
      ...o.extra,
    },
  };
}

/** Behaves like Telegram: every update at or above the offset is served again until the offset passes it. */
export class FakeSource implements UpdateSource {
  updates: RawUpdate[] = [];
  requestedOffsets: number[] = [];
  failWith: Error | null = null;
  async getUpdates(offset: number): Promise<RawUpdate[]> {
    this.requestedOffsets.push(offset);
    if (this.failWith) throw this.failWith;
    return this.updates.filter((u) => u.update_id >= offset).map((u) => structuredClone(u));
  }
}

export const uuidFor = (seed: string): string => {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** A door double with the real door's idempotency: the same key returns the same task. */
export class FakeDoor implements DoorClient {
  admitCalls: Array<{ updateId: number; recipe: string; objective: string; key: string }> = [];
  readCalls: string[] = [];
  private byKey = new Map<string, string>();
  admitResult: AdmitResult | null = null;
  reads = new Map<string, ReadResult>();
  get distinctTasks(): number {
    return new Set(this.byKey.values()).size;
  }
  async admitMission(input: { updateId: number; recipe: string; objective: string }): Promise<AdmitResult> {
    const key = idempotencyKeyFor(input.updateId);
    this.admitCalls.push({ ...input, key });
    if (this.admitResult) return this.admitResult;
    let taskId = this.byKey.get(key);
    if (!taskId) {
      taskId = uuidFor(`task:${key}`);
      this.byKey.set(key, taskId);
    }
    return { ok: true, taskId };
  }
  async readTask(taskId: string): Promise<ReadResult> {
    this.readCalls.push(taskId);
    return this.reads.get(taskId) ?? { found: false };
  }
}

export const STATUS: SystemStatus = {
  epoch: "5",
  releaseId: "59d2dbd5d966e7db735a8fad6149c47eacbde17f",
  tasksTotal: 31,
  tasksInFlight: 1,
  tasksAwaiting: 0,
  missionTasks: 2,
  latestFire: { windowKey: "dailyAt/09:00|Europe/London|2026-09-20", state: "ADMITTED" },
  alertsOpen: { P0: 0, P1: 0, P2: 0, P3: 1 },
  outboxPending: 0,
  outboxPoison: 0,
};

export class FakeStatus implements StatusReader {
  reads = 0;
  async read(): Promise<SystemStatus> {
    this.reads += 1;
    return STATUS;
  }
}

export interface Harness {
  deps: OperatorDeps;
  source: FakeSource;
  inbox: InMemoryInboxStore;
  door: FakeDoor;
  status: FakeStatus;
  outbox: InMemoryNotificationOutboxStore;
  delivered: string[];
  clock: { now: Date };
  poll: () => ReturnType<typeof pollOnce>;
  /** The text of every reply queued so far, in order. */
  replies: () => Promise<string[]>;
}

export const LIMITS: OperatorLimits = { chatId: CHAT, dailyMissionCap: 5, ratePerMinute: 10, pollTimeoutSec: 20 };

export function harness(over: Partial<OperatorLimits> = {}): Harness {
  const source = new FakeSource();
  const inbox = new InMemoryInboxStore();
  const door = new FakeDoor();
  const status = new FakeStatus();
  const outbox = new InMemoryNotificationOutboxStore();
  const delivered: string[] = [];
  const clock = { now: new Date(NOW) };
  const deps: OperatorDeps = {
    limits: { ...LIMITS, ...over },
    source,
    inbox,
    door,
    status,
    outbox,
    deliver: async (ids) => {
      delivered.push(...ids);
    },
    deliverDue: async () => {},
    now: () => new Date(clock.now),
  };
  return {
    deps,
    source,
    inbox,
    door,
    status,
    outbox,
    delivered,
    clock,
    poll: () => pollOnce(deps),
    replies: async () => (await outbox.getAll()).filter((r) => r.checkId.startsWith("OPERATOR.reply.")).map((r) => r.message),
  };
}
