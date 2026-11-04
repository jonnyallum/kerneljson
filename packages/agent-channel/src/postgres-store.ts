import { randomUUID } from "node:crypto";
import pg from "pg";
import { TenantContext } from "../../contracts/src/index.js";
import { ChannelError, ChannelMessage } from "./contract.js";
import {
  contentHash,
  normaliseRecipients,
  requireTenant,
  DeliveryState,
  THREAD_INDEX_LIMIT,
  type AckRecord,
  type ChannelStore,
  type MessageDraft,
  type RoomRecipient,
  type ThreadSummary,
} from "./store.js";
import type { AgentRegistry, RoomMember } from "./service.js";

/**
 * Durable ChannelStore. Every statement is bound to the tenant id argument, which the service
 * takes from the authenticated context. The session setting app.tenant_id is set to the same
 * value so row policies on the agent_channel role agree with the statement filters.
 * This file queries only agent_channel_* tables.
 */

interface MessageRow {
  id: string;
  seq: string | number;
  tenant_id: string;
  thread_id: string;
  kind: ChannelMessage["kind"];
  author_principal_id: string;
  author_kind: ChannelMessage["author"]["kind"];
  handle: string;
  body: string;
  redacted: boolean;
  in_reply_to: string | null;
  task_ref: string | null;
  idempotency_key: string;
  content_hash: string;
  created_at: Date;
}

const MESSAGE_COLUMNS = `id, seq, tenant_id, thread_id, kind, author_principal_id, author_kind, handle,
  body, redacted, in_reply_to, task_ref, idempotency_key, content_hash, created_at`;

function asSeq(value: string | number): number {
  const seq = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(seq) || seq < 0) throw new ChannelError("CONFLICT", "Stored sequence is not usable");
  return seq;
}

function toMessage(row: MessageRow): ChannelMessage {
  return ChannelMessage.parse({
    id: row.id,
    seq: asSeq(row.seq),
    tenantId: row.tenant_id,
    threadId: row.thread_id,
    kind: row.kind,
    author: { id: row.author_principal_id, kind: row.author_kind },
    handle: row.handle,
    body: row.body,
    redacted: row.redacted,
    inReplyTo: row.in_reply_to,
    taskRef: row.task_ref,
    idempotencyKey: row.idempotency_key,
    contentHash: row.content_hash,
    createdAt: row.created_at.toISOString(),
  });
}

function isUnique(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export async function withChannelTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (db: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const tenant = requireTenant(tenantId);
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("select set_config('app.tenant_id', $1, true)", [tenant]);
    const result = await fn(db);
    await db.query("commit");
    return result;
  } catch (error) {
    try {
      await db.query("rollback");
    } catch {
      // The connection may already be aborted. The original error is the one to report.
    }
    throw error;
  } finally {
    db.release();
  }
}

