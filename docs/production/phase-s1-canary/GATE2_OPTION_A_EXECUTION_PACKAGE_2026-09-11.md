# S1 Canary Gate 2 — Option A execution package (repo-only evidence)

Date: 2026-09-11 (Europe/London). Author: Claude B (takeover; verifier / package preparer).
Scope: **Preparation and evidence only. NO production mutation performed in producing this
document.** Gate 2 execution is authorised to proceed step-by-step by Jonny, who runs every
secret-consuming and mutating command locally; Claude prepares and verifies only.

This document is the canonical, immutable record of the approved Gate 2 Option A execution
for the first scheduler canary (`claude_md_check`). The identities and timestamps below are
**approved and immutable** — they must be reused verbatim on any retry or idempotent re-run.

---

## 1. Fixed facts (approved / verified)

| Item | Value | Source of truth |
|---|---|---|
| Production KernelJSON project ref | `banqdzddfganzfhckdps` | `supabase/.temp/project-ref`, `kerneljson.config.json`, CLI link |
| Canonical main HEAD | `190bcb19ed70864282e012e39584e248c0c4b55b` (`190bcb1`) | `git rev-parse HEAD` |
| Reviewed scheduler migration | `supabase/migrations/20260910180000_scheduler.sql` | last of 12 local migrations |
| Reviewed runner | `services/kernel/src/tools/canary-runner.ts` | merged PR #13 |
| Tenant UUID (`estate`) | `5f970749-7507-894b-a2e4-872ce20a94b7` | existing production tenant |
| Approved HUMAN principal UUID | `da5c6dfc-38c5-4773-bd47-5c80ed908d75` | approved up front |
| Role | `operator` (least privilege; fixed in the reviewed path) | Gate 1.6 decision |
| Existing SERVICE principal (untouched) | `72db0114-839e-8ca9-a2fa-462b561a936b` | must remain unchanged |
| Approved canary schedule UUID | `acab9ebc-dc92-5c3a-90d6-4d6f9ddb0a1b` | approved; immutable |
| Schedule UUID derivation | `uuid5(NAMESPACE_URL, "kerneljson://schedule/claude_md_check")` | reproducible |
| Approved `createdAt` | `2026-09-11T09:00:00.000+00:00` | approved; immutable |
| Canary name | `claude_md_check` | fixed in `CANARY_SPEC` |
| Canary version | `v1` | fixed in `CANARY_SPEC` |

**Schedule UUID reproducibility check** (documentation only, computes no state):

```
python -c "import uuid; print(uuid.uuid5(uuid.NAMESPACE_URL, 'kerneljson://schedule/claude_md_check'))"
# => acab9ebc-dc92-5c3a-90d6-4d6f9ddb0a1b
```

The schedule id is stable across spec versions by design (toggling lifecycle is not a version
change; a semantic change is a new `(schedule_id, version)` row with the same `schedule_id`),
so the derivation name deliberately excludes the version.

---

## 2. Code-side verification (this session, repo unchanged since)

- `git` — branch `main`, HEAD `190bcb1`, up to date with `origin/main`. Lineage PR #13 -> #12 -> #11/#10/#9/#7. FACT.
- Runner tests — `tests/canary-runner.test.ts` **12/12 PASS** (vitest 5.0.0). FACT.
- Typecheck — `tsc --noEmit` exit 0. FACT.
- Lint — `eslint ... --max-warnings=0` exit 0. FACT.
- Runner contract — env-only `DATABASE_URL` (never printed), code-only error path, explicit
  operation + explicit IDs, generates no IDs, delegates to `runHumanProvision` /
  `installDisabledCanary`, no raw SQL, fail-closed, import-guarded. FACT.
- Launcher — `pnpm exec tsx <file> <op> --flags` forwards all arguments and fails closed
  `DATABASE_URL_MISSING` (exit 1, no connection) when the secret is absent. FACT (tested with
  `DATABASE_URL` force-unset and dummy UUIDs).
- Migration contents — six scheduler tables; Option-B FK `admitted_child_task_id ->
  kernel_private.task_admissions(task_id)`; bind-once trigger; RLS enabled + `revoke all` from
  `anon`/`authenticated` on all six; no permissive policies; pure DDL (zero schedules). FACT.

## 3. `installDisabledCanary` contract (why the schedule id is caller-supplied)

`installDisabledCanary(store, gate, rawInput): Promise<CanarySeedResult>`, where `rawInput`
is validated by `CanarySeedInput = z.strictObject({ scheduleId: Id, version, tenantId,
principalId, ownerId, createdBy, name, timezone, calendar, missedRunPolicy, overlapPolicy,
nonexistentTimePolicy, maxBackfillRuns, perScheduleConcurrency, createdAt: Timestamp })`;
`Id = z.uuid()`, `Timestamp = z.iso.datetime({ offset: true })`.

