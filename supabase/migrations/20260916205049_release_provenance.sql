-- One transactional serialization point for binding insertion and activation.
-- Epoch 0 is the explicit pre-activation baseline, NOT a fabricated release.
create table kernel_private.release_epoch (
 singleton boolean primary key default true check(singleton),
 epoch bigint not null check(epoch >= 0)
);
insert into kernel_private.release_epoch values(true,0);
create table kernel_private.release_activations (
 epoch bigint primary key check(epoch > 0),
 request_id uuid not null unique,
 release_id text not null check(release_id ~ '^[A-Za-z0-9._:-]{1,160}$'),
 previous_release_id text,
 activated_at timestamptz not null,
 created_by text not null,
 evidence jsonb not null check(jsonb_typeof(evidence) = 'object' and evidence <> '{}'::jsonb)
);
alter table kernel_private.release_epoch enable row level security;
alter table kernel_private.release_activations enable row level security;
revoke all on kernel_private.release_epoch, kernel_private.release_activations from public, anon, authenticated, service_role;
create trigger release_activations_immutable before update or delete on kernel_private.release_activations
 for each row execute function public.reject_ledger_mutation();
create trigger release_activations_no_truncate before truncate on kernel_private.release_activations
 for each statement execute function public.reject_ledger_mutation();

-- ALTER TABLE holds ACCESS EXCLUSIVE through migration commit: all existing rows
-- are definitively before installation of the insert trigger. Do not backfill time.
alter table kernel_private.execution_bindings
 add column release_epoch bigint not null default 0 check(release_epoch >= 0),
 add column persisted_at timestamptz;
create index execution_bindings_release_epoch on kernel_private.execution_bindings(release_epoch);

create function kernel_private.stamp_binding_provenance() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
 -- A real UPDATE (not SELECT FOR UPDATE) invalidates stale repeatable-read
 -- snapshots. Lock survives until the outer binding transaction commits/aborts.
 update kernel_private.release_epoch set epoch=epoch where singleton
 returning epoch into new.release_epoch;
 if not found then raise exception 'Missing canonical release epoch'; end if;
 new.persisted_at := clock_timestamp(); -- audit only, never used for ordering
 return new;
end $$;
revoke all on function kernel_private.stamp_binding_provenance() from public, anon, authenticated, service_role;
create trigger execution_bindings_provenance before insert on kernel_private.execution_bindings
 for each row execute function kernel_private.stamp_binding_provenance();

-- Operator-only entry point; never called at process startup or by the scheduler.
-- expected_epoch is a compare-and-swap guard; request_id makes uncertain retries safe.
create function kernel_private.activate_release(p_request_id uuid, p_release_id text,
 p_expected_epoch bigint, p_evidence jsonb) returns bigint
language plpgsql security invoker set search_path = '' as $$
declare current_epoch bigint; prior text; existing kernel_private.release_activations;
begin
 update kernel_private.release_epoch set epoch=epoch where singleton returning epoch into current_epoch;
 if not found then raise exception 'Missing canonical release epoch'; end if;
 select * into existing from kernel_private.release_activations where request_id=p_request_id;
 if found then
  if existing.release_id is distinct from p_release_id or existing.evidence is distinct from p_evidence
     or existing.epoch - 1 is distinct from p_expected_epoch then
   raise exception 'Activation request conflict';
  end if;
  return existing.epoch; -- Never reactivate a historical retry.
 end if;
 if p_expected_epoch is distinct from current_epoch then raise exception 'Stale release epoch'; end if;
 select release_id into prior from kernel_private.release_activations where epoch=current_epoch;
 update kernel_private.release_epoch set epoch=epoch+1 where singleton returning epoch into current_epoch;
 insert into kernel_private.release_activations(epoch,request_id,release_id,previous_release_id,activated_at,created_by,evidence)
 values(current_epoch,p_request_id,p_release_id,prior,clock_timestamp(),current_user,p_evidence);
 return current_epoch;
end $$;
revoke all on function kernel_private.activate_release(uuid,text,bigint,jsonb) from public, anon, authenticated, service_role;
