# KernelJSON Codex Handoff

## FINAL CANONICAL INSTRUCTION

KernelJSON now has a final agreed architecture and roadmap.

Before implementation, read and obey in this order:

1. `ARCHITECTURE.md`
2. `FINAL_PLAN.md`
3. `STATE.yaml`
4. `BUILD_PLAN.md`
5. this `CODEX_HANDOFF.md`
6. accepted ADRs under `docs/adr/`
7. `docs/cognition/COGNITIVE_ARCHITECTURE.md`
8. `docs/cognition/IMPLEMENTATION_PLAN.md`
9. the cognitive hardening specs listed below

Cognitive hardening specs are binding for the phases in which they become relevant:

- `docs/cognition/COGNITIVE_SECURITY.md`
- `docs/cognition/IDENTITY_GOVERNANCE.md`
- `docs/cognition/CONTEXT_ASSEMBLY.md`
- `docs/cognition/COGNITIVE_CONFLICT_PROTOCOL.md`
- `docs/cognition/IDENTITY_BACKUP_AND_RECOVERY.md`

Accepted cognitive ADRs include:

- `docs/adr/0005-persistent-identities-ephemeral-workers.md`
- `docs/adr/0006-core-team-and-dynamic-specialists.md`
- `docs/adr/0007-canonical-context-and-memory-boundaries.md`

The architecture is considered frozen as of 2026-09-09. Do not continue speculative redesign while implementing. If a material conflict or missing architectural prerequisite is discovered, document it and stop that architectural branch. A material change requires an explicit human decision and an ADR where accepted boundaries would change.

`STATE.yaml` remains the source of truth for verified implementation. Design documents do not mean a feature exists.

The current implementation scope remains **Phases 1-3 only**. The final cognitive plan does not authorise premature implementation of Primary Identity, Core Team, specialists, memory retrieval, Mission Control or autonomous workflows.

## Mission

Build KernelJSON as a durable cognitive execution platform, not an agent roster.

The architectural constitution in `ARCHITECTURE.md` is binding unless a new accepted ADR explicitly supersedes it.

The six primitives are:

1. EVENT
2. TASK
3. CAPABILITY
4. STATE
5. POLICY
6. EVIDENCE

The core rule is: **a Task is the primitive; an agent/worker is only one possible execution strategy.**

The accepted cognitive rules are:

- **Identities may persist. Cognitive executions do not.**
- **Models may reason over canonical state. They do not become canonical state.**

## Current verified state

- Repository: `jonnyallum/kerneljson`
- Branch: `main`
- Supabase project ref: `banqdzddfganzfhckdps`
- Supabase CLI has been linked locally by Jonny.
- jVault project: `kerneljson`
- Phase 0 bootstrap is complete.
- No production business logic exists yet unless `STATE.yaml` has subsequently been truthfully updated by verified implementation.
- Typed contract files began as placeholders.
- No migration or Restate workflow should be assumed complete unless verified in repository state/tests.

## Non-negotiable constraints

Do NOT introduce:

- persistent cognitive agent rosters
- personas as infrastructure
- LangGraph, CrewAI or AutoGen as the runtime architecture
- Redis, RabbitMQ or Kafka without proven need and an ADR where architecture changes
- Supabase as a job queue
- secrets in Git, committed `.env` files, prompts or durable memory
- direct DeepSeek/provider imports throughout the codebase
- LLM-controlled permissions
- side-effect success without evidence
- provider conversation state as canonical identity/memory
- durable memory without provenance
- self-modification without evaluation/governance
- automatic authority growth from reflection or good performance
- swarms without a simpler baseline/evaluation case
- silent broadening of the current phase
- large speculative frameworks or abstractions not required by the current acceptance tests

Prefer deterministic mechanisms where they solve the problem reliably.

Prefer the smallest typed implementation that satisfies the acceptance tests.

## Canonical ownership

- Restate: durable execution, retries, waits, recovery, workflow scheduling
- Supabase/PostgreSQL: persisted state, provenance, task projections, evidence, outcomes, memory, identity state and world model when their phases arrive
- Git: source, schemas, migrations, policies, evals, constitutional docs and ADRs
- jVault `kerneljson`: credentials and runtime secrets
- Object storage: large artefacts
- Mission Control: later human visibility/control surface
- Model providers: replaceable cognitive engines, never canonical state owners

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

These are execution identity references, not the later Primary Identity cognitive model.

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

`AGENT_LOOP` is an execution kind. It does not authorise a separate persistent agent scheduler/roster.

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

Do not prematurely add the later cognitive Primary Identity schema during this slice.

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

Do not implement the full cognitive memory promotion/context-assembly system yet.

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
- preserve tenant/principal scoping needed by later cognitive boundaries

---

# PHASE 3 - Restate durable TaskWorkflow

Implement the smallest possible durable workflow that proves runtime semantics before any LLM integration.

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

Do not implement cognitive workers, Primary Identity or Core Team in Phase 3.

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
- no cognitive-worker implementation yet
- no Primary Identity/Core Team implementation yet
- no channel integrations yet
- no Mission Control UI yet
- no memory retrieval/context assembly yet
- no autonomous workflows yet
- `STATE.yaml` updated truthfully for verified implementation only
- README/build docs updated only to reflect what actually exists

# Working discipline

Before changing accepted architecture, add an ADR and obtain the required human decision.

Do not silently broaden scope.

When discovering a missing prerequisite:

1. record the gap
2. implement the minimum safe prerequisite if it is genuinely in scope and does not change accepted architecture
3. otherwise leave a clear blocker

Never report a feature as built because a file or placeholder exists. Report only verified behaviour.

Do not modify `FINAL_PLAN.md` simply to make implementation easier.

# First action

Inspect the repository, `FINAL_PLAN.md`, `STATE.yaml` and toolchain, then provide a concise implementation plan based on the actual files before editing. After that, implement the Phase 1-3 slice end-to-end, testing as you go.