-- KJ-P2.1 — reliable notification delivery: outbox + delivery audit log.
--
-- PREPARED ONLY. NOT APPLIED TO PRODUCTION IN THIS PHASE — same convention as
-- 20260915220000_alert_state.sql and 20260910180000_scheduler.sql: written
-- and tested against a throwaway/disposable Postgres, never applied here.
-- Production activation is a separate, future, explicitly authorised change
-- window (see docs/operations/KJ_P2.1_RELIABLE_NOTIFICATION_DELIVERY.md).
--
-- Problem this closes: services/kernel/src/alerting/engine.ts used to
-- persist AlertStateRow (including last_notified_at) before any transport
-- delivery was attempted. A crash or transport failure between that commit
-- and delivery could silently lose a notification: the episode was already
-- marked notified, so the reducer's own dedup (see reducer.ts) correctly
-- refuses to re-emit a decision for the same still-open episode. Alert
-- EPISODE identity (kernel_private.alert_state, keyed by fingerprint) and
-- notification DELIVERY (this file) are deliberately separate concerns:
-- episode dedup must never depend on whether a specific delivery attempt
-- ever left the process.
--
-- kernel_private.notification_outbox — one row per notification INTENT. A
-- (fingerprint, first_seen_at, kind, occurrence_count) tuple is "one specific
-- thing worth telling someone about" (see services/kernel/src/alerting/outbox.ts's
-- deriveNotificationId): fingerprint alone recurs across separate episodes
-- after a recovery, so first_seen_at pins this to one episode, and
-- kind+occurrence_count pin it to one moment within that episode.
--
-- Written in the SAME transaction as the alert_state upsert that produced it
-- (see pg-state-store.ts's putAll) — intent persistence and state
-- persistence commit atomically, so a crash right after that commit can
-- never leave "state says notified" without a durable, replayable intent
-- behind it.
create table kernel_private.notification_outbox (
  notification_id text primary key,
  fingerprint text not null,
  check_id text not null,
  entity_id text not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  kind text not null check (kind in ('NEW','ESCALATED','DEESCALATED','RECOVERED')),
  occurrence_count integer not null check (occurrence_count > 0),
  severity text not null check (severity in ('P0','P1','P2','P3')),
  message text not null,
  -- Only meaningful for kind='RECOVERED'.
  duration_ms bigint,
  status text not null check (status in ('PENDING','SENDING','DELIVERED','POISON')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  created_at timestamptz not null,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz not null,
  delivered_at timestamptz,
  last_error text,
  check (kind = 'RECOVERED' or duration_ms is null),
  check (status = 'DELIVERED' or delivered_at is null),
  check (status != 'DELIVERED' or delivered_at is not null),
  unique (fingerprint, first_seen_at, kind, occurrence_count)
);
-- The delivery worker's hot path: PENDING rows due now, oldest first.
create index notification_outbox_due on kernel_private.notification_outbox(status, next_attempt_at);
-- Recovering abandoned SENDING rows ("crash after delivery, before
-- acknowledgement" — see outbox.ts's recoverIfStaleSending).
create index notification_outbox_sending on kernel_private.notification_outbox(status, last_attempt_at) where status = 'SENDING';

alter table kernel_private.notification_outbox enable row level security;
revoke all on kernel_private.notification_outbox from public, anon, authenticated;

-- kernel_private.notification_delivery_events — append-only audit log, one
-- row per delivery ATTEMPT outcome (not one row per outbox intent). Mirrors
-- the mutable-current-state-table + immutable-history-table convention used
-- elsewhere in this schema (e.g. tasks/task_events): the outbox row is the
-- current snapshot; this is the full history. Exists so "poison/permanent
-- failures become visible operational state" is a real, queryable answer —
-- what happened on every attempt, not just the outbox row's latest
-- attempt_count/last_error.
create table kernel_private.notification_delivery_events (
  id bigint generated always as identity primary key,
  notification_id text not null references kernel_private.notification_outbox(notification_id),
  attempt_number integer not null check (attempt_number > 0),
  attempted_at timestamptz not null,
  outcome text not null check (outcome in ('DELIVERED','TRANSIENT_FAILURE','PERMANENT_FAILURE','AMBIGUOUS_RECOVERED')),
  error_class text,
  transport text not null
);
create index notification_delivery_events_notification_id on kernel_private.notification_delivery_events(notification_id);

alter table kernel_private.notification_delivery_events enable row level security;
revoke all on kernel_private.notification_delivery_events from public, anon, authenticated;
