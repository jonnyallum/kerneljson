import type pg from "pg";
import type { CommandKind, CompleteInput, Disposition, InboxRow, InboxStore } from "./inbox-store.js";

/** Postgres implementation of the adapter's inbox (see `supabase/migrations/20260920120000_telegram_operator.sql`). */
export class PgInboxStore implements InboxStore {
  constructor(private readonly pool: pg.Pool) {}

  async offset(): Promise<number> {
    const r = await this.pool.query<{ next_offset: string }>("select next_offset from kernel_private.telegram_operator_state where singleton");
    return Number(r.rows[0]?.next_offset ?? 0);
  }

  async advanceOffset(next: number, unauthorisedDelta: number, now: string): Promise<void> {
    // greatest(): the offset can only move forward, whatever order calls arrive in.
    await this.pool.query(
      `update kernel_private.telegram_operator_state
          set next_offset = greatest(next_offset, $1::bigint),
              unauthorised_total = unauthorised_total + $2::bigint,
              updated_at = $3::timestamptz
        where singleton`,
      [next, unauthorisedDelta, now],
    );
  }

  async claim(input: { updateId: number; now: string; textSha256: string }): Promise<InboxRow> {
    await this.pool.query(
      `insert into kernel_private.telegram_inbox(update_id, received_at, state, text_sha256)
       values ($1::bigint, $2::timestamptz, 'RECEIVED', $3)
       on conflict (update_id) do nothing`,
      [input.updateId, input.now, input.textSha256],
    );
    const r = await this.pool.query<{
      update_id: string;
      state: "RECEIVED" | "DONE";
      command: CommandKind | null;
      disposition: Disposition | null;
      mission: boolean;
      task_id: string | null;
      reply_notification_id: string | null;
      received_at: Date;
    }>(
      `select update_id, state, command, disposition, mission, task_id, reply_notification_id, received_at
         from kernel_private.telegram_inbox where update_id = $1::bigint`,
      [input.updateId],
    );
    const row = r.rows[0];
    if (!row) throw new Error("telegram inbox row missing after claim");
    return {
      updateId: Number(row.update_id),
      state: row.state,
      command: row.command,
      disposition: row.disposition,
      mission: row.mission,
      taskId: row.task_id,
      replyNotificationId: row.reply_notification_id,
      receivedAt: row.received_at.toISOString(),
    };
  }

  async countRecent(sinceIso: string, excludeUpdateId: number): Promise<number> {
    const r = await this.pool.query<{ n: number }>(
      `select count(*)::int n from kernel_private.telegram_inbox
        where received_at > $1::timestamptz and update_id <> $2::bigint and disposition is distinct from 'RATE_LIMITED'`,
      [sinceIso, excludeUpdateId],
    );
    return r.rows[0]!.n;
  }

  async hasRecentRateNotice(sinceIso: string): Promise<boolean> {
    const r = await this.pool.query<{ found: boolean }>(
      `select exists(select 1 from kernel_private.telegram_inbox
        where disposition = 'RATE_LIMITED' and reply_notification_id is not null and received_at > $1::timestamptz) found`,
      [sinceIso],
    );
    return r.rows[0]!.found;
  }

  async countMissionsSince(sinceIso: string, excludeUpdateId: number): Promise<number> {
    const r = await this.pool.query<{ n: number }>(
      `select count(*)::int n from kernel_private.telegram_inbox
        where mission and received_at >= $1::timestamptz and update_id <> $2::bigint`,
      [sinceIso, excludeUpdateId],
    );
    return r.rows[0]!.n;
  }

  async complete(input: CompleteInput): Promise<void> {
    const r = await this.pool.query(
      `update kernel_private.telegram_inbox
          set state = 'DONE', command = $2, disposition = $3, mission = $4, task_id = $5::uuid,
              reply_notification_id = $6, completed_at = $7::timestamptz
        where update_id = $1::bigint`,
      [input.updateId, input.command, input.disposition, input.mission, input.taskId, input.replyNotificationId, input.now],
    );
    if (r.rowCount !== 1) throw new Error("update was never claimed");
  }
}
