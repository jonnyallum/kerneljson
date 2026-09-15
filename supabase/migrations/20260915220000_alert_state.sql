-- KJ-P1.2 — production alerting persistent state.
--
-- PREPARED ONLY. NOT APPLIED TO PRODUCTION IN THIS PHASE. Per the KJ-P1.2
-- authorisation: "do not mutate production during this phase unless explicitly
-- authorised later." The alert engine works fully without this table — it falls
-- back to InMemoryAlertStateStore (services/kernel/src/alerting/state-store.ts)
-- when no persistent store is configured. Applying this migration to production
-- is a separate, future, explicitly-authorised change window, exactly like the
-- scheduler migration (20260910180000_scheduler.sql) was prepared long before
-- S1 schedule enablement actually happened.
--
-- One row per (check_id, entity_id) fingerprint — the stable identity of "this
-- specific problem" (see services/kernel/src/alerting/reducer.ts). Mutable by
-- design (upserted every alert-engine run), unlike the append-only ledger
-- tables (evidence, task_events) — there is deliberately no immutability
-- trigger here.
create table kernel_private.alert_state (
  fingerprint text primary key,
  check_id text not null,
  entity_id text not null,
  severity text not null check (severity in ('P0','P1','P2','P3')),
  current_state text not null check (current_state in ('OPEN','RECOVERED')),
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  last_notified_at timestamptz,
  occurrence_count integer not null check (occurrence_count > 0),
  recovered_at timestamptz,
  check (current_state = 'RECOVERED' or recovered_at is null),
  check (current_state = 'OPEN' or recovered_at is not null)
);
create index alert_state_check_id on kernel_private.alert_state(check_id);
create index alert_state_current_state on kernel_private.alert_state(current_state);

alter table kernel_private.alert_state enable row level security;
revoke all on kernel_private.alert_state from public, anon, authenticated;
