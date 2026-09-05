alter table public.relationships add column task_id uuid, add column evidence_id uuid;
alter table public.relationships add constraint relationships_task_tenant_fk
foreign key(task_id,tenant_id) references public.tasks(id,tenant_id);
alter table public.relationships add constraint relationships_evidence_task_fk
foreign key(evidence_id,task_id) references public.evidence(id,task_id);
-- Enforce for new rows; historical rows can remain distinguishable and excluded.
alter table public.relationships add constraint relationships_require_provenance
check(task_id is not null and evidence_id is not null) not valid;
do $$ declare t text; begin
  foreach t in array array['entities','relationships','observations'] loop
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.reject_ledger_mutation()',t||'_immutable',t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.reject_ledger_mutation()',t||'_no_truncate',t);
  end loop;
end $$;
create index observations_tenant_entity_time on public.observations(tenant_id,entity_id,observed_at desc,id);
create index relationships_tenant_source on public.relationships(tenant_id,source_id,id);
