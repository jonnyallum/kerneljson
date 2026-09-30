# KJ-P8-A: resumable implementation plan

Status: design checkpoint; no P8 implementation or production work executed.
Date: 30 September 2026.
Contract: [ADR-0023](../adr/0023-evidence-bound-reflection-proposals.md).
Programme authority and restart state: [new-system checkpoint](https://github.com/jonnyallum/new-system/blob/main/docs/migration/KJ_P8_RESTART_CHECKPOINT.md).

## Checkpoints

| ID | Deliverable and completion evidence | State |
|---|---|---|
| D0 | P7B result and restart pointer committed/pushed; historical pointers superseded | DONE: new-system `1e32de9e7fce0f17eada46644a586cc6e83743dc` |
| D1 | ADR, refusal matrix and bounded implementation sequence committed/pushed | This design change |
| K1 | Strict contracts, canonical manifests, deterministic projection and pure verifier; focused positive/refusal tests | NOT STARTED |
| K2 | Real-Postgres schema, RLS/ACLs, immutability, deferred completion invariant and concurrency; migration rollback qualification | NOT STARTED |
| K3 | Explicit HUMAN admission/control and durable workflow; proposal/evidence/completion atomicity and cancellation | NOT STARTED |
| K4 | Real Restate crash/replay, behavioral mutations, full regression, image/topology qualification | NOT STARTED |
| L1 | Separate reviewed production runbook/window, disabled deployment then bounded live proof | NOT AUTHORISED |

Do not skip from D1 to production. A draft design is not an implemented contract.
Implementation review must resolve the transaction and deployment seams listed
below against actual interfaces before adding a migration or admission recipe.
No acceptance or test result is claimed for K1–K4 yet.

## K1: contract and verifier

Inspect the existing mission/faculty/identity pure completion verifiers and their
ledger read adapter. Factor a source-read/verification seam without moving completion
authority out of Ledger or importing prompt/memory assemblers into verification.
Keep the helper useful to both source qualification and reflection completion.

Add strict request/proposal/disposition schemas and canonical digest functions.
The public request has only schema, sourceTaskId and focus. Build observations and
evaluation codes deterministically from verified metadata. No caller-provided prose,
origin, score or authority fields. Property-order changes preserve semantic digests;
changed input fields change them. Include multibyte UTF-8 boundary tests.

Exit: focused tests, typecheck/lint and import-boundary checks; exact changes and
commands recorded in a small qualification note. Commit and push before K2.

## K2: persistence

Use the migration tool's established naming workflow when implementation begins;
no pre-invented migration timestamp in this design. Resolve transaction ownership
with Ledger first. Exercise an actual deferred constraint proving no proposal can
commit without its completed producing task and matching evidence. Use composite
tenant/task/evidence references and exact ACL assertions, including default grants.

Prove concurrent identical submissions and dispositions converge, conflicting
payloads refuse, failure rolls the entire transaction back, and non-owner roles
cannot alter/truncate history. The production owner-role ceiling must be stated,
not obscured by a successful RLS test under another role.

Exit: real disposable Postgres tests and deliberately failed pre-COMMIT qualification;
no schema applied to production. Commit and push before K3.

## K3: canonical execution and controls

Add the reflection recipe to compiler/admission only in its separately reviewed
implementation. Admission must derive tenant/principal and HUMAN authorization.
The worker builds one proposal from one supported source; no ModelPort or promotion
port is wired. Policy must explicitly allow only this bounded proposal operation.

The proposed new disposition control must follow existing signed task-control
authentication, freshness and membership checks. Do not overload approve to mean
acknowledge or add a second approval store. Record disposition after completion,
as a distinct immutable event with its own idempotency namespace.

Resolve these concrete integration questions before implementation:

1. How does the current Ledger API permit proposal insertion and verified completion
   on one caller-owned transaction? Follow existing identity completion patterns;
   if adaptation is needed, qualify its effect on existing workflows first.
2. How is the recipe unavailable in production before L1, including direct Restate
   entry points? An absent UI command alone is not a gate. Design a fail-closed
   admission/execution gate whose replay behavior is explicit; do not introduce a
   switch that changes previously committed results.
3. How will the strict objective JSON parser detect duplicate keys before ordinary
   JSON parsing discards them? Select/test a small bounded parser; do not hand-wave
   this requirement or silently weaken it to last-key-wins.

Exit: gateway/ledger/control integration tests, known forbidden-store write probes,
and cancellation race tests. Commit and push before K4.

## Required refusal and mutation matrix

| ID | Deliberate violation | Required observation |
|---|---|---|
| R01 | Wrong tenant, revoked membership, non-HUMAN caller | Refuse before source read/proposal write; no cross-tenant data in error |
| R02 | Running/failed/cancelled, pre-contract or reflection source | Refuse unsupported source; zero proposals |
| R03 | Wrong source evidence task/step/digest, missing call binding or pin | Existing evidence predicate fails; COMPLETED alone cannot bypass it |
| R04 | Caller supplies trust/origin/status/model/content/unknown keys; duplicate JSON key | Strict parse refusal; no normalization into trusted input |
| R05 | More references/codes/bytes than the contract permits | Whole refusal at exact UTF-8 limits, no truncation |
| R06 | Attempt to persist prompt, memory text, full projection, output or credential-shaped string | Output allowlist/scan refuses; raw values absent from log, evidence and journal result |
| R07 | Same key changed request; concurrent same/different disposition | One original result for identical replay; conflicting payload refuses |
| R08 | Cross-tenant raw insert, UPDATE/DELETE/TRUNCATE, leaked default grants | Named FK/guard/ACL refusal in Postgres; pre-COMMIT qualification fails |
| R09 | Proposal committed without completed producing task or matching evidence | Deferred constraint aborts the whole transaction |
| R10 | Crash before COMMIT / after COMMIT before Restate acknowledgement | No partial result / exact original proposal on replay, no duplicate evidence |
| R11 | Cancellation wins before completion / completion wins first | No proposal for cancelled task / durable completed result, no split state |
| R12 | Wrong actor, proposal digest or target task in disposition | Refuse; original proposal/task and decision history unchanged |
| R13 | Source/governance rules change after a committed result, then replay | Return verified original result under its recorded contract, never re-propose |
| R14 | Inject memory promote, identity apply, route/config write, evaluation execution or scheduler port | Import/wiring tripwire fails; no side effect available |
| R15 | Replace factual observation with comparative claim or supplied score | Strict enum/manifest refusal; no unsupported performance assertion |
| R16 | Retract source memory, inspect proposal and replay | Only the historical digest/reference remains; no copied text to expose or rewrite |

For each row, add a focused mutation removing the relevant guard and require its
intended test to fail. Pair privacy/output allowlist mutations with persisted-row
and journal-result assertions, not snapshots of implementation internals alone.
Use production code with fixture external services for real Restate recovery.

## Interruption protocol

At every checkpoint commit: record HEAD, branch, passed and failed checks, exact
next action, whether any process is still running, and whether production changed.
Push before beginning the next checkpoint. Preserve a failed test's evidence;
"started" never becomes "passed" because a session ended.

If cut off during D1–K4, leave production alone. Inspect `git status` and the latest
pushed checkpoint before resuming; preserve unrelated untracked files. Do not
rerun provider calls, migrations or production deployment from a remembered chat
instruction. L1 needs its own authorization, recovery record and explicit gates.

The older P6 materialisation incident and legacy observability gap are separate
work; P8 must not fabricate or rewrite their historical evidence to clear health.
