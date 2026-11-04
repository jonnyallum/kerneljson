import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { Id } from "../../contracts/src/common.js";
import { ChannelError, ChannelMessage, Handle } from "./contract.js";

export interface MessageDraft {
  kind: ChannelMessage["kind"];
  author: ChannelMessage["author"];
  handle: string;
  body: string;
  redacted: boolean;
  threadId: string;
  inReplyTo: string | null;
  taskRef: string | null;
  idempotencyKey: string;
}
export interface AckRecord {
  principalId: string;
  handle: string;
  upToSeq: number;
  at: string;
}
export const DeliveryState = z.enum(["pending", "delivered", "acked"]);
export type DeliveryState = z.infer<typeof DeliveryState>;
/** One row per recipient. The sender is not a recipient of their own message. */
export interface DeliveryRecord {
  messageId: string;
  seq: number;
  recipientId: string;
  handle: string;
  state: DeliveryState;
  updatedAt: string;
}
export interface RoomRecipient {
  principalId: string;
  handle: string;
}
export interface ThreadSummary {
  threadId: string;
  count: number;
  lastSeq: number;
  handle: string;
}
export const THREAD_INDEX_LIMIT = 50;

/**
 * Storage port. It has no operation that touches tasks, approvals or control events (ADR-0026 s1).
 * Every method is scoped by tenant id taken from the authenticated context, never from input.
 */
export interface ChannelStore {
  append(
    tenantId: string,
    draft: MessageDraft,
    recipients: readonly RoomRecipient[],
  ): Promise<{ message: ChannelMessage; duplicate: boolean }>;
  get(tenantId: string, id: string): Promise<ChannelMessage | null>;
  list(tenantId: string, q: { after: number; limit: number; threadId?: string | undefined }): Promise<ChannelMessage[]>;
  ack(tenantId: string, rec: Omit<AckRecord, "at">): Promise<AckRecord>;
  acks(tenantId: string): Promise<AckRecord[]>;
  maxSeq(tenantId: string): Promise<number>;
  /** pending -> delivered for this recipient. acked stays acked. */
  markDelivered(tenantId: string, recipientId: string, messageIds: readonly string[]): Promise<void>;
  deliveries(tenantId: string, messageIds?: readonly string[]): Promise<DeliveryRecord[]>;
  threads(tenantId: string): Promise<ThreadSummary[]>;
}

export function requireTenant(tenantId: string): string {
  return Id.parse(tenantId);
}

/** Recipients are other room members. The author is removed; duplicates collapse. */
export function normaliseRecipients(authorId: string, recipients: readonly RoomRecipient[]): RoomRecipient[] {
  const seen = new Set<string>();
  const out: RoomRecipient[] = [];
  for (const recipient of recipients) {
    const principalId = Id.parse(recipient.principalId);
    const handle = Handle.parse(recipient.handle);
    if (principalId === authorId || seen.has(principalId)) continue;
    seen.add(principalId);
    out.push({ principalId, handle });
  }
  return out;
}

export const contentHash = (
  d: Pick<MessageDraft, "kind" | "body" | "threadId" | "inReplyTo" | "taskRef">,
) =>
  createHash("sha256")
    .update(JSON.stringify([d.kind, d.body, d.threadId, d.inReplyTo, d.taskRef]))
    .digest("hex");

