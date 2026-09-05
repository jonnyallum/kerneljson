# Phase 4: deterministic compiler, planner and executor

The user authorized Phase 4 after local verification of Phases 1–3. The build
plan names a compiler, planner and executor but provides no further Phase 4
specification. This implementation deliberately limits planning to explicit
versioned recipes. [ADR-0005](../adr/0005-deterministic-kernel-plans.md) records
the implementation boundary.

## Implemented flow

`KernelSubmission → compileIntent → Task → planTask → ExecutionPlan → KernelWorkflowV1 → persisted evidence → verified Outcome`

The caller supplies a validated IntentEnvelope and recipe ID:

| Recipe | Graph | Acceptance |
| --- | --- | --- |
| `uppercase/v1` | uppercase | Output equals uppercase(trim(objective)) |
| `uppercase-reverse/v1` | uppercase → durable wait → reverse | Output equals reverse(uppercase(trim(objective))) |

Objective text is literal data for these recipes, not an executable instruction.
Attachments and context references are rejected because their resolvers do not
exist yet. Unknown recipes, caller-supplied plans, permissions and extra fields
are rejected. There is no model call or model-generated plan.

## Components

- `services/kernel/src/compiler/index.ts`: pure intent validation and task
  compilation. Task IDs derive from tenant ID, intent ID and recipe version;
  resubmitting the same identity uses the same Restate workflow key. Restate's
  first accepted submission wins; changing a submitted intent requires a new
  intent ID. Principal, tenant, timestamp and trace are retained; the creation
  event records the original intent and its correlation ID.
- `services/kernel/src/planner/index.ts`: stable task-owned step IDs, explicit
  dependency-bound inputs, a declared result step and deterministic topological
  ordering. The plan schema rejects cycles, missing or duplicate dependencies,
  duplicate steps, foreign task IDs, disconnected work and unsupported operations.
- `services/kernel/src/executor/index.ts`: deterministic function dispatch,
  dependency-output resolution and independent completion verification.
- `services/kernel/src/executor/workflow.ts`: sequential DAG execution in
  Restate, including durable waits, signal/cancellation decisions and ledger writes.
- `services/kernel/src/compiler/client.ts`: internal `KernelClient` with
  `submit`, `status`, `signal` and `cancel` methods.

The immutable PLAN_COMPILED event contains the full validated graph and digest.
All planned steps are persisted atomically with that event, initially READY.
Waiting steps project WAITING; cancelled waiting steps project CANCELLED. Steps
that were never executed remain READY beneath a terminal CANCELLED task and are
not independently scheduled. Every ordinary completed step has start/completion
events and a persisted output. The existing PostgreSQL tables suffice; Phase 4
adds no SQL migrations and performs no remote database operations.

Completion requires exactly one compiled-plan event. The verifier reconstructs
the versioned plan, independently computes every expected result, checks every
persisted step and validates the final evidence's task ID, result-step ID, plan
digest, input, output and SHA-256 digest. Outcome acceptance and summary must
match those verified results. This happens within the transaction that writes
the completion event, outcome and final task projection.

## Durable compatibility and cancellation

The original `TaskWorkflow` remains registered with its original workflow code.
The new executor is registered as `KernelWorkflowV1`; both use Restate for
journals/retries/waits and PostgreSQL for projections and audit evidence. No
database polling loop selects work. No separate queue or scheduler is introduced.

Phase 4 checks cancellation between steps and at the durable wait. A single
durable decision is first-writer-wins. Once a resume decision wins, a later
cancellation cannot supersede it. Cancellation is cooperative, does not undo
completed work and may arrive too late for a recipe with no wait. The decision
response acknowledges the stored decision; query task status for the actual
terminal result. These endpoints are internal and require a trusted caller and
network boundary; public authentication and policy/approval services are later
phases. Principals/tenants/memberships must already be provisioned.

## Verification

```sh
pnpm test:unit
pnpm typecheck
pnpm build
pnpm test
```

On this Windows host, set `$env:KERNELJSON_DOCKER_WSL = 'Ubuntu'` first. The local
Docker/PostgreSQL/Restate prerequisites and disposable-stack boundaries remain
as described in [the Phase 1–3 runbook](phase-1-3.md).

`tests/kernel.test.ts` covers compilation, graph safety, execution dependencies
and adversarial completion checks. `tests/recovery.test.ts` exercises both
workflow versions through the live service, including graph persistence,
one-step execution, restart at durable wait, post-commit/pre-acknowledgement
process failure, duplicate submissions/signals, cancellation and graph-injection
rejection. The old contract, SQL and recovery suites remain required regressions.

Executed on 5 September 2026 on branch `codex/phase-4`:

| Check | Observed result |
| --- | --- |
| `pnpm typecheck` | Passed |
| `pnpm build` | Passed |
| Combined `pnpm test` | 63 passed, 0 failed, 0 skipped; 92.05 seconds |
| Contract/lifecycle unit tests | 29 passed |
| Compiler/planner/executor unit tests | 18 passed |
| PostgreSQL regression tests | 7 passed |
| Live Restate integration tests | 9 passed: 4 original, 5 Phase 4 |

The machine-readable report is `artifacts/local/phase4-tests.json`. The exact
combined command was `pnpm test --reporter=default --reporter=json
--outputFile=artifacts/local/phase4-tests.json`. The environment and pinned
runtime versions are unchanged from the Phase 1–3 validation. File hashes also
confirmed that `services/kernel/src/workflow.ts` and all four migration files
were unchanged from the Phase 3 tested-source snapshot.

The working tree includes the earlier uncommitted Phase 1–3 work. No commit,
Git push, remote migration or remote dry run was performed in Phase 4.

## Deferred

Arbitrary user-authored plans, natural-language/model planning, parallel
execution, provider capabilities, authentication/policy services, model ports,
DeepSeek, channels, UI, memory retrieval and autonomous workflows are not part
of this slice. The next build-plan phase is Phase 5 (ModelPort and provider),
which requires a separate instruction to start.
