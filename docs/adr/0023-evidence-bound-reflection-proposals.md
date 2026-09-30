# ADR-0023: Evidence-bound reflection proposals

Status: PROPOSED — design only; no implementation or production activation.
Date: 30 September 2026.

## 1. Problem and first deliverable

P7B proved that identity can frame model execution without owning task authority.
The next programme step is KJ-P8 (Stage G): reflection, memory promotion and
controlled growth. A completed mission does not by itself prove that a model's
suggested lesson is true, that a route should change, or that an identity should
evolve. We need a durable proposal and evaluation boundary before adding such behavior.

**P8-A is a deterministic review-proposal inbox.** An authenticated HUMAN explicitly
requests review of one completed repo-analysis mission through canonical admission.
The kernel records bounded execution observations and an evaluation request. The
result is held for human inspection; acknowledging it changes no runtime behavior.
There is no new provider invocation, recurring reflection job or automatic learner.

Example: review task T records that its analyst used provider/model P/M, its
independent reviewer succeeded, and its contract-bound evidence verified. It can
request `ASSESS_ANALYST_ROUTE` for a future evaluation. It cannot conclude that P/M
is better from one successful example or install P/M as a preference.

FACT: P5's `submitModelCandidate` produces held MODEL_PROPOSAL candidates; its
VERIFIED_OUTCOME path has different, restricted authority. P6 faculty configuration,
P7 identity governance, ADR-0013 evaluation gates and ADR-0015 routing already own
their respective decisions. P8-A does not replace these paths.

## 2. Authority and scope

The admission door authenticates principal and tenant; the ledger creates and
completes the reflection task. Restate provides durable execution only. A proposal
row is task output, not an alternative task state or permission token.

P8-A adds no write path to canonical memory, identity, faculty definitions,
provider routes, policy, schedules, approvals or executable configuration. No code
generation, shell execution, provider-selected tools or evaluation execution is
available through its proposal port. Class C/D stays frozen before and after P8.

Source selection is one HUMAN-requested, same-tenant, COMPLETED
`repo-analysis-mission/v1` task with a persisted binding at or after the P7B marker.
Legacy/pre-contract missions, active/failed/cancelled tasks, reflection tasks and
arbitrary evidence references are refused in this first version. Supporting failures,
multiple-task trends or external feedback requires a later explicit source contract.

## 3. Admission and strict contracts

Proposed recipe: `reflection-review/v1`. Use the existing authenticated task door
and idempotency mechanism. Its objective is a JSON encoding of this strict input:

| Field | Contract |
|---|---|
| `schema` | literal `kerneljson:reflection-request/v1` |
| `sourceTaskId` | UUID, resolved within the authenticated tenant |
| `focus` | `REVIEW_EXECUTION` or `ASSESS_ANALYST_ROUTE` |

No caller-supplied tenant, proposer role, trust class, evidence digest, status,
provider, model, summary, arbitrary instruction or content field is accepted.
Duplicate JSON keys and unknown fields are refused before normalization. Maximum
encoded input: 1 KiB UTF-8. Compare replay requests using canonical parsed bytes;
the same admission key with a different semantic input refuses as it does today.

The output `ReflectionProposalV1` contains kernel-assigned proposal/reflection-task/
source-task/tenant IDs; authenticated requester ID; focus; schema and policy versions;
source binding epoch/release; evidence references and digests; verified analyst and
reviewer provider/model/call IDs; identity version/core/projection digests; faculty,
memory-assembly, assembly and continuity digests; observation/evaluation-request codes;
canonical source-manifest digest; proposal digest; and kernel timestamp.

Cognition mode is explicitly NONE or REQUIRED, copied from the canonical latch.
Identity version/core/projection fields are all null for NONE and all present for
REQUIRED; partial identity provenance refuses. Memory assembly digest is null only
when the source evidence records no assembly. Provider/model observations come from
the source's persisted faculty pins and validated runtime evidence, never current
worker configuration. Identity verification uses the pinned version, never HEAD.

