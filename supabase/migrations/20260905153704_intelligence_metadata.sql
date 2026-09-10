create table public.capabilities (id uuid primary key, name text not null unique, created_at timestamptz not null default now());
create table public.capability_versions (
  id uuid primary key default gen_random_uuid(), capability_id uuid not null references public.capabilities,
  version text not null, contract jsonb not null, created_at timestamptz not null default now(), unique(capability_id,version)
);
create table public.capability_runs (
  id uuid primary key, task_id uuid not null references public.tasks, step_id uuid not null,
  capability_version_id uuid not null references public.capability_versions, idempotency_key text not null check(length(idempotency_key)>0),
  request_digest text not null check(request_digest ~ '^[a-f0-9]{64}$'), result jsonb not null, evidence_id uuid not null,
  created_at timestamptz not null, unique(task_id,idempotency_key),
  foreign key(step_id,task_id) references public.task_steps(id,task_id),
  foreign key(evidence_id,task_id) references public.evidence(id,task_id)
);
create table public.memory_items (
  id uuid primary key, tenant_id uuid not null references public.tenants, task_id uuid not null, evidence_id uuid not null,
  source text not null, content jsonb not null, observed_at timestamptz not null, valid_until timestamptz,
  foreign key(task_id,tenant_id) references public.tasks(id,tenant_id),
  foreign key(evidence_id,task_id) references public.evidence(id,task_id), check(valid_until > observed_at)
);
create table public.outcomes (
  id uuid primary key, task_id uuid not null unique references public.tasks,
  status public.task_status not null check(status in ('COMPLETED','FAILED','CANCELLED')),
  contract jsonb not null, completed_at timestamptz not null,
  check(contract->>'taskId' = task_id::text and contract->>'status' = status::text)
);
create table public.evaluations (
  id uuid primary key, task_id uuid not null references public.tasks, outcome_id uuid references public.outcomes,
  evaluator_version text not null, result jsonb not null, created_at timestamptz not null default now()
);
-- Deferred so event, outcome and projection can be committed atomically.
create function public.check_task_completion() returns trigger language plpgsql set search_path = '' as $$
declare o jsonb; criterion text; r jsonb;
begin
  if new.status = 'COMPLETED' then
    select contract into o from public.outcomes where task_id=new.id and status='COMPLETED';
    if o is null or jsonb_typeof(o->'evidenceRefs') is distinct from 'array'
      or jsonb_array_length(o->'evidenceRefs') = 0
      or jsonb_typeof(o->'acceptanceResults') is distinct from 'array'
      or jsonb_array_length(o->'acceptanceResults') = 0 then
      raise exception 'completion requires outcome and evidence' using errcode='23514';
    end if;
    if exists(select 1 from jsonb_array_elements_text(o->'evidenceRefs') x where not exists (
      select 1 from public.evidence e where e.task_id=new.id and e.id::text=x.value)) then
      raise exception 'completion evidence does not belong to task' using errcode='23514';
    end if;
    if jsonb_array_length(o->'acceptanceResults') <> jsonb_array_length(new.contract->'acceptanceCriteria') then
      raise exception 'acceptance criteria mismatch' using errcode='23514';
    end if;
    for criterion in select jsonb_array_elements_text(new.contract->'acceptanceCriteria') loop
      if (select count(*) from jsonb_array_elements(o->'acceptanceResults') a where a->>'criterion'=criterion) <> 1 then
        raise exception 'acceptance criterion missing or duplicated' using errcode='23514';
      end if;
    end loop;
    for r in select * from jsonb_array_elements(o->'acceptanceResults') loop
      if r->>'passed' is distinct from 'true' or jsonb_typeof(r->'evidenceRefs') is distinct from 'array'
        or jsonb_array_length(r->'evidenceRefs') = 0 or not ((o->'evidenceRefs') @> (r->'evidenceRefs')) then
        raise exception 'acceptance evidence missing' using errcode='23514';
      end if;
    end loop;
    if not exists(select 1 from public.task_events where task_id=new.id and type='TASK_COMPLETED') then
      raise exception 'completion requires audit event' using errcode='23514';
    end if;
  end if;
  return new;
end $$;
create constraint trigger task_completion_evidence after insert or update on public.tasks deferrable initially deferred for each row execute function public.check_task_completion();
create function public.check_task_transition() returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status in ('COMPLETED','FAILED','CANCELLED') then
    raise exception 'terminal task is immutable' using errcode='23514';
  end if;
  if new.status <> old.status and not (
    (old.status='RECEIVED' and new.status in ('COMPILED','FAILED','CANCELLED')) or
    (old.status='COMPILED' and new.status in ('READY','APPROVAL_REQUIRED','FAILED','CANCELLED')) or
    (old.status='READY' and new.status in ('RUNNING','FAILED','CANCELLED')) or
    (old.status='RUNNING' and new.status in ('WAITING','APPROVAL_REQUIRED','VERIFYING','FAILED','CANCELLED')) or
    (old.status='WAITING' and new.status in ('RUNNING','FAILED','CANCELLED')) or
    (old.status='APPROVAL_REQUIRED' and new.status in ('READY','RUNNING','FAILED','CANCELLED')) or
    (old.status='VERIFYING' and new.status in ('COMPLETED','FAILED','CANCELLED'))
  ) then raise exception 'invalid task transition' using errcode='23514'; end if;
  return new;
end $$;
create trigger task_transition before update on public.tasks for each row execute function public.check_task_transition();
create trigger outcomes_immutable before update or delete on public.outcomes for each row execute function public.reject_ledger_mutation();
create trigger outcomes_no_truncate before truncate on public.outcomes for each statement execute function public.reject_ledger_mutation();
create trigger capability_runs_immutable before update or delete on public.capability_runs for each row execute function public.reject_ledger_mutation();
do $$ declare t text; begin
  foreach t in array array['capabilities','capability_versions','capability_runs','memory_items','outcomes','evaluations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
revoke execute on function public.check_task_completion(), public.check_task_transition() from public;
