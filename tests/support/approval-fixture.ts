import { randomUUID } from "node:crypto";
import { UPPERCASE } from "../../packages/capabilities/src/index.js";
import {
  mintHandle,
  callbackDataFor,
  type ApprovalCard,
  type ApprovalRequest,
  type ApprovalStatus,
  type CardText,
  type Decision,
  type Handles,
  type InlineKeyboard,
} from "../../services/kernel/src/channel/telegram/approval-cards.js";
import type { ApprovalsDeps } from "../../services/kernel/src/channel/telegram/approvals.js";
import type { BotApi } from "../../services/kernel/src/channel/telegram/bot-api.js";
import type { CallbackDisposition, CardStore, CardToClose, CardToSend } from "../../services/kernel/src/channel/telegram/card-store.js";
import type { ApprovalDoor, ApproveAnswer } from "../../services/kernel/src/channel/telegram/door-client.js";
import type { RawUpdate } from "../../services/kernel/src/channel/telegram/updates.js";
import { CHAT, NOW } from "./telegram-fixture.js";

export const TENANT = "10000000-0000-4000-8000-000000000001";
export const APPROVER = "70000000-0000-4000-8000-000000000002";

export const hex = (c: string): string => c.repeat(64);

export function request(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId: randomUUID(),
    taskId: randomUUID(),
    tenantId: TENANT,
    scopeDigest: hex("a"),
    invocationDigest: hex("b"),
    capability: UPPERCASE.id,
    expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    ...over,
  };
}

export interface CallbackOptions {
  fromId?: number;
  isBot?: boolean;
  chatId?: number;
  chatType?: string;
  messageId?: number | null;
  queryId?: string;
}

/** A Telegram `callback_query` update as the Bot API delivers it. */
export function callbackUpdate(updateId: number, data: string | undefined, o: CallbackOptions = {}): RawUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: o.queryId ?? `q${updateId}`,
      from: { id: o.fromId ?? Number(CHAT), is_bot: o.isBot ?? false },
      ...(o.messageId === null
        ? {}
        : { message: { message_id: o.messageId ?? 501, chat: { id: o.chatId ?? Number(CHAT), type: o.chatType ?? "private" } } }),
      ...(data === undefined ? {} : { data }),
    },
  };
}

export class FakeBot implements BotApi {
  cards: Array<{ text: CardText; keyboard: InlineKeyboard; messageId: number }> = [];
  closed: Array<{ messageId: number; text: CardText }> = [];
  answers: Array<{ queryId: string; text: CardText }> = [];
  failSend: Error | null = null;
  failClose: Error | null = null;
  failAnswer: Error | null = null;
  next = 501;
  async sendCard(text: CardText, keyboard: InlineKeyboard): Promise<{ messageId: number }> {
    if (this.failSend) throw this.failSend;
    const messageId = this.next++;
    this.cards.push({ text, keyboard, messageId });
    return { messageId };
  }
  async closeCard(messageId: number, text: CardText): Promise<void> {
    if (this.failClose) throw this.failClose;
    this.closed.push({ messageId, text });
  }
  async answer(queryId: string, text: CardText): Promise<void> {
    if (this.failAnswer) throw this.failAnswer;
    this.answers.push({ queryId, text });
  }
}

/** A door double. Setting `onApprove` lets a test stand in for what the ledger does with the answer. */
export class FakeApprovalDoor implements ApprovalDoor {
  calls: Array<{ taskId: string; scopeDigest: string; decision: Decision; updateId: number }> = [];
  answer: ApproveAnswer = "ACCEPTED";
  onApprove: (input: { taskId: string; scopeDigest: string; decision: Decision }) => void = () => {};
  async approve(input: { taskId: string; scopeDigest: string; decision: Decision; updateId: number }): Promise<ApproveAnswer> {
    this.calls.push({ ...input });
    this.onApprove(input);
    return this.answer;
  }
}

interface Stored {
  card: ApprovalCard;
  handles: Handles;
}

/** Same semantics as the Postgres store, in memory. `ledger` stands in for `public.approvals.status`. */
export class InMemoryCardStore implements CardStore {
  readonly cards = new Map<string, Stored>();
  readonly ledger = new Map<string, ApprovalStatus>();
  readonly callbacks = new Map<number, { state: "RECEIVED" | "DONE"; disposition: CallbackDisposition | null }>();
  readonly pending: ApprovalRequest[] = [];

  /** Put an approval in the ledger as PENDING, ready for discovery. */
  addPending(r: ApprovalRequest): void {
    this.pending.push(r);
    this.ledger.set(r.approvalId, "PENDING");
  }

