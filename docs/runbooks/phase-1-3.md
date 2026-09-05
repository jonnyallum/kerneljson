# Phase 1–3 local validation

The only execution recipe is deterministic: uppercase the task objective, wait for a signal, then reverse the result and verify its SHA-256 evidence. The acceptance criterion must be exactly `Output equals reverse(uppercase(trim(objective)))`. Additional constraints, budgets, deadlines and higher risk classes are rejected, rather than silently ignored.

## Commands

Requires Node >=22, pnpm 10.4.0, Docker Engine and Compose. Dependencies are pinned in the lockfile.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test:unit
pnpm test:db
pnpm test:recovery
pnpm test
```

On this Windows checkout, Docker Desktop fails while creating its inference-manager socket. The existing Ubuntu WSL Docker Engine works. In PowerShell, select it for integration tests:

```powershell
wsl -d Ubuntu -- service docker start
$env:KERNELJSON_DOCKER_WSL = 'Ubuntu'
pnpm test
```

The tests use only the dedicated `kerneljson-validation` Compose project. PostgreSQL is bound to loopback port 55432, Restate ingress to 18080, Restate admin to 19070 and the worker to 19080. Local PostgreSQL uses trust authentication and disposable data; these settings are exclusively for testing. The recovery suite resets this named stack and its test volume before running. It never uses an ambient `DATABASE_URL` or a linked Supabase project. Do not use this stack to hold valuable data. On WSL the harness holds a foreground process for the duration of each integration suite, preventing WSL's idle shutdown without changing machine settings.

The DB suite executes the actual migration SQL in transactions on a fresh PostgreSQL 17 database, creating Supabase's `anon`, `authenticated`, and `service_role` roles locally. This tests PostgreSQL semantics; it is not a test of hosted Auth, PostgREST, Storage or remote RLS integration. Every application table has RLS enabled and `anon`/`authenticated` access revoked. No tenant-facing API policies are introduced in this slice. The worker accesses PostgreSQL directly as a trusted backend.

The recovery suite registers a real Restate deployment and checks:

- durable wait across SIGKILL/restart of both worker and Restate, retaining Restate's data volume;
- a worker crash after step B's database commit but before the Restate journal acknowledgement;
- concurrent duplicate signals and repeated workflow submission;
- cancellation at the durable decision boundary and rejection of a late resume;
- no projection created for an unsupported task request.

It checks exact event keys, step counts, evidence count, outcome and status. No mocked Restate context establishes these claims. The crash hook is confined to `tests/support/worker.ts`; the production worker has no environment-driven crash hook.

## Runtime semantics

`TaskClient` in `services/kernel/src/client.ts` exposes `submit`, `status`, `signal`, and `cancel`. It maps to Restate's native `TaskWorkflow/{taskId}/run/send`, `/status`, `/signal`, and `/cancel` handlers. The workflow ID is the task ID. Only a trusted internal caller may supply tenant/principal identity; these endpoints are not a public authenticated gateway. Provision principals, tenants and memberships before submission.

Signal and cancellation resolve one durable promise. The first accepted decision wins, including a decision arriving before the workflow reaches its wait. Cancellation is cooperative at that boundary: a cancellation after a winning resume reports the original resume decision and does not undo step B. Shared handlers do not mutate workflow state or task projections. The run handler owns all lifecycle writes.

Restate journals time, generated IDs and database calls. Each ledger write atomically commits its event, projection and associated step/evidence/outcome. A task-scoped event key and request digest reject conflicting reuse and make replay after a committed write safe. PostgreSQL advisory locks serialize ledger updates; they are transaction locks, not scheduling or a job queue. Restate owns retries. The deterministic functions have no external provider effects. The capability run table reserves task-scoped idempotency keys for later provider receipts; this slice makes no such provider calls.

Completion requires every declared criterion to pass against evidence for this task. The verifier recomputes the fixed recipe's output and digest. PostgreSQL also rejects completion without an outcome, evidence references, acceptance results and a completion event. Events, evidence and outcomes cannot be updated, deleted or truncated through ordinary SQL, including by the local owner with triggers enabled. As with all PostgreSQL safeguards, a database administrator can change/drop triggers or tables; this is not protection against a hostile database administrator.

## Supabase review and deployment boundary

Project ref: `banqdzddfganzfhckdps`. No remote migration has been applied by this implementation. Runtime credentials, when needed, must be injected from jVault project `kerneljson`; do not place them in source or command arguments. The local test stack needs no jVault secrets.

After reviewing the migration files and local evidence, the exact remote dry-run command for Jonny is:

```sh
supabase db push --linked --project-ref banqdzddfganzfhckdps --dry-run --skip-vault
```

This command has not been executed here. The `--skip-vault` flag avoids the CLI's vault-update pre-step. A real push requires explicit approval after inspecting the dry run; no CI or test command performs it. Do not include `--include-seed` or `--include-roles` for these migrations.

For a full Supabase local stack with a functioning Docker Desktop/CLI connection:

```sh
supabase start
supabase db reset --local
supabase db lint --local
```

These full-stack commands are separate from the isolated PostgreSQL tests. Reset affects local Supabase data and must only target a disposable local instance.

Migrations are transactional. A failed migration can be rolled back before commit. After audit data exists, do not implement automatic destructive down migrations; preserve the ledger and use reviewed forward fixes. The disposable test stack can be removed with:

```sh
docker compose -f infrastructure/docker/validation.compose.yaml down --volumes
```

For WSL on Windows, prefix that command with `wsl -d Ubuntu --` and use the `/mnt/c/...` absolute Compose path.

## Sources consulted

- [Supabase database testing](https://supabase.com/docs/guides/local-development/testing/overview)
- [Supabase explicit API grants change](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)
- [Restate workflows and service definitions](https://docs.restate.dev/develop/ts/services)
- [Restate durable promises](https://docs.restate.dev/develop/ts/external-events)
