-- KJ-P5 - canonical memory fabric (ADR-0018, ADR-0020).
--
-- PREPARED ONLY. NOT APPLIED TO PRODUCTION BY THIS CHANGE - same convention as the earlier migrations: written
-- and tested against a disposable Postgres, and applied to production only in a separate, explicitly authorised
-- change window (see docs/operations/KJ_P5_CANONICAL_MEMORY.md).
--
-- KernelJSON owns canonical memory. A model or an external system (the Shared Brain) can only submit a CANDIDATE;
-- a deterministic policy decides; a promotion is recorded; and only then is a canonical VERSION written. These
-- tables enforce that themselves, so it holds even if application code is wrong:
--   * a canonical version cannot exist without a promotion event that names it (foreign key + trigger);
--   * a promotion that creates canonical memory cannot exist for a candidate whose origin is a model or the Shared Brain;
--   * a version's trust class must be the one its candidate's origin earns;
--   * versions, promotions, relations and context assemblies are append-only (updates and deletes are rejected);
--   * a memory's class and subject cannot change across versions, and a retracted memory cannot be built on.
-- Separate from public.memory_items (ADR-0011 result memory), which is untouched.

-- 1. Candidates: what a source PROPOSED. The state moves forward only, through the guard below.
create table public.memory_candidates (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id),
  origin text not null check (origin in ('OPERATOR_INSTRUCTION','VERIFIED_OUTCOME','MODEL_PROPOSAL','SHARED_BRAIN')),
  submitted_by uuid not null references public.principals(id),
  idempotency_key text not null check (length(idempotency_key) between 8 and 200),
  proposed_class text not null check (proposed_class in ('FACT','PREFERENCE','DECISION','COMMITMENT','LESSON','EPISODE','RELATIONSHIP','PROJECT_KNOWLEDGE')),
  intent text not null check (intent in ('NEW','CORRECT','SUPERSEDE','RETRACT')),
  target_memory_id uuid,
  content text not null check (length(content) <= 2000),
  content_digest text not null check (content_digest ~ '^[a-f0-9]{64}$'),
  subject_kind text not null check (subject_kind in ('PRINCIPAL','PROJECT','TENANT')),
  subject_ref text not null check (length(subject_ref) between 1 and 200),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) between 1 and 8),
  reason text not null check (length(reason) between 1 and 500),
  request_digest text not null check (request_digest ~ '^[a-f0-9]{64}$'),
  state text not null check (state in ('HELD','AWAITING_APPROVAL','PROMOTED','REFUSED','REJECTED')),
  state_reason text not null,
  approval_id uuid references public.approvals(id),
  created_at timestamptz not null default now(),
  decided_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  check ((intent = 'NEW') = (target_memory_id is null)),
  check (state <> 'AWAITING_APPROVAL' or approval_id is not null),
  -- A model or Shared Brain candidate can never be recorded as promoted, even by a direct insert.
  check (state <> 'PROMOTED' or origin in ('OPERATOR_INSTRUCTION','VERIFIED_OUTCOME'))
);
create index memory_candidates_tenant_state on public.memory_candidates(tenant_id, state, created_at);

create function public.memory_candidate_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'memory candidates are never deleted' using errcode = '55000'; end if;
  -- Everything about what was proposed is frozen. Only the outcome of an approval may move the state.
  if new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id or new.origin is distinct from old.origin
     or new.submitted_by is distinct from old.submitted_by or new.idempotency_key is distinct from old.idempotency_key
     or new.proposed_class is distinct from old.proposed_class or new.intent is distinct from old.intent
     or new.target_memory_id is distinct from old.target_memory_id or new.content is distinct from old.content
     or new.content_digest is distinct from old.content_digest or new.subject_kind is distinct from old.subject_kind
     or new.subject_ref is distinct from old.subject_ref or new.evidence is distinct from old.evidence
     or new.reason is distinct from old.reason or new.request_digest is distinct from old.request_digest
     or new.approval_id is distinct from old.approval_id or new.created_at is distinct from old.created_at then
    raise exception 'a memory candidate is immutable except for the outcome of its approval' using errcode = '55000';
  end if;
  if not (old.state = 'AWAITING_APPROVAL' and new.state in ('PROMOTED','REJECTED')) then
    raise exception 'invalid memory candidate transition % to %', old.state, new.state using errcode = '55000';
  end if;
  return new;
