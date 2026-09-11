-- Phase S1 — production scheduler durable state (PREP; NOT YET APPLIED).
-- This lives in the KernelJSON kernel's OWN database (schema `public` here is the
-- kernel's private authority DB, distinct from the legacy Brain's public.actions).
-- The scheduler is subordinate: it decides WHEN an admission request is emitted;
-- KernelJSON Admission owns whether canonical work exists. These tables never mint.
--
-- CORE INVARIANT (DB-enforced, not app-only):
--   (schedule_id, schedule_version, fire_window_key) identifies ONE logical fire.
--   A retry / restart / duplicate wake / lost ack / second worker cannot create a
--   second canonical fire — the unique constraint below makes a second insert fail
--   and resolve to the existing row.

-- DB-enforced enums: unknown/invalid policy or state values cannot be persisted.
create type public.schedule_lifecycle_state as enum ('enabled','paused','disabled');
create type public.schedule_fire_state as enum
  ('PLANNED','ADMISSION_PENDING','ADMITTED','SKIPPED','FAILED','CANCELLED');
create type public.schedule_missed_run_policy as enum ('SKIP','RUN_ONCE','BACKLOG_BOUNDED');
create type public.schedule_overlap_policy as enum ('FORBID','QUEUE','REPLACE');
create type public.schedule_nonexistent_time_policy as enum ('SKIP','SHIFT_FORWARD');
create type public.schedule_backfill_status as enum ('PREVIEW','APPROVED','EXECUTED','REJECTED');
create type public.schedule_observation_kind as enum
  ('MISS','OVERLAP','FAILURE','REPLAY','AUTHORITY','LEASE_RECOVERED');

-- Immutable, versioned spec. A SEMANTIC change is a new (schedule_id, version) row.
create table public.schedule_specs (
  schedule_id uuid not null,
  version text not null,
  tenant_id uuid not null references public.tenants,
  principal_id uuid not null references public.principals,
  owner_id uuid not null references public.principals,
  name text not null check (length(name) between 1 and 200),
  timezone text not null check (length(timezone) between 1 and 64),
  calendar jsonb not null check (jsonb_typeof(calendar) = 'object'),
  missed_run_policy public.schedule_missed_run_policy not null,
  overlap_policy public.schedule_overlap_policy not null,
  nonexistent_time_policy public.schedule_nonexistent_time_policy not null default 'SHIFT_FORWARD',
  max_backfill_runs integer not null check (max_backfill_runs between 0 and 100),
  per_schedule_concurrency integer not null check (per_schedule_concurrency between 1 and 50),
  enabled_for_production boolean not null default false,
  created_at timestamptz not null,
  created_by uuid not null references public.principals,
  primary key (schedule_id, version),
  foreign key (tenant_id, principal_id) references public.tenant_memberships(tenant_id, principal_id),
  check (missed_run_policy <> 'BACKLOG_BOUNDED' or max_backfill_runs >= 1)
);

-- Current lifecycle state. Toggling enabled/paused/disabled is NOT a version change.
create table public.schedule_state (
  schedule_id uuid primary key,
  state public.schedule_lifecycle_state not null default 'disabled',
  active_version text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid not null references public.principals,
  foreign key (schedule_id, active_version) references public.schedule_specs(schedule_id, version)
);

