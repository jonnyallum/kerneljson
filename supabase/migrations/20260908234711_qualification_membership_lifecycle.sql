alter table public.tenant_memberships add column status text not null default 'ACTIVE' check(status in ('ACTIVE','REVOKED','REMOVED'));
alter table public.tenant_memberships add column status_changed_at timestamptz not null default clock_timestamp();
create table kernel_private.membership_events (
 id bigint generated always as identity primary key,
 membership_id uuid not null,
 tenant_id uuid not null,
 principal_id uuid not null,
 previous jsonb not null, current jsonb not null,
 database_actor text not null, occurred_at timestamptz not null default clock_timestamp()
);
alter table kernel_private.membership_events enable row level security;
revoke all on kernel_private.membership_events from public, anon, authenticated;
create trigger membership_events_immutable before update or delete on kernel_private.membership_events for each row execute function public.reject_ledger_mutation();
create trigger membership_events_no_truncate before truncate on kernel_private.membership_events for each statement execute function public.reject_ledger_mutation();
create function kernel_private.membership_change() returns trigger language plpgsql set search_path='' as $$
begin
 if new.id<>old.id or new.tenant_id<>old.tenant_id or new.principal_id<>old.principal_id then raise exception 'membership identity is immutable'; end if;
 if new.status<>old.status or new.role<>old.role then
  new.status_changed_at=clock_timestamp();
  insert into kernel_private.membership_events(membership_id,tenant_id,principal_id,previous,current,database_actor) values(old.id,old.tenant_id,old.principal_id,jsonb_build_object('status',old.status,'role',old.role),jsonb_build_object('status',new.status,'role',new.role),current_user);
 end if;
 return new;
end $$;
create trigger membership_change before update on public.tenant_memberships for each row execute function kernel_private.membership_change();
revoke execute on function kernel_private.membership_change() from public;
