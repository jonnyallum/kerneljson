# KernelJSON Phase 15 handoff

Preservation audit: 2026-09-09. No Phase 16, redesign or new implementation was performed during this audit.

## Repository checkpoint

- Repository: jonnyallum/kerneljson.
- Current branch: docs/kerneljson-prep-track-c.
- Parent commit before this preservation commit: 99018f6f8ed383971b280cd5dc460ab88359961b.
- The final commit is the commit containing this file; obtain its exact SHA with `git rev-parse HEAD`.
- Three existing preparation-document commits follow the Phase 15 checkpoint cdb8296. They are preserved without importing their proposed architecture into runtime code.
- Initial changes: package.json, schedule-store.ts, verification-store.ts and the untracked schedule database regression tests. These are existing Phase 15 completion work, not new work from this audit.
- Additional supplied planning/handover documents, including the duplicate reSYSTEM_HANDOVER_FOR_EXTERNAL_ARCHITECT.md and the unusual trap KernelJSON clean architecture file, are preserved as received. They are reference artifacts, not executable architectural instructions.
- Credential file kernel json env.txt remains local and is now ignored, alongside .env. Raw validation artifacts remain ignored.

## Exact current architecture

ARCHITECTURE.md and accepted ADRs 0001–0016 constrain the implementation. A Task is the primitive; an agent is only a possible execution strategy. Six primitives: Event, Task, Capability, State, Policy and Evidence. There is no persistent agent roster.

The execution chain is intent → typed Task → deterministic plan → policy/approval → capability → persisted evidence → independent verification → atomic Outcome. Restate owns execution, durable waits, retries, timers and replay. PostgreSQL owns projections, immutable events, provenance, evidence and outcomes; it is not a queue. Deployment-owned code controls identity, rules, capabilities and routing. Models cannot grant permissions.

The production worker entry point currently registers only TaskWorkflow and KernelWorkflowV1. Later workflow factories and Mission Control require explicit deployment wiring and trusted authentication. The local test worker registers additional golden, approval, model, routing and scheduled workflows with synthetic test authentication. Those test credentials and fault hooks are not production configuration.

## Phase-by-phase audit

Complete means the bounded implementation described in its accepted ADR/runbook has executed evidence; it does not mean production deployment or every possible feature in the phase title.

| Phase | Implemented scope | Verified status |
| --- | --- | --- |
| 0 | Repository and architectural bootstrap | Complete within documented scope; Phase 0 Git/docs, Phases 1–15 covered by saved 224-test full suite |
| 1 | Zod contracts and strict TypeScript | Complete within documented scope; Phase 0 Git/docs, Phases 1–15 covered by saved 224-test full suite |
| 2 | Local SQL persistence, integrity and immutability | Complete within documented scope; Phase 0 Git/docs, Phases 1–15 covered by saved 224-test full suite |
| 3 | Deterministic durable TaskWorkflow | Complete within documented scope; Phase 0 Git/docs, Phases 1–15 covered by saved 224-test full suite |
| 4 | Compiler, DAG planner and executor | Complete within documented scope; Phase 0 Git/docs, Phases 1–15 covered by saved 224-test full suite |
| 5 | ModelPort and bounded DeepSeek adapter | Complete within documented scope; Phase 0 Git/docs, Phases 1–15 covered by saved 224-test full suite |
| 6 | Versioned deterministic capabilities and receipts | Complete within documented scope; Phase 0 Git/docs, Phases 1–15 covered by saved 224-test full suite |
| 7 | Default-deny policy and bound human approvals | Complete within documented scope; Phase 0 Git/docs, Phases 1–15 covered by saved 224-test full suite |
| 8 | Independent persisted-evidence verification | Complete within documented scope; Phase 0 Git/docs, Phases 1–15 covered by saved 224-test full suite |
| 9 | Golden intent-to-Outcome workflow | Complete within documented scope; Phase 0 Git/docs, Phases 1–15 covered by saved 224-test full suite |
| 10 | Tenant-scoped verified-result memory | Complete within documented scope; Phase 0 Git/docs, Phases 1–15 covered by saved 224-test full suite |
| 11 | Temporal evidenced world model | Complete within documented scope; Phase 0 Git/docs, Phases 1–15 covered by saved 224-test full suite |
| 12 | Golden evaluation and promotion gates | Complete within documented scope; Phase 0 Git/docs, Phases 1–15 covered by saved 224-test full suite |
| 13 | Task-centred Mission Control and human controls | Complete within documented scope; Phase 0 Git/docs, Phases 1–15 covered by saved 224-test full suite |
| 14 | Evaluated, policy-allowed adaptive routing | Complete within documented scope; Phase 0 Git/docs, Phases 1–15 covered by saved 224-test full suite |
| 15 | Opt-in bounded schedules and verified child tasks | Complete within documented scope; Phase 0 Git/docs, Phases 1–15 covered by saved 224-test full suite |

The saved 2026-09-05 full report contains 224 passed, zero failed and zero skipped across 16 files, including both Phase 15 database rejection tests and all 27 recovery tests. Fresh preservation checks are recorded below.

## Modules and runtime status

