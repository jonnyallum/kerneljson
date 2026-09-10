-- Preserve legacy outcomes semantics while making every terminal task readable.
create table kernel_private.terminal_results (
 task_id uuid primary key references public.tasks,
 contract jsonb not null
);
create function kernel_private.record_terminal_result() returns trigger language plpgsql set search_path='' as $$
begin
 if new.status in ('FAILED','CANCELLED') then
  insert into kernel_private.terminal_results(task_id,contract) values(new.id,jsonb_build_object(
   'taskId',new.id,'status',new.status,'acceptanceResults',(select jsonb_agg(jsonb_build_object('criterion',x,'passed',false,'evidenceRefs','[]'::jsonb)) from jsonb_array_elements_text(new.contract->'acceptanceCriteria') x),
   'evidenceRefs','[]'::jsonb,'summary','Task '||lower(new.status::text)||'; no completion evidence asserted',
   'completedAt',coalesce(new.contract->>'completedAt',to_char(new.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))) on conflict(task_id) do nothing;
 end if;
 return new;
end $$;
create trigger task_terminal_result after insert or update on public.tasks for each row execute function kernel_private.record_terminal_result();
create table kernel_private.effect_receipts (
 task_id uuid not null references public.tasks, operation_id uuid not null, step_id uuid not null,
 disposition text not null check(disposition in ('UNRESOLVED','CONFIRMED')),
 evidence_id uuid, created_at timestamptz not null default clock_timestamp(),
 primary key(task_id,operation_id,disposition),
 foreign key(step_id,task_id) references public.task_steps(id,task_id),
 foreign key(evidence_id,task_id) references public.evidence(id,task_id),
 check((disposition='CONFIRMED')=(evidence_id is not null))
);
do $$ declare t text; begin
 foreach t in array array['terminal_results','effect_receipts'] loop
  execute format('alter table kernel_private.%I enable row level security',t);
  execute format('revoke all on kernel_private.%I from public, anon, authenticated',t);
  execute format('create trigger %I before update or delete on kernel_private.%I for each row execute function public.reject_ledger_mutation()',t||'_immutable',t);
  execute format('create trigger %I before truncate on kernel_private.%I for each statement execute function public.reject_ledger_mutation()',t||'_no_truncate',t);
 end loop;
end $$;
revoke execute on function kernel_private.record_terminal_result() from public;
