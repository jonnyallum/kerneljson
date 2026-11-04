import { createHash } from "node:crypto";
import { TenantContext } from "../../contracts/src/index.js";
import { Id } from "../../contracts/src/common.js";
import { AckInput, ChannelError, PostInput, ReadQuery, type ChannelMessage } from "./contract.js";
import { redactSecrets } from "./redact.js";
import type { AckRecord, ChannelStore, DeliveryRecord, RoomRecipient, ThreadSummary } from "./store.js";

/** A principal allowed to use this tenant's room, and the handle readers see. */
export interface RoomMember {
  principalId: string;
  handle: string;
}

/** Tenant-scoped registry of principals allowed to use the channel, and their handles. */
export interface AgentRegistry {
  handleFor(context: TenantContext): Promise<string | null>;
  /** Every current member of the tenant's room, including the caller when they are a member. */
  members(tenantId: string): Promise<RoomMember[]>;
}

/** A new thread id is derived from the idempotency key, so a replayed post lands in the same thread. */
export function deriveThreadId(tenantId: string, principalId: string, key: string): string {
  const h = createHash("sha256").update(`${tenantId}|${principalId}|${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export class ChannelService {
  constructor(
    private readonly store: ChannelStore,
    private readonly registry: AgentRegistry,
  ) {}

  private async who(raw: unknown) {
    const context = TenantContext.parse(raw);
    const handle = await this.registry.handleFor(context);
    if (!handle)
      throw new ChannelError("DENIED", "Principal is not registered for this tenant's channel");
    return { context, handle };
  }

  async post(
    raw: unknown,
    rawInput: unknown,
  ): Promise<{ message: ChannelMessage; duplicate: boolean }> {
    const { context, handle } = await this.who(raw);
    const input = PostInput.parse(rawInput);
    let threadId = input.threadId ?? null;
    if (input.inReplyTo) {
      const parent = await this.store.get(context.tenantId, input.inReplyTo);
      if (!parent) throw new ChannelError("NOT_FOUND", "Parent message not found");
      if (threadId && threadId !== parent.threadId)
        throw new ChannelError("CONFLICT", "Thread does not match parent");
      threadId = parent.threadId;
    }
    const { text, redacted } = redactSecrets(input.body);
    const members = await this.registry.members(context.tenantId);
    const recipients: RoomRecipient[] = members
      .filter((member) => member.principalId !== context.principal.id)
      .map((member) => ({ principalId: member.principalId, handle: member.handle }));
    return this.store.append(
      context.tenantId,
      {
        kind: input.kind,
        author: context.principal,
        handle,
        body: text,
        redacted,
        threadId: threadId ?? deriveThreadId(context.tenantId, context.principal.id, input.idempotencyKey),
        inReplyTo: input.inReplyTo ?? null,
        taskRef: input.taskRef ?? null,
        idempotencyKey: input.idempotencyKey,
      },
      recipients,
    );
  }

  async read(raw: unknown, rawQuery: unknown) {
    const { context } = await this.who(raw);
    const q = ReadQuery.parse(rawQuery);
    let after = q.after;
    if (q.since) {
      const prior = await this.store.get(context.tenantId, q.since);
      if (!prior) throw new ChannelError("NOT_FOUND", "Cursor message not found");
      if (prior.seq > after) after = prior.seq;
    }
    const query: { after: number; limit: number; threadId?: string } = { after, limit: q.limit };
    if (q.threadId) query.threadId = q.threadId;
    const messages = await this.store.list(context.tenantId, query);
    if (messages.length > 0) {
      await this.store.markDelivered(
        context.tenantId,
        context.principal.id,
        messages.map((message) => message.id),
      );
    }
    return { messages, next: messages.at(-1)?.seq ?? after };
  }

  async ack(raw: unknown, rawInput: unknown): Promise<AckRecord> {
    const { context, handle } = await this.who(raw);
    const { upToSeq } = AckInput.parse(rawInput);
    if (upToSeq > (await this.store.maxSeq(context.tenantId)))
      throw new ChannelError("CONFLICT", "Ack is beyond the end of the log");
    return this.store.ack(context.tenantId, {
      principalId: context.principal.id,
      handle,
      upToSeq,
    });
  }

  /** Highest sequence number in the tenant's log, for tail reads. */
  async cursorEnd(raw: unknown) {
    const { context } = await this.who(raw);
    return this.store.maxSeq(context.tenantId);
  }

  /** Per-reader cursors. "Acknowledged" means the reader itself said so; stored is not read. */
  async cursors(raw: unknown) {
    const { context } = await this.who(raw);
    return this.store.acks(context.tenantId);
  }

  /** Delivery rows for this tenant. Pass message ids to limit the page. */
  async deliveries(raw: unknown, messageIds?: readonly string[]): Promise<DeliveryRecord[]> {
    const { context } = await this.who(raw);
    if (!messageIds) return this.store.deliveries(context.tenantId);
    for (const id of messageIds) Id.parse(id);
    return this.store.deliveries(context.tenantId, messageIds);
  }

  /** Thread index for the tenant's one shared room. Summaries carry no message body. */
  async threads(raw: unknown): Promise<ThreadSummary[]> {
    const { context } = await this.who(raw);
    return this.store.threads(context.tenantId);
  }
}
