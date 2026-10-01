# ADR-0023: Reflection, self-model and governed identity growth (KJ-P8)

Status: PROPOSED (design only). Nothing here is implemented, migrated or deployed.
Date: 01/10/2026.
Base: canonical `main` `750d5b7926f320d8e9d3f64789b8f7035eaa4f3d`. Production: epoch 13, release `cebbb0d`, cognition
ON, Class C/D frozen (docs/operations/KJ_P7B_LIVE_RESULT_2026-09-30.md).

Builds on: ADR-0018 and ADR-0020 (canonical memory), ADR-0021 (Primary Identity), ADR-0022 (identity cognition binding,
with its D1 erratum), docs/cognition/IDENTITY_GOVERNANCE.md, and Stage G of docs/cognition/IMPLEMENTATION_PLAN.md.

Supersedes, if accepted: the alternative prototype `docs/adr/0023-evidence-bound-reflection-proposals.md` on the
unmerged branch `codex/kjp8-proposal-design` (draft PR #49). That design is retained here only where section 3 says so.

## 1. Context: what the code is today (observed at `750d5b7`)

These facts constrain the design. Every claim was checked in this worktree.

1. **Admission.** The door accepts a static catalogue of recipes (`apps/gateway/src/server.ts` `PublicSubmission`):
   golden, uppercase, `claude_md_check/v1`, `repo-analysis-mission/v1` and `identity-change/v1`. A new recipe is a
   deliberate catalogue change. Nothing else mints canonical tasks.
2. **Model-origin identity candidates cannot be approved today.** P7A's `identity_candidates` CHECK
   `origin = 'OPERATOR_INSTRUCTION' or state in ('HELD','REJECTED')` means a `MODEL_PROPOSAL` candidate can never
   reach `APPROVED`. The activation guard requires `APPROVED` (or a HELD operator C/D candidate). The P7A design note
   says adoption meant a human resubmitting the content as a new operator candidate.
3. **The identity-change workflow** creates only `OPERATOR_INSTRUCTION` candidates (`identity-workflow.ts`). It has two
   request kinds, `PROPOSE` and `ROLLBACK`. Stale protection is the P7A compare-and-swap: the candidate's
   `base_version`/`base_identity_core_digest` must equal the head at apply time.
4. **Class C/D is frozen by default.** `identity_activation_guard` refuses C/D while
   `coalesce(identity_governance_state.frozen, true)`; production has no governance row and no C/D policy rule.
   G13 did not unfreeze it (ADR-0021 erratum, ADR-0022 section 14).
5. **Faculties.** `validateFacultyPin` hard-codes `permittedRecipes.includes(MISSION_RECIPE)`, and `routeFaculty` maps
   only `RUNTIME_ANALYSE` to intelligence and `RUNTIME_REVIEW` to verifier. Using faculties for a new recipe therefore
   needs a reviewed, static extension of both; there is no adaptive input.
6. **P7B framing** applies only to the mission analyst (`ANALYST_INTELLIGENCE_V1`, `RUNTIME_ANALYSE`). The completion
   oracle runs only for `repo-analysis-mission/v1`.
7. **P5.** `submitModelCandidate` produces HELD model memory candidates. The protected-promotion carrier is broken and
   fenced (ADR-0021, "The P5 protected-promotion fence"). P8 needs neither.
8. **The production worker connects as `postgres`**, the owner (OBSERVED, KJ_P7B1_DEPLOYMENT_RUNBOOK.md and the P7B
   live record). Database grants therefore cannot separate worker code from deployment authority. Only code
   structure, fences and health checks can. This drives the P8B blocker in section 21.
9. **Secret screen** `identity/secret-scan.ts` (`findSecretShapedContent`) already guards identity documents.

## 2. Decision in one paragraph

Reflection is advisory cognition inside a normal admitted, HUMAN-requested task (`identity-reflection/v1`). It reads a
kernel-qualified evidence packet and the current identity **as data**. It can emit only two kinds of record: bounded
**ReflectionProposals** and **SelfModelObservations** (Class E). Both are evaluated by an independent verifier and
classified and stored by KernelJSON. From P8A-2, an eligible identity proposal may become exactly one **HELD
`MODEL_PROPOSAL` candidate** in the existing `identity_candidates` table, and in P8A nothing can ever activate it.
P8B, under a separate review and authorisation, lets the human principal adopt a model candidate through the existing
identity-change authority, in time-boxed growth windows. Reflection never produces canonical behavioural change.

## 3. Why the Codex prototype was not adopted, and what is retained

**Not adopted as the architecture.** It designs only a deterministic review-proposal inbox: one source mission, no
model reflection, no self-model, no identity candidates, no growth path. Its K1 code was written before any hostile
design review. It also uses a different recipe and proposal schema, which would make two incompatible proposal
systems.

**Retained deliberately, as P8A-0 (section 18):**
- the strict, flat request contract (unknown and duplicate keys refused, a 1 KiB cap);
- re-verifying each source task through the existing pure completion seams (mission, faculty and identity
  verifiers) rather than trusting `COMPLETED`;
- a repeatable-read resolution of source facts;
- a domain-separated digest of the source manifest;
- factual, versioned observation codes;
- the rule that no prompt, output, memory or projection text is persisted by P8.

No Codex code is reused. The prototype's K1 implementation is not approved by this ADR.

## 4. Authority model

| Actor | May | May never |
|---|---|---|
| HUMAN principal (via the admission door) | request a reflection; dispose of (dismiss) a proposal or candidate; correct an observation; freeze reflection; in P8B, adopt a model candidate, subject to approval | n/a |
| KernelJSON (workflow + ledger) | qualify evidence; classify; deduplicate; enforce caps; store records; create a HELD model candidate; complete the task | activate identity from a model output; change routing, faculty, memory permission, policy, admission or schedule |
| Reflecting model (intelligence faculty) | propose edits and observations as structured JSON | create state, tasks, approvals or activations; choose a faculty, provider or model; read memory beyond its faculty ceiling |
| Evaluating model (verifier faculty) | give an advisory verdict on each record | approve, classify authoritatively, or create anything |
| Deployment authority (postgres, change window) | raise the reflection mode; in P8B, open a growth window | operate from inside the worker (fenced in code; see section 21) |

Reflection records are **outputs of a task**, never permission tokens. One admission door, many event and execution
doors, one task authority: unchanged.

## 5. Reflection task contract

- **Recipe `identity-reflection/v1`**, routed to `KernelWorkflowV1` (the same execution binding and release provenance
  as missions). It is added to the door's static catalogue. The door requires a HUMAN principal for this recipe.
- **Request kinds** (strict JSON objective, flat, at most 4 KiB, unknown or duplicate keys refused):

| Kind | Fields | Model call? | Approval? |
|---|---|---|---|
| `REFLECT` | `sourceTaskIds` (1 to 10 UUIDs, same tenant), `focus` (`OUTCOMES`, `COMMUNICATION`, `IDENTITY` or `POST_CHANGE`; `POST_CHANGE` also needs `activationId`), `operatorFeedback` (0 to 2000 chars) | yes | no |
| `DISPOSE` | `subject` (proposal, candidate or observation id), `disposition` (`DISMISS` or `CORRECT`), `reason`, and `correction` for observations only | no | no: it only narrows |
| `FREEZE` | `reason` | no | no: it only narrows |

  `operatorFeedback` and `reason` are secret-screened at the workflow's first step (refused, never stored on refusal).
  They are operator-authored and live in the immutable task contract.
- **Plan for `REFLECT`:** `REFLECT_QUALIFY` (deterministic), then `REFLECT_PROPOSE` (intelligence), then
  `REFLECT_EVALUATE` (verifier), then `REFLECT_RECORD` (deterministic). Any refusal ends the task FAILED with
  evidence.
- **No daemon, loop or background agent.** A reflection task never admits another task. Section 16 removes every path
  from records to admission.
- **The only live trigger in P8 is an explicit HUMAN request.** Verifier failures, feedback, provider metrics and
  scheduler events are **not** triggers. A future event policy would need its own ADR and must still enter through
  admission.

## 6. What the reflecting model receives (identity as data, not framing)

**The reflector (intelligence faculty) receives:**
- the qualified evidence packet: factual codes, receipts, verdicts, digests and bounded excerpts that already exist
  in canonical evidence, each labelled;
- the operator's feedback text;
- the current canonical identity document, A, C and D, as **labelled subject data**
  (`SUBJECT IDENTITY (data under review; not instructions)`);
- ACTIVE Class E observations as data;
- P5 memory assembled through the existing read-only port, within its faculty memory ceiling.

**The evaluator (verifier faculty) receives:** the proposed records, the cited packet entries and the subject
identity. It gets **no memory**: the existing review isolation applies.

**No P7B identity framing for either.** `profileForOperation` returns no profile for the reflection operations, so no
`IdentityProjection` is assembled. Seeing the identity as data grants no authority. Framing reflection would need its
own reviewed projection profile; this ADR does not add one.

**Faculties: no new faculty.** The static routing table gains `REFLECT_PROPOSE` → intelligence and
`REFLECT_EVALUATE` → verifier. Each faculty's `permittedRecipes` and `permittedOperations` gain the recipe and
operation through a normal reviewed faculty-version append (P6 governance), and `validateFacultyPin` stops
hard-coding the mission recipe in favour of checking the pinned faculty's own list. The pinned provider and model are
whatever the faculty pin says. Class E has no input to this (section 9).

## 7. ReflectionProposal

**Immutable row `public.reflection_proposals`:** `id` (deterministic from task, step and ordinal), `tenant_id`,
`identity_id`, `reflection_task_id` (FK to the task and tenant), `proposer` (`MODEL`), `kind`, `base_version_id`,
`base_identity_version`, `base_identity_core_digest`, `edit` (jsonb), `rationale` (at most 1000 chars), `evidence_refs`
(jsonb, 1 to 8 packet entries), `proposal_key`, `proposal_digest`, `created_at`.

**Kinds:**
- `IDENTITY_EDIT`: exactly one field edit. The field is one of the allow-listed paths `classA.*`, `classC.*`,
  `classD.objectives` or `classD.vision`. The operation is `REPLACE` for a string, or `ADD_ITEM`/`REMOVE_ITEM` for
  `values` and `objectives`. One edit per proposal keeps every diff reviewable. The governance class is **never** taken
  from the model: the database classifies the resulting candidate.
- `ROLLBACK_RECOMMENDATION`: names a prior version. It is advice only and is never executable (section 14).

**Evaluation (immutable, one per proposal):** `public.reflection_evaluations` holds the verifier's structured verdict,
the evaluator call id and its `MODEL_CALLED` binding.

**Status** is derived from immutable facts, never edited in place: evaluation, then dispositions (section 8), then,
once a candidate exists, the candidate's own state. A proposal is never a second identity workflow.

## 8. Dispositions, lifecycle mapping and audit

**`public.reflection_dispositions`** is append-only. It stores one terminal disposition per subject (a proposal or an
observation), unique by subject:

| Disposition | Set by |
|---|---|
| `INELIGIBLE` | kernel: evaluator not supportive, a kernel check failed, stale at record time, or a cap was hit |
| `CANDIDATE_CREATED` | kernel; links the candidate id |
| `DISMISSED` | HUMAN, via `DISPOSE` |
| `SUPERSEDED` | kernel or HUMAN; links the successor |

**The governance lifecycle maps onto existing objects**, with nothing duplicated:

| Lifecycle stage | Represented by |
|---|---|
| PROPOSED | the proposal row |
| CLASSIFIED | the database classification on candidate insert; before that, a kernel pre-check only |
| EVALUATED | the evaluation row |
| APPROVAL_REQUIRED, APPROVED or REJECTED | the candidate state and ApprovalStore |
| APPLIED | `identity_versions` + `identity_activations` (P8B) |
| OBSERVED | a `POST_CHANGE` reflection |
| SUPERSEDED or ROLLED_BACK | a later activation, or a ROLLBACK through the existing path |

**Nothing is ever deleted.** Every table here is immutable through `reject_ledger_mutation`; rejected records remain
auditable.

**HUMAN dismissal of a HELD model candidate** uses the existing candidate transition HELD → REJECTED, written by the
`DISPOSE` task. Dismissal only narrows, so it needs no approval.

## 9. SelfModelObservation (Class E), separate durable state

**Class E is not added to the Primary Identity document.** Doing so would change `identity_core_digest` semantics, the
Class A digest, the P7B projection, G5 continuity, version comparison and activation governance.

**Immutable `public.self_model_observations`:** `id`, `tenant_id`, `identity_id`, `reflection_task_id`, `origin`
(`MODEL_REFLECTION` or `OPERATOR_CORRECTION`), `kind`, `scope` (jsonb), `claim` (at most 300 chars),
`evidence_refs` (1 to 10), `observation_key`, `supersedes_id`, `created_at`.

**Kinds (v1):**
- `TASK_CLASS_OUTCOME`: how evaluated tasks of a recipe or question shape turned out;
- `PROVIDER_ROUTE_OUTCOME`: how a pinned provider/model performed in the cited sample;
- `VERIFIER_FINDING_PATTERN`: what the verifier repeatedly flagged;
- `OPERATOR_COMMUNICATION_PREFERENCE`: inferred from explicit operator feedback.

`DELEGATION_PATTERN` is reserved and unused, because nothing delegates in v1.

**Lifecycle (derived, as for proposals):**
- PROPOSED becomes ACTIVE (verifier supportive and kernel checks pass) or INELIGIBLE;
- SUPERSEDED by a newer observation with the same kind and scope, or by a HUMAN `CORRECT`;
- a correction creates an `OPERATOR_CORRECTION` observation, which outranks any model inference with the same kind and
  scope. An incorrect observation is superseded, never erased.

**Confidence is deterministic and computed by the kernel, never by the model:**

| Class | Rule |
|---|---|
| `OPERATOR_ASSERTED` | origin `OPERATOR_CORRECTION` |
| `ANECDOTAL` | 1 distinct supporting source task |
| `EMERGING` | 2 to 4 distinct supporting source tasks |
| `CONSISTENT` | at least 5 distinct supporting source tasks and no cited contradicting task |

A "supporting source task" is a distinct qualified packet entry cited by the observation or by its support rows
(section 11). There is no numeric pseudo-probability.

**Authority ceiling: Class E describes; it never commands.** In P8 the only consumers are:
- the reflector, which reads it as data;
- health checks and Mission Control, read-only.

It must never reach provider, model, faculty or ordering selection, `providerPreferences`, `routingReason`, memory
permissions, policy, approval, admission, scheduling, task creation, or the P7B `IdentityProjection`. This is enforced
by the fence in section 16 and the absence of any consumer. "DeepSeek performed better in this evaluated sample" may
be recorded; "therefore route to DeepSeek" has no code path.

## 10. Identity candidate boundary and MODEL_PROPOSAL rules

1. The only identity mutation store is `identity_candidates`. P8 adds no other.
2. A reflection creates **at most one** candidate. A new unique partial index on `proposed_by_task` for
   `MODEL_PROPOSAL` enforces this.
3. **Origin is `MODEL_PROPOSAL` permanently.** No conversion to `OPERATOR_INSTRUCTION`, and no "resubmit as operator"
   laundering. In P8B a HUMAN adoption is recorded as an approval and an activation bound to the model candidate; the
   origin column never changes.
4. `proposed_by_task` is set to the reflection task, so provenance is a foreign key, not a claim.
5. **The candidate document** is computed by the kernel: the head document plus the single structured edit. It is
   validated by `IdentityDocumentDraft` and screened for secrets. The database computes the class and base. Stale
   protection is the P7A compare-and-swap; P8 adds nothing weaker.
6. **Conditions for creating the candidate (P8A-2):**
   - reflection mode is `PROPOSE_IDENTITY`;
   - the evaluator's verdict is `SUPPORT` with `authority_impact = NONE` and `prefer_no_change = false`;
   - base equals head;
   - the caps hold.
   Otherwise the proposal is recorded `INELIGIBLE`.
7. **Class A proposals** may become HELD candidates. Their adoption is HUMAN-approved only, in P8B and forever.
8. **SHARED_BRAIN origin stays never-approvable.** P8 does not touch it.

## 11. Deduplication, replay and idempotency

- **`proposal_key`** = sha256 of the canonical JSON of `{contract: "kerneljson:reflection-proposal-key/v1", tenant,
  identity, base_version, base_identity_core_digest, kind, field, op, normalised value}`. It is UNIQUE per tenant.
- **`observation_key`** = sha256 of `{contract: "kerneljson:self-model-key/v1", tenant, identity, kind, canonical
  scope, normalised claim}`. It is UNIQUE per tenant.
- **A repeat with the same key does not mint a new record.** The record step returns the existing one and appends an
  immutable row to **`public.reflection_support`** (subject id, reflection task, evidence refs). Immutable content is
  never mutated. This applies to rejected proposals too, so a repeatedly rejected idea cannot respawn.
- **Replay.** Ids are deterministic (task, step, ordinal), and the record step runs in one `ctx.run` and one database
  transaction under an advisory lock on the reflection task. A replay or lost journal re-executes to the same rows
  (`on conflict` plus digest comparison; a mismatch refuses).

## 12. Rate limits and spam (database-enforced, by triggers)

| Limit | Value | Why |
|---|---|---|
| reflection tasks per tenant per rolling 24h | 6 | human review bandwidth; checked in `REFLECT_QUALIFY` by a database function counting admitted tasks of this recipe |
| proposals per reflection task | 3 | small diffs |
| observations per reflection task | 3 | small diffs |
| model candidates per reflection task | 1 | the unique index above |
| undisposed proposals per tenant on the current head | 20 | bounded inbox |
| HELD `MODEL_PROPOSAL` candidates per identity on the current head | 3 | matches the 3-per-24h C/D activation cap; a human cannot meaningfully review more |

- **Stale records do not consume slots.** Stale means the base is not head (section 13). So a HEAD change can never
  deadlock the cap.
- **Over a cap**, the deterministic refusal records `INELIGIBLE (CAP)`.
- The existing **3 APPLIED C/D activations per rolling 24h** is separate and unchanged.

## 13. Stale proposals

- Every identity-related proposal and candidate binds `base_version_id`, `base_identity_version` and
  `base_identity_core_digest` at creation.
- **Stale** means the base is not the current head. It is computed in a view, never written as a mutation.
- A stale proposal cannot become a candidate (`INELIGIBLE (STALE)`).
- A stale candidate cannot be adopted: the P7A compare-and-swap in `identity_version_guard` refuses it, and the P8B
  adoption workflow pre-checks the same.
- The remedy is a new reflection against the new head. A proposal is never rebased or merged.

## 14. Regression observation and rollback recommendation

- After a P8B adoption, Mission Control shows the activation as **unreviewed** until a HUMAN requests a `POST_CHANGE`
  reflection.
- That reflection's qualified packet compares missions pinned to the new version against the prior version. P7B
  identity pins record the version per mission, so this comparison uses deterministic counts (verifier verdicts,
  reconcile decisions) plus model commentary.
- **Allowed outcomes:** Class E observations, a `ROLLBACK_RECOMMENDATION` proposal, and the health signal
  `reflection.adoptedChangeUnreviewed` (P3, notified).
- **No automatic rollback, ever.** A rollback is a HUMAN `identity-change/v1` `ROLLBACK` through the existing approval
  rules. A recommendation is only text with evidence.

## 15. Evidence, provenance and secrets

- **Packet entries** are references to canonical evidence: task id, evidence id, digest and a factual code.
  - Sources are COMPLETED or FAILED tasks of the same tenant, each re-verified through the existing pure completion
    seams (from the Codex prototype).
  - Operator feedback is cited through the reflection task's own contract digest.
  - P5 memory is cited by assembly id and digest only.
- **Durable P8 rows store no prompt text, model output, memory text or projection text.** The proposed field value is
  the one deliberate exception, because it is the proposal itself; it is secret-screened and capped.
- **The two model calls get D1-style `MODEL_CALLED` digest bindings**, so their provenance matches missions. Runtime
  evidence keeps the model output text exactly as mission runtime evidence does today. It gains no new copy of memory
  text, and P5 retraction stays intact.
- **Every proposal and observation proves:** tenant, identity, source admitted task, packet refs, base version, proposer
  type, evaluator call binding, disposition, timestamps and content digest. A provider conversation is never
  canonical state; only kernel-parsed structured outputs are.
- **Secrets.** `findSecretShapedContent` screens every stored string: edit values, rationales, claims, corrections,
  feedback and reasons. A hit refuses the record. Credentials, tokens, database URLs, signing material and provider
  bodies never enter P8 state.

## 16. Structural fences (transitive runtime-import test, like ADR-0022 section 6)

- **Modules:** `services/kernel/src/reflection/**`, with `self-model.ts` holding Class E.
- **Forbidden importers of `reflection/**`:**
  - the gateway (admission);
  - `scheduler/**`;
  - `faculty/**` (routing and registry);
  - `policy.ts` and `approval-*`;
  - `services/memory/**` (promotion authority);
  - `ledger.ts` (completion authority);
  - `identity/projection.ts`, `identity/cognition-binding.ts`, `mission/analyst-assembly.ts` and `mission/prompts.ts`;
  - `identity-workflow.ts`, except for the one narrow pure contract module `reflection/adoption-contract.ts` in P8B.
- **Inverse fence:** `reflection/**` may not import faculty routing or registry write paths, memory write paths,
  approval decision code, or the P7B projection or assembler.
- **Class E:** `reflection/self-model.ts` may be imported only by the reflection workflow, health and Mission Control
  read paths.
- **Mutations** inject forbidden imports into faculty policy, the scheduler, the gateway, the ledger, the P7B
  assembler and the memory service; each must be killed.

## 17. Freeze and unfreeze governance

**P8A reflection mode** lives in `kernel_private.reflection_governance`, an append-only event table (one row per
change) holding `tenant`, `mode`, `set_by`, `reason` and `at`. The current mode is the latest row; no row means
`DISABLED`.

| Mode | Allows |
|---|---|
| `DISABLED` | no proposals, observations or candidates (database triggers refuse the inserts) |
| `OBSERVE` | proposals and observations |
| `PROPOSE_IDENTITY` | also HELD model candidates |

- **Raising** the mode is deployment authority only: a postgres-only function, run in an authorised change window.
- **Lowering** to `DISABLED` is also available to any HUMAN owner through a `FREEZE` task, because freezing is safe.
- **The insert trigger refuses any non-`DISABLED` row** unless the deployment function inserts it, recognised by a
  transaction-local setting that only that function sets. Because the production worker is also `postgres`, this
  stops a code path, not a determined worker. That residual is blocker B1 (section 21).
- **When frozen:**
  - an in-flight reflection fails closed at `REFLECT_RECORD` with evidence;
  - pending proposals and HELD candidates stay as they are, auditable;
  - `DISPOSE` still works (dismissal narrows);
  - normal cognition, current identity, existing tasks and HUMAN emergency rollback are unaffected.

**P8B growth: explicit, time-boxed windows.** This is chosen over a permanent unfreeze and over a standing
controlled-growth mode.

- `kernel_private.identity_growth_windows` is append-only: `identity_id`, `authorisation_ref` (the change-window
  record and the HUMAN authorisation), `reason`, `opened_at`, `expires_at` (at most `opened_at` + 7 days) and
  `closed_at`.
- In P8B, a C/D activation from any origin requires the existing default freeze to be overridden by an **open,
  unexpired window**. This uses a new migration that replaces the guard function; the P7A file is not edited.
  `set_identity_freeze(…, false)` is retired for C/D growth.
- **Why windows:**
  - they fail closed by expiry without anyone acting;
  - every opening is an immutable audited row naming its human authorisation;
  - an emergency close is one insert;
  - C/D changes stay rare, deliberate events.

  A permanent unfreeze would make continuous drift the default. A standing mode would have no natural end and would be
  forgotten.
- **Opening** a window is deployment authority only. **Closing** one early is also available to a HUMAN owner through
  `FREEZE`.

## 18. Rollout

**P8A-0: substrate, feature off.** Implementation and deployment; no live reflection.
- One new migration: the reflection tables, dispositions, support, Class E tables, governance mode, caps, the
  candidate unique index and cap trigger, health checks.
- Contracts and the deterministic `REFLECT_QUALIFY` packet builder (the retained Codex idea).
- The fences.
- The mode stays `DISABLED`, and the door does not yet accept the recipe.

**P8A-1: reflecting cognition, proposals only.** A separate authorisation.
- The recipe is opened at the door; the faculty versions and static routing are extended; mode `OBSERVE`.
- Live acceptance: proofs 1 to 7, 13, 14 and 15 of section 19.

**P8A-2: HELD model candidates.** A separate authorisation; mode `PROPOSE_IDENTITY`.
- Live acceptance: the remaining P8A proofs.
- Class C/D is still frozen. A `MODEL_PROPOSAL` still cannot be approved at all, because the P7A CHECK is unchanged.

**P8B: controlled growth.** A separate ADR addendum, its own hostile review, and explicit HUMAN authorisation.
- `identity-change/v1` gains the kind `ADOPT {candidateId, reason}`, HUMAN owner only. Its new pure contract is
  `reflection/adoption-contract.ts`.
- A new migration does three things:
  1. allows `APPROVED` for `MODEL_PROPOSAL` only when a GRANTED HUMAN approval bound to that candidate exists;
  2. binds version creation for a model candidate to the ADOPT task that holds that approval;
  3. requires an approval for **every** model-origin activation, whatever its class (stronger than the operator C/D
     ALLOW path), plus an open growth window for C/D.
- New gates `IDENTITY_ADOPT_MODEL_A`, `_C` and `_D` exist in production policy as `APPROVAL_REQUIRED` only. **There is
  no auto-adoption at any class.**

## 19. Acceptance gates

**P8A** (live, with production mode raised in its window):
1. An admitted reflection task completes normally.
2. The identity is read and unchanged (versions, activations and head digests are identical before and after).
3. Exactly the bounded records are produced.
4. Each binds the base version and digest.
5. Each cites qualified packet entries.
6. The verifier evaluates each, on a model different from the proposer's (reconcile-style independence).
7. A SelfModelObservation is recorded, with faculty pins, routes, `providerPreferences` and policy byte-identical
   before and after.
8. A HELD `MODEL_PROPOSAL` candidate exists (P8A-2).
9. No activation occurs.
10. Class C/D is still frozen.
11. A replay creates no duplicate; a repeat appends support.
12. A HEAD change makes the record stale, and conversion is refused.
13. A dismissed or ineligible record remains auditable.
14. No Shared Brain access occurs: no connector, no credential, no request.
15. No task is self-generated: the task count delta equals the admitted requests.
16. Health is clean, with NO_OBSERVATION where expected.

**P8B:**
1. Explicit HUMAN authorisation is recorded.
2. One approved C or D model candidate is adopted through the existing workflow.
3. The 3-per-24h cap is still effective (a fourth is refused).
4. D8 atomicity holds.
5. The prior version can still be rolled back.
6. A `POST_CHANGE` reflection is recorded.
7. There is no authority expansion (the policy, faculty and route diff is empty).
8. Class A bytes are unchanged for a C/D adoption.
9. G5 provider continuity still holds on the new version.
10. An expired window refuses.

## 20. Health and alerting (explicit rows only, no fallback)

| Check | Invariant | Severity |
|---|---|---|
| `reflection.modelCandidateActivationGoverned` | every activation of a `MODEL_PROPOSAL` candidate has a GRANTED HUMAN approval bound to it under an adopt gate, and C/D ones fall in an open window | **P0** |
| `reflection.recordsBoundToReflectionTasks` | every proposal, observation and model candidate references a task of recipe `identity-reflection/v1` in the same tenant | **P0** (canonical state without the canonical task) |
| `reflection.heldModelCandidatesBounded` | HELD model candidates on head ≤ 3 per identity | P1 (the database also enforces it) |
| `reflection.noDuplicateRecordKeys` | keys are unique | P2 |
| `reflection.recordsHaveEvidence` | every record has 1 or more qualified refs, and an ACTIVE observation has an evaluation | P2 |
| `reflection.adoptedChangeUnreviewed` | no adopted model change older than 14 days without a `POST_CHANGE` reflection | P3, notified |

- NO_OBSERVATION (mode `DISABLED`, or no records) is UNKNOWN at P3 and silent, recovering silently, as in ADR-0022.
- Database-unreachable is UNKNOWN at P3 and silent.

## 21. Threat model, adversarial answers and self-review findings

**Adversarial questions (deterministic answers):**

1. **Canonical state without a task?** No. Every record row has an FK to a reflection task, and the
   `recordsBoundToReflectionTasks` check is P0.
2. **Can it create a task?** No. There is no admission path from `reflection/**` (fence), and the plan has no
   task-minting step.
3. **Can it approve itself?** No. Approvals are HUMAN Telegram decisions through ApprovalStore; there is no reflection
   import of approval code.
4. **Can it activate its own candidate?** No. In P8A it is impossible in the database (the P7A CHECK). In P8B it needs
   a HUMAN ADOPT task, a GRANTED approval and, for C/D, an open window.
5. **Can it mutate Class A?** Only as a HELD candidate. Adoption is always HUMAN-approved, and the class is computed by
   the database.
6. **Can it route to another provider?** No. Class E has no consumer, the routing table is static, and the fence
   enforces it.
7. **Can it read more memory?** No. The faculty memory ceiling applies unchanged, and the verifier gets none.
8. **Can Class E alter the P7B projection?** No. It is not in the identity document, and the fence keeps it out of the
   assembler.
9. **Can a stale proposal apply?** No. Section 13 and the P7A compare-and-swap prevent it.
10. **Can replay duplicate?** No. Deterministic ids, unique keys and support rows prevent it.
11. **Can rejected records disappear?** No. They are immutable and recorded as dispositions.
12. **Can model origin become operator origin?** No. Nothing writes the origin, and P8B records adoption separately.
13. **Can secrets be embedded?** Screened, refused and capped.
14. **Can a Class D aspiration schedule work?** No. Identity has no import into the scheduler or admission, and
    objectives are text only.
15. **Can it write to the Shared Brain?** No. There is no connector, credential or code.
16. **Can it bypass the C/D freeze?** No. P8A changes no guard; P8B needs an open window.
17. **Who opens a growth window?** Deployment authority in an authorised change window, naming the HUMAN
    authorisation (but see blocker B1).
18. **How is an opening audited?** An immutable window row, plus release-window evidence.
19. **How does the human freeze immediately?** A `FREEZE` task (lowering only) or the deployment function. The window
    close or `DISABLED` row is effective at the next insert.
20. **What happens to pending records when frozen?** They are retained and auditable. They cannot be converted or
    adopted, and can still be dismissed.

**Threats and the defences against each:**

| Threat | Defence |
|---|---|
| self-approval | Q3 |
| origin laundering | Q12 and the P7A owner check, which applies to operator origin only |
| proposal spam | section 12 |
| stale application | section 13 |
| replay duplication | section 11 |
| Class E routing leakage | section 9 and the fence |
| memory leakage | section 6 |
| autonomous task generation | sections 5 and 16 |
| goal-to-schedule leakage | Q14 |
| secret persistence | section 15 |
| verifier collusion | a different faculty, a different model enforced, advisory only, and KernelJSON decides eligibility by deterministic checks |
| provider session as canonical | section 15 |
| automatic rollback | section 14 |
| freeze ambiguity | one mode table, one window table, explicit precedence: DISABLED wins over everything |
| accidental C/D unfreeze | windows expire and `set_identity_freeze` is retired for growth |
| Shared Brain creep | Q15 |

**Self-review findings and their fixes:**
- A "verifier-approved" proposal could look like approval. Fixed: eligibility needs evaluator support **and**
  deterministic kernel checks, and an eligible proposal only creates a HELD candidate.
- Repeatedly rejected ideas could respawn. Fixed: keys are unique across all dispositions, and a repeat becomes
  support.
- A HEAD change could deadlock the caps. Fixed: stale records do not count.
- A `FREEZE` task path could also raise the mode. Mitigated: the `FREEZE` code path only ever writes `DISABLED`, and
  any other row must come through the deployment function. Full prevention needs B1.
- Operator feedback could smuggle instructions. It is data in the user message, labelled, and has no authority path.
- The P8A-1 live trigger could become automatic through Telegram. Fixed: any Telegram command must still admit a
  HUMAN `identity-reflection/v1` task through the door; nothing else.

**BLOCKING items:**
- **B1: blocks P8B; does not block P8A.** The worker runs as `postgres`, so the database cannot stop worker code from
  calling the deployment-only mode-raise or window-open functions. Code fences and P0 health are detection, not
  prevention.
  - Before P8B, the worker must run as a dedicated least-privilege database role. That role would get SELECT/INSERT on
    the tables it writes and no EXECUTE on `set_reflection_mode` or `open_growth_window`, and its grants would need
    re-qualification across P1 to P7.
  - In P8A the residual is acceptable: the worst case of a raised mode is extra proposals and observations, with no
    authority and no activation, because the database still forbids approving a `MODEL_PROPOSAL`.
- **B2: blocks P8A-1, by design.** The faculty-version appends that permit the reflection recipe and operations are a
  Class B structural change. They need their own reviewed faculty change; this ADR does not author those versions.

## 22. Explicit non-goals

- auto-adoption at any class;
- adaptive routing;
- dynamic specialists and swarms;
- the Shared Brain (P9);
- P5 protected-promotion repair or any memory promotion;
- automatic reflection triggers;
- scheduler or admission authority changes beyond one catalogue entry;
- Class B (faculty) changes beyond the static routing extension;
- autonomous goals;
- automatic rollback;
- reflection framing (no projection profile);
- unfreezing Class C/D in P8A.

## 23. Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Class E inside the identity document | breaks the proven P7 digests and projection (section 9) |
| a second identity-change store | two mutation authorities |
| converting adopted candidates to operator origin | laundering |
| model-computed confidence | false precision |
| verifier verdict as approval | collusion risk; advisory only |
| permanent C/D unfreeze, or a standing growth mode | drift by default (section 17) |
| automatic reflection triggers in v1 | autonomous task generation |
| a new "reflector" faculty | not needed; would bypass the P6 review |
| the Codex inbox as the architecture | no growth path; separate schema (section 3) |

## 24. Open questions

None is authority-critical except B1 and B2 above.
- The exact text templates for Mission Control are implementation detail for P8A-1.
- The 14-day `POST_CHANGE` threshold is a tunable default.
