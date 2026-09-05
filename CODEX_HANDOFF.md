# KernelJSON Codex Handoff

## Saved checkpoint — 2026-09-05

Current branch: `codex/phase-15`. Phases 1–14 are implemented with the
executed evidence recorded in `STATE.yaml` and the phase runbooks. Phase 15
is in progress: typecheck, build, four unit tests and four targeted recovery
tests passed. It is not complete. See `docs/runbooks/phase-15.md` for remaining
verification work. The last full combined suite was Phase 9; later phases
have focused validation only. The user requested saving and pushing this
checkpoint before further implementation. No remote migrations were pushed.

The original bootstrap status below is historical, not the current state.

This is the historical Phase 1–3 handoff. The user subsequently authorized
Phases 4 onward; see `STATE.yaml`, the accepted ADRs and the phase runbooks
for those bounded follow-on implementations. The exclusions below describe
the historical Phase 1–3 scope, not a ban on the subsequently authorized Phase 5
ModelPort and DeepSeek adapter. Local tests and live provider validation passed;
see STATE.yaml for evidence. Production model-backed recipes remain later work.

## Mission

Build KernelJSON as a durable cognitive execution platform, not an agent roster.

The architectural constitution in `ARCHITECTURE.md` is binding unless a new ADR explicitly supersedes it.

The six primitives are:

1. EVENT
2. TASK
3. CAPABILITY
4. STATE
5. POLICY
6. EVIDENCE

The core rule is: **a Task is the primitive; an agent is only one possible execution strategy.**

## Current verified state

- Repository: `jonnyallum/kerneljson`
- Branch: `main`
- Supabase project ref: `banqdzddfganzfhckdps`
- Supabase CLI has been linked locally by Jonny.
- jVault project: `kerneljson`
- Phase 0 bootstrap is complete.
- No production business logic exists yet.
- Typed contract files exist as placeholders.
- No migrations have been applied by this project yet.
- No Restate workflow has been implemented yet.

Read these first:

1. `ARCHITECTURE.md`
2. `STATE.yaml`
3. `BUILD_PLAN.md`
4. `docs/adr/0001-tasks-not-agents.md`
5. `docs/adr/0002-durable-execution.md`
6. `docs/adr/0003-evidence-bound-completion.md`
7. `docs/adr/0004-jvault.md`

## Non-negotiable constraints

Do NOT introduce:

- persistent cognitive agent rosters
- personas as infrastructure
- LangGraph, CrewAI or AutoGen
- Redis, RabbitMQ or Kafka without proven need
- Supabase as a job queue
- secrets in Git or committed `.env` files
- direct DeepSeek imports throughout the codebase
- LLM-controlled permissions
- side-effect success without evidence
- self-modification without evaluation
- large speculative frameworks or abstractions not required by the current phase

Prefer the smallest typed implementation that satisfies the acceptance tests.

## Canonical ownership

- Restate: durable execution, retries, waits, recovery, workflow scheduling
- Supabase/PostgreSQL: persisted state, provenance, task projections, evidence, outcomes, memory and world model
- Git: source, schemas, migrations, policies, evals and ADRs
- jVault `kerneljson`: credentials and runtime secrets
- Object storage: large artefacts
- Mission Control: later human visibility/control surface

## Immediate implementation slice

Build only Phases 1-3 now.

---

# PHASE 1 - Typed contracts

Use TypeScript, strict mode, Zod schemas and inferred TypeScript types.

Implement the placeholders under `packages/contracts/src/`.

Required contracts:

## Identity

- `PrincipalRef`
- `TenantRef`
- `TraceRef`

## IntentEnvelope

Fields should include at minimum:

- id
- principal
- tenant
- channel/source
- text/objective
- attachments/context refs
- receivedAt
- correlation/trace identifiers

## Task

At minimum:

- id
- parentTaskId optional
- principal
- tenant
- objective
- acceptanceCriteria[]
- constraints[]
- riskClass
- budget optional
- deadline optional
- status
- traceId
- createdAt
- startedAt optional
- completedAt optional

Task status must be an explicit enum. Initial lifecycle:

- RECEIVED
- COMPILED
- READY
- RUNNING
- WAITING
- APPROVAL_REQUIRED
- VERIFYING
- COMPLETED
- FAILED
- CANCELLED

## TaskStep

At minimum:

- id
- taskId
- kind
- status
- dependencies[]
- requiredCapabilities[]
- riskClass
- retryPolicy
- timeout optional
- input
- output optional

Step kind must support at least:

- DETERMINISTIC_FUNCTION
- TOOL_CALL
- LLM_CALL
- AGENT_LOOP
- PARALLEL_MAP
- SANDBOX_EXEC
- HUMAN_APPROVAL
- WAIT_FOR_EVENT
- SCHEDULE
- SUBWORKFLOW

## TaskEvent

Immutable event contract with at minimum:

- id
- taskId
- stepId optional
- type
- occurredAt
- actor
- traceId
- payload

Event types must support the initial lifecycle:

- TASK_CREATED
- INTENT_RESOLVED
- PLAN_COMPILED
- POLICY_CHECKED
- STEP_STARTED
- MODEL_CALLED
- TOOL_CALLED
- EVIDENCE_RECEIVED
- STEP_COMPLETED
- APPROVAL_REQUESTED
- APPROVAL_GRANTED
- VERIFICATION_FAILED
- REPLAN_TRIGGERED
- TASK_COMPLETED
- TASK_FAILED
- LEARNING_PROPOSED

