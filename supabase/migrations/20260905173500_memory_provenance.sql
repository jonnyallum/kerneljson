-- Append-only result memory; expiration is part of the immutable observation.
create trigger memory_items_immutable before update or delete on public.memory_items
for each row execute function public.reject_ledger_mutation();
create trigger memory_items_no_truncate before truncate on public.memory_items
for each statement execute function public.reject_ledger_mutation();
create index memory_tenant_observed on public.memory_items(tenant_id,observed_at desc,id);