export class PostgresChannelStore implements ChannelStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async append(tenantId: string, draft: MessageDraft, recipients: readonly RoomRecipient[]) {
    const tenant = requireTenant(tenantId);
    const hash = contentHash(draft);
    const people = normaliseRecipients(draft.author.id, recipients);
    return withChannelTenant(this.pool, tenant, async (db) => {
      const prior = await this.lookup(db, tenant, draft.author.id, draft.idempotencyKey);
      if (prior) {
        if (prior.contentHash !== hash) throw new ChannelError("CONFLICT", "Idempotency key reused with different content");
        return { message: prior, duplicate: true as const };
      }
      await db.query("savepoint channel_msg");
      try {
        const seqRow = await db.query<{ seq: string | number }>(
          `insert into agent_channel_counters (tenant_id, last_seq) values ($1, 1)
           on conflict (tenant_id) do update set last_seq = agent_channel_counters.last_seq + 1
           returning last_seq as seq`,
          [tenant],
        );
        const seqValue = seqRow.rows[0]?.seq;
        if (seqValue === undefined) throw new ChannelError("CONFLICT", "Sequence was not allocated");
        const seq = asSeq(seqValue);
        const id = randomUUID();
        const createdAt = this.now();
        await db.query(
          `insert into agent_channel_messages (
             id, tenant_id, seq, thread_id, kind, author_principal_id, author_kind, handle,
             body, redacted, in_reply_to, task_ref, idempotency_key, content_hash, created_at
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            id,
            tenant,
            seq,
            draft.threadId,
            draft.kind,
            draft.author.id,
            draft.author.kind,
            draft.handle,
            draft.body,
            draft.redacted,
            draft.inReplyTo,
            draft.taskRef,
            draft.idempotencyKey,
            hash,
            createdAt,
          ],
        );
        if (people.length > 0) {
          await db.query(
            `insert into agent_channel_deliveries
               (tenant_id, message_id, recipient_principal_id, handle, state, updated_at)
             select $1, $2, x.principal_id, x.handle, 'pending', $3
             from jsonb_to_recordset($4::jsonb) as x(principal_id uuid, handle text)
             where x.principal_id <> $5`,
            [tenant, id, createdAt, JSON.stringify(people.map((person) => ({ principal_id: person.principalId, handle: person.handle }))), draft.author.id],
          );
        }
      } catch (error) {
        await db.query("rollback to savepoint channel_msg");
        if (!isUnique(error)) throw error;
        const winner = await this.lookup(db, tenant, draft.author.id, draft.idempotencyKey);
        if (!winner) throw error;
        if (winner.contentHash !== hash) throw new ChannelError("CONFLICT", "Idempotency key reused with different content");
        return { message: winner, duplicate: true as const };
      }
      const written = await this.lookup(db, tenant, draft.author.id, draft.idempotencyKey);
      if (!written) throw new ChannelError("CONFLICT", "Stored message could not be read back");
      return { message: written, duplicate: false as const };
    });
  }

  async get(tenantId: string, id: string) {
    const tenant = requireTenant(tenantId);
    return withChannelTenant(this.pool, tenant, async (db) => {
      const rows = await db.query<MessageRow>(
        `select ${MESSAGE_COLUMNS} from agent_channel_messages where tenant_id = $1 and id = $2`,
        [tenant, id],
      );
      const row = rows.rows[0];
      return row ? toMessage(row) : null;
    });
  }

  async list(tenantId: string, q: { after: number; limit: number; threadId?: string | undefined }) {
    const tenant = requireTenant(tenantId);
    return withChannelTenant(this.pool, tenant, async (db) => {
      const rows = await db.query<MessageRow>(
        `select ${MESSAGE_COLUMNS} from agent_channel_messages
         where tenant_id = $1 and seq > $2 and ($3::uuid is null or thread_id = $3)
         order by seq asc
         limit $4`,
        [tenant, q.after, q.threadId ?? null, q.limit],
      );
      return rows.rows.map(toMessage);
    });
  }

  async maxSeq(tenantId: string) {
    const tenant = requireTenant(tenantId);
    return withChannelTenant(this.pool, tenant, async (db) => {
      const rows = await db.query<{ seq: string | number }>(
        "select coalesce(max(seq), 0) as seq from agent_channel_messages where tenant_id = $1",
        [tenant],
      );
      return asSeq(rows.rows[0]?.seq ?? 0);
    });
  }

  async ack(tenantId: string, rec: Omit<AckRecord, "at">) {
    const tenant = requireTenant(tenantId);
    const at = this.now();
    return withChannelTenant(this.pool, tenant, async (db) => {
      const rows = await db.query<{ principal_id: string; handle: string; up_to_seq: string | number; acked_at: Date }>(
        `insert into agent_channel_acks (tenant_id, principal_id, handle, up_to_seq, acked_at)
         values ($1, $2, $3, $4, $5)
         on conflict (tenant_id, principal_id) do update
           set up_to_seq = greatest(agent_channel_acks.up_to_seq, excluded.up_to_seq),
               handle = excluded.handle,
               acked_at = excluded.acked_at
         returning principal_id, handle, up_to_seq, acked_at`,
        [tenant, rec.principalId, rec.handle, rec.upToSeq, at],
      );
      const row = rows.rows[0];
      if (!row) throw new ChannelError("CONFLICT", "Ack was not stored");
      const upToSeq = asSeq(row.up_to_seq);
      await db.query(
        `update agent_channel_deliveries d
         set state = 'acked', updated_at = $3
         from agent_channel_messages m
         where d.tenant_id = $1 and d.recipient_principal_id = $2
           and m.id = d.message_id and m.tenant_id = d.tenant_id
           and m.seq <= $4 and d.state <> 'acked'`,
        [tenant, rec.principalId, at, upToSeq],
      );
      return { principalId: row.principal_id, handle: row.handle, upToSeq, at: row.acked_at.toISOString() };
    });
  }

  async acks(tenantId: string) {
    const tenant = requireTenant(tenantId);
    return withChannelTenant(this.pool, tenant, async (db) => {
      const rows = await db.query<{ principal_id: string; handle: string; up_to_seq: string | number; acked_at: Date }>(
        `select principal_id, handle, up_to_seq, acked_at from agent_channel_acks
         where tenant_id = $1 order by handle`,
        [tenant],
      );
      return rows.rows.map((row) => ({
        principalId: row.principal_id,
        handle: row.handle,
        upToSeq: asSeq(row.up_to_seq),
        at: row.acked_at.toISOString(),
      }));
    });
  }

  async markDelivered(tenantId: string, recipientId: string, messageIds: readonly string[]) {
    if (messageIds.length === 0) return;
    const tenant = requireTenant(tenantId);
    await withChannelTenant(this.pool, tenant, async (db) => {
      await db.query(
        `update agent_channel_deliveries
         set state = 'delivered', updated_at = $4
         where tenant_id = $1 and recipient_principal_id = $2
           and message_id = any($3::uuid[]) and state = 'pending'`,
        [tenant, recipientId, messageIds, this.now()],
      );
    });
  }

  async deliveries(tenantId: string, messageIds?: readonly string[]) {
    if (messageIds && messageIds.length === 0) return [];
    const tenant = requireTenant(tenantId);
    return withChannelTenant(this.pool, tenant, async (db) => {
      const rows = await db.query<{
        message_id: string;
        seq: string | number;
        recipient_principal_id: string;
        handle: string;
        state: DeliveryState;
        updated_at: Date;
      }>(
        `select d.message_id, m.seq, d.recipient_principal_id, d.handle, d.state, d.updated_at
         from agent_channel_deliveries d
         join agent_channel_messages m on m.id = d.message_id and m.tenant_id = d.tenant_id
         where d.tenant_id = $1 and ($2::uuid[] is null or d.message_id = any($2::uuid[]))
         order by m.seq, d.handle`,
        [tenant, messageIds ?? null],
      );
      return rows.rows.map((row) => ({
        messageId: row.message_id,
        seq: asSeq(row.seq),
        recipientId: row.recipient_principal_id,
        handle: row.handle,
        state: DeliveryState.parse(row.state),
        updatedAt: row.updated_at.toISOString(),
      }));
    });
  }

  async threads(tenantId: string): Promise<ThreadSummary[]> {
    const tenant = requireTenant(tenantId);
    return withChannelTenant(this.pool, tenant, async (db) => {
      const rows = await db.query<{ thread_id: string; count: string | number; last_seq: string | number; handle: string }>(
        `select thread_id, count(*)::int as count, max(seq) as last_seq,
                (array_agg(handle order by seq desc))[1] as handle
         from agent_channel_messages
         where tenant_id = $1
         group by thread_id
         order by max(seq) desc
         limit $2`,
        [tenant, THREAD_INDEX_LIMIT],
      );
      return rows.rows.map((row) => ({
        threadId: row.thread_id,
        count: asSeq(row.count),
        lastSeq: asSeq(row.last_seq),
        handle: row.handle,
      }));
    });
  }

  private async lookup(db: pg.PoolClient, tenantId: string, principalId: string, key: string) {
    const rows = await db.query<MessageRow>(
      `select ${MESSAGE_COLUMNS} from agent_channel_messages
       where tenant_id = $1 and author_principal_id = $2 and idempotency_key = $3`,
      [tenantId, principalId, key],
    );
    const row = rows.rows[0];
    return row ? toMessage(row) : null;
  }
}

/** Room membership from agent_channel_members. The role is not granted any other schema. */
export class PostgresAgentRegistry implements AgentRegistry {
  constructor(private readonly pool: pg.Pool) {}

  async handleFor(context: TenantContext): Promise<string | null> {
    const parsed = TenantContext.parse(context);
    return withChannelTenant(this.pool, parsed.tenantId, async (db) => {
      const rows = await db.query<{ handle: string }>(
        `select handle from agent_channel_members where tenant_id = $1 and principal_id = $2`,
        [parsed.tenantId, parsed.principal.id],
      );
      return rows.rows[0]?.handle ?? null;
    });
  }

  async members(tenantId: string): Promise<RoomMember[]> {
    const tenant = requireTenant(tenantId);
    return withChannelTenant(this.pool, tenant, async (db) => {
      const rows = await db.query<{ principal_id: string; handle: string }>(
        `select principal_id, handle from agent_channel_members where tenant_id = $1 order by handle`,
        [tenant],
      );
      return rows.rows.map((row) => ({ principalId: row.principal_id, handle: row.handle }));
    });
  }
}
