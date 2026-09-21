# ADR-0020: The canonical memory fabric

Status: PROPOSED (implemented in KJ-P5, not merged or deployed at the time of writing)

Date: 21/09/2026

Numbering: 0020, because 0019 (Telegram approvals interface) is taken. This implements ADR-0018 (canonical memory
authority). It does not revisit it, and it leaves ADR-0007 and ADR-0011 unchanged.

## Decision

KernelJSON owns canonical memory. A memory is created by one path only:

    experience -> candidate -> deterministic policy -> promotion event -> canonical version
                                   -> bounded retrieval -> context assembly -> model execution evidence

A model, a provider session, a tool, a channel or an external system such as the Shared Brain can only ever SUBMIT A
CANDIDATE. The kernel's policy decides. The database enforces the same rule independently of the application, so the
authority holds even if service code is wrong.

## Memory classes

Eight, extensible by a new value in one enum, a new row in the policy table and a migration:

| Class | Meaning |
|---|---|
| FACT | something stated to be true |
| PREFERENCE | how the operator likes things done |
| DECISION | a choice that was made |
| COMMITMENT | something someone will do |
| LESSON | something learned from an outcome |
| EPISODE | a record of something that happened |
| RELATIONSHIP | a link between people or things (identity-adjacent, so protected) |
| PROJECT_KNOWLEDGE | knowledge about a project |

The class says what a memory IS. Who it is ABOUT is a separate field (the subject: a principal, a project or the
tenant), and where it came from is a third (the origin). A class is fixed for the life of a memory.

## Tables (migration 20260921180000, prepared, not applied to production)

Separate concepts, separate tables, none of them overloading task evidence or alerts.

| Table | Holds | Mutability |
|---|---|---|
| memory_candidates | what a source proposed, its origin, its request digest, its state | frozen; only the outcome of an approval moves the state |
| memory_promotions | every policy decision, and the approved completion of a protected one | append-only |
| memory_versions | one row per immutable canonical version, with provenance, evidence and policy | append-only |
| memory_relations | SUPERSEDES (by an allowed promotion) and CONFLICTS_WITH (flagged by a human) | append-only |
| memory_context_assemblies | exactly which memory versions a model execution was given, and the digest | append-only |

`memory_current` is a view: the head version of each memory, if it is an assertion that nothing supersedes. Row level
security is on for every table and nothing is granted to public roles. The service reaches the tables only through
`withTenant`, which rechecks tenant membership.

## Authority, enforced twice

The origin is set by which kernel entry point received the candidate (`submitOperatorInstruction`,
`submitVerifiedOutcomeCandidate`, `submitModelCandidate`, `submitExternalCandidate`), never by anything in the
candidate. The submission contract has no origin, trust class, state or policy field to set.

| Origin | May become | Trust class earned |
|---|---|---|
| OPERATOR_INSTRUCTION (an authenticated human channel) | any class canonical at once; RELATIONSHIP needs approval | USER_AUTHORED |
| VERIFIED_OUTCOME (a verified task, evidence checked in the ledger) | EPISODE at once; LESSON and DECISION need approval; nothing else | INTERNAL_DERIVED |
| MODEL_PROPOSAL | never: held as a candidate | MODEL_DERIVED |
| SHARED_BRAIN | never: held as a candidate | UNTRUSTED_EXTERNAL |

Content that looks like a credential is refused whatever the origin, and is stored redacted (the digest is kept, the
value is not).

The database rules, independent of the service: a promotion that creates canonical memory cannot exist for a model or
Shared Brain candidate; a candidate of those origins cannot be recorded as promoted; a version must be named by exactly
one promotion event; a version's trust class must be the one its origin earns; a memory's class, subject and tenant
cannot change across versions; a retracted memory cannot be built on; and nothing is ever updated or deleted.

## Promotion, and protected promotion