end $$;
create trigger memory_candidates_guard before update or delete on public.memory_candidates
  for each row execute function public.memory_candidate_guard();
create trigger memory_candidates_no_truncate before truncate on public.memory_candidates
  for each statement execute function public.reject_ledger_mutation();

-- 2. Promotion events: every policy decision, and the approved completion of a protected one. Append-only.
create table public.memory_promotions (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id),
  candidate_id uuid not null references public.memory_candidates(id),
  decision text not null check (decision in ('ALLOW','REQUIRE_APPROVAL','HOLD','REFUSE','ALLOW_APPROVED','REJECT_APPROVAL')),
  rule_id text not null check (length(rule_id) between 1 and 80),
  policy_version text not null check (length(policy_version) between 1 and 80),
  reason text not null check (length(reason) between 1 and 500),
  promoted_by_kind text not null check (promoted_by_kind in ('POLICY_ENGINE','APPROVED_HUMAN')),
  promoted_by_principal uuid references public.principals(id),
  approval_id uuid references public.approvals(id),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) >= 1),
  result_memory_id uuid,
  result_version integer,
  created_at timestamptz not null default now(),
  check ((decision in ('ALLOW','ALLOW_APPROVED')) = (result_memory_id is not null and result_version is not null)),
  check (decision not in ('ALLOW_APPROVED','REJECT_APPROVAL','REQUIRE_APPROVAL') or approval_id is not null)
);
create unique index memory_promotions_one_result on public.memory_promotions(candidate_id) where result_memory_id is not null;
create index memory_promotions_candidate on public.memory_promotions(candidate_id, created_at);

create function public.memory_promotion_guard() returns trigger language plpgsql as $$
declare c public.memory_candidates%rowtype;
begin
  select * into c from public.memory_candidates where id = new.candidate_id;
  if not found or c.tenant_id <> new.tenant_id then
    raise exception 'promotion must belong to its candidate''s tenant' using errcode = '23514';
  end if;
  -- The authority rule, in the database: nothing a model or the Shared Brain wrote can become canonical memory.
  if new.decision in ('ALLOW','ALLOW_APPROVED') and c.origin not in ('OPERATOR_INSTRUCTION','VERIFIED_OUTCOME') then
    raise exception 'a % candidate cannot be promoted to canonical memory', c.origin using errcode = '23514';
  end if;
  return new;
end $$;
create trigger memory_promotions_guard before insert on public.memory_promotions
  for each row execute function public.memory_promotion_guard();
create trigger memory_promotions_immutable before update or delete on public.memory_promotions
  for each row execute function public.reject_ledger_mutation();
create trigger memory_promotions_no_truncate before truncate on public.memory_promotions
  for each statement execute function public.reject_ledger_mutation();