  /** A card that was already sent as message `messageId`. Returns its two handles. */
  seedSent(r: ApprovalRequest, messageId = 501): Handles {
    const handles = { granted: mintHandle(), denied: mintHandle() };
    this.cards.set(r.approvalId, {
      card: { ...r, state: "SENT", attemptCount: 1, claimedAt: null, messageId },
      handles,
    });
    this.ledger.set(r.approvalId, "PENDING");
    return handles;
  }

  async discover(input: { tenantId: string; approverId: string; now: string; limit: number }): Promise<number> {
    let created = 0;
    for (const r of this.pending) {
      if (this.cards.has(r.approvalId) || r.tenantId !== input.tenantId || this.ledger.get(r.approvalId) !== "PENDING") continue;
      this.cards.set(r.approvalId, {
        card: { ...r, state: "QUEUED", attemptCount: 0, claimedAt: null, messageId: null },
        handles: { granted: mintHandle(), denied: mintHandle() },
      });
      created++;
    }
    return created;
  }
  async claimToSend(input: { now: string; staleMs: number; maxAttempts: number; limit: number }): Promise<CardToSend[]> {
    const out: CardToSend[] = [];
    for (const s of this.cards.values()) {
      if (out.length >= input.limit) break;
      const stale = s.card.state === "SENDING" && s.card.claimedAt !== null && Date.parse(s.card.claimedAt) < Date.parse(input.now) - input.staleMs;
      if ((s.card.state === "QUEUED" || stale) && Date.parse(s.card.expiresAt) > Date.parse(input.now) && s.card.attemptCount < input.maxAttempts) {
        s.card = { ...s.card, state: "SENDING", attemptCount: s.card.attemptCount + 1, claimedAt: input.now };
        out.push({ card: { ...s.card }, handles: s.handles });
      }
    }
    return out;
  }
  async markSent(approvalId: string, messageId: number): Promise<void> {
    const s = this.cards.get(approvalId);
    if (s && s.card.state === "SENDING") s.card = { ...s.card, state: "SENT", messageId };
  }
  async releaseUnsent(approvalId: string): Promise<void> {
    const s = this.cards.get(approvalId);
    if (s && s.card.state === "SENDING") s.card = { ...s.card, state: "QUEUED" };
  }
  async listToClose(input: { now: string; limit: number }): Promise<CardToClose[]> {
    const out: CardToClose[] = [];
    for (const s of this.cards.values()) {
      const status = this.ledger.get(s.card.approvalId) ?? "PENDING";
      if (s.card.state !== "RESOLVED" && (status !== "PENDING" || Date.parse(s.card.expiresAt) <= Date.parse(input.now)))
        out.push({ card: { ...s.card }, status: status === "PENDING" ? "EXPIRED" : status });
    }
    return out.slice(0, input.limit);
  }
  async markResolved(approvalId: string): Promise<void> {
    const s = this.cards.get(approvalId);
    if (s) s.card = { ...s.card, state: "RESOLVED" };
  }
  async byHandle(handle: string): Promise<{ card: ApprovalCard; decision: Decision } | null> {
    for (const s of this.cards.values()) {
      if (s.handles.granted === handle) return { card: { ...s.card }, decision: "GRANTED" };
      if (s.handles.denied === handle) return { card: { ...s.card }, decision: "DENIED" };
    }
    return null;
  }
  async statusOf(approvalId: string): Promise<ApprovalStatus | null> {
    return this.ledger.get(approvalId) ?? null;
  }
  async claimCallback(input: { updateId: number }): Promise<{ state: "RECEIVED" | "DONE" }> {
    const row = this.callbacks.get(input.updateId) ?? { state: "RECEIVED" as const, disposition: null };
    this.callbacks.set(input.updateId, row);
    return { state: row.state };
  }
  async completeCallback(input: { updateId: number; disposition: CallbackDisposition }): Promise<void> {
    this.callbacks.set(input.updateId, { state: "DONE", disposition: input.disposition });
  }
}

export interface ApprovalHarness {
  cards: InMemoryCardStore;
  bot: FakeBot;
  door: FakeApprovalDoor;
  clock: { now: Date };
  deps: ApprovalsDeps;
}

export function approvalHarness(): ApprovalHarness {
  const cards = new InMemoryCardStore();
  const bot = new FakeBot();
  const door = new FakeApprovalDoor();
  const clock = { now: new Date(NOW) };
  return {
    cards,
    bot,
    door,
    clock,
    deps: { tenantId: TENANT, approverId: APPROVER, cards, bot, door, now: () => new Date(clock.now) },
  };
}

/** The callback data a real card would carry for a handle. */
export const dataFor = (handle: string): string => callbackDataFor(handle);
