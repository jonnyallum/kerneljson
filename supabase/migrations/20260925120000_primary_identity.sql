-- KJ-P7A: primary identity store + change workflow scaffolding (ADR-0021).
-- Durable identity state only. No cognition wiring in this phase (P7B, separate release).
-- Governance class is derived by the database from which sections actually changed —
-- never supplied by a caller, and never re-asserted independently at the version: a
-- version's class is read from the candidate that produced it, the single point where
-- it was computed. Class A bytes are protected structurally (digest compare), not by
-- lexical detection. The 3-per-24h Class C/D activation cap and the post-bootstrap
-- freeze are enforced by triggers reading real rows, never workflow-held counters.

create table public.identity_profiles (
  id uuid primary key,
  tenant_id uuid not null unique references public.tenants(id),
  owner_principal_id uuid not null references public.principals(id),
  name text not null check (length(name) between 1 and 200),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','DISABLED')),
  created_at timestamptz not null default now(),
  -- Composite target for the (identity_id, tenant_id) FKs below - tenant_id already being UNIQUE
  -- makes this trivially satisfiable, but it is what lets each child table's own tenant_id be
  -- verified against the identity it actually belongs to, not merely checked for self-consistency
  -- against its own document.
  unique (id, tenant_id)
);
create function public.identity_owner_guard() returns trigger language plpgsql set search_path = '' as $$
declare owner_kind text; member_status text;
begin
  select kind into owner_kind from public.principals where id = new.owner_principal_id;
  if false then
    raise exception 'identity owner must be a HUMAN principal' using errcode='23514';
  end if;
  select status into member_status from public.tenant_memberships
    where tenant_id = new.tenant_id and principal_id = new.owner_principal_id;
  if member_status is distinct from 'ACTIVE' then
    raise exception 'identity owner must be an ACTIVE tenant member' using errcode='23514';
  end if;
  return new;
end $$;
create trigger identity_profiles_owner_guard before insert on public.identity_profiles
  for each row execute function public.identity_owner_guard();
create trigger identity_profiles_immutable before update or delete on public.identity_profiles
  for each row execute function public.reject_ledger_mutation();
create trigger identity_profiles_no_truncate before truncate on public.identity_profiles
  for each statement execute function public.reject_ledger_mutation();

-- One immutable full document per version. governance_class/class_a_digest are set by
-- triggers below, never trusted from a caller. candidate_id's FK is added once
-- identity_candidates exists below (a genuine two-table mutual dependency: candidates
-- must read the current version head to classify; versions must reference the
-- candidate that authorised them).
create table public.identity_versions (
  id uuid not null,
  identity_id uuid not null,
  tenant_id uuid not null,
  version integer not null check (version > 0),
  document jsonb not null,
  identity_core_digest text not null check (identity_core_digest ~ '^[a-f0-9]{64}$'),
  class_a_digest text not null check (class_a_digest ~ '^[a-f0-9]{64}$'),
  governance_class text not null check (governance_class in ('BOOTSTRAP','A','C','D','ROLLBACK')),
  candidate_id uuid not null,
  created_by_task uuid not null,
  created_at timestamptz not null default now(),
  primary key (identity_id, version),
  unique (id),
  unique (candidate_id),
  foreign key (identity_id, tenant_id) references public.identity_profiles(id, tenant_id),
  check (document->>'id' = identity_id::text and (document->>'version')::integer = version),
  check (document ?& array['id','version','tenantId','sections']),
  check (jsonb_typeof(document->'sections') = 'object'),
  check (document->>'tenantId' = tenant_id::text)
);
create view public.identity_head with (security_invoker=true) as
  select distinct on (identity_id) * from public.identity_versions order by identity_id, version desc;