export class InMemoryChannelStore implements ChannelStore {
  private rows = new Map<string, ChannelMessage[]>();
  private ackRows = new Map<string, Map<string, AckRecord>>();
  private deliveryRows = new Map<string, DeliveryRecord[]>();
  constructor(private readonly now: () => Date = () => new Date()) {}
  private t(tenantId: string) {
    const id = requireTenant(tenantId);
    let r = this.rows.get(id);
    if (!r) this.rows.set(id, (r = []));
    return r;
  }
  private deliveriesFor(tenantId: string) {
    const id = requireTenant(tenantId);
    let r = this.deliveryRows.get(id);
    if (!r) this.deliveryRows.set(id, (r = []));
    return r;
  }
  async append(tenantId: string, d: MessageDraft, recipients: readonly RoomRecipient[]) {
    const rows = this.t(tenantId);
    const hash = contentHash(d);
    const prior = rows.find(
      (m) => m.author.id === d.author.id && m.idempotencyKey === d.idempotencyKey,
    );
    if (prior) {
      if (prior.contentHash !== hash)
        throw new ChannelError("CONFLICT", "Idempotency key reused with different content");
      return { message: prior, duplicate: true };
    }
    const createdAt = this.now().toISOString();
    const message = ChannelMessage.parse({
      id: randomUUID(),
      seq: rows.length + 1,
      tenantId: requireTenant(tenantId),
      threadId: d.threadId,
      kind: d.kind,
      author: d.author,
      handle: d.handle,
      body: d.body,
      redacted: d.redacted,
      inReplyTo: d.inReplyTo,
      taskRef: d.taskRef,
      idempotencyKey: d.idempotencyKey,
      contentHash: hash,
      createdAt,
    });
    rows.push(message);
    for (const recipient of normaliseRecipients(d.author.id, recipients)) {
      this.deliveriesFor(tenantId).push({
        messageId: message.id,
        seq: message.seq,
        recipientId: recipient.principalId,
        handle: recipient.handle,
        state: "pending",
        updatedAt: createdAt,
      });
    }
    return { message, duplicate: false };
  }
  async get(tenantId: string, id: string) {
    return this.t(tenantId).find((m) => m.id === id) ?? null;
  }
  async list(tenantId: string, q: { after: number; limit: number; threadId?: string | undefined }) {
    return this.t(tenantId)
      .filter((m) => m.seq > q.after && (!q.threadId || m.threadId === q.threadId))
      .slice(0, q.limit);
  }
  async maxSeq(tenantId: string) {
    return this.t(tenantId).length;
  }
  async ack(tenantId: string, rec: Omit<AckRecord, "at">) {
    const id = requireTenant(tenantId);
    let m = this.ackRows.get(id);
    if (!m) this.ackRows.set(id, (m = new Map()));
    const prev = m.get(rec.principalId);
    // Cursors only move forward, so a replayed or late ack cannot rewind a reader.
    const at = this.now().toISOString();
    const next: AckRecord = {
      ...rec,
      upToSeq: Math.max(prev?.upToSeq ?? 0, rec.upToSeq),
      at,
    };
    m.set(rec.principalId, next);
    for (const row of this.deliveriesFor(id)) {
      if (row.recipientId !== rec.principalId || row.seq > next.upToSeq || row.state === "acked") continue;
      row.state = "acked";
      row.updatedAt = at;
    }
    return next;
  }
  async acks(tenantId: string) {
    return [...(this.ackRows.get(requireTenant(tenantId))?.values() ?? [])];
  }
  async markDelivered(tenantId: string, recipientId: string, messageIds: readonly string[]) {
    if (messageIds.length === 0) return;
    const ids = new Set(messageIds);
    const at = this.now().toISOString();
    for (const row of this.deliveriesFor(tenantId)) {
      if (row.recipientId !== recipientId || !ids.has(row.messageId) || row.state !== "pending") continue;
      row.state = "delivered";
      row.updatedAt = at;
    }
  }
  async deliveries(tenantId: string, messageIds?: readonly string[]) {
    if (messageIds && messageIds.length === 0) return [];
    const ids = messageIds ? new Set(messageIds) : null;
    return this.deliveriesFor(tenantId)
      .filter((row) => !ids || ids.has(row.messageId))
      .sort((a, b) => a.seq - b.seq || a.handle.localeCompare(b.handle));
  }
  async threads(tenantId: string) {
    const grouped = new Map<string, ChannelMessage[]>();
    for (const message of this.t(tenantId)) {
      const bucket = grouped.get(message.threadId) ?? [];
      bucket.push(message);
      grouped.set(message.threadId, bucket);
    }
    const summaries: ThreadSummary[] = [];
    for (const [threadId, messages] of grouped) {
      const last = messages[messages.length - 1];
      if (!last) continue;
      summaries.push({ threadId, count: messages.length, lastSeq: last.seq, handle: last.handle });
    }
    return summaries.sort((a, b) => b.lastSeq - a.lastSeq).slice(0, THREAD_INDEX_LIMIT);
  }
}
