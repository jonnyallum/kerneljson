import type pg from "pg";
import {
  isValidRequest,
  mintHandle,
  type ApprovalCard,
  type ApprovalRequest,
  type ApprovalStatus,
  type CardState,
  type Decision,
  type Handles,
} from "./approval-cards.js";
import type { CallbackDisposition, CardStore, CardToClose, CardToSend } from "./card-store.js";

/** Postgres implementation of the card store (see `supabase/migrations/20260920150000_telegram_approvals.sql`). */
interface CardRow {
  approval_id: string;
  task_id: string;
  tenant_id: string;
  scope_digest: string;
  invocation_digest: string;
  capability: string;
  expires_at: Date;
  state: CardState;
  attempt_count: number;
  claimed_at: Date | null;
  message_id: string | null;
}

const CARD_COLUMNS =
  "c.approval_id, c.task_id, c.tenant_id, c.scope_digest, c.invocation_digest, c.capability, c.expires_at, c.state, c.attempt_count, c.claimed_at, c.message_id";

const toCard = (r: CardRow): ApprovalCard => ({
  approvalId: r.approval_id,
  taskId: r.task_id,
  tenantId: r.tenant_id,
  scopeDigest: r.scope_digest,
  invocationDigest: r.invocation_digest,
  capability: r.capability,
  expiresAt: r.expires_at.toISOString(),
  state: r.state,
  attemptCount: r.attempt_count,
  claimedAt: r.claimed_at ? r.claimed_at.toISOString() : null,
  messageId: r.message_id === null ? null : Number(r.message_id),
});

