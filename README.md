# KernelJSON

KernelJSON is a durable cognitive execution platform.

It is NOT an agent roster.

## Six primitives

1. EVENT
2. TASK
3. CAPABILITY
4. STATE
5. POLICY
6. EVIDENCE

## Core rule

A task is the primitive.

An agent is only one possible execution strategy.

## Canonical responsibilities

- Restate: durable execution
- Supabase/PostgreSQL: persisted world state and provenance
- Git: code, schemas, policies and migrations
- jVault: credentials and secrets
- Object storage: large artefacts
- Mission Control: human visibility and control

See ARCHITECTURE.md.

## Phase 1–3 implementation

Zod contracts and strict TypeScript live in `packages/contracts/src`. Four SQL migrations define identity, task ledger, intelligence metadata and world-model persistence. `services/kernel/src` implements the fixed deterministic Restate TaskWorkflow and its internal client.

Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm build` and `pnpm test`. Integration tests require Docker and use an isolated local PostgreSQL/Restate stack. `pnpm test:unit` runs contracts and lifecycle checks without Docker.

See [the validation runbook](docs/runbooks/phase-1-3.md) for prerequisites, Windows/WSL setup, recovery tests, cancellation semantics and the remote Supabase review boundary. `STATE.yaml` records executed validation, rather than treating authored files as proof of completion.

[Executed validation results](docs/runbooks/validation-results.md): 40 tests passed, including local PostgreSQL constraints and real Restate restart/recovery.

## Phase 4 implementation

The kernel now compiles validated intents into tasks, plans deterministic dependency graphs, and executes them through `KernelWorkflowV1`. It supports explicit `uppercase/v1` and `uppercase-reverse/v1` recipes, validates graph dependencies, persists the plan and step projections, and checks plan-bound evidence before completion. The original Phase 3 workflow remains available.

See [the Phase 4 runbook](docs/runbooks/phase-4.md) for the implemented scope, API, recovery semantics and limits. This is deterministic recipe planning; model planning and external capabilities remain later phases.

Phase 4 validation: **63 tests passed**, with strict TypeScript, build, database regressions and real recovery checks for both workflow versions.

## Phase 5 implementation

`packages/models/src` provides a task-scoped ModelPort and a DeepSeek text adapter with bounded requests, validated results, sanitized receipts and classified errors. The kernel helper journals model results through Restate before recording receipts. Existing production workflows remain deterministic; model-backed recipes follow capability and policy implementation.

See [the Phase 5 runbook](docs/runbooks/phase-5.md) for local tests, durable-call semantics, limitations and the explicit jVault-backed live smoke check. Live provider validation passed using the user-supplied, Git-ignored `.env`; `STATE.yaml` records the receipt and model returned by the provider.

Phase 5 local validation: **109 tests passed**, including 44 model contract/HTTP tests and 11 real Restate recovery tests; TypeScript and build passed.

## Phase 6 implementation

The initial capability layer adds an exact-version registry, schema-validated pure text capabilities, independent result verification and durable execution receipts. The PostgreSQL adapter records capability runs, evidence and audit events atomically with idempotency and task/step binding checks. Permissioned and external capabilities remain disabled pending policy/approval work.

See [the Phase 6 runbook](docs/runbooks/phase-6.md) and `STATE.yaml` for scope and executed validation. Existing production workflows retain their journal sequences.

Phase 6 validation: **142 tests passed**, including 25 capability unit tests, 14 PostgreSQL tests and 12 real Restate recovery tests; TypeScript and build passed.

## Phase 7 implementation

Deterministic, default-deny policy rules and scoped human approvals gate capability execution. Resolution rechecks identity, tenant membership, scope and deadline; Restate owns the approval wait and recovery. See [the Phase 7 runbook](docs/runbooks/phase-7.md) for authentication requirements and the boundary before final evidence verification.

Phase 7 validation: **162 tests passed**, plus a final targeted approval recovery run; TypeScript and build passed.

## Phase 8 implementation

Persisted evidence verification now governs atomic final outcomes for the policy-gated uppercase recipe. See [the Phase 8 runbook](docs/runbooks/phase-8.md). Validation: **173 tests passed**, strict TypeScript and build passed.

## Phase 9 implementation

GoldenTaskWorkflowV1 compiles an intent and carries it through policy, durable approval, execution and verified Outcome. See [the Phase 9 runbook](docs/runbooks/phase-9.md). All **175 tests passed**, including recovery after the final database commit.

## Phase 10 implementation

Verified task results can be retained and retrieved with tenant isolation, evidence provenance and expiry. See [the Phase 10 runbook](docs/runbooks/phase-10.md). All 8 memory tests and 17 database regressions passed; TypeScript and build passed. The new migration was validated locally only.

## Phase 11 implementation

The world model now preserves stable entity identities, temporal verified observations and evidence-backed relationships. See [the Phase 11 runbook](docs/runbooks/phase-11.md). All 32 focused tests passed; TypeScript and build passed. Migrations remain local only.

## Phase 12 implementation

Versioned golden evaluations execute real candidates and persist immutable reports. Promotion checks require all expected results for the exact candidate and suite. See [the Phase 12 runbook](docs/runbooks/phase-12.md). All 27 focused tests and the five-case golden CLI passed.

## Phase 13 implementation

Mission Control provides task status, outcomes, evidence and event history, with authenticated approval/cancellation controls. See [the Phase 13 runbook](docs/runbooks/phase-13.md). HTTP and real workflow control tests passed; the rendered pages were inspected in a local browser. Production authentication and hosting are not configured.

## Phase 14 implementation

Adaptive routing ranks evaluated, policy-allowed capability versions using evidenced task measurements and explicit limits. See [the Phase 14 runbook](docs/runbooks/phase-14.md). Six routing tests and two targeted recovery checks passed. Production routes remain explicitly configured.

## Phase 15 implementation

Opt-in bounded schedules execute fixed uppercase child tasks with durable waits, current authorization checks and cooperative cancellation. Parent completion independently verifies child capability/policy evidence and acceptance criteria. Two database rejection tests and four real recovery tests passed in the saved 224-test full suite. No production scheduler is enabled. The fresh preservation run also passed all 224 tests; typecheck/build passed and catalogue validation passed. See [the final handoff](PHASE_15_HANDOFF.md) for current checks, exact source/test inventory and deployment gaps.

## Post-Phase-15 qualification

Gate 1 adds reproducible CI and ESLint, trusted persisted execution bindings, membership revocation, workflow-aware controls and an authenticated gateway handler. Its public contract supports two deterministic recipes; authentication and admission are mandatory injected dependencies. It does not expose a public Restate endpoint or deploy infrastructure.

Use Node 22.19.0 and pnpm 10.4.0. Run frozen install, `pnpm typecheck`, `pnpm lint`, the full `pnpm test` suite with Docker, and `pnpm build`. See [Gate 1 qualification](docs/production/QUALIFICATION_GATE_1.md) for exact commands, test evidence and deployment prerequisites. Earlier phase counts below/above are historical checkpoint counts.

Gate 1 local qualification passed: **277 tests, including 31 recovery tests; zero failures or skips**, plus frozen install, typecheck, lint and build from a fresh source export. All 224 original tests and 27 original recovery tests remain. No remote migrations or deployment were performed.
