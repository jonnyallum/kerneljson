import { createHash } from "node:crypto";
import { TenantContext } from "../../contracts/src/index.js";
import { AckInput, ChannelError, PostInput, ReadQuery, type ChannelMessage } from "./contract.js";
import { redactSecrets } from "./redact.js";
import type { AckRecord, ChannelStore } from "./store.js";

/** Tenant-scoped registry of principals allowed to use the channel, and their handles. */
export interface AgentRegistry {
  handleFor(context: TenantContext): Promise<string | null>;
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
    return this.store.append(context.tenantId, {
      kind: input.kind,
      author: context.principal,
      handle,
      body: text,
      redacted,
      threadId: threadId ?? deriveThreadId(context.tenantId, context.principal.id, input.idempotencyKey),
      inReplyTo: input.inReplyTo ?? null,
      taskRef: input.taskRef ?? null,
      idempotencyKey: input.idempotencyKey,
    });
  }

  async read(raw: unknown, rawQuery: unknown) {
    const { context } = await this.who(raw);
    const q = ReadQuery.parse(rawQuery);
    const messages = await this.store.list(context.tenantId, q);
    return { messages, next: messages.at(-1)?.seq ?? q.after };
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

  /** Per-reader cursors. "Acknowledged" means the reader itself said so; stored is not read. */
  async cursors(raw: unknown) {
    const { context } = await this.who(raw);
    return this.store.acks(context.tenantId);
  }
}
