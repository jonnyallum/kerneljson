-- KJ-P4A - Telegram operator channel: durable inbox and poll offset.
--
-- PREPARED ONLY. NOT APPLIED TO PRODUCTION BY THIS CHANGE - same convention as
-- 20260917120000_notification_outbox.sql: written and tested against a disposable Postgres, and
-- applied to production only in a separate, explicitly authorised change window (see
-- docs/operations/KJ_P4A_TELEGRAM_OPERATOR_CHANNEL.md).
--
-- The channel adapter is NOT an authority. These tables hold only what the adapter needs to be
-- replay-safe: which Telegram updates it has already handled, and how far it has read. Tasks,
-- evidence and outcomes remain solely in the existing ledger; nothing here can create or complete one.
--
-- kernel_private.telegram_inbox: one row per Telegram update that reached the adapter as a command
-- from the allow-listed chat, keyed by Telegram's own update_id. The row is claimed (RECEIVED) before
-- any work and closed (DONE) after, so a crash between the two is resumed, never repeated: the door's
-- idempotency key is derived from update_id, so even a resumed admission converges on ONE task.
-- The message text is never stored, only its sha256, so a mistyped secret cannot end up in the database.
create table kernel_private.telegram_inbox (
  update_id bigint primary key check (update_id >= 0),
  received_at timestamptz not null,
  state text not null check (state in ('RECEIVED','DONE')),
  command text check (command in ('STATUS','MISSION','TASK','MALFORMED')),
  disposition text check (disposition in ('ADMITTED','ANSWERED','MALFORMED','RATE_LIMITED','CAP_EXCEEDED','ADMISSION_FAILED')),
  -- True only for a mission the door admitted; this is what the per-day mission cap counts.
  mission boolean not null default false,
  task_id uuid,
  reply_notification_id text,
  text_sha256 text not null check (text_sha256 ~ '^[a-f0-9]{64}$'),
  completed_at timestamptz,
  check ((state = 'DONE') = (disposition is not null and completed_at is not null)),
  check (not mission or disposition = 'ADMITTED'),
  check (disposition is distinct from 'ADMITTED' or task_id is not null)
);
-- The rate window and the daily cap both scan by time.
create index telegram_inbox_received on kernel_private.telegram_inbox(received_at);

alter table kernel_private.telegram_inbox enable row level security;
revoke all on kernel_private.telegram_inbox from public, anon, authenticated;

-- kernel_private.telegram_operator_state: a single row. next_offset is the getUpdates offset to ask
-- for next (Telegram redelivers everything below it until acknowledged, so it advances only after a
-- batch is fully handled and never moves backwards). unauthorised_total counts updates from anyone
-- other than the allow-listed chat: counted, never answered, never stored.
create table kernel_private.telegram_operator_state (
  singleton boolean primary key default true check (singleton),
  next_offset bigint not null default 0 check (next_offset >= 0),
  unauthorised_total bigint not null default 0 check (unauthorised_total >= 0),
  updated_at timestamptz not null default now()
);
insert into kernel_private.telegram_operator_state(singleton) values (true);

alter table kernel_private.telegram_operator_state enable row level security;
revoke all on kernel_private.telegram_operator_state from public, anon, authenticated;