interface PendingRow {
  approval_id: string;
  task_id: string;
  tenant_id: string;
  scope_digest: unknown;
  invocation_digest: unknown;
  capability: unknown;
  expires_at: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export class PgCardStore implements CardStore {
  constructor(private readonly pool: pg.Pool) {}

  async discover(input: { tenantId: string; approverId: string; now: string; limit: number }): Promise<number> {
    // Read the ledger's own record of each pending approval that has no card yet. The scope digest,
    // invocation digest, capability and deadline all come from the POLICY_CHECKED event the
    // ApprovalStore wrote, so what is shown and later forwarded is the ledger's, not anything else's.
    const pending = await this.pool.query<PendingRow>(
      `select a.id as approval_id, a.task_id, t.tenant_id,
              e.payload->'evaluation'->>'scopeDigest' as scope_digest,
              e.payload->'evaluation'->'scope'->>'invocationDigest' as invocation_digest,
              e.payload->'evaluation'->'scope'->'capability'->>'id' as capability,
              e.payload->'evaluation'->>'expiresAt' as expires_at
         from public.approvals a
         join public.tasks t on t.id = a.task_id
         join public.task_events e on e.task_id = a.task_id and e.event_key = 'policy-approval:' || a.id::text
        where a.status = 'PENDING'
          -- Only once the workflow is actually waiting for the answer, never in the instant between
          -- the approval being recorded and the task reaching APPROVAL_REQUIRED.
          and t.status::text = 'APPROVAL_REQUIRED'
          and a.requested_from = $1::uuid
          and t.tenant_id = $2::uuid
          and not exists (select 1 from kernel_private.telegram_approval_cards c where c.approval_id = a.id)
        order by a.requested_at
        limit $3`,
      [input.approverId, input.tenantId, input.limit],
    );
    let created = 0;
    for (const row of pending.rows) {
      const request: ApprovalRequest = {
        approvalId: row.approval_id,
        taskId: row.task_id,
        tenantId: row.tenant_id,
        scopeDigest: str(row.scope_digest),
        invocationDigest: str(row.invocation_digest),
        capability: str(row.capability),
        expiresAt: str(row.expires_at),
      };
      // An approval that cannot be shown faithfully is never shown. It stays answerable through the
      // door directly; the adapter simply does not put a button on something it cannot describe.
      if (!isValidRequest(request)) continue;
      const db = await this.pool.connect();
      try {
        await db.query("begin");
        const inserted = await db.query(
          `insert into kernel_private.telegram_approval_cards
             (approval_id, task_id, tenant_id, scope_digest, invocation_digest, capability, expires_at, state, created_at)
           values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::timestamptz, 'QUEUED', $8::timestamptz)
           on conflict (approval_id) do nothing
           returning approval_id`,
          [
            request.approvalId,
            request.taskId,
            request.tenantId,
            request.scopeDigest,
            request.invocationDigest,
            request.capability,
            request.expiresAt,
            input.now,
          ],
        );
        if (inserted.rowCount === 1) {
          for (const decision of ["GRANTED", "DENIED"] as const) {
            await db.query(
              "insert into kernel_private.telegram_approval_handles(handle, approval_id, decision) values ($1, $2::uuid, $3)",
              [mintHandle(), request.approvalId, decision],
            );
          }
          created++;
        }
        await db.query("commit");
      } catch (error) {
        await db.query("rollback").catch(() => {});
        throw error;
      } finally {
        db.release();
      }
    }
    return created;
  }

  async claimToSend(input: { now: string; staleMs: number; maxAttempts: number; limit: number }): Promise<CardToSend[]> {
    const claimed = await this.pool.query<CardRow>(
      `update kernel_private.telegram_approval_cards c
          set state = 'SENDING', attempt_count = c.attempt_count + 1, claimed_at = $1::timestamptz
        where c.approval_id in (
              select approval_id from kernel_private.telegram_approval_cards
               where expires_at > $1::timestamptz
                 and attempt_count < $3
                 and (state = 'QUEUED'
                      or (state = 'SENDING' and claimed_at < $1::timestamptz - ($2::bigint * interval '1 millisecond')))
               order by created_at
               limit $4
                 for update skip locked)
        returning ${CARD_COLUMNS}`,
      [input.now, input.staleMs, input.maxAttempts, input.limit],
    );
    const out: CardToSend[] = [];
    for (const row of claimed.rows) {
      const handles = await this.handlesFor(row.approval_id);
      if (handles) out.push({ card: toCard(row), handles });
    }
    return out;
  }

  private async handlesFor(approvalId: string): Promise<Handles | null> {
    const r = await this.pool.query<{ handle: string; decision: Decision }>(
      "select handle, decision from kernel_private.telegram_approval_handles where approval_id = $1::uuid",
      [approvalId],
    );
    const granted = r.rows.find((h) => h.decision === "GRANTED")?.handle;
    const denied = r.rows.find((h) => h.decision === "DENIED")?.handle;
    return granted && denied ? { granted, denied } : null;
  }

  async markSent(approvalId: string, messageId: number, now: string): Promise<void> {
    // Only a card that is still being sent becomes SENT: a card settled meanwhile stays settled.
    await this.pool.query(
      `update kernel_private.telegram_approval_cards
          set state = 'SENT', message_id = $2::bigint, sent_at = $3::timestamptz
        where approval_id = $1::uuid and state = 'SENDING'`,
      [approvalId, messageId, now],
    );
  }

  async releaseUnsent(approvalId: string): Promise<void> {
    await this.pool.query(
      "update kernel_private.telegram_approval_cards set state = 'QUEUED' where approval_id = $1::uuid and state = 'SENDING'",
      [approvalId],
    );
  }

  async listToClose(input: { now: string; limit: number }): Promise<CardToClose[]> {
    const r = await this.pool.query<CardRow & { approval_status: ApprovalStatus }>(
      `select ${CARD_COLUMNS}, a.status as approval_status
         from kernel_private.telegram_approval_cards c
         join public.approvals a on a.id = c.approval_id
        where c.state <> 'RESOLVED'
          and (a.status <> 'PENDING' or c.expires_at <= $1::timestamptz)
        order by c.created_at
        limit $2`,
      [input.now, input.limit],
    );
    return r.rows.map((row) => ({
      card: toCard(row),
      // A pending approval past its deadline can no longer be granted: the store refuses on the DB clock.
      status: row.approval_status === "PENDING" ? "EXPIRED" : row.approval_status,
    }));
  }

  async markResolved(approvalId: string, now: string): Promise<void> {
    await this.pool.query(
      `update kernel_private.telegram_approval_cards
          set state = 'RESOLVED', resolved_at = $2::timestamptz
        where approval_id = $1::uuid and state <> 'RESOLVED'`,
      [approvalId, now],
    );
  }

  async byHandle(handle: string): Promise<{ card: ApprovalCard; decision: Decision } | null> {
    const r = await this.pool.query<CardRow & { decision: Decision }>(
      `select ${CARD_COLUMNS}, h.decision
         from kernel_private.telegram_approval_handles h
         join kernel_private.telegram_approval_cards c on c.approval_id = h.approval_id
        where h.handle = $1`,
      [handle],
    );
    const row = r.rows[0];
    return row ? { card: toCard(row), decision: row.decision } : null;
  }

  async statusOf(approvalId: string): Promise<ApprovalStatus | null> {
    const r = await this.pool.query<{ status: ApprovalStatus }>("select status from public.approvals where id = $1::uuid", [approvalId]);
    return r.rows[0]?.status ?? null;
  }

  async claimCallback(input: { updateId: number; now: string }): Promise<{ state: "RECEIVED" | "DONE" }> {
    await this.pool.query(
      `insert into kernel_private.telegram_callback_inbox(update_id, received_at, state)
       values ($1::bigint, $2::timestamptz, 'RECEIVED')
       on conflict (update_id) do nothing`,
      [input.updateId, input.now],
    );
    const r = await this.pool.query<{ state: "RECEIVED" | "DONE" }>(
      "select state from kernel_private.telegram_callback_inbox where update_id = $1::bigint",
      [input.updateId],
    );
    const row = r.rows[0];
    if (!row) throw new Error("telegram callback row missing after claim");
    return { state: row.state };
  }

  async completeCallback(input: {
    updateId: number;
    disposition: CallbackDisposition;
    approvalId: string | null;
    pressed: Decision | null;
    now: string;
  }): Promise<void> {
    await this.pool.query(
      `update kernel_private.telegram_callback_inbox
          set state = 'DONE', disposition = $2, approval_id = $3::uuid, pressed = $4, completed_at = $5::timestamptz
        where update_id = $1::bigint and state = 'RECEIVED'`,
      [input.updateId, input.disposition, input.approvalId, input.pressed, input.now],
    );
  }
}