## Evidence

At minimum:

- id
- taskId
- stepId optional
- type
- source
- uri/ref optional
- digest/hash optional
- capturedAt
- metadata

Evidence must be suitable for deterministic verification. Do not model evidence as free prose only.

## Capability

At minimum:

- id
- version
- description
- inputSchemaRef
- outputSchemaRef
- riskClass
- permissions[]
- implementationType
- verification requirements

Implementation types should support:

- DETERMINISTIC
- MCP
- API
- SKILL
- SANDBOX
- HUMAN
- HYBRID

## PolicyDecision

At minimum:

- id
- taskId
- stepId optional
- capability
- decision
- reasonCode
- evaluatedAt
- policyVersion

Decision enum:

- ALLOW
- DENY
- APPROVAL_REQUIRED

## Approval

At minimum:

- id
- taskId
- stepId optional
- requestedFrom
- requestedAt
- status
- resolvedAt optional
- evidence/ref optional

## Outcome

At minimum:

- taskId
- status
- acceptanceResults[]
- evidenceRefs[]
- summary
- completedAt

## Contract quality gates

- all schemas parse valid fixtures
- invalid fixtures are rejected
- no `any`
- strict TypeScript passes
- exports consolidated through `packages/contracts/src/index.ts`
- add unit tests

---

# PHASE 2 - Supabase persistence foundation

Create versioned SQL migrations under `supabase/migrations/`.

Do NOT apply remote migrations until they pass local review/tests and Jonny can inspect a dry run.

Initial migration groups:

## 001 identity

Tables:

- principals
- tenants
- tenant_memberships
- channels

## 002 task ledger

Tables:

- tasks
- task_steps
- task_events
- approvals
- evidence
- artifacts

Requirements:

- UUID primary keys
- timestamps with timezone
- immutable `task_events`
- useful foreign keys
- indexes for task/status/tenant/trace lookups
- idempotency key support for external side effects
- payload columns may use `jsonb` where type-specific structure cannot reasonably be relational
- task status is a projection; event history remains authoritative for audit

Prevent UPDATE and DELETE on `task_events` through database permissions/policies or triggers appropriate to the chosen design.

## 003 intelligence metadata

Tables:

- capabilities
- capability_versions
- capability_runs
- memory_items
- outcomes
- evaluations

Memory must support provenance fields from day one. Add vector support only if the extension is available and the migration remains clean/reversible.

## 004 world model

Tables:

- entities
- relationships
- observations

Requirements:

- stable entity identity
- typed relationships
- temporal/provenance information on observations
- no assumption that an observation is permanently true

## Supabase safety

- no production-destructive SQL
- migrations must be reversible where practical
- no embedded secrets
- add SQL tests/checks where practical
- produce exact dry-run commands for Jonny before remote push

---

# PHASE 3 - Restate durable TaskWorkflow

Implement the smallest possible durable workflow that proves the runtime semantics before any LLM integration.

Desired conceptual API:

- `task.submit`
- `task.status`
- `task.cancel`
- `task.signal`

First workflow acceptance path:

1. submit task
2. persist task projection/event
3. execute deterministic step A
4. write STEP_STARTED / STEP_COMPLETED events
5. enter a durable wait
6. resume via signal
7. execute deterministic step B
8. attach deterministic evidence
9. verify evidence
10. write TASK_COMPLETED
11. persist outcome

Critical recovery test:

- start a workflow
- reach durable wait or mid-execution boundary
- stop/restart the Restate service/application
- workflow resumes without duplicate externally visible side effects

Use idempotency keys wherever a retried step could otherwise duplicate a write.

Do not integrate DeepSeek in Phase 3.

---

# Test strategy

Set up Vitest or an equivalent lightweight TypeScript test runner.

Required tests before the slice is considered complete:

1. contract valid fixture suite
2. contract invalid fixture suite
3. task lifecycle transition tests
4. evidence-bound completion negative test: task cannot complete without required evidence
5. policy enum/decision tests
6. event immutability DB test
7. idempotency constraint test
8. Restate recovery/resume test
9. duplicate-signal/retry safety test
10. clean `pnpm test` and `pnpm typecheck`

Create the first fixtures under `evals/golden/` or `evals/fixtures/`, but do not build the full evaluation system yet.

# Definition of done for this handoff

Do not declare completion until all of the following are true:

- Phase 1 contracts implemented and tested
- Phase 2 migrations authored and validated locally
- remote Supabase changes are NOT pushed without explicit review/approval
- Phase 3 deterministic Restate workflow implemented
- restart/resume behaviour demonstrated by an automated or reproducible test
- evidence is required for completion
- no DeepSeek integration yet
- no channel integrations yet
- no Mission Control UI yet
- no memory retrieval yet
- no autonomous workflows yet
- `STATE.yaml` updated truthfully
- README/build docs updated only to reflect what actually exists

# Working discipline

Before changing architecture, add an ADR.

Do not silently broaden scope.

When discovering a missing prerequisite:

1. record the gap
2. implement the minimum safe prerequisite if it is in scope
3. otherwise leave a clear blocker

Never report a feature as built because a file or placeholder exists. Report only verified behaviour.

# First action

Inspect the repository and toolchain, then provide a concise implementation plan based on the actual files before editing. After that, implement the Phase 1-3 slice end-to-end, testing as you go.