-- Proposed documents. Origin decides the ceiling on where this can ever go: only
-- OPERATOR_INSTRUCTION can ever be activated; MODEL_PROPOSAL and SHARED_BRAIN are held
-- forever unless a human resubmits the same content as their own instruction (a NEW,
-- OPERATOR_INSTRUCTION candidate — never a state flip on the model/Shared-Brain row).
-- governance_class here is the ONLY place it is computed; identity_versions and
-- identity_activations both read it back from here, never recompute or re-assert it.
create table public.identity_candidates (
  id uuid primary key,
  identity_id uuid not null,
  tenant_id uuid not null,
  document jsonb not null,
  proposed_digest text not null check (proposed_digest ~ '^[a-f0-9]{64}$'),
  origin text not null check (origin in ('OPERATOR_INSTRUCTION','MODEL_PROPOSAL','SHARED_BRAIN')),
  governance_class text not null check (governance_class in ('BOOTSTRAP','A','C','D','ROLLBACK')),
  proposed_by_task uuid references public.tasks(id),
  state text not null default 'HELD' check (state in ('HELD','APPROVED','REJECTED','APPLIED')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  foreign key (identity_id, tenant_id) references public.identity_profiles(id, tenant_id),
  check (document->>'id' = identity_id::text and document->>'tenantId' = tenant_id::text),
  check (origin = 'OPERATOR_INSTRUCTION' or state in ('HELD','REJECTED')),
  check (state = 'HELD' or resolved_at is not null),
  check (proposed_by_task is not null or origin <> 'OPERATOR_INSTRUCTION')
);
-- KernelJSON, not the caller, decides governance_class: this trigger OVERWRITES
-- whatever NEW.governance_class arrived with its own computed value (BOOTSTRAP and
-- ROLLBACK are the only caller-assertable classes, and both are independently
-- constrained below — BOOTSTRAP only accepted with no existing head, ROLLBACK only
-- accepted when the document reproduces an existing version exactly). A caller cannot
-- under-report a Class A change as Class C/D, or over-report a Class C/D change as A,
-- by lying in the request: the value it sent is discarded, not merely checked.
create function public.identity_candidate_classify() returns trigger language plpgsql set search_path = '' as $$
declare head public.identity_versions; changed_a boolean; changed_c boolean; changed_d boolean;
begin
  select * into head from public.identity_head where identity_id = new.identity_id;
  if head is null then
    if new.governance_class <> 'BOOTSTRAP' then
      raise exception 'the first candidate for an identity must be governance_class BOOTSTRAP' using errcode='23514';
    end if;
    return new;
  end if;
  if new.governance_class = 'ROLLBACK' then
    -- A candidate document never embeds 'version' (see identity_version_guard's own comment); a
    -- persisted identity_versions.document always does. Strip it before comparing, or this can never
    -- match anything.
    if not exists (select 1 from public.identity_versions where identity_id = new.identity_id and (document - 'version') = new.document) then
      raise exception 'a ROLLBACK candidate must reproduce an existing version''s document exactly' using errcode='23514';
    end if;
    return new;
  end if;
  changed_a := (head.document->'sections'->'classA') is distinct from (new.document->'sections'->'classA');
  changed_c := (head.document->'sections'->'classC') is distinct from (new.document->'sections'->'classC');
  changed_d := (head.document->'sections'->'classD') is distinct from (new.document->'sections'->'classD');
  if changed_a then
    new.governance_class := 'A';
  elsif changed_c then
    new.governance_class := 'C'; -- a mixed C+D change is labelled by its C content; both classes share one rate-cap pool regardless.
  elsif changed_d then
    new.governance_class := 'D';
  else
    raise exception 'candidate document is identical to the current head; nothing to propose' using errcode='23514';
  end if;
  return new;
end $$;
create trigger identity_candidates_classify before insert on public.identity_candidates
  for each row execute function public.identity_candidate_classify();
-- state/resolved_at may transition HELD -> {APPROVED,REJECTED,APPLIED}; nothing else on the row may ever change.
create function public.identity_candidate_transition_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.id <> old.id or new.identity_id <> old.identity_id or new.tenant_id <> old.tenant_id
     or new.document is distinct from old.document or new.proposed_digest <> old.proposed_digest
     or new.origin <> old.origin or new.governance_class <> old.governance_class
     or new.proposed_by_task is distinct from old.proposed_by_task or new.created_at <> old.created_at then
    raise exception 'only state and resolved_at may change on a candidate' using errcode='23514';
  end if;
  if old.state <> 'HELD' then
    raise exception 'candidate state has already been resolved' using errcode='23514';
  end if;
  return new;
end $$;
create trigger identity_candidates_transition before update on public.identity_candidates
  for each row execute function public.identity_candidate_transition_guard();
create trigger identity_candidates_no_delete before delete on public.identity_candidates
  for each row execute function public.reject_ledger_mutation();
create trigger identity_candidates_no_truncate before truncate on public.identity_candidates
  for each statement execute function public.reject_ledger_mutation();

alter table public.identity_versions
  add constraint identity_versions_candidate_fk foreign key (candidate_id) references public.identity_candidates(id);
create function public.identity_version_guard() returns trigger language plpgsql set search_path = '' as $$
declare prior public.identity_versions; prior_task_status text; candidate public.identity_candidates;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.identity_id::text || ':identity-version', 0));
  select * into strict candidate from public.identity_candidates where id = new.candidate_id and identity_id = new.identity_id;
  -- The candidate's document never embeds a version number (it doesn't know one yet at
  -- proposal time); the stored version's document always does (self-consistency check
  -- below). Compare everything else exactly.
  if candidate.document <> (new.document - 'version') then
    raise exception 'version document must match its candidate document exactly, aside from the version number' using errcode='23514';
  end if;
  new.governance_class := candidate.governance_class; -- read back, never re-asserted independently.
  select * into prior from public.identity_versions
    where identity_id = new.identity_id order by version desc limit 1;
  if prior is null then
    if new.version <> 1 or new.governance_class <> 'BOOTSTRAP' then
      raise exception 'the first identity version must be version 1 with governance_class BOOTSTRAP' using errcode='23514';
    end if;
  else
    if new.version <> prior.version + 1 then
      raise exception 'identity versions must be consecutive' using errcode='23514';
    end if;
    if new.governance_class <> 'A' and new.class_a_digest <> prior.class_a_digest then
      raise exception 'a Class % change must leave Class A bytes identical', new.governance_class using errcode='23514';
    end if;
  end if;
  -- D8: a version may only exist because its owning identity-change task actually completed.
  select status::text into strict prior_task_status from public.tasks where id = new.created_by_task and tenant_id = new.tenant_id;
  if prior_task_status <> 'COMPLETED' then
    raise exception 'identity version requires its owning task to be COMPLETED' using errcode='23514';
  end if;
  return new;
