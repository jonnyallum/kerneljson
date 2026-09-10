create trigger evaluations_immutable before update or delete on public.evaluations
for each row execute function public.reject_ledger_mutation();
create trigger evaluations_no_truncate before truncate on public.evaluations
for each statement execute function public.reject_ledger_mutation();
create index evaluations_task_version on public.evaluations(task_id,evaluator_version,created_at desc);