-- One logical fire. THE core invariant is the unique (schedule_id, version, fire_window_key).
create table public.schedule_fires (
  idempotency_key text primary key,               -- scheduleId|version|fireWindowKey
  schedule_id uuid not null,
  schedule_version text not null,
  fire_window_key text not null,
  fire_identity uuid not null unique,             -- content-derived admission-request identity
  fire_at_utc timestamptz not null,
  state public.schedule_fire_state not null default 'PLANNED',
  admission_request_id uuid,
  -- S1-R Option B: bind the canonical ADMISSION identity, which exists synchronously
  -- once KernelJSON Admission (POST /v1/tasks) succeeds. public.tasks is downstream
  -- materialisation and MUST NOT gate the fire's record of the canonical child task id.
  admitted_child_task_id uuid references kernel_private.task_admissions(task_id),
  admission_result jsonb check (admission_result is null or jsonb_typeof(admission_result) = 'object'),
  admitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (schedule_id, schedule_version) references public.schedule_specs(schedule_id, version),
  unique (schedule_id, schedule_version, fire_window_key),   -- <= no second canonical fire
  check ((state = 'ADMITTED') = (admitted_child_task_id is not null)),
  check (idempotency_key = schedule_id::text || '|' || schedule_version || '|' || fire_window_key)
);
create index schedule_fires_due_idx on public.schedule_fires (schedule_id, fire_at_utc);

-- Bind-once: once a fire is bound to a child task, that binding is immutable.
-- A retry offering a DIFFERENT task id must FAIL CLOSED (never overwrite).
create or replace function public.schedule_fire_bind_once() returns trigger as $$
begin
  if old.admitted_child_task_id is not null
     and new.admitted_child_task_id is distinct from old.admitted_child_task_id then
    raise exception 'schedule fire % already bound to %, refusing rebind to %',
      old.idempotency_key, old.admitted_child_task_id, new.admitted_child_task_id;
  end if;
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;
create trigger schedule_fire_bind_once_trg
  before update on public.schedule_fires
  for each row execute function public.schedule_fire_bind_once();

-- Audited, bounded backfill. No unbounded range; no self-approval.
create table public.schedule_backfill_requests (
  id uuid primary key,
  schedule_id uuid not null,
  schedule_version text not null,
  requested_by uuid not null references public.principals,
  requested_from timestamptz not null,
  requested_to timestamptz not null,
  computed_windows integer not null check (computed_windows >= 0),
  max_runs integer not null check (max_runs between 1 and 100),
  preview_digest text not null check (preview_digest ~ '^[a-f0-9]{8,64}$'),
  status public.schedule_backfill_status not null default 'PREVIEW',
  approved_by uuid references public.principals,
  created_at timestamptz not null default now(),
  executed_at timestamptz,
  foreign key (schedule_id, schedule_version) references public.schedule_specs(schedule_id, version),
  check (requested_to >= requested_from),
  check (computed_windows <= max_runs),
  check (status in ('PREVIEW','REJECTED') or approved_by is not null),   -- no approval => cannot advance
  check (approved_by is null or approved_by <> requested_by)              -- no self-approval
);

-- Operator-visible observations. Never task authority.
create table public.schedule_observations (
  id uuid primary key,
  schedule_id uuid not null,
  idempotency_key text,
  kind public.schedule_observation_kind not null,
  detail jsonb not null check (jsonb_typeof(detail) = 'object'),
  created_at timestamptz not null default now()
);
create index schedule_observations_sched_idx on public.schedule_observations (schedule_id, created_at);

-- Bounded claim/lease so a crashed worker cannot orphan a schedule. Recovery is a
-- lease takeover after expiry (epoch bump), NOT a new task.
create table public.schedule_leases (
  schedule_id uuid primary key,
  owner text not null,
  epoch integer not null default 0,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- Row-level security. These six tables are KernelJSON's private authority state, so
-- they follow the SAME convention as every other kernel table (see identity /
-- task_ledger migrations): RLS ENABLED (deny-by-default, NO policies) AND all grants
-- REVOKED from the public API roles. Result: anon/authenticated have zero access.
-- The kernel's own privileged DB path (superuser / service_role, which bypasses RLS)
-- is unaffected — there are deliberately NO permissive public policies here. Tenant-
-- scoped scheduler policies, if ever wanted, are a separate future authority decision.
do $$ declare t text; begin
  foreach t in array array[
    'schedule_specs','schedule_state','schedule_fires',
    'schedule_backfill_requests','schedule_observations','schedule_leases'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
