# ADR-0021: Primary Identity — governed durable state, not a second authority

Status: PROPOSED (design adversarially reviewed by Grok — APPROVE, conditional on D4/D6/D7 below being folded into
the implementation before this seal is considered closed)

Date: 25/09/2026

Numbering: 0021, next after 0020 (canonical memory fabric). Builds on ADR-0018 (canonical memory authority),
ADR-0020 (memory fabric), ADR-0006/PR #44 (core team and faculties), ADR-0019 (Telegram approvals interface), and
`docs/cognition/IDENTITY_GOVERNANCE.md` / `IMPLEMENTATION_PLAN.md` Stage D, which this ADR makes concrete and
binding. It does not revisit any of those; it leaves them unchanged.

## Decision

Primary Identity is durable KernelJSON state: who is speaking, in what voice, under what values — never what is
allowed to happen. It is not a principal, not a worker, not task authority, not policy authority, not approval
authority, not capability authority, not memory authority, and not scheduler authority. Persistent identity,
ephemeral cognition: a provider session may end; the identity KernelJSON hands the next one back is the same
canonical object. KernelJSON remains the sole canonical task authority throughout — identity narrows what a
cognitive execution is *framed* to do, it never widens what KernelJSON already decided it may do.

This ADR records nine decisions (D1–D9). D4, D6 and D7 are Grok's mandatory amendments to the reviewed design;
they are binding, not optional, and G0 (this ADR) is not sealed until they are reflected in the implementation.

### D1 — What Primary Identity governs, and what it explicitly does not

One canonical identity per tenant. It carries voice, values, constitutional relationship to the operator, and how
it frames the Core Team (P6) faculties and canonical (P5) memory to a cognitive execution — never which faculty
runs, never which memory a task may read beyond what policy and faculty already allow, never whether a task is
admitted, approved, retried, or completed. Every one of those remains exactly where P1–P6 already put it.

### D2 — One immutable document per version; governance class derived, never asserted

A version is one full, immutable document, not a diff. Its sections are grouped into governance classes:

| Class | Sections | Rule |
|---|---|---|
| A — Constitutional | name, constitution, values, operator relationship, faculty framing, memory policy | human approval always; byte-identical across any Class C/D change |
| C — Persona | persona, communication, behaviour, presentation | governed change, rate-limited, cannot touch Class A bytes |
| D — Mantras/vision | objectives, vision | governed change, rate-limited, cannot touch Class A bytes |

The governance class of a proposed change is *computed by KernelJSON from which sections actually changed between
the current head and the candidate document* — a diff over the canonical serialization, run server-side. A caller
supplies a full candidate document and nothing else; it cannot supply, and the schema has no field for, a
governance class, a trust level, an approval requirement, or an activation state. (Class B — structural role — and
Class E — self-model — from `IDENTITY_GOVERNANCE.md` are out of scope for P7; B already lives in P6's faculty
config, E is deferred to a later reflection phase and must not be smuggled in as a P7 section.)

### D3 — Canonical digest construction is explicit, not incidental

`identity_core_digest` (and every other content digest this ADR requires) is computed over a deliberately defined
canonical serialization of the document — key order fixed, whitespace fixed, number/string formatting fixed,
specified and unit-tested as its own function — never over `jsonb::text` or any other representation Postgres or
Node happens to produce today. The contract is the function, not an accident of a library version. Two documents
with identical meaning and different incidental formatting must produce identical digests; two documents differing
in one byte of Class A content must not.

### D4 — Faculty lock (Grok-mandated)

Identity may never choose a `facultyId`, enable a faculty, reorder faculties, or override P6's routing decision.
`facultyId` comes only from the kernel's already-compiled plan / the persisted P6 faculty pin for that step — the
exact same authority P6 already established (`services/kernel/src/faculty/registry.ts`). Identity may only narrow
the *framing* given to whichever faculty the kernel already selected, bounded by:

    effective_scope = min(identity_framing_scope, kernel_faculty_ceiling)

No soft routing language anywhere in the identity document or its assembly ("identity prefers", "identity
suggests a specialist for") is permitted to exist as anything other than inert prose — it must have zero code path
that reads it to influence faculty selection. This is enforced structurally (the faculty pin and the identity
assembly are computed by two different, non-communicating code paths that only meet in the evidence record), not
by convention.

### D5 — Approval reuse; no second approval system

Class A activation reuses the existing `ApprovalStore` / P4B signed-control-assertion machinery exactly as P4B and
P5's protected promotions already do — no parallel approval mechanism. A distinct capability namespace,
`IDENTITY_APPLY_*`, scopes identity approvals so they can never be confused with an ordinary task approval or a
future memory-promotion approval at the storage layer, even though the workflow underneath is the same store. The
approval binds exactly `candidate_id`, `proposed_digest`, and `created_by_task` — an approval cannot be replayed
against a candidate that has since mutated, and a Telegram card for an identity change says **IDENTITY CHANGE**
in its text, unambiguously, so a human approving it can never mistake it for a task or memory approval.

### D6 — Governance and rate limit are DB-enforced, not workflow-remembered (Grok-mandated)

Every Class C/D operator change — not just Class A — goes through the same governed path: admission door →
`identity-change/v1` task → policy → a governed version write → activation → evidence → completion. There is no
direct Telegram, API, or store mutation of identity state, for any class. The 3-per-rolling-24h cap on Class C/D
**APPLIED** activations is enforced by the database counting actual `activations` rows in the trailing 24h window
— a constraint or trigger that refuses the insert, not a count a Restate workflow keeps in memory and could lose,
skip, or race. The structural invariant that a Class C/D change leaves every Class A section byte-identical is
verified by comparing the canonical Class A serialization of old and new documents, not by scanning the new
document's text for authority-sounding language — lexical detection may exist as an additional defence-in-depth
layer, but it is never the enforcement mechanism, because it is trivially both over- and under-inclusive.

### D7 — Two-window freeze: P7A store, P7B behaviour (Grok-mandated)

P7A and P7B are separate release windows, separate PRs, separate Grok reviews, separate production activations.
P7A means identity exists as governed canonical state — versioned, activated, approvable, rollback-capable — but
**no cognition consumes it yet**; mission execution is byte-for-byte unchanged by P7A. Once bootstrap identity v1
is activated in P7A's live window, further Class C/D activations are **frozen** (refused at the DB layer, not
merely discouraged) until P7B's live qualification (G13) completes. An emergency HUMAN-approved rollback to an
already-activated older version remains available throughout the freeze — freezing forward change is not the same
as removing the operator's ability to revert. P7B is the only window that wires identity into an actual model
execution, and only for one consumer (D-series below, "P7B — runtime identity assembly").

