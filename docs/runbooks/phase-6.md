# Phase 6: Initial capability layer

The initial layer is a code-owned registry, a validated invocation/result contract,
a Restate execution helper and an atomic PostgreSQL receipt store. ADR-0007
defines the scope. No migrations or new dependencies were required.

## Available capabilities

| Export | Version | Input | Output | Verification |
| --- | --- | --- | --- | --- |
| UPPERCASE | 1.0.0 | `{text: string}` | Trimmed uppercase text | Recompute from input |
| REVERSE | 1.0.0 | `{text: string}` | Unicode code points in reverse order | Independently accumulate reversed points |

`createBuiltinRegistry()` in `packages/capabilities/src/index.ts` creates the
registry. `list()` returns immutable descriptors containing metadata and JSON
schemas. `describe({id, version})` resolves only an exact version, with no aliases
or fallback. Inputs accept at most 16,384 UTF-16 code units; the output schema
allows expansion during Unicode uppercasing. Empty text is valid.

`execute(invocation)` checks the request and capability-specific schema, executes
the pure function, checks its output schema and runs its verifier. `verify` can
independently check a receipt without invoking the implementation. Digests bind
the task, step, run, trace, idempotency key, input, descriptor and output. Canonical
JSON hashing survives PostgreSQL JSONB key reordering. Arrays retain their order.

Failures use fixed CapabilityError codes. Invalid input never reaches the
implementation; invalid output or verification failure never yields a successful
result. A verified capability result is neither a task Outcome nor a permission
decision. Task completion still requires verification against its acceptance
criteria.

The constructor permits only LOW-risk, permission-free DETERMINISTIC definitions
with explicit numeric versions. It rejects duplicate ID/version registration.
Definitions must be trusted, reviewed, synchronous application code. The registry
does not sandbox JavaScript or prove that an arbitrary implementation is pure.
It does not load plugins, accept executable model output or grant permissions.

## Durable execution and persistence

`callCapability(ctx, registry, request, record)` in
`services/kernel/src/capabilities.ts` journals execution inside `ctx.run`, then
records the result in a separate durable operation. Invalid execution terminates
with a sanitized Restate error. The surrounding workflow owns task failure and
cancellation handling; this helper never changes lifecycle state.

`CapabilityStore.record(request, result, audit)` supplies the receipt sink.
The audit contains stable evidence/event IDs and a timestamp; generate these
through Restate's UUID and clock APIs before entering a `ctx.run` closure.

The store independently validates the result and takes the same per-task
transaction lock as Ledger. New receipts require a persisted RUNNING, LOW-risk
task and RUNNING deterministic step with matching input, capability requirement,
idempotency key and trace. It then atomically persists:

- The capability and exact version descriptor, including both JSON schemas.
- DETERMINISTIC_RESULT evidence bound to the verified result digest.
- An immutable TOOL_CALLED event referencing the result and evidence.
- A capability_runs record referencing the step, version and evidence.

An existing identical task/idempotency-key pair is a no-op. A different request
or result under that key fails. Descriptor changes require a new version; the
store rejects overwriting an existing version's definition. There is no database
queue, public API grant or task status transition. Receipt payloads contain
output data; apply the task ledger's access and retention controls accordingly.

Recovery after journaled execution reuses the result. If the process dies after
the SQL commit but before acknowledgement, the store's idempotency check prevents
duplicate evidence and events. Execution before journal commit may be repeated;
the initial implementations are pure and have no external side effects.

Capability descriptors are write-once through this adapter. The existing database
does not prevent a privileged administrator from changing capability_versions;
the adapter checks the persisted definition on each new run. Existing event,
evidence and capability-run UPDATE/DELETE protections remain in force.

## Validation

```powershell
pnpm typecheck
pnpm build
pnpm test:unit
$env:KERNELJSON_DOCKER_WSL = "Ubuntu"
pnpm test --reporter=default --reporter=json --outputFile=artifacts/local/phase6-tests.json
```

Unit tests cover version lookup, schema validation, unsupported registration,
Unicode behavior, independent verification and provenance tampering. PostgreSQL
tests cover concurrent retries, conflicting keys, ownership/input binding,
inactive tasks, descriptor conflicts, rollback and immutable runs. The real
Restate test crashes after receipt commit, restarts Restate and the worker,
and checks one execution, one run, one evidence record and one audit event.
STATE.yaml records the executed test totals and evidence report.

Executed on 2026-09-05 on `codex/phase-6`: **142 tests passed**, with zero
failures or skips, in 103.95 seconds. This includes 25 capability unit tests,
14 PostgreSQL tests, 12 Restate recovery tests and 91 existing unit/HTTP tests.
Strict TypeScript and the build passed. The report is
`artifacts/local/phase6-tests.json`; source hashes are captured alongside it in
`artifacts/local/phase6-source-hashes.json`.

CapabilityProbeV1 is registered only by the integration-test worker. It deliberately
leaves its fixture task RUNNING with no final Outcome: a verified capability is
not a verified task. Production TaskWorkflow and KernelWorkflowV1 retain their
existing deterministic plans, journal sequences and completion verifiers.

Phase 7 policy/approvals and later recipe integration remain separate work.
External API/MCP tools, model tool calls, sandbox execution, memory, channels and
autonomous workflows are not enabled. Phase 6 does not read `.env` or call any
live model or remote Supabase endpoint.