`scheduleId` is used verbatim (canary-seed.ts:149,189,207,215,231). There is no internal
derivation and no predefined schedule-id constant, so the identity is a deliberate decision,
approved above. `createdAt` is an explicit input specifically so an idempotent re-run
reproduces byte state (canary-seed.ts:78,94); a fresh timestamp on re-run would trip
`CONFLICTING_EXISTING_STATE`, so it too is fixed and approved above. The reviewed path forces
`state='disabled'` and `enabledForProduction=false`, and sets `principalId` = `createdBy` =
the HUMAN owner.

---

## 4. Checkpoint sequence (Jonny runs each; verify before the next; never combine)

Order: 0 (preconditions) -> A (dry-run) -> B (migrate) -> C (verify) -> D (provision) ->
E (verify) -> F (install) -> G (verify) -> H (disabled soak) -> I (STOP).

### Checkpoint 0 — read-only preconditions (every `ok` must be `true`)

```sql
select 'estate_tenant_exactly_one' as check,
  (select count(*) from public.tenants where id='5f970749-7507-894b-a2e4-872ce20a94b7' and name='estate')=1 as ok,
  (select count(*)::text from public.tenants where id='5f970749-7507-894b-a2e4-872ce20a94b7') as detail
union all select 'human_principal_absent',
  (select count(*) from public.principals where id='da5c6dfc-38c5-4773-bd47-5c80ed908d75')=0,
  (select count(*)::text from public.principals where id='da5c6dfc-38c5-4773-bd47-5c80ed908d75')
union all select 'human_membership_absent',
  (select count(*) from public.tenant_memberships where principal_id='da5c6dfc-38c5-4773-bd47-5c80ed908d75')=0,
  (select count(*)::text from public.tenant_memberships where principal_id='da5c6dfc-38c5-4773-bd47-5c80ed908d75')
union all select 'human_principal_count_zero',
  (select count(*) from public.principals where kind='HUMAN')=0,
  (select count(*)::text from public.principals where kind='HUMAN')
union all select 'service_principal_present_service',
  (select count(*) from public.principals where id='72db0114-839e-8ca9-a2fa-462b561a936b' and kind='SERVICE')=1,
  (select coalesce(kind,'<missing>') from public.principals where id='72db0114-839e-8ca9-a2fa-462b561a936b')
union all select 'scheduler_tables_absent',
  (select count(*) from information_schema.tables where table_schema='public' and table_name in
   ('schedule_specs','schedule_state','schedule_fires','schedule_backfill_requests','schedule_observations','schedule_leases'))=0,
  (select count(*)::text from information_schema.tables where table_schema='public' and table_name in
   ('schedule_specs','schedule_state','schedule_fires','schedule_backfill_requests','schedule_observations','schedule_leases'))
union all select 'fk_targets_present',
  (select count(*) from information_schema.tables where (table_schema='public' and table_name in ('principals','tenants','tenant_memberships'))
     or (table_schema='kernel_private' and table_name='task_admissions'))=4,
  (select string_agg(table_schema||'.'||table_name,',') from information_schema.tables where (table_schema='public' and table_name in ('principals','tenants','tenant_memberships'))
     or (table_schema='kernel_private' and table_name='task_admissions'))
order by check;
```

### Checkpoint A — migration dry-run (must list ONLY the scheduler migration; else STOP)

```
supabase db push --linked --dry-run --skip-vault
```

Linked ref is `banqdzddfganzfhckdps`. `--skip-vault` is safe: `[db.vault]` in `config.toml`
is commented out. The DB password is entered at the interactive prompt, never in argv.

### Checkpoint B — apply the scheduler migration (only after A shows exactly one pending)

```
supabase db push --linked --skip-vault
```

### Checkpoint C — read-only migration verification (every `ok` must be `true`)