### D8 — Apply and completion are one atomic success path

An activation must never exist orphaned behind a task that later fails. `successful activation ⇔ its
identity-change task completes successfully` is a hard invariant: if the activation write commits but the task's
completion cannot, the system fails closed and recovers idempotently to one truth on retry/replay — never two
plausible "current" identities. A replay of the same task must not produce a duplicate version, a duplicate
activation, or a task state that contradicts what was actually activated. An orphan detector (an activation with
no completed owning task, or a completed activating task with no corresponding activation row) is part of the
health model, on the same footing as P6's `authority.admittedFiresMaterialised` — a real, watched invariant, not
an assumption.

### D9 — Cross-provider continuity requires four digests, not one version number (Grok-mandated)

Proving "the same identity persisted across provider A and provider B" requires evidence that all of the
following match, independently: `identity_core_digest`, an evidence-bound `assembly_digest` (what was actually
handed to the model, not just what the DB currently holds), the P6 faculty digest, and the P5 memory-assembly
digest. Matching database identity version alone is not sufficient — a version number matching while the assembly
that was actually sent to a provider silently drifted would be exactly the kind of gap this ADR exists to close.

## The P5 protected-promotion fence

A known, already-documented latent bug in P5 (ADR-0020: "Protected promotion is approval-CAPABLE at the store...
Nothing calls `settleApproval` on a schedule yet") means a protected memory promotion can mint a task that reaches
`COMPILED` and then never resolves — an admission-adjacent carrier with no admission workflow actually driving it
to a terminal state. P7 must not create a second instance of this shape, and must not let an existing one leak
through the identity-change path either. During P7: **any protected P5 carrier path — explicitly including
RELATIONSHIP-class `/remember` — is hard-refused if it would rely on that broken no-admission flow**, failing
closed with an explicit operator-facing message, never a silent hang. P7 does not rewrite P5's architecture to fix
this. A documented follow-up is owed: P5 protected promotions must later move onto a normal governed *admitted*
workflow (the same shape D6/D8 above already require for identity), tracked as future work, not solved here.

## Alternatives rejected

- **A second approval system for identity.** Rejected for the same reason ADR-0020 rejected it for memory: the
  existing store, reused, is the whole point of "no second authority."
- **Lexical/keyword detection as the Class A protection mechanism.** Rejected per D6 — detectable by construction
  gaming, and it inverts the actual guarantee (byte-identity of Class A) into a heuristic.
- **A single identity version number as the cross-provider proof.** Rejected per D9 — proves the database agrees
  with itself, not that two providers actually received the same thing.
- **Seeding the bootstrap identity directly with SQL.** Rejected — every active identity, including the very
  first one, must trace to a governed, completed `identity-change/v1` task, or the "no second authority" claim is
  false from row one.
- **Wiring identity into cognition in the same PR as the store.** Rejected per D7 — conflates "does governed
  storage work" with "does behaviour change," which is exactly the coupling that makes an incident hard to
  isolate, as KJ-P6's deploy/activate-gap incident just demonstrated for a much smaller surface.

## Limits, stated plainly

- P7A ships zero behavioural change. If P7A's live window is the only thing that ever lands, mission execution is
  provably unaffected — that is the intended, checkable property of the split, not an accident.
- Class B (structural role) and Class E (self-model / learned preference) identity domains from
  `IDENTITY_GOVERNANCE.md` are explicitly not built here. B already lives in P6; E is deferred to a future
  reflection phase (KJ-P8 territory) and must not be smuggled into a P7 section.
- The P5 protected-promotion bug is fenced against, not fixed, by this work. The fix is separate, future, tracked
  work.

## Not in scope, deliberately

Reflection-driven identity proposals actually being evaluated or auto-adopted (KJ-P8), dynamic specialist identity
(Stage F), swarms or adversarial cognition (Stage H), voice/CLI/future-channel presentation overlays beyond the
bounded, non-widening kind D7's "channels" rule already constrains, and any model or Shared Brain path that can
reach activation rather than only ever producing a HELD candidate.
