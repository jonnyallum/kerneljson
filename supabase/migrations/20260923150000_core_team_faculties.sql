-- KJ-P6: prepared for controlled activation; configuration is not a task authority.
create table public.faculty_versions (
  tenant_id uuid not null references public.tenants(id),
  faculty_id text not null check (faculty_id in ('primary-executive','architect','builder','operator','intelligence','archivist','guardian','verifier')),
  version integer not null check (version > 0),
  definition jsonb not null,
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  primary key(tenant_id,faculty_id,version),
  check (definition->>'tenantId'=tenant_id::text and definition->>'id'=faculty_id and (definition->>'version')::integer=version),
  check (definition ?& array['tenantId','id','version','enabled','authorityCeiling','toolPermissions','policyVersion']),
  check (definition->>'authorityCeiling'='ADVISORY_TEXT_ONLY' and definition->'toolPermissions'='[]'::jsonb),
  check (definition->>'policyVersion'='faculty-routing/v1' and jsonb_typeof(definition->'enabled')='boolean')
);
create function public.faculty_version_guard() returns trigger language plpgsql set search_path = '' as $$
declare prior integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.tenant_id::text || ':faculty:' || new.faculty_id,0));
  select coalesce(max(version),0) into prior from public.faculty_versions where tenant_id=new.tenant_id and faculty_id=new.faculty_id;
  if new.version <> prior+1 then raise exception 'faculty versions must be consecutive' using errcode='23514'; end if;
  return new;
end $$;
create trigger faculty_version_sequence before insert on public.faculty_versions for each row execute function public.faculty_version_guard();
create trigger faculty_versions_immutable before update or delete on public.faculty_versions for each row execute function public.reject_ledger_mutation();
create trigger faculty_versions_no_truncate before truncate on public.faculty_versions for each statement execute function public.reject_ledger_mutation();
create view public.faculty_current with (security_invoker=true) as
  select distinct on (tenant_id,faculty_id) * from public.faculty_versions order by tenant_id,faculty_id,version desc;

create table public.faculty_pins (
  tenant_id uuid not null,
  task_id uuid not null,
  step_id uuid not null,
  faculty_id text not null,
  faculty_version integer not null,
  pin jsonb not null,
  created_at timestamptz not null default now(),
  primary key(task_id,step_id),
  foreign key(task_id,tenant_id) references public.tasks(id,tenant_id),
  foreign key(step_id,task_id) references public.task_steps(id,task_id),
  foreign key(tenant_id,faculty_id,faculty_version) references public.faculty_versions(tenant_id,faculty_id,version),
  check (pin ?& array['tenantId','taskId','stepId','faculty','facultyDigest','routingReason','provider','model','policyVersion','operation']),
  check (pin->>'tenantId'=tenant_id::text and pin->>'taskId'=task_id::text and pin->>'stepId'=step_id::text),
  check (pin->'faculty'->>'id'=faculty_id and (pin->'faculty'->>'version')::integer=faculty_version)
);
create function public.faculty_pin_guard() returns trigger language plpgsql set search_path = '' as $$
declare f public.faculty_versions; cur public.faculty_versions; op text; task_state text; plan jsonb;
begin
  select * into strict f from public.faculty_versions where tenant_id=new.tenant_id and faculty_id=new.faculty_id and version=new.faculty_version;
  select * into strict cur from public.faculty_current where tenant_id=new.tenant_id and faculty_id=new.faculty_id;
  if not (f.definition->>'enabled')::boolean or not (cur.definition->>'enabled')::boolean
     or new.pin->'faculty' is distinct from f.definition or new.pin->>'facultyDigest' is distinct from f.digest
     or new.pin->>'policyVersion' is distinct from f.definition->>'policyVersion' then
    raise exception 'invalid or disabled faculty pin' using errcode='23514';
  end if;
  select status::text into strict task_state from public.tasks where id=new.task_id and tenant_id=new.tenant_id;
  if task_state <> 'RUNNING' then raise exception 'faculty requires running admitted task' using errcode='23514'; end if;
  select payload->'plan' into strict plan from public.task_events where task_id=new.task_id and type='PLAN_COMPILED';
  select s->>'operation' into strict op from jsonb_array_elements(plan->'steps') s where s->>'id'=new.step_id::text;
  if plan->>'recipe' <> 'repo-analysis-mission/v1' or op not in ('RUNTIME_ANALYSE','RUNTIME_REVIEW')
     or new.pin->>'operation' is distinct from op
     or new.faculty_id <> case op when 'RUNTIME_ANALYSE' then 'intelligence' else 'verifier' end
     or new.pin->>'routingReason' <> case op when 'RUNTIME_ANALYSE' then 'repo-analysis/analyst' else 'repo-analysis/independent-reviewer' end
     or not (f.definition->'permittedRecipes' ? 'repo-analysis-mission/v1')
     or not (f.definition->'permittedOperations' ? op)
     or not (f.definition->'permittedCapabilityClasses' ? 'MODEL_TEXT')
     or not (f.definition->'providerPreferences' ? (new.pin->>'provider')) then
    raise exception 'faculty cannot expand admitted plan' using errcode='23514';
  end if;
  return new;
end $$;
create trigger faculty_pin_valid before insert on public.faculty_pins for each row execute function public.faculty_pin_guard();
create trigger faculty_pins_immutable before update or delete on public.faculty_pins for each row execute function public.reject_ledger_mutation();
create trigger faculty_pins_no_truncate before truncate on public.faculty_pins for each statement execute function public.reject_ledger_mutation();
alter table public.faculty_versions enable row level security;
alter table public.faculty_pins enable row level security;
revoke all on public.faculty_versions,public.faculty_pins,public.faculty_current from public,anon,authenticated;
revoke update,delete,truncate on public.faculty_versions,public.faculty_pins from service_role;
revoke execute on function public.faculty_version_guard(),public.faculty_pin_guard() from public;