```sql
select 'six_tables_exist' as check,
  (select count(*) from information_schema.tables where table_schema='public' and table_name in
   ('schedule_specs','schedule_state','schedule_fires','schedule_backfill_requests','schedule_observations','schedule_leases'))=6 as ok,
  (select string_agg(table_name,',' order by table_name) from information_schema.tables where table_schema='public' and table_name in
   ('schedule_specs','schedule_state','schedule_fires','schedule_backfill_requests','schedule_observations','schedule_leases')) as detail
union all select 'optionB_fk_to_task_admissions',
  exists (select 1 from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu on kcu.constraint_name=tc.constraint_name and kcu.constraint_schema=tc.constraint_schema
    join information_schema.constraint_column_usage ccu on ccu.constraint_name=tc.constraint_name and ccu.constraint_schema=tc.constraint_schema
    where tc.constraint_type='FOREIGN KEY' and tc.table_schema='public' and tc.table_name='schedule_fires'
      and kcu.column_name='admitted_child_task_id'
      and ccu.table_schema='kernel_private' and ccu.table_name='task_admissions' and ccu.column_name='task_id'),
  'admitted_child_task_id -> kernel_private.task_admissions(task_id)'
union all select 'rls_enabled_all_six',
  (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
    and c.relname in ('schedule_specs','schedule_state','schedule_fires','schedule_backfill_requests','schedule_observations','schedule_leases') and c.relrowsecurity)=6,
  (select count(*)::text from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
    and c.relname in ('schedule_specs','schedule_state','schedule_fires','schedule_backfill_requests','schedule_observations','schedule_leases') and c.relrowsecurity)
union all select 'anon_authenticated_revoked',
  (select count(*) from information_schema.role_table_grants where table_schema='public' and grantee in ('anon','authenticated')
    and table_name in ('schedule_specs','schedule_state','schedule_fires','schedule_backfill_requests','schedule_observations','schedule_leases'))=0,
  (select coalesce(string_agg(distinct grantee||':'||privilege_type,','),'none') from information_schema.role_table_grants
    where table_schema='public' and grantee in ('anon','authenticated')
    and table_name in ('schedule_specs','schedule_state','schedule_fires','schedule_backfill_requests','schedule_observations','schedule_leases'))
union all select 'no_permissive_policies',
  (select count(*) from pg_policies where schemaname='public' and tablename in
   ('schedule_specs','schedule_state','schedule_fires','schedule_backfill_requests','schedule_observations','schedule_leases'))=0,
  (select count(*)::text from pg_policies where schemaname='public' and tablename in
   ('schedule_specs','schedule_state','schedule_fires','schedule_backfill_requests','schedule_observations','schedule_leases'))
union all select 'zero_schedules_from_migration',
  ((select count(*) from public.schedule_specs)+(select count(*) from public.schedule_state)+(select count(*) from public.schedule_fires))=0,
  ('specs='||(select count(*) from public.schedule_specs)||' state='||(select count(*) from public.schedule_state)||' fires='||(select count(*) from public.schedule_fires))
order by check;
```

### Checkpoint D — HUMAN provisioning (role fixed to `operator` in the reviewed path)

```
jvault run --project kerneljson -- pnpm exec tsx services/kernel/src/tools/canary-runner.ts provision-human --principal-id da5c6dfc-38c5-4773-bd47-5c80ed908d75 --tenant-id 5f970749-7507-894b-a2e4-872ce20a94b7
```

### Checkpoint E — read-only identity verification (every `ok` must be `true`)

```sql
select 'human_principal_is_human' as check,
  (select count(*) from public.principals where id='da5c6dfc-38c5-4773-bd47-5c80ed908d75' and kind='HUMAN')=1 as ok,
  (select coalesce(kind,'<missing>') from public.principals where id='da5c6dfc-38c5-4773-bd47-5c80ed908d75') as detail
union all select 'one_active_operator_membership_in_estate',
  (select count(*) from public.tenant_memberships where principal_id='da5c6dfc-38c5-4773-bd47-5c80ed908d75'
    and tenant_id='5f970749-7507-894b-a2e4-872ce20a94b7' and role='operator' and status='ACTIVE')=1,
  (select coalesce(role||'/'||status,'<none>') from public.tenant_memberships where principal_id='da5c6dfc-38c5-4773-bd47-5c80ed908d75')
union all select 'human_has_exactly_one_membership',
  (select count(*) from public.tenant_memberships where principal_id='da5c6dfc-38c5-4773-bd47-5c80ed908d75')=1,
  (select count(*)::text from public.tenant_memberships where principal_id='da5c6dfc-38c5-4773-bd47-5c80ed908d75')
union all select 'service_principal_unchanged',
  ((select count(*) from public.principals where id='72db0114-839e-8ca9-a2fa-462b561a936b' and kind='SERVICE')=1
   and (select count(*) from public.tenant_memberships where principal_id='72db0114-839e-8ca9-a2fa-462b561a936b' and role='operator' and status='ACTIVE')=1),
  (select 'kind='||coalesce(kind,'<missing>') from public.principals where id='72db0114-839e-8ca9-a2fa-462b561a936b')
union all select 'exactly_two_principals_total',
  (select count(*) from public.principals)=2, (select count(*)::text from public.principals)
union all select 'scheduler_still_empty',
  ((select count(*) from public.schedule_specs)+(select count(*) from public.schedule_state)+(select count(*) from public.schedule_fires))=0,
  ('specs='||(select count(*) from public.schedule_specs)||' fires='||(select count(*) from public.schedule_fires))
order by check;
```

### Checkpoint F — install the disabled canary (final, approved values verbatim)

