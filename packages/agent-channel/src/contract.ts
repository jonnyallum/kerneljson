import { z } from "zod";
import { Id, Timestamp } from "../../contracts/src/common.js";
import { PrincipalRef } from "../../contracts/src/identity.js";

/** ADR-0026. A message is narrative. It can reference a task id; it can never change a task. */
export const MessageKind = z.enum(["NOTE", "QUESTION", "REPLY", "HANDOFF", "STATUS"]);
export type MessageKind = z.infer<typeof MessageKind>;

export const Handle = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/);
export const IdempotencyKey = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
export const MAX_BODY = 4000;
export const MAX_READ = 100;

/** Caller-supplied fields only. Author, tenant and principal are never accepted from a body. */
export const PostInput = z.strictObject({
  kind: MessageKind,
  body: z.string().trim().min(1).max(MAX_BODY),
  threadId: Id.optional(),
  inReplyTo: Id.optional(),
  taskRef: Id.optional(),
  idempotencyKey: IdempotencyKey,
});
export type PostInput = z.infer<typeof PostInput>;

export const ChannelMessage = z.strictObject({
  id: Id,
  seq: z.number().int().positive(),
  tenantId: Id,
  threadId: Id,
  kind: MessageKind,
  author: PrincipalRef,
  handle: Handle,
  body: z.string().min(1).max(MAX_BODY),
  redacted: z.boolean(),
  inReplyTo: Id.nullable(),
  taskRef: Id.nullable(),
  idempotencyKey: IdempotencyKey,
  contentHash: z.string().length(64),
  createdAt: Timestamp,
});
export type ChannelMessage = z.infer<typeof ChannelMessage>;

export const ReadQuery = z.strictObject({
  /** Exclusive sequence cursor. Zero reads from the start of the log. */
  after: z.coerce.number().int().min(0).default(0),
  /** Exclusive message id. Resolved inside the caller's tenant, then treated as `after` that seq. */
  since: Id.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_READ).default(50),
  threadId: Id.optional(),
});
export type ReadQuery = z.infer<typeof ReadQuery>;

export const AckInput = z.strictObject({ upToSeq: z.number().int().positive() });
export type AckInput = z.infer<typeof AckInput>;

export class ChannelError extends Error {
  constructor(readonly code: "DENIED" | "CONFLICT" | "NOT_FOUND", message: string) {
    super(message);
  }
}