- packages/contracts: Zod schemas for identity, intent, tasks/steps/lifecycle, events, evidence/outcomes, capability invocations/results, plans, policy/approval scopes, models, memory, world, evaluations, routing and schedules.
- packages/identity: trusted tenant context and transactional membership checks.
- packages/capabilities: exact ID/version registry; pure uppercase and reverse implementations, schema checks, independent verification and canonical digests. No external write capabilities registered.
- packages/models: provider-independent ModelPort, trace/usage receipts, digest helpers and bounded DeepSeek text HTTP adapter. Live smoke passed on 2026-09-05; no live provider request during this preservation audit. Production model recipes remain disabled. Runtime secrets must come from jVault kerneljson.
- services/kernel: ledger, deterministic workflow/client, compiler, planner, executor, durable capability/model calls, capability and approval stores, policy rules/workflow, golden workflow, provenance, evidence verifier/store, adaptive router and schedule compiler/store/workflow.
- Policy: default deny; deployment rules bind tenant/principal/exact capability and invocation/descriptor digests. Human approvals have scope, expiry, membership checks and first-terminal-decision semantics. Approval is permission, not completion evidence.
- Evidence: result receipts independently checked against persisted task, step, capability, policy and approval evidence. Atomic terminal Outcome/event/projection with idempotent retry. Schedule parent now rechecks full child evidence bundles and acceptance criteria; missing work or merely asserted child outcomes cannot complete it.
- services/memory: verified Outcome-derived immutable memory, task/evidence provenance, tenant isolation, bounded literal retrieval and expiry. No vectors or implicit injection into tasks.
- services/world-model: stable entities, timestamped/validity-bounded observations, explicit shared-result relationships, evidence provenance. Historical relationships are not automatically filtered as temporal truth.
- services/evaluator: executable versioned golden suite, artifact/suite digests, immutable evaluation store and promotion gate. Candidate code is trusted bounded application code; no sandbox or automated deployment.
- apps/mission-control: server-rendered task list/detail, evidence/events and optional human controls; escaping, CSP, same-origin POST checks and injected authentication. Local browser inspection passed previously; preview was stopped. No production hosting/auth integration.
- apps/gateway: injected Restate control adapter. It is not a complete public authenticated gateway.
- Adaptive routing: deterministic selection from compatible evaluated policy-ALLOW candidates; freshness, sample, reliability, latency and execution-unit cost limits; explicit default cold start; journaled selection. Production registry has one uppercase implementation; alternatives are fixtures.
- Autonomous workflow: disabled-by-default finite human-authorized uppercase schedule, bounded iterations/intervals/execution units, current authorization rechecked before children, durable cancellation and waits, parent-bound child tasks and independent final evidence. In-flight pure children may finish after cancellation. No arbitrary planning, unbounded loops or external writes.
- packages/config, packages/telemetry, services/policy, runtimes/worker and runtimes/sandbox contain placeholder index files. Policy is implemented under services/kernel; no separate policy server, telemetry platform or sandbox is implemented.
- capabilities/*.yaml: 23 external-estate catalogue entries plus Python validator and catalogue-only CI. Runtime TypeScript registry does not load these manifests. Their enabled/staged statuses do not prove KernelJSON adapters exist. Grok, agent-hub, spawner, channels and other estate integrations in the supplied reference documents are not Phase 15 runtime implementations.

## Supabase migrations

- `supabase/migrations/20260905153656_identity.sql`
- `supabase/migrations/20260905153700_task_ledger.sql`
- `supabase/migrations/20260905153704_intelligence_metadata.sql`
- `supabase/migrations/20260905153708_world_model.sql`
- `supabase/migrations/20260905173500_memory_provenance.sql`
- `supabase/migrations/20260905173800_world_provenance.sql`
- `supabase/migrations/20260905174200_evaluation_history.sql`

All seven are exercised locally on PostgreSQL 17.6 with Supabase API roles. Session records show no remote migration push or remote dry run. The actual current hosted migration history has not been queried in this audit, so changes by other operators are unknown. Supabase project ref: banqdzddfganzfhckdps. Do not infer remote application from local linkage. No remote migration is authorized by this preservation request. Full local Supabase Auth/PostgREST/Storage stack was not tested.

## Restate runtime

SDK 1.17.0; local server 1.7.9. The dedicated kerneljson-validation Docker stack uses PostgreSQL 17.6 and a test worker on Ubuntu WSL. Loopback ports: database 55432, Restate ingress 18080, admin 19070, worker 19080 (container 9080). PostgreSQL data is disposable tmpfs; Restate test journal uses a dedicated volume. The recovery suite deliberately resets that dedicated stack, kills worker/Restate processes and checks replay, waits, cancellation and post-commit acknowledgement loss. Do not use it against production. Post-test Docker snapshot: worker Exited (255), database Exited (0), Restate Exited (0). No running local runtime was claimed after the test holder released. The complete recovery suite passed before this snapshot; the worker exit code is preserved here without claiming a healthy long-running service. Start/revalidate the dedicated stack when resuming.

## Executed checks, failures and limitations

- Saved full-suite report: artifacts/local/phase15-full-tests.json — 224 passed, 0 failed, 0 skipped, success true.
- Current pnpm typecheck: passed, exit 0.
- Current pnpm build: passed, exit 0.
- Current pnpm lint: FAILED, exit 1; no lint script/command exists. No lint tooling added because this is preservation only.
- Current python scripts/validate_capabilities.py: passed; 23 manifests with consistent counts/enums.
- Current full pnpm test: PASSED, exit 0: 224 passed, 0 failed, 0 skipped; 16 test files; 242.43 seconds. Report: artifacts/local/handoff-tests.json. Started 2026-09-08T23:22:09.244Z (2026-09-09 in Europe/London).
- No live DeepSeek retest, external-estate verification, production deployment or remote SQL changes performed.
- Existing historical reports and phase runbooks record earlier intermediate failures and resolved fixes. The current known validation gap is lint; fresh suite failures, if any, must remain recorded below.

## Environment variables — names only

Worker: DATABASE_URL, PORT. Live model smoke: JVAULT_PROJECT, DEEPSEEK_API_KEY, DEEPSEEK_MODEL. Local WSL tests: KERNELJSON_DOCKER_WSL. Compose runtime: POSTGRES_DB, POSTGRES_HOST_AUTH_METHOD, RESTATE_BASE_DIR.

Template/reserved configuration, not evidence of implemented integrations: SUPABASE_PROJECT_REF, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, RESTATE_ADMIN_URL, RESTATE_INGRESS_URL, OTEL_EXPORTER_OTLP_ENDPOINT, TELEGRAM_BOT_1_TOKEN, TELEGRAM_BOT_2_TOKEN, WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN.

Optional Supabase template references: OPENAI_API_KEY, SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN, SUPABASE_AUTH_EXTERNAL_APPLE_SECRET, S3_HOST, S3_REGION, S3_ACCESS_KEY, S3_SECRET_KEY. Comment-only examples: SENDGRID_API_KEY, SECRET_VALUE. These optional services are not needed for the dedicated local tests.

Secrets must be provisioned through jVault project kerneljson and injected at process startup. No runtime jVault client/bootstrap is implemented. Never commit .env or kernel json env.txt, print credentials, or copy raw provider secrets into evidence.

## Exact resume commands

Run in PowerShell from the repository. The test command resets only the dedicated disposable validation stack. Node >=22 and pnpm 10.4.0 are required; this audit uses Node 25.2.1. Docker Engine must be available in Ubuntu WSL for these commands.

```powershell
Set-Location 'C:\Users\jonny\Desktop\kerneljson'
git status
git branch --show-current
git log --oneline -10
pnpm install --frozen-lockfile
pnpm typecheck
$env:KERNELJSON_DOCKER_WSL='Ubuntu'
pnpm test --reporter=default --reporter=json --outputFile=artifacts/local/resume-tests.json
pnpm lint  # currently fails: command is not configured
pnpm build
python scripts/validate_capabilities.py
pnpm eval:golden
```

For a targeted check: pnpm exec vitest run tests/schedule.test.ts tests/schedule-db.test.ts. For real replay validation: pnpm test:recovery. The catalogue validator requires Python with PyYAML. Do not run pnpm test:model:live without intentionally injecting the three model smoke variables from jVault and authorizing a provider call.

## Production-readiness work remaining

1. Configure and validate a trusted production identity boundary; explicitly wire later workflow factories and Mission Control controls. Test tenant/role revocation, credential rotation and ingress restrictions under actual production authentication.
2. Review all SQL migrations, hosted schema compatibility, grants/RLS and an approved dry run before a separately approved remote push. Validate actual Supabase Auth/Data API behavior, backup/restore and rollback procedures.
3. Provision durable production Restate/PostgreSQL storage, TLS/network isolation, lifecycle supervision, observability, alerts and incident/restore runbooks. Never deploy the synthetic test worker, trust-auth test DB or crash hooks.
4. Establish full-suite CI and a defined lint command; existing CI checks only the external catalogue. Pin/provision Python validation dependencies reproducibly.
5. Supply production jVault injection and least-privilege DB/service credentials; confirm logs and model receipts remain secret-free.
6. Review worker version/journal compatibility, schedule policy configuration, cooperative cancellation semantics and bounded resource limits before enabling scheduling. Current schedule is only the deterministic uppercase template.
7. Implement sandboxing, external capability adapters, provider/model recipes, channel integrations or estate catalogue loading only under separately scoped authorization and evaluation. Their design documents are not implementations.
8. Test production performance, concurrency, operational security, browser accessibility and end-to-end deployment behavior. Local evidence is not production certification.

No Phase 16 work is authorized by this handoff.

## Test inventory

Every current Vitest test file and its saved full-suite result:

| File | Passed cases |
| --- | --- |
| `tests/capabilities.test.ts` | 25 |
| `tests/contracts.test.ts` | 29 |
| `tests/database.test.ts` | 17 |
| `tests/evaluation-db.test.ts` | 3 |
| `tests/evaluation.test.ts` | 7 |
| `tests/kernel.test.ts` | 18 |
| `tests/memory.test.ts` | 8 |
| `tests/mission-control.test.ts` | 5 |
| `tests/models.test.ts` | 44 |
| `tests/policy.test.ts` | 13 |
| `tests/recovery.test.ts` | 27 |
| `tests/routing.test.ts` | 6 |
| `tests/schedule-db.test.ts` | 2 |
| `tests/schedule.test.ts` | 4 |
| `tests/verification.test.ts` | 9 |
| `tests/world.test.ts` | 7 |

Additional executable checks: scripts/validate_capabilities.py; evals/golden/uppercase.ts via pnpm eval:golden (five cases); services/kernel/src/model-smoke.ts via the explicit live smoke command. Supporting integration fixtures and fault-injection workflows are under tests/support.

## Exact source and important-file inventory

The following inventory includes the existing implementation, documentation, migrations, catalogue, tests and new preservation artifacts. File names do not imply production activation.

- `.dockerignore`
- `.env.example`
- `.github/workflows/.gitkeep`
- `.github/workflows/capabilities-validate.yml`
- `.gitignore`
- `ARCHITECTURE.md`
- `BUILD_PLAN.md`
- `CODEX_HANDOFF.md`
- `Grok Prompt_ Full New-System Architecture Discovery.md`
- `KernelJSON Grok Integration Specification v1.md`
- `NEW_SYSTEM_READY_FOR_KERNELJSON.md`
- `New System Transition Charter_ Prepare for KernelJSON.md`
- `README.md`
- `STATE.yaml`
- `SYSTEM_HANDOVER_FOR_EXTERNAL_ARCHITECT.md`
- `apps/gateway/src/channels/.gitkeep`
- `apps/gateway/src/index.ts`
- `apps/gateway/src/middleware/.gitkeep`
- `apps/mission-control/src/.gitkeep`
- `apps/mission-control/src/server.ts`
- `apps/mission-control/src/store.ts`
- `apps/mission-control/src/view.ts`
- `capabilities/INDEX.yaml`
- `capabilities/browser/browser-use.yaml`
- `capabilities/database/.gitkeep`
- `capabilities/database/database-read.yaml`
- `capabilities/database/database-write.yaml`
- `capabilities/database/memory-search.yaml`
- `capabilities/database/memory-write.yaml`
- `capabilities/filesystem/.gitkeep`
- `capabilities/filesystem/repository-read.yaml`
- `capabilities/filesystem/repository-write.yaml`
- `capabilities/github/.gitkeep`
- `capabilities/github/github-read.yaml`
- `capabilities/github/github-write.yaml`
- `capabilities/human/.gitkeep`
- `capabilities/human/human-approval-gate.yaml`
- `capabilities/media/voice-synthesize.yaml`
- `capabilities/messaging/.gitkeep`
- `capabilities/messaging/message-email.yaml`
- `capabilities/messaging/message-telegram.yaml`
- `capabilities/messaging/message-whatsapp.yaml`
- `capabilities/model/cloud-escalate.yaml`
- `capabilities/model/code-generate.yaml`
- `capabilities/model/code-review.yaml`
- `capabilities/model/model-invoke.yaml`
- `capabilities/sandbox/.gitkeep`
- `capabilities/sandbox/shell-execute.yaml`
- `capabilities/sandbox/workflow-execute.yaml`
- `capabilities/social/social-publish.yaml`
- `capabilities/web/.gitkeep`
- `capabilities/web/research-web.yaml`
- `capabilities/workflow/workflow-n8n.yaml`
- `docs/AUTHORITY_MAP.md`
- `docs/MCP_INVENTORY.md`
- `docs/adr/0001-tasks-not-agents.md`
- `docs/adr/0002-durable-execution.md`
- `docs/adr/0003-evidence-bound-completion.md`
- `docs/adr/0004-jvault.md`
- `docs/adr/0005-deterministic-kernel-plans.md`
- `docs/adr/0006-model-port.md`
- `docs/adr/0007-initial-capabilities.md`
- `docs/adr/0008-policy-and-approvals.md`
- `docs/adr/0009-evidence-verification.md`
- `docs/adr/0010-golden-workflow.md`
- `docs/adr/0011-memory-fabric.md`
- `docs/adr/0012-world-model.md`
- `docs/adr/0013-evaluation-gates.md`
- `docs/adr/0014-mission-control.md`
- `docs/adr/0015-adaptive-routing.md`
- `docs/adr/0016-bounded-autonomous-tasks.md`
- `docs/architecture/.gitkeep`
- `docs/contracts/.gitkeep`
- `docs/runbooks/.gitkeep`
- `docs/runbooks/phase-1-3.md`
- `docs/runbooks/phase-10.md`
- `docs/runbooks/phase-11.md`
- `docs/runbooks/phase-12.md`
- `docs/runbooks/phase-13.md`
- `docs/runbooks/phase-14.md`
- `docs/runbooks/phase-15.md`
- `docs/runbooks/phase-4.md`
- `docs/runbooks/phase-5.md`
- `docs/runbooks/phase-6.md`
- `docs/runbooks/phase-7.md`
- `docs/runbooks/phase-8.md`
- `docs/runbooks/phase-9.md`
- `docs/runbooks/validation-results.md`
- `evals/adversarial/.gitkeep`
- `evals/fixtures/.gitkeep`
- `evals/fixtures/capabilities.ts`
- `evals/fixtures/contracts.ts`
- `evals/fixtures/kernel.ts`
- `evals/fixtures/models.ts`
- `evals/fixtures/verification.ts`
- `evals/golden/.gitkeep`
- `evals/golden/uppercase.ts`
- `evals/regression/.gitkeep`
- `infrastructure/docker/.gitkeep`
- `infrastructure/docker/validation.compose.yaml`
- `infrastructure/docker/worker.Dockerfile`
- `infrastructure/otel/.gitkeep`
- `infrastructure/restate/.gitkeep`
- `infrastructure/vm/.gitkeep`
- `kerneljson-planning0709.md`
- `kerneljson.config.json`
- `package.json`
- `packages/capabilities/src/.gitkeep`
- `packages/capabilities/src/index.ts`
- `packages/config/src/index.ts`
- `packages/contracts/src/approval.ts`
- `packages/contracts/src/capability-run.ts`
- `packages/contracts/src/capability.ts`
- `packages/contracts/src/common.ts`
- `packages/contracts/src/evaluation.ts`
- `packages/contracts/src/event.ts`
- `packages/contracts/src/evidence.ts`
- `packages/contracts/src/identity.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/intent.ts`
- `packages/contracts/src/lifecycle.ts`
- `packages/contracts/src/memory.ts`
- `packages/contracts/src/model.ts`
- `packages/contracts/src/outcome.ts`
- `packages/contracts/src/plan.ts`
- `packages/contracts/src/policy-gate.ts`
- `packages/contracts/src/policy.ts`
- `packages/contracts/src/routing.ts`
- `packages/contracts/src/schedule.ts`
- `packages/contracts/src/task.ts`
- `packages/contracts/src/verification.ts`
- `packages/contracts/src/world.ts`
- `packages/identity/src/index.ts`
- `packages/models/src/deepseek.ts`
- `packages/models/src/digest.ts`
- `packages/models/src/index.ts`
- `packages/models/src/port.ts`
- `packages/telemetry/src/index.ts`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`
- `policies/base/.gitkeep`
- `policies/tenants/.gitkeep`
- `reSYSTEM_HANDOVER_FOR_EXTERNAL_ARCHITECT.md`
- `runtimes/sandbox/src/index.ts`
- `runtimes/worker/src/index.ts`
- `scripts/bootstrap/.gitkeep`
- `scripts/development/.gitkeep`
- `scripts/validate_capabilities.py`
- `scripts/verification/.gitkeep`
- `services/evaluator/src/candidate.ts`
- `services/evaluator/src/cli.ts`
- `services/evaluator/src/index.ts`
- `services/evaluator/src/store.ts`
- `services/kernel/src/approval-store.ts`
- `services/kernel/src/autonomous-workflow.ts`
- `services/kernel/src/capabilities.ts`
- `services/kernel/src/capability-store.ts`
- `services/kernel/src/client.ts`
- `services/kernel/src/compiler/.gitkeep`
- `services/kernel/src/compiler/client.ts`
- `services/kernel/src/compiler/index.ts`
- `services/kernel/src/deterministic.ts`
- `services/kernel/src/executor/index.ts`
- `services/kernel/src/executor/workflow.ts`
- `services/kernel/src/golden-workflow.ts`
- `services/kernel/src/index.ts`
- `services/kernel/src/ledger.ts`
- `services/kernel/src/model-smoke.ts`
- `services/kernel/src/models.ts`
- `services/kernel/src/planner/.gitkeep`
- `services/kernel/src/planner/index.ts`
- `services/kernel/src/policy-workflow.ts`
- `services/kernel/src/policy.ts`
- `services/kernel/src/provenance.ts`
- `services/kernel/src/router/.gitkeep`
- `services/kernel/src/routing.ts`
- `services/kernel/src/schedule-store.ts`
- `services/kernel/src/schedule.ts`
- `services/kernel/src/scheduler/.gitkeep`
- `services/kernel/src/verification-store.ts`
- `services/kernel/src/verification.ts`
- `services/kernel/src/workflow.ts`
- `services/memory/src/index.ts`
- `services/policy/src/index.ts`
- `services/world-model/src/index.ts`
- `supabase/.gitignore`
- `supabase/config.toml`
- `supabase/migrations/20260905153656_identity.sql`
- `supabase/migrations/20260905153700_task_ledger.sql`
- `supabase/migrations/20260905153704_intelligence_metadata.sql`
- `supabase/migrations/20260905153708_world_model.sql`
- `supabase/migrations/20260905173500_memory_provenance.sql`
- `supabase/migrations/20260905173800_world_provenance.sql`
- `supabase/migrations/20260905174200_evaluation_history.sql`
- `supabase/seed.sql`
- `tests/capabilities.test.ts`
- `tests/contracts.test.ts`
- `tests/database.test.ts`
- `tests/evaluation-db.test.ts`
- `tests/evaluation.test.ts`
- `tests/kernel.test.ts`
- `tests/memory.test.ts`
- `tests/mission-control.test.ts`
- `tests/models.test.ts`
- `tests/policy.test.ts`
- `tests/recovery.test.ts`
- `tests/routing.test.ts`
- `tests/schedule-db.test.ts`
- `tests/schedule.test.ts`
- `tests/support/autonomous-probe.ts`
- `tests/support/capability-probe.ts`
- `tests/support/golden-probe.ts`
- `tests/support/knowledge-db.ts`
- `tests/support/local.ts`
- `tests/support/mission-preview.ts`
- `tests/support/model-probe.ts`
- `tests/support/policy-probe.ts`
- `tests/support/routing-probe.ts`
- `tests/support/worker.ts`
- `tests/verification.test.ts`
- `tests/world.test.ts`
- `trap KernelJSON clean architecture`
- `tsconfig.base.json`
- `tsconfig.json`
- `vitest.config.ts`
- `workflows/development/.gitkeep`
- `workflows/operations/.gitkeep`
- `workflows/repository/.gitkeep`
- `workflows/research/.gitkeep`
- `PHASE_15_HANDOFF.md`

## Individual test cases in the saved full-suite report

### capabilities.test.ts

- discovers immutable exact versions and their JSON schemas — passed
- executes and independently verifies a built-in (0) — passed
- executes and independently verifies a built-in (1) — passed
- executes and independently verifies a built-in (2) — passed
- executes and independently verifies a built-in (3) — passed
- rejects invalid or scope-expanding invocation fixtures (0) — passed
- rejects invalid or scope-expanding invocation fixtures (1) — passed
- rejects invalid or scope-expanding invocation fixtures (2) — passed
- rejects invalid or scope-expanding invocation fixtures (3) — passed
- rejects invalid or scope-expanding invocation fixtures (4) — passed
- rejects invalid or scope-expanding invocation fixtures (5) — passed
- validates capability-specific input before execution (0) — passed
- validates capability-specific input before execution (1) — passed
- validates capability-specific input before execution (2) — passed
- refuses permissioned, external or unversioned registration (0) — passed
- refuses permissioned, external or unversioned registration (1) — passed
- refuses permissioned, external or unversioned registration (2) — passed
- refuses permissioned, external or unversioned registration (3) — passed
- refuses permissioned, external or unversioned registration (4) — passed
- refuses permissioned, external or unversioned registration (5) — passed
- detects output schema errors, incorrect results, thrown verifiers and implementation failures — passed
- does not let receipt hashes replace independent verification — passed
- binds every receipt to task, step, trace, version, key, descriptor and input — passed
- canonical digests survive JSONB key order but preserve array order and values — passed
- captures registrations and refuses silent schema coercion — passed

### contracts.test.ts

- contract fixtures PrincipalRef accepts valid fixture — passed
- contract fixtures PrincipalRef rejects malformed, missing and unknown fields — passed
- contract fixtures TenantRef accepts valid fixture — passed
- contract fixtures TenantRef rejects malformed, missing and unknown fields — passed
- contract fixtures TraceRef accepts valid fixture — passed
- contract fixtures TraceRef rejects malformed, missing and unknown fields — passed
- contract fixtures IntentEnvelope accepts valid fixture — passed
- contract fixtures IntentEnvelope rejects malformed, missing and unknown fields — passed
- contract fixtures Task accepts valid fixture — passed
- contract fixtures Task rejects malformed, missing and unknown fields — passed
- contract fixtures TaskStep accepts valid fixture — passed
- contract fixtures TaskStep rejects malformed, missing and unknown fields — passed
- contract fixtures TaskEvent accepts valid fixture — passed
- contract fixtures TaskEvent rejects malformed, missing and unknown fields — passed
- contract fixtures Evidence accepts valid fixture — passed
- contract fixtures Evidence rejects malformed, missing and unknown fields — passed
- contract fixtures Capability accepts valid fixture — passed
- contract fixtures Capability rejects malformed, missing and unknown fields — passed
- contract fixtures PolicyDecision accepts valid fixture — passed
- contract fixtures PolicyDecision rejects malformed, missing and unknown fields — passed
- contract fixtures Approval accepts valid fixture — passed
- contract fixtures Approval rejects malformed, missing and unknown fields — passed
- contract fixtures Outcome accepts valid fixture — passed
- contract fixtures Outcome rejects malformed, missing and unknown fields — passed
- rejects invalid enums, IDs, timestamps and self-dependencies — passed
- freezes nested immutable event data — passed
- enforces lifecycle transitions and terminal states — passed
- requires verified task-bound evidence and every criterion — passed
- recomputes deterministic evidence and rejects tampering — passed

### database.test.ts

- Phase 6 atomically persists one capability run, evidence and event under concurrent retries — passed
- Phase 6 rejects idempotency conflicts without another evidence record — passed
- Phase 6 rejects wrong trace, step, input and capability bindings before persistence — passed
- Phase 6 rolls back evidence and event if capability run insertion fails — passed
- Phase 6 rejects forged output even when the attacker recomputes its digest — passed
- Phase 6 refuses descriptor changes under an already-persisted version — passed
- Phase 6 refuses to persist new execution receipts for a waiting task — passed
- Phase 7 binds approvals to scope and authenticated identity, with first terminal decision winning — passed
- Phase 7 cannot grant an expired approval — passed
- Phase 7 rechecks tenant membership before granting — passed
- applies all four migration groups with RLS and no public API grants — passed
- rejects event UPDATE, DELETE and TRUNCATE even for the local owner — passed
- retries ledger writes without duplicates and rejects changed input — passed
- rejects lifecycle skips and completion without evidence at the database boundary — passed
- enforces tenant ownership and provenance foreign keys — passed
- enforces capability side-effect idempotency and immutable evidence — passed
- commits evidence-bound completion atomically and protects terminal records — passed

### evaluation-db.test.ts

- runs and persists an idempotent executable evaluation with a verified task anchor — passed
- rejects result injection, unverified anchors and stale candidate promotion — passed
- isolates tenant reports and protects evaluation history in SQL — passed

### evaluation.test.ts

- executes the golden corpus against the real registered capability — passed
- blocks a schema-valid semantic regression — passed
- classifies thrown failures without exposing error content — passed
- rejects non-JSON outputs including unawaited promises — passed
- requires exact candidate and suite versions with every case present — passed
- rejects forged passing flags, duplicate cases and malformed suites — passed
- does not let candidate mutation rewrite expected fixtures — passed

### kernel.test.ts

- compiles the same intent deterministically and preserves identity and provenance — passed
- rejects unsupported recipes, resolvers and caller-supplied permissions or plans — passed
- treats objective text literally rather than as executable instructions — passed
- plans uppercase/v1 with stable task-owned steps and dependency-bound inputs — passed
- plans uppercase-reverse/v1 with stable task-owned steps and dependency-bound inputs — passed
- rejects tasks whose requirements cannot be met by a recipe — passed
- rejects execution graph: missing dependency — passed
- rejects execution graph: cycle — passed
- rejects execution graph: duplicate step — passed
- rejects execution graph: foreign task — passed
- rejects execution graph: hidden input edge — passed
- rejects execution graph: disconnected work — passed
- rejects execution graph: unsupported execution — passed
- rejects execution graph: missing result — passed
- rejects execution graph: caller permissions — passed
- refuses to execute with unresolved dependencies or bypass a durable wait — passed
- verifies persisted plan, every step, evidence and outcome together — passed
- rejects tampered or missing evidence, incomplete steps, substituted plans and invented outcomes — passed

### memory.test.ts

- remembers verified output once under concurrent retries and retrieves provenance — passed
- excludes future observations and expired memory, including expiry boundary — passed
- does not interpret search wildcards or accept unbounded requests — passed
- rejects foreign or unsupported evidence and conflicting validity — passed
- isolates tenants even for a principal belonging to both — passed
- rejects non-completed task evidence and evidence outside the verified outcome — passed
- database rejects memory mutation and deletion — passed
- rechecks revoked membership and principal kind — passed

### mission-control.test.ts

- serves a task overview and evidence-backed task detail over HTTP — passed
- requires authentication and tenant membership — passed
- escapes stored content and applies restrictive browser security headers — passed
- rejects cross-origin mutations and cannot complete a task through the UI — passed
- returns bounded, non-leaking errors for invalid or unknown task identifiers — passed

### models.test.ts

- rejects mismatched task/trace/input/output provenance before persistence — passed
- keeps ModelPort results provider-independent and normalizes property order — passed
- returns validated text and a task/step/trace-bound receipt with usage and digests — passed
- rejects invalid or scope-expanding model requests before I/O (0) — passed
- rejects invalid or scope-expanding model requests before I/O (1) — passed
- rejects invalid or scope-expanding model requests before I/O (2) — passed
- rejects invalid or scope-expanding model requests before I/O (3) — passed
- rejects invalid or scope-expanding model requests before I/O (4) — passed
- rejects invalid or scope-expanding model requests before I/O (5) — passed
- rejects invalid or scope-expanding model requests before I/O (6) — passed
- rejects invalid or scope-expanding model requests before I/O (7) — passed
- rejects invalid or scope-expanding model requests before I/O (8) — passed
- rejects invalid or scope-expanding model requests before I/O (9) — passed
- rejects invalid or scope-expanding model requests before I/O (10) — passed
- rejects invalid or scope-expanding model requests before I/O (11) — passed
- rejects invalid or scope-expanding model requests before I/O (12) — passed
- rejects invalid or scope-expanding model requests before I/O (13) — passed
- classifies HTTP 400 without retries or leaking its body — passed
- classifies HTTP 401 without retries or leaking its body — passed
- classifies HTTP 403 without retries or leaking its body — passed
- classifies HTTP 402 without retries or leaking its body — passed
- classifies HTTP 429 without retries or leaking its body — passed
- classifies HTTP 500 without retries or leaking its body — passed
- classifies HTTP 503 without retries or leaking its body — passed
- does not treat finish reason length as successful output — passed
- does not treat finish reason content_filter as successful output — passed
- does not treat finish reason tool_calls as successful output — passed
- does not treat finish reason insufficient_system_resource as successful output — passed
- fails closed on malformed provider data (0) — passed
- fails closed on malformed provider data (1) — passed
- fails closed on malformed provider data (2) — passed
- fails closed on malformed provider data (3) — passed
- fails closed on malformed provider data (4) — passed
- fails closed on malformed provider data (5) — passed
- rejects unsolicited tool calls even with a stop finish reason — passed
- bounds response bytes and rejects invalid JSON — passed
- sanitizes transport exceptions and exposes uncertain execution — passed
- does not send a pre-cancelled request — passed
- rejects invalid deployment configuration and inconsistent usage — passed
- sends only the documented bounded text request over HTTP — passed
- enforces timeout before headers or during body reads (body=false) — passed
- enforces timeout before headers or during body reads (body=true) — passed
- supports cancellation after dispatch — passed
- does not follow redirects with authorization — passed

### policy.test.ts

- evaluates an explicit ALLOW rule with a stable scope — passed
- evaluates an explicit DENY rule with a stable scope — passed
- evaluates an explicit APPROVAL_REQUIRED rule with a stable scope — passed
- denies unmatched identity/tenant/version (0) — passed
- denies unmatched identity/tenant/version (1) — passed
- denies unmatched identity/tenant/version (2) — passed
- denies by default and refuses scope mismatch before considering ALLOW — passed
- cannot authorize an unsupported capability (0) — passed
- cannot authorize an unsupported capability (1) — passed
- cannot authorize an unsupported capability (2) — passed
- rejects ambiguous, service-approver and unbounded approval rules — passed
- rejects actor/permissions injection into an approval answer — passed
- fails closed on task requirements the initial executor cannot enforce — passed

### recovery.test.ts

- Phase 15 resumes a bounded schedule timer and recovers its final evidence commit — passed
- Phase 15 cancel stops future child work at its durable wait — passed
- Phase 15 revoke stops future child work at its durable wait — passed
- Phase 15 rejects unauthorized schedules and orphan child execution — passed
- Phase 14 journals route selection across its database commit and worker recovery — passed
- Phase 13 Mission Control approve routes an authenticated human action through the golden workflow — passed
- Phase 13 Mission Control cancel routes an authenticated human action through the golden workflow — passed
- Phase 9 golden intent recovers approval and outcome commit with one complete audit chain — passed
- Phase 9 rejects unsupported recipes and spoofed intent ownership before persistence — passed
- Phase 8 verifies persisted approved execution before terminal outcome (matching criteria=true) — passed
- Phase 8 verifies persisted approved execution before terminal outcome (matching criteria=false) — passed
- Phase 7 waits durably, rejects spoofed approval and executes only after an authenticated grant — passed
- Phase 7 DENIED prevents execution and a late grant cannot reverse it — passed
- Phase 7 CANCEL prevents execution and a late grant cannot reverse it — passed
- Phase 7 expires its durable approval wait without executing the capability — passed
- Phase 6 recovers capability receipt commit before acknowledgement without repeating execution — passed
- survives worker and Restate restart at durable wait; duplicate signal/submission is safe — passed
- replays after database commit but before Restate acknowledgement without duplicate effects — passed
- cancels a waiting task durably; a late resume cannot execute step B — passed
- rejects unsupported recipe requests without creating a task projection — passed
- Phase 4 compiles an intent and executes a one-step plan without a wait — passed
- Phase 4 executes the persisted DAG across Restate/worker restart and duplicate signals — passed
- Phase 4 recovers after a graph step commit before Restate acknowledgement — passed
- Phase 4 cancels a waiting graph without executing downstream work — passed
- Phase 4 rejects graph injection at the workflow boundary before persistence — passed
- Phase 5 journals model HTTP 200 results across a receipt commit/acknowledgement crash — passed
- Phase 5 journals model HTTP 429 results across a receipt commit/acknowledgement crash — passed

### routing.test.ts

- adapts deterministically to measured latency among evaluated compatible versions — passed
- never trades policy or evaluation failure for faster execution — passed
- enforces reliability, latency, cost, freshness and descriptor binding — passed
- requires explicit cold-start opt-in and uses only the evaluated default — passed
- breaks ties stably and rejects duplicate or injected measurement evidence — passed
- rejects task/step/invocation scope mismatches before selection — passed

### schedule-db.test.ts

- rejects schedule completion with unverified children (asserted outcome=false) — passed
- rejects schedule completion with unverified children (asserted outcome=true) — passed

### schedule.test.ts

- compiles a bounded task plan with stable unique child task identities — passed
- defaults disabled and requires an explicit authenticated human owner — passed
- enforces run counts, execution-unit budgets and interval limits — passed
- rejects attempts to enable, choose arbitrary workflows or inject plan fields — passed

### verification.test.ts

- passes only independently verified, policy-authorized capability evidence — passed
- fails without steps — passed
- fails without runs — passed
- fails without evidence — passed
- fails without policies — passed
- rejects arbitrary acceptance criteria and unverified task state — passed
- rejects incomplete steps and forged output despite a recomputed digest — passed
- rejects foreign evidence, descriptor drift and denied policy — passed
- requires bound human evidence for approval-required execution — passed

### world.test.ts

- keeps a stable tenant identity and rejects changing its type — passed
- stores verified observations once and filters knowledge and validity intervals — passed
- retains multiple valid observations and rejects rewriting an observation window — passed
- requires matching evidence on both endpoints before recording a typed relationship — passed
- isolates entity identities and prevents cross-tenant observations and edges — passed
- rejects injected claims, confidence, invalid windows and missing evidence — passed
- database prevents graph history mutation and requires relationship provenance — passed


## Historical executed report summary

| Local report | Passed | Failed | Not selected/skipped |
| --- | --- | --- | --- |
| handoff-tests.json | 224 | 0 | 0 |
| phase1-3-tests.json | 40 | 0 | 0 |
| phase10-tests.json | 25 | 0 | 0 |
| phase11-tests.json | 32 | 0 | 0 |
| phase12-tests.json | 27 | 0 | 0 |
| phase13-http-tests.json | 5 | 0 | 0 |
| phase13-recovery-tests.json | 2 | 0 | 20 |
| phase14-recovery-tests.json | 2 | 0 | 21 |
| phase14-unit-tests.json | 6 | 0 | 0 |
| phase15-full-tests.json | 224 | 0 | 0 |
| phase15-recovery-tests.json | 4 | 0 | 23 |
| phase4-tests.json | 63 | 0 | 0 |
| phase5-tests.json | 109 | 0 | 0 |
| phase6-tests.json | 142 | 0 | 0 |
| phase7-tests.json | 162 | 0 | 0 |
| phase8-tests.json | 173 | 0 | 0 |
| phase9-tests.json | 175 | 0 | 0 |

Fresh raw report SHA-256: `3edf1715d45d1074f51b0d10ec68a3b39c21c82f9f033a4512d612c9e8eeac63`. Raw JSON is kept locally; the counts and test inventory above are committed for portable evidence.

Additional audit check: `git diff --cached --check` returned exit 1 for trailing whitespace/extra EOF blank lines in the supplied Grok integration specification, both external-architect handover copies and the unusual trap artifact. These reference files are preserved unchanged as requested; this is not a TypeScript/test failure.