Every decision is a `memory_promotions` row: candidate id, the deciding process or approved human, policy version,
rule id, reason, the candidate's evidence, and the resulting memory id and version. The canonical version copies the
evidence and provenance, so provenance cannot be dropped in promotion.

Protected promotions use the EXISTING approval machinery and no second system. A protected candidate gets a task with
one deterministic step, a policy evaluation of APPROVAL_REQUIRED for a named human approver with a deadline, and an
`approvals` row recorded by the existing `ApprovalStore`. The approval binds the invocation, which names the candidate
id and the sha256 of its canonical request, so an approval for one candidate cannot promote another. The candidate is
completed or rejected from the approval's persisted decision. With no approver configured, a protected candidate
stays held; nothing is promoted without one.

## Supersession, correction and retraction

Never a destructive rewrite. CORRECT appends version n+1 of the same memory. SUPERSEDE creates a new memory and a
SUPERSEDES relation to the old one. RETRACT appends a retraction version that keeps the retracted text as history.
The current view, retrieval and context assembly prefer the current head and drop superseded and retracted memories,
while `find` and history keep every version with its provenance. A conflict between two current memories is flagged by
a human as a relation; both stay, and the assembler labels both as conflicting rather than choosing.

## Bounded context assembly

Input: tenant, principal, purpose, optional project, allowed classes, item and token budget. The steps, all
deterministic: SQL filters by tenant, subject scope, allowed classes and current head first; then ranking by term
overlap with the purpose (a small stopword list), recency, then id; PREFERENCE and COMMITMENT are always eligible,
other classes need overlap; items are packed in rank order into the budget and an item that does not fit is excluded
whole and recorded, never truncated. Similarity is never authority and no embedding is involved. The output is the
selected memories, each with provenance and a selection reason, and a digest over the request and the exact
versions. The model never receives the store.

Every assembly is recorded in `memory_context_assemblies` (a database check refuses a record that exceeds its budget),
tied to the task and the model call it was for. The mission's analyst evidence carries `memory_context` with the
assembly id, the context digest and each memory id and version. The reviewer receives no memory, to keep the review
independent of the operator's stated preferences.

## The Shared Brain boundary

An interface and two pure conversions. The port has one method, `search`. What it returns is UNTRUSTED_EXTERNAL
context that keeps its source reference and is recorded as external. Anything it proposes as memory goes through
`submitExternalCandidate`, which can only produce a held candidate. There is no write, promote or identity method to
call, and no bulk migration. A real adapter to the Shared Brain is a separate later change.

## Telegram

`/remember <text>`, `/memories`, `/memory <id>`, `/forget <id>`. Telegram stays a channel adapter: it carries an
explicit instruction and the answer. `/forget` is a governed retraction. Physical deletion is not a path this channel
has; it would be a separate explicit capability and policy path. Replies are fixed templates, and only text the
operator wrote themselves is ever echoed back.

## Alternatives rejected

- Letting a model promote its own reflections: exactly the memory poisoning and identity drift ADR-0018 exists to prevent.
- Vector similarity as the selector: not explainable or reproducible, and not authoritative. It may rank later, only
  after deterministic metadata filtering.
- Extending `memory_items`: that table is verified task-result memory with different columns and lifecycle (ADR-0011).
  It stays as it is and can be a source of EPISODE candidates later.
- A second approval system: refused by design; the existing store is reused.

## Limits, stated plainly

- Protected promotion is approval-CAPABLE at the store. The durable Restate workflow that waits for the answer and the
  Telegram card for a memory promotion are not built (the existing approval workflows are specific to one capability).
  Nothing calls `settleApproval` on a schedule yet.
- Retrieval ranks the newest 500 eligible current memories. That is ample for a single operator and is a stated bound.
- Nothing has run against production. The migration is prepared, not applied.

## Not in scope, deliberately

Primary Identity and personality, hopes and mantras, Core Team and faculties, autonomous reflection loops, automatic
personality mutation, full Shared Brain migration and vector-database optimisation. P6 to P8 build on this layer.
