create table kernel_private.control_events (
 id uuid primary key, task_id uuid not null references kernel_private.execution_bindings(task_id),
 principal_id uuid not null references public.principals,
 contract jsonb not null, occurred_at timestamptz not null default clock_timestamp()
);
alter table kernel_private.control_events enable row level security;
revoke all on kernel_private.control_events from public, anon, authenticated;
create trigger control_events_immutable before update or delete on kernel_private.control_events for each row execute function public.reject_ledger_mutation();
create trigger control_events_no_truncate before truncate on kernel_private.control_events for each statement execute function public.reject_ledger_mutation();
create table kernel_private.task_admissions (
 task_id uuid primary key references kernel_private.execution_bindings(task_id),
 tenant_id uuid not null references public.tenants, principal_id uuid not null references public.principals,
 key_digest text not null check(key_digest ~ '^[a-f0-9]{64}$'),
 request_digest text not null check(request_digest ~ '^[a-f0-9]{64}$'), payload jsonb not null,
 unique(tenant_id,principal_id,key_digest)
);
create table kernel_private.dispatch_events (
 id uuid primary key, task_id uuid not null references kernel_private.task_admissions,
 status text not null check(status in ('REQUESTED','ACCEPTED','UNRESOLVED')),
 invocation_id text, occurred_at timestamptz not null default clock_timestamp()
);
do $$ declare t text; begin
 foreach t in array array['task_admissions','dispatch_events'] loop
  execute format('alter table kernel_private.%I enable row level security',t);
  execute format('revoke all on kernel_private.%I from public, anon, authenticated',t);
  execute format('create trigger %I before update or delete on kernel_private.%I for each row execute function public.reject_ledger_mutation()',t||'_immutable',t);
  execute format('create trigger %I before truncate on kernel_private.%I for each statement execute function public.reject_ledger_mutation()',t||'_no_truncate',t);
 end loop;
end $$;