Digest contracts are domain-separated: source manifest
`kerneljson:reflection-source/v1`, proposal `kerneljson:reflection-proposal/v1`.
Use SHA-256 over canonical JSON with the contract name included. The proposal digest
excludes only its own digest field and includes its immutable IDs/timestamp; the
source-manifest digest excludes proposal/request IDs and creation time. Allocate
proposal identity/time once in the producing transaction and return the committed
record on replay rather than regenerate them. The exact field allowlist must be
embodied by strict K1 schemas, including explicit nulls instead of absent fields.

Observation codes are factual, versioned enums: `CANONICAL_COMPLETION_VERIFIED`,
`ANALYST_RECEIPT_BOUND`, `REVIEWER_ISOLATED`. Evaluation-request codes map one-to-one
from focus: `REVIEW_SINGLE_EXECUTION` or `BENCHMARK_ANALYST_ROUTE`. The projection must
not describe success as comparative performance, causality or a generalized lesson.

Limits: one source task; one proposal per reflection task; at most eight evidence
references; at most three observation codes; one evaluation-request code; 16 KiB
canonical proposal JSON. Digest/identifier contracts reuse existing strict formats.
Reject over-limit input or output in full; never truncate or silently drop a source.
Read only the source metadata required by this schema, never arbitrary JSON dumps.

## 4. Evidence qualification and privacy

Use a repeatable-read transaction to resolve source task, its authoritative compiled
plan/steps, binding/activation, faculty pins, cognition latch/pin, runtime evidence
and MODEL_CALLED. All references must match tenant, source task and expected step.
Recheck the existing mission, faculty and identity completion predicates through
their pure verification seams, plus current canonical version digest parity. Do not
reimplement weaker checks or accept COMPLETED alone as proof. Define a reusable
read-only source verifier before the workflow; unsupported legacy/schema shapes fail.

The verifier consumes persisted facts. It does not rebuild prompts, reread memory
content, invoke models, fetch GitHub or trust a caller's assertion of verification.
The source manifest names the exact evidence and governance versions verified, so
an evaluation can later bind to this observation rather than a moving "latest" state.

Do not persist prompts, messages, source excerpts, model analysis/output text,
memory text, full identity projections, credentials or provider bodies in the
proposal, its task objective, evidence, refusal detail or decision event. Existing
immutable source evidence stays where its original contract deliberately put it;
P8 adds digest/reference links only. UI text uses fixed templates and does not
automatically dereference memory or provider output. This avoids an additional
memory-content copy and preserves P5 retraction behavior.

The helper may read existing evidence necessary for pure verification in memory,
but its return type and durable journal result contain only the allowlisted manifest.
Run the existing secret-shaped-content scan over proposed stored strings as defense
in depth; it is not proof that arbitrary generated prose would be safe to persist.

## 5. Proposed persistence and transaction boundaries

Names below are planned, not existing schema or reserved migration filenames:

- `kernel_private.reflection_proposals`: immutable proposal JSON/digest and indexed
  task, source-task, tenant and schema identifiers. Unique reflection-task ID and
  proposal ID. Composite FKs preserve same-tenant task/evidence relationships.
- `kernel_private.reflection_decisions`: append-only, kernel-timestamped terminal
  HUMAN disposition, named proposal/digest, actor, fixed reason code and request key.
  At most one terminal disposition per proposal. A view derives HELD versus decided;
  there is no mutable proposal-status column or independently writable task status.

Both tables require RLS, no public/anon/authenticated privileges, explicit minimal
ACLs, immutable UPDATE/DELETE/TRUNCATE guards and insert-time provenance checks.
Document the actual runtime database role and owner trust boundary; RLS is not a
claim that an owning role cannot bypass DDL. Supabase default ACLs must be exercised
in real Postgres before any migration is considered qualified.

