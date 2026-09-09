-- Gate 1 backend-only authority metadata; not a scheduler or job queue.
create schema kernel_private;
revoke all on schema kernel_private from public, anon, authenticated;
create table kernel_private.execution_bindings (
 task_id uuid primary key,
 tenant_id uuid not null references public.tenants,
 principal_id uuid not null references public.principals,
 contract jsonb not null,
 check(contract->>'taskId'=task_id::text and contract->>'tenantId'=tenant_id::text and contract->'principal'->>'id'=principal_id::text)
);
alter table kernel_private.execution_bindings enable row level security;
create trigger execution_bindings_immutable before update or delete on kernel_private.execution_bindings for each row execute function public.reject_ledger_mutation();
create trigger execution_bindings_no_truncate before truncate on kernel_private.execution_bindings for each statement execute function public.reject_ledger_mutation();
revoke all on kernel_private.execution_bindings from public, anon, authenticated;