-- 3. Canonical memory: one row per immutable version.
create table public.memory_versions (
  memory_id uuid not null,
  version integer not null check (version >= 1),
  tenant_id uuid not null references public.tenants(id),
  class text not null check (class in ('FACT','PREFERENCE','DECISION','COMMITMENT','LESSON','EPISODE','RELATIONSHIP','PROJECT_KNOWLEDGE')),
  kind text not null check (kind in ('ASSERT','RETRACT')),
  content text not null check (length(content) <= 2000),
  content_digest text not null check (content_digest ~ '^[a-f0-9]{64}$'),
  subject_kind text not null check (subject_kind in ('PRINCIPAL','PROJECT','TENANT')),
  subject_ref text not null check (length(subject_ref) between 1 and 200),
  trust_class text not null check (trust_class in ('USER_AUTHORED','INTERNAL_DERIVED','MODEL_DERIVED','UNTRUSTED_EXTERNAL')),
  confidence text not null check (confidence in ('STATED','VERIFIED','INFERRED')),
  provenance jsonb not null,
  evidence jsonb not null check (jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) >= 1),
  policy jsonb not null,
  candidate_id uuid not null references public.memory_candidates(id),
  promotion_id uuid not null references public.memory_promotions(id),
  supersedes_version integer,
  created_at timestamptz not null,
  promoted_at timestamptz not null default now(),
  primary key (memory_id, version),
  unique (promotion_id),
  foreign key (memory_id, supersedes_version) references public.memory_versions(memory_id, version),
  check ((version = 1) = (supersedes_version is null)),
  check (supersedes_version is null or supersedes_version = version - 1),
  check (kind <> 'RETRACT' or version > 1)
);
create index memory_versions_tenant_class on public.memory_versions(tenant_id, class);
create index memory_versions_subject on public.memory_versions(tenant_id, subject_kind, subject_ref);

create function public.memory_version_guard() returns trigger language plpgsql as $$
declare p public.memory_promotions%rowtype; c public.memory_candidates%rowtype; prev public.memory_versions%rowtype; expected text;
begin
  select * into p from public.memory_promotions where id = new.promotion_id;
  if not found or p.decision not in ('ALLOW','ALLOW_APPROVED') or p.tenant_id <> new.tenant_id or p.candidate_id <> new.candidate_id
     or p.result_memory_id is distinct from new.memory_id or p.result_version is distinct from new.version then
    raise exception 'canonical memory requires a promotion event that names exactly this version' using errcode = '23514';
  end if;
  select * into c from public.memory_candidates where id = new.candidate_id;
  expected := case c.origin when 'OPERATOR_INSTRUCTION' then 'USER_AUTHORED' when 'VERIFIED_OUTCOME' then 'INTERNAL_DERIVED'
                            when 'MODEL_PROPOSAL' then 'MODEL_DERIVED' else 'UNTRUSTED_EXTERNAL' end;
  if new.trust_class <> expected then
    raise exception 'trust class % is not the one origin % earns' , new.trust_class, c.origin using errcode = '23514';
  end if;
  if new.version > 1 then
    select * into prev from public.memory_versions where memory_id = new.memory_id and version = new.version - 1;
    if not found or prev.tenant_id <> new.tenant_id or prev.class <> new.class
       or prev.subject_kind <> new.subject_kind or prev.subject_ref <> new.subject_ref then
      raise exception 'a memory''s class, subject and tenant cannot change across versions' using errcode = '23514';
    end if;
    if prev.kind = 'RETRACT' then
      raise exception 'a retracted memory cannot be built on' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger memory_versions_guard before insert on public.memory_versions
  for each row execute function public.memory_version_guard();
create trigger memory_versions_immutable before update or delete on public.memory_versions
  for each row execute function public.reject_ledger_mutation();
create trigger memory_versions_no_truncate before truncate on public.memory_versions
  for each statement execute function public.reject_ledger_mutation();

-- 4. Relations between memories. SUPERSEDES is created only by an allowed promotion; CONFLICTS_WITH is a flag by a person.
create table public.memory_relations (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id),
  kind text not null check (kind in ('SUPERSEDES','CONFLICTS_WITH')),
  from_memory uuid not null,
  to_memory uuid not null,
  created_by_promotion_id uuid references public.memory_promotions(id),
  actor uuid references public.principals(id),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) >= 1),
  created_at timestamptz not null default now(),
  check (from_memory <> to_memory),
  check ((kind = 'SUPERSEDES') = (created_by_promotion_id is not null)),
  check ((kind = 'CONFLICTS_WITH') = (actor is not null)),
  unique (kind, from_memory, to_memory)
);
create index memory_relations_to on public.memory_relations(tenant_id, kind, to_memory);

