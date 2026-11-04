import { createHash, randomUUID } from "node:crypto";
import { ChannelError, ChannelMessage } from "./contract.js";

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

/**
 * Storage port. It has no operation that touches tasks, approvals or control events (ADR-0026 s1).
 * Every method is scoped by tenant id taken from the authenticated context, never from input.
 */
export interface ChannelStore {
  append(tenantId: string, draft: MessageDraft): Promise<{ message: ChannelMessage; duplicate: boolean }>;
  get(tenantId: string, id: string): Promise<ChannelMessage | null>;
  list(tenantId: string, q: { after: number; limit: number; threadId?: string | undefined }): Promise<ChannelMessage[]>;
  ack(tenantId: string, rec: Omit<AckRecord, "at">): Promise<AckRecord>;
  acks(tenantId: string): Promise<AckRecord[]>;
  maxSeq(tenantId: string): Promise<number>;
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
  constructor(private readonly now: () => Date = () => new Date()) {}
  private t(tenantId: string) {
    let r = this.rows.get(tenantId);
    if (!r) this.rows.set(tenantId, (r = []));
    return r;
  }
  async append(tenantId: string, d: MessageDraft) {
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
    const message = ChannelMessage.parse({
      id: randomUUID(),
      seq: rows.length + 1,
      tenantId,
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
      createdAt: this.now().toISOString(),
    });
    rows.push(message);
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
    let m = this.ackRows.get(tenantId);
    if (!m) this.ackRows.set(tenantId, (m = new Map()));
    const prev = m.get(rec.principalId);
    // Cursors only move forward, so a replayed or late ack cannot rewind a reader.
    const next: AckRecord = {
      ...rec,
      upToSeq: Math.max(prev?.upToSeq ?? 0, rec.upToSeq),
      at: this.now().toISOString(),
    };
    m.set(rec.principalId, next);
    return next;
  }
  async acks(tenantId: string) {
    return [...(this.ackRows.get(tenantId)?.values() ?? [])];
  }
}
