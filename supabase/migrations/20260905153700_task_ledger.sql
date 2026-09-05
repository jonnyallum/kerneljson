create type public.task_status as enum ('RECEIVED','COMPILED','READY','RUNNING','WAITING','APPROVAL_REQUIRED','VERIFYING','COMPLETED','FAILED','CANCELLED');
create table public.tasks (
  id uuid primary key, tenant_id uuid not null references public.tenants,
  principal_id uuid not null references public.principals,
  parent_task_id uuid, trace_id uuid not null, status public.task_status not null default 'RECEIVED',
  contract jsonb not null check (jsonb_typeof(contract) = 'object'
    and contract ?& array['id','tenant','principal','status','acceptanceCriteria','objective','traceId','createdAt']
    and (contract->'tenant') ? 'id' and (contract->'principal') ? 'id'
    and jsonb_typeof(contract->'acceptanceCriteria') = 'array'
    and jsonb_array_length(contract->'acceptanceCriteria') > 0),
  created_at timestamptz not null, updated_at timestamptz not null default now(),
  unique (id, tenant_id), foreign key (parent_task_id, tenant_id) references public.tasks(id, tenant_id),
  foreign key (tenant_id, principal_id) references public.tenant_memberships(tenant_id, principal_id),
  check (parent_task_id <> id),
  check (contract->>'id' = id::text and contract->>'status' = status::text),
  check (contract->>'traceId' = trace_id::text),
  check (contract->'tenant'->>'id' = tenant_id::text and contract->'principal'->>'id' = principal_id::text)
);
create index tasks_tenant_status on public.tasks(tenant_id,status);
create index tasks_trace on public.tasks(trace_id);
create table public.task_steps (
  id uuid primary key, task_id uuid not null references public.tasks,
  status public.task_status not null, contract jsonb not null, created_at timestamptz not null default now(),
  unique (id, task_id), check (contract->>'taskId' = task_id::text and contract->>'id' = id::text and contract->>'status' = status::text)
);
create index task_steps_task_status on public.task_steps(task_id,status);
create table public.task_events (
  id uuid primary key, task_id uuid not null references public.tasks, step_id uuid,
  event_key text not null, request_digest text not null check (request_digest ~ '^[a-f0-9]{64}$'),
  type text not null check (type in ('TASK_CREATED','INTENT_RESOLVED','PLAN_COMPILED','POLICY_CHECKED','STEP_STARTED','MODEL_CALLED','TOOL_CALLED','EVIDENCE_RECEIVED','STEP_COMPLETED','APPROVAL_REQUESTED','APPROVAL_GRANTED','VERIFICATION_FAILED','REPLAN_TRIGGERED','TASK_COMPLETED','TASK_FAILED','LEARNING_PROPOSED','TASK_READY','TASK_STARTED','TASK_WAITING','TASK_RESUMED','TASK_VERIFYING','TASK_CANCELLED')),
  occurred_at timestamptz not null, actor_id uuid not null references public.principals,
  trace_id uuid not null, payload jsonb not null,
  unique(task_id,event_key), foreign key(step_id,task_id) references public.task_steps(id,task_id)
);
create index task_events_task_time on public.task_events(task_id,occurred_at);
create index task_events_trace on public.task_events(trace_id);
create function public.reject_ledger_mutation() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'immutable ledger record' using errcode = '55000'; end $$;
create trigger task_events_immutable before update or delete on public.task_events for each row execute function public.reject_ledger_mutation();
create trigger task_events_no_truncate before truncate on public.task_events for each statement execute function public.reject_ledger_mutation();
create table public.evidence (
  id uuid primary key, task_id uuid not null references public.tasks, step_id uuid,
  type text not null, source text not null, ref text, uri text, digest text check (digest ~ '^[a-f0-9]{64}$'),
  captured_at timestamptz not null, metadata jsonb not null check (jsonb_typeof(metadata) = 'object'),
  unique(id,task_id), foreign key(step_id,task_id) references public.task_steps(id,task_id),
  check (nullif(ref,'') is not null or nullif(uri,'') is not null or digest is not null)
);
create index evidence_task on public.evidence(task_id);
create trigger evidence_immutable before update or delete on public.evidence for each row execute function public.reject_ledger_mutation();
create trigger evidence_no_truncate before truncate on public.evidence for each statement execute function public.reject_ledger_mutation();
create table public.approvals (
  id uuid primary key, task_id uuid not null references public.tasks, step_id uuid,
  requested_from uuid not null references public.principals, requested_at timestamptz not null,
  status text not null check (status in ('PENDING','GRANTED','DENIED','EXPIRED')), resolved_at timestamptz, evidence_id uuid,
  foreign key(step_id,task_id) references public.task_steps(id,task_id),
  foreign key(evidence_id,task_id) references public.evidence(id,task_id),
  check ((status = 'PENDING' and resolved_at is null and evidence_id is null) or (status <> 'PENDING' and resolved_at is not null and resolved_at >= requested_at and evidence_id is not null))
);
create table public.artifacts (
  id uuid primary key, task_id uuid not null references public.tasks, evidence_id uuid not null,
  uri text not null, digest text not null check (digest ~ '^[a-f0-9]{64}$'), created_at timestamptz not null,
  foreign key(evidence_id,task_id) references public.evidence(id,task_id)
);
do $$ declare t text; begin
  foreach t in array array['tasks','task_steps','task_events','approvals','evidence','artifacts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
revoke update, delete, truncate on public.task_events, public.evidence from service_role;
revoke execute on function public.reject_ledger_mutation() from public;