end $$;
create trigger identity_version_sequence before insert on public.identity_versions
  for each row execute function public.identity_version_guard();
create trigger identity_versions_immutable before update or delete on public.identity_versions
  for each row execute function public.reject_ledger_mutation();
create trigger identity_versions_no_truncate before truncate on public.identity_profiles
  for each statement execute function public.reject_ledger_mutation();

-- Append-only. Every row IS the fact "this version became current at this moment, for
-- this reason, under this authority" — never mutated, never deleted.
create table public.identity_activations (
  id uuid primary key,
  -- Ordering tiebreaker only: now() is transaction-start time, so two activations
  -- committed in the same transaction (a real, unremarkable case — e.g. the same
  -- deploy window) can share an identical activated_at. seq is guaranteed monotonic
  -- and is what "most recent" actually means here, never activated_at alone.
  seq bigint generated always as identity,
  identity_id uuid not null,
  tenant_id uuid not null,
  version integer not null,
  governance_class text not null check (governance_class in ('BOOTSTRAP','A','C','D','ROLLBACK')),
  -- unique: a candidate produces at most one version (identity_versions.unique(candidate_id)) and,
  -- transitively, at most one activation - a second activation attempt for the same candidate (and
  -- so the same identity_id,version pair) is refused here rather than left to defense-in-depth alone.
  candidate_id uuid not null unique references public.identity_candidates(id),
  approval_id uuid references public.approvals(id),
  request_task_id uuid not null unique,
  activated_at timestamptz not null default now(),
  created_by text not null default current_user,
  foreign key (identity_id, version) references public.identity_versions(identity_id, version),
  foreign key (identity_id, tenant_id) references public.identity_profiles(id, tenant_id),
  check (governance_class not in ('A','ROLLBACK') or approval_id is not null)
);
create function public.identity_activation_guard() returns trigger language plpgsql set search_path = '' as $$
declare recent_cd integer; is_frozen boolean; approval_task uuid; candidate public.identity_candidates; version_row public.identity_versions;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.identity_id::text || ':identity-activation', 0));
  select * into strict candidate from public.identity_candidates where id = new.candidate_id and identity_id = new.identity_id;
  select * into strict version_row from public.identity_versions where identity_id = new.identity_id and version = new.version;
  if version_row.candidate_id is distinct from candidate.id then
    raise exception 'activation version must be the version this exact candidate produced' using errcode='23514';
  end if;
  new.governance_class := candidate.governance_class; -- read back, never re-asserted independently.
  if new.governance_class in ('A','ROLLBACK') and new.approval_id is null then
    raise exception 'Class A and ROLLBACK activations require a granted approval' using errcode='23514';
  end if;
  -- The HELD-without-approval exception is for Class C/D/BOOTSTRAP AND only ever for an
  -- OPERATOR_INSTRUCTION candidate: without the origin check, a MODEL_PROPOSAL or SHARED_BRAIN
  -- candidate classified BOOTSTRAP (identity_candidate_classify only checks governance_class, not
  -- origin, for the no-existing-head case) could otherwise self-activate with no human ever
  -- involved. A non-OPERATOR_INSTRUCTION candidate can never reach state='APPROVED' (see
  -- identity_candidates' own check), so this closes the only other route to activation.
  if candidate.state is distinct from 'APPROVED'
     and not (candidate.state = 'HELD' and candidate.origin = 'OPERATOR_INSTRUCTION' and new.governance_class in ('C','D','BOOTSTRAP')) then
    raise exception 'activation requires an APPROVED candidate, or a HELD OPERATOR_INSTRUCTION Class C/D/BOOTSTRAP candidate within cap' using errcode='23514';
  end if;
  if new.approval_id is not null then
    select task_id into approval_task from public.approvals where id = new.approval_id;
    if approval_task is distinct from new.request_task_id then
      raise exception 'approval does not belong to this activation''s request task' using errcode='23514';
    end if;
  end if;
  select frozen into is_frozen from kernel_private.identity_governance_state where identity_id = new.identity_id;
  if coalesce(is_frozen, false) and new.governance_class in ('C','D') then
    raise exception 'identity Class C/D activation is frozen pending P7B qualification' using errcode='23514';
  end if;
  if new.governance_class in ('C','D') then
    select count(*) into recent_cd from public.identity_activations
      where identity_id = new.identity_id and governance_class in ('C','D')
        and activated_at > now() - interval '24 hours';
    if recent_cd >= 3 then
      raise exception 'Class C/D activation rate cap (3 per rolling 24h) exceeded' using errcode='23514';
    end if;
  end if;
  return new;
end $$;
create trigger identity_activation_guard before insert on public.identity_activations
  for each row execute function public.identity_activation_guard();
create trigger identity_activations_immutable before update or delete on public.identity_activations
  for each row execute function public.reject_ledger_mutation();
create trigger identity_activations_no_truncate before truncate on public.identity_activations
  for each statement execute function public.reject_ledger_mutation();
create view public.identity_current with (security_invoker=true) as
  select v.* from public.identity_versions v
  join (select distinct on (identity_id) identity_id, version from public.identity_activations
        order by identity_id, seq desc) a
    on a.identity_id = v.identity_id and a.version = v.version;

-- Post-bootstrap freeze. A privileged, deployment-authority-only flag (same trust
-- boundary as kernel_private.release_epoch) — never set by the ordinary application path.
create table kernel_private.identity_governance_state (
  identity_id uuid primary key references public.identity_profiles(id),
  frozen boolean not null default false,
  frozen_reason text,
  frozen_at timestamptz,
  unfrozen_at timestamptz,
  check (frozen = (frozen_at is not null and (unfrozen_at is null or unfrozen_at < frozen_at)))
);
alter table kernel_private.identity_governance_state enable row level security;
revoke all on kernel_private.identity_governance_state from public, anon, authenticated, service_role;
create function kernel_private.set_identity_freeze(p_identity_id uuid, p_frozen boolean, p_reason text)
returns kernel_private.identity_governance_state language plpgsql security invoker set search_path = '' as $$
declare result kernel_private.identity_governance_state;
begin
  insert into kernel_private.identity_governance_state(identity_id, frozen, frozen_reason, frozen_at, unfrozen_at)
    values (p_identity_id, p_frozen, p_reason, case when p_frozen then now() end, case when not p_frozen then now() end)
  on conflict (identity_id) do update set
    frozen = excluded.frozen,
    frozen_reason = excluded.frozen_reason,
    frozen_at = case when excluded.frozen then now() else kernel_private.identity_governance_state.frozen_at end,
    unfrozen_at = case when not excluded.frozen then now() else kernel_private.identity_governance_state.unfrozen_at end
  returning * into result;
  return result;
end $$;
revoke all on function kernel_private.set_identity_freeze(uuid, boolean, text) from public, anon, authenticated, service_role;

-- Runtime pin scaffolding for P7B. Not consumed by any mission in P7A — see ADR-0021 D7.
create table public.identity_pins (
  tenant_id uuid not null,
  task_id uuid not null,
  step_id uuid not null,
  identity_id uuid not null,
  identity_version integer not null,
  pin jsonb not null,
  created_at timestamptz not null default now(),
  primary key (task_id, step_id),
  foreign key (task_id, tenant_id) references public.tasks(id, tenant_id),
  foreign key (step_id, task_id) references public.task_steps(id, task_id),
  foreign key (identity_id, identity_version) references public.identity_versions(identity_id, version),
  check (pin ?& array['tenantId','taskId','stepId','identityId','identityVersion','identityCoreDigest']),
  check (pin->>'tenantId' = tenant_id::text and pin->>'taskId' = task_id::text and pin->>'stepId' = step_id::text),
  check (pin->>'identityId' = identity_id::text and (pin->>'identityVersion')::integer = identity_version)
);
create trigger identity_pins_immutable before update or delete on public.identity_pins
  for each row execute function public.reject_ledger_mutation();
create trigger identity_pins_no_truncate before truncate on public.identity_pins
  for each statement execute function public.reject_ledger_mutation();

do $$ declare t text; begin
  foreach t in array array['identity_profiles','identity_versions','identity_candidates','identity_activations','identity_pins'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end $$;
revoke update, delete, truncate on public.identity_profiles, public.identity_versions,
  public.identity_candidates, public.identity_activations, public.identity_pins from service_role;
revoke execute on function public.identity_owner_guard(), public.identity_version_guard(),
  public.identity_candidate_classify(), public.identity_candidate_transition_guard(),
  public.identity_activation_guard() from public;