Source qualification, proposal insert, strict digest-only task evidence and canonical
completion commit in one transaction using the existing ledger completion authority.
If the current ledger transaction interface cannot support this, fix the integration
design before implementation; do not insert a proposal and then optimistically
declare a task complete. A deferred constraint must reject a committed proposal
whose producing task is not canonically COMPLETED with its matching evidence.

The lock order is producing task, then proposal/disposition. Source rows used here
are immutable completed records; never lock or update the source as a new authority.
Completion rereads the producing task's state in that transaction, so cancellation
either wins before commit or observes the committed result. It cannot leave a held
proposal after a cancelled producing task. Any durable retry first queries the
canonical producing-task/proposal result; it must not rerun under today's source
rules before returning a previously committed, identical result.

## 6. Human disposition and later action

Proposed authenticated control: reflection-only disposition action through the
existing task control infrastructure, with strict proposal ID, proposal digest,
decision, reason code and idempotency key. Two terminal decisions:

- `ACKNOWLEDGED`: the human has reviewed the proposal; grants no permission.
- `REJECTED`: fixed reason `INSUFFICIENT_EVIDENCE`, `NOT_USEFUL`, `DUPLICATE` or
  `OUT_OF_SCOPE`. Acknowledgement uses `REVIEWED` only.

This is audit/disposition, not a new approval mechanism. Reject non-HUMAN,
wrong-tenant, wrong-task, stale-digest and conflicting terminal decisions. Same key
and same payload returns the original event; changed payload refuses. Competing
keys converge on the single committed terminal decision; a contrary loser refuses.
Disposition is available only after canonical producing-task completion. Read/list
operations recheck membership and use deterministic cursor pagination, maximum 50.
Disposition input is bounded to 1 KiB UTF-8 and uses fixed reason codes rather than
free text. Refusals expose stable codes, never source contents or raw SQL errors.

No `APPROVED`, `APPLIED` or `PROMOTED` state exists in P8-A. A later action must be a
new canonical task/candidate with its own policy and, where required, the existing
ApprovalStore workflow bound to the exact target digest. An acknowledgement or
evaluation report cannot substitute for that approval.

## 7. Later P8 slices — deliberately not activated by this ADR

P8-B can add a bounded reflection model only after specifying its faculty/profile,
provider budget, request/receipt evidence, proposal-text storage and retraction
semantics. Its conclusions remain MODEL_DERIVED. Citing a verified task or being
transported by a HUMAN never upgrades their origin to VERIFIED_OUTCOME or
OPERATOR_INSTRUCTION. A new origin/promotion policy needs its own reviewed change.

P8-C can link proposals to actual ADR-0013 evaluation runs, binding suite and
candidate artifact digests and preserving failures. Evaluation success is necessary
evidence for a change, not deploy authority. Existing deterministic routing,
memory and identity governance decide whether a separately requested change may
proceed. Review rollback/supersession and regression criteria per target subsystem.
No P8 slice implicitly opens the Class C/D freeze or creates autonomous goals.

## 8. Acceptance and rollout

The [implementation checkpoints and refusal matrix](../operations/KJ_P8A_IMPLEMENTATION_PLAN.md)
are part of this proposal. Every authority invariant needs a positive case, a
specific refusal case, and an isolated mutation that removes that invariant and is
detected. Failure in collection/setup is inconclusive, not a killed mutation.

Acceptance means an explicitly admitted reflection task completes with exactly one
verified, bounded proposal; read/disposition work within the tenant; replay recovers
without duplicates; and all prohibited destination stores/configuration remain
unchanged. It does not mean a lesson was learned or any recommendation was applied.

No production feature flag or deployment is introduced by this document. Later
code must remain unreachable from production admission until its independent
implementation qualification and explicitly authorised activation window. This
design does not authorise a P8 production migration, schedule or unfreeze.