```
jvault run --project kerneljson -- pnpm exec tsx services/kernel/src/tools/canary-runner.ts install-canary --schedule-id acab9ebc-dc92-5c3a-90d6-4d6f9ddb0a1b --tenant-id 5f970749-7507-894b-a2e4-872ce20a94b7 --owner-id da5c6dfc-38c5-4773-bd47-5c80ed908d75 --created-at 2026-09-11T09:00:00.000+00:00
```

`PgIdentityGate` performs read-only SELECTs and requires the HUMAN owner from Checkpoint D to
exist first. The runner forces `state=disabled`, `enabled_for_production=false`.

### Checkpoint G — read-only disabled-canary verification (every `ok` must be `true`)

```sql
select 'canary_spec_exists' as check,
  (select count(*) from public.schedule_specs where name='claude_md_check')=1 as ok,
  (select coalesce(string_agg(schedule_id::text||'@'||version,','),'<none>') from public.schedule_specs where name='claude_md_check') as detail
union all select 'schedule_id_matches_approved',
  (select count(*) from public.schedule_specs where name='claude_md_check' and schedule_id='acab9ebc-dc92-5c3a-90d6-4d6f9ddb0a1b')=1,
  (select coalesce(string_agg(schedule_id::text,','),'<none>') from public.schedule_specs where name='claude_md_check')
union all select 'owner_is_approved_human',
  (select count(*) from public.schedule_specs where name='claude_md_check' and owner_id='da5c6dfc-38c5-4773-bd47-5c80ed908d75')=1,
  (select coalesce(string_agg(owner_id::text,','),'<none>') from public.schedule_specs where name='claude_md_check')
union all select 'enabled_for_production_false',
  (select bool_and(enabled_for_production=false) from public.schedule_specs where name='claude_md_check'),
  (select coalesce(bool_and(enabled_for_production)::text,'<none>') from public.schedule_specs where name='claude_md_check')
union all select 'state_disabled',
  (select count(*) from public.schedule_state st join public.schedule_specs sp on sp.schedule_id=st.schedule_id
    where sp.name='claude_md_check' and st.state='disabled')=1,
  (select coalesce(string_agg(st.state::text,','),'<none>') from public.schedule_state st join public.schedule_specs sp on sp.schedule_id=st.schedule_id where sp.name='claude_md_check')
union all select 'zero_fires', (select count(*) from public.schedule_fires)=0, (select count(*)::text from public.schedule_fires)
union all select 'zero_admitted_child_tasks',
  (select count(*) from public.schedule_fires where admitted_child_task_id is not null)=0,
  (select count(*)::text from public.schedule_fires where admitted_child_task_id is not null)
union all select 'zero_observations', (select count(*) from public.schedule_observations)=0, (select count(*)::text from public.schedule_observations)
union all select 'exactly_one_spec_total', (select count(*) from public.schedule_specs)=1, (select count(*)::text from public.schedule_specs)
order by check;
```

Restate/execution/evidence are downstream of a fire; `zero_fires` + `state_disabled` +
`zero_admitted_child_tasks` + `zero_observations` is the DB-observable proof of zero execution.

### Checkpoint H — disabled soak

Leave the canary disabled. Do not enable `claude_md_check`; do not create a fire.

### Checkpoint I — STOP

---

## 5. Secret-handling boundary

- Claude never receives, inspects, prints, logs, or persists `DATABASE_URL`, the DB password,
  or any connection string. None appears in this document.
- Secrets reach the runner only via `jvault run --project kerneljson -- <cmd>`, which injects
  the `kerneljson` project's secrets (including `DATABASE_URL`) into the child process
  environment; the value is never an argv token and never written to disk. The runner reads
  `process.env["DATABASE_URL"]` and fails closed if it is absent.
- The migration's DB password is entered at the Supabase CLI interactive prompt, never in argv
  or shell history.
- Read-only verification runs in the Supabase SQL editor on `banqdzddfganzfhckdps`, or via
  Jonny's own jVault-injected `psql`. Claude handles no secret in either path.
- Note: the Supabase MCP available to Claude in this session is scoped to a different
  organisation and cannot see `banqdzddfganzfhckdps`; this is a connector-scope limit, not a
  production-state finding. Claude therefore did not run the live prechecks; they are packaged
  above for Jonny to run.

## 6. Gate 2 stop boundary (still forbidden)

Do not: execute any production mutation from Claude; enable `claude_md_check`; create the first
production fire; deploy Restate changes; execute Phase B or C1 hygiene; alter EMAIL authority
or Phase 8.1; alter WhatsApp / n8n / OpenClaw / JaiOS; touch the SERVICE principal.

## 7. Status at time of writing

Production mutation = NONE. Migration not applied. HUMAN principal not created. Canary not
installed. Next action: Jonny runs Checkpoint 0 (preconditions), then Checkpoint A (dry-run),
and pastes the dry-run output back before any mutation command is issued.
