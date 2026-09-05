create table public.entities (
  id uuid primary key, tenant_id uuid not null references public.tenants, identity_key text not null,
  type text not null, created_at timestamptz not null default now(), unique(tenant_id,identity_key), unique(id,tenant_id)
);
create table public.relationships (
  id uuid primary key, tenant_id uuid not null references public.tenants,
  source_id uuid not null, target_id uuid not null, type text not null,
  created_at timestamptz not null default now(),
  foreign key(source_id,tenant_id) references public.entities(id,tenant_id),
  foreign key(target_id,tenant_id) references public.entities(id,tenant_id)
);
create table public.observations (
  id uuid primary key, tenant_id uuid not null references public.tenants, entity_id uuid not null,
  task_id uuid not null, evidence_id uuid not null, source text not null, value jsonb not null,
  observed_at timestamptz not null, valid_from timestamptz not null, valid_until timestamptz,
  confidence numeric not null check(confidence >= 0 and confidence <= 1),
  foreign key(entity_id,tenant_id) references public.entities(id,tenant_id),
  foreign key(task_id,tenant_id) references public.tasks(id,tenant_id),
  foreign key(evidence_id,task_id) references public.evidence(id,task_id), check(valid_until > valid_from)
);
create index observations_entity_time on public.observations(entity_id,observed_at);
create index relationships_target on public.relationships(target_id);
do $$ declare t text; begin
  foreach t in array array['entities','relationships','observations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
