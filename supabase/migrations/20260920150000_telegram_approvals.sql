-- KJ-P4B - Telegram approvals: the adapter's durable memory of approval cards and button presses.
--
-- PREPARED ONLY. NOT APPLIED TO PRODUCTION BY THIS CHANGE - same convention as the KJ-P4A and outbox
-- migrations: written and tested against a disposable Postgres, and applied to production only in a
-- separate, explicitly authorised change window (see docs/operations/KJ_P4B_TELEGRAM_APPROVALS.md).
--
-- These tables are NOT an approval authority. An approval lives in public.approvals and is resolved
-- only by the ApprovalStore, inside the policy workflow, for the named approver, against the exact
-- scope digest, before the DB-clock expiry. Nothing here can grant, deny, expire or cancel one, and
-- nothing here is read to decide whether an approval is valid. They only remember which approvals
-- were shown in Telegram (so each is shown once), which opaque button handle means what, and which
-- button presses were already handled (so a Telegram redelivery cannot act twice).
--
-- kernel_private.telegram_approval_cards: one row per approval shown (or about to be shown) in the
-- chat, keyed by the approval id. The scope digest and expiry are COPIED from the ledger's own
-- POLICY_CHECKED event when the card is created, so the value the adapter later forwards to the door
-- is the ledger's, never something typed or carried back by Telegram.
create table kernel_private.telegram_approval_cards (
  approval_id uuid primary key references public.approvals(id),
  task_id uuid not null references public.tasks(id),
  tenant_id uuid not null,
  scope_digest text not null check (scope_digest ~ '^[a-f0-9]{64}$'),
  invocation_digest text not null check (invocation_digest ~ '^[a-f0-9]{64}$'),
  capability text not null check (capability ~ '^[a-zA-Z0-9._/-]{1,80}$'),
  expires_at timestamptz not null,
  state text not null check (state in ('QUEUED','SENDING','SENT','RESOLVED')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  claimed_at timestamptz,
  message_id bigint,
  created_at timestamptz not null,
  sent_at timestamptz,
  resolved_at timestamptz,
  check (state <> 'SENT' or message_id is not null),
  check ((state = 'RESOLVED') = (resolved_at is not null))
);
create index telegram_approval_cards_open on kernel_private.telegram_approval_cards(state) where state <> 'RESOLVED';

alter table kernel_private.telegram_approval_cards enable row level security;
revoke all on kernel_private.telegram_approval_cards from public, anon, authenticated;

-- kernel_private.telegram_approval_handles: the two buttons of a card. The callback data Telegram
-- carries is `kj1:<handle>`, an unguessable random token, and NOTHING else: the decision, the task
-- and the digest are looked up here, server side. So a forged, edited or replayed-from-another-card
-- callback either names no row or names a row bound to a different card, and is refused.
create table kernel_private.telegram_approval_handles (
  handle text primary key check (handle ~ '^[A-Za-z0-9_-]{22}$'),
  approval_id uuid not null references kernel_private.telegram_approval_cards(approval_id),
  decision text not null check (decision in ('GRANTED','DENIED')),
  unique (approval_id, decision)
);

alter table kernel_private.telegram_approval_handles enable row level security;
revoke all on kernel_private.telegram_approval_handles from public, anon, authenticated;

-- kernel_private.telegram_callback_inbox: one row per button press that reached the adapter from the
-- allow-listed chat, keyed by Telegram's own update_id, claimed (RECEIVED) before any work and closed
-- (DONE) after. A redelivered update is therefore handled once. The callback data itself is never
-- stored, only which approval it resolved to and what happened.
create table kernel_private.telegram_callback_inbox (
  update_id bigint primary key check (update_id >= 0),
  received_at timestamptz not null,
  state text not null check (state in ('RECEIVED','DONE')),
  disposition text check (disposition in (
    'UNKNOWN_HANDLE','WRONG_MESSAGE','EXPIRED','RESOLVED','ALREADY_RESOLVED','DOOR_REFUSED','UNAVAILABLE','NOT_FOUND'
  )),
  approval_id uuid,
  pressed text check (pressed in ('GRANTED','DENIED')),
  completed_at timestamptz,
  check ((state = 'DONE') = (disposition is not null and completed_at is not null))
);

alter table kernel_private.telegram_callback_inbox enable row level security;
revoke all on kernel_private.telegram_callback_inbox from public, anon, authenticated;