create function public.memory_relation_guard() returns trigger language plpgsql as $$
declare p public.memory_promotions%rowtype; n integer;
begin
  select count(distinct tenant_id) into n from public.memory_versions where memory_id in (new.from_memory, new.to_memory);
  if n <> 1 or not exists (select 1 from public.memory_versions where memory_id = new.from_memory and tenant_id = new.tenant_id)
     or not exists (select 1 from public.memory_versions where memory_id = new.to_memory and tenant_id = new.tenant_id) then
    raise exception 'a relation connects two memories of its own tenant' using errcode = '23514';
  end if;
  if new.kind = 'SUPERSEDES' then
    select * into p from public.memory_promotions where id = new.created_by_promotion_id;
    if not found or p.decision not in ('ALLOW','ALLOW_APPROVED') or p.tenant_id <> new.tenant_id or p.result_memory_id is distinct from new.from_memory then
      raise exception 'supersession requires the promotion that created the superseding memory' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger memory_relations_guard before insert on public.memory_relations
  for each row execute function public.memory_relation_guard();
create trigger memory_relations_immutable before update or delete on public.memory_relations
  for each row execute function public.reject_ledger_mutation();
create trigger memory_relations_no_truncate before truncate on public.memory_relations
  for each statement execute function public.reject_ledger_mutation();

-- 5. Context assemblies: exactly which memories a model execution was given. Append-only.
create table public.memory_context_assemblies (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id),
  principal_id uuid not null references public.principals(id),
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  purpose_digest text not null check (purpose_digest ~ '^[a-f0-9]{64}$'),
  request jsonb not null,
  items jsonb not null check (jsonb_typeof(items) = 'array'),
  external jsonb not null check (jsonb_typeof(external) = 'array'),
  excluded jsonb not null check (jsonb_typeof(excluded) = 'array'),
  budget_max_tokens integer not null check (budget_max_tokens > 0),
  budget_used_tokens integer not null check (budget_used_tokens >= 0),
  check (budget_used_tokens <= budget_max_tokens),
  task_id uuid references public.tasks(id),
  step_id uuid,
  call_id uuid,
  created_at timestamptz not null default now()
);
create index memory_context_assemblies_task on public.memory_context_assemblies(tenant_id, task_id);
create trigger memory_context_assemblies_immutable before update or delete on public.memory_context_assemblies
  for each row execute function public.reject_ledger_mutation();
create trigger memory_context_assemblies_no_truncate before truncate on public.memory_context_assemblies
  for each statement execute function public.reject_ledger_mutation();

-- 6. The current view: the head version of each memory, if it is an assertion that nothing supersedes.
create view public.memory_current with (security_invoker = true) as
select v.*
  from public.memory_versions v
 where v.version = (select max(m.version) from public.memory_versions m where m.memory_id = v.memory_id)
   and v.kind = 'ASSERT'
   and not exists (select 1 from public.memory_relations r
                    where r.kind = 'SUPERSEDES' and r.to_memory = v.memory_id and r.tenant_id = v.tenant_id);

-- 7. Row level security on, no public grants: reached only through the service, which rechecks tenant membership.
do $$ declare t text; begin
  foreach t in array array['memory_candidates','memory_promotions','memory_versions','memory_relations','memory_context_assemblies'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end $$;
revoke all on public.memory_current from public, anon, authenticated;
revoke execute on function public.memory_candidate_guard() from public;
revoke execute on function public.memory_promotion_guard() from public;
revoke execute on function public.memory_version_guard() from public;
revoke execute on function public.memory_relation_guard() from public;

-- 8. Telegram: the inbox may now record the four memory commands (a widening of one check constraint, no data change).
alter table kernel_private.telegram_inbox drop constraint if exists telegram_inbox_command_check;
alter table kernel_private.telegram_inbox add constraint telegram_inbox_command_check
  check (command in ('STATUS','MISSION','TASK','MALFORMED','REMEMBER','MEMORIES','MEMORY','FORGET'));
