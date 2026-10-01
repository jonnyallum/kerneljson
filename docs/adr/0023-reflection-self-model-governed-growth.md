# ADR-0023: Reflection, self-model and governed identity growth (KJ-P8)

Status: PROPOSED, revision 2 (design only). Nothing here is implemented, migrated or deployed.
Date: 01/10/2026.
Base: canonical `main` `750d5b7926f320d8e9d3f64789b8f7035eaa4f3d`. Production: epoch 13, release `cebbb0d`, cognition
ON, Class C/D frozen (docs/operations/KJ_P7B_LIVE_RESULT_2026-09-30.md).

Builds on: ADR-0018 and ADR-0020 (canonical memory), ADR-0021 (Primary Identity), ADR-0022 (identity cognition binding,
with its D1 erratum), docs/cognition/IDENTITY_GOVERNANCE.md, and Stage G of docs/cognition/IMPLEMENTATION_PLAN.md.

Supersedes, if accepted: the alternative prototype `docs/adr/0023-evidence-bound-reflection-proposals.md` on the
unmerged branch `codex/kjp8-proposal-design` (draft PR #49). That design is retained here only where section 3 says so.

## 0. Revision record

Revision 1 is commit `f2b36fa928a475307c6913f87f0d6dc0e031a243`. The hostile design seal returned BLOCK with six
blockers. Revision 2 is a new commit on the same branch; revision 1 is not rewritten.

| Blocker or residual | Revision 1 defect | Resolved in |
|---|---|---|
| B-RL | the 6-per-24h reflection limit was a count taken after admission, so it could race and was not atomic | sections 5.4 and 12 |
| B-SEC | operator free text was stored in the immutable task before it was secret-screened | section 5.3 |
| B-EV | reflection runtime evidence kept raw model output text | sections 6.3 and 15 |
| B-GW | growth windows were called append-only but had a mutable `closed_at` | sections 17.2 and 17.3 |
| B-CHK | the design implied a CHECK constraint could consult ApprovalStore | section 18 |
| B-ISO | verifier isolation was not extended to the reflection evaluator | sections 6.4 and 6.5 |
| reflection caller | any HUMAN tenant member could reflect on the identity | section 5.2 |
| CORRECT while DISABLED | undefined | sections 9.4 and 17.1 |
| Class E `ACTIVE` | a writable state that read like a permission | section 9.3 |
| composite foreign keys | several relationships were bare UUIDs | section 23 |
| 14-day semantics | read as a threshold with authority | section 14 |

Section numbers changed from revision 1: section 18 (P8B adoption mechanics) and section 23 (same-tenant references)
are new, and the later sections moved down.

## 1. Context: what the code is today (observed at `750d5b7`)

These facts constrain the design. Each was read in this worktree; none was exercised by a test in this revision.

1. **Admission.** The door accepts a static catalogue of recipes (`apps/gateway/src/server.ts` `PublicSubmission`):
   golden, uppercase, `claude_md_check/v1`, `repo-analysis-mission/v1` and `identity-change/v1`. A new recipe is a
   deliberate catalogue change. Nothing else mints canonical tasks.
2. **Admission is one database transaction.** Inside one `withTenant(..., 'submit')` transaction (plain `begin`, so
   READ COMMITTED) the door takes an advisory lock on the idempotency key, returns the prior admission on a replay,
   and otherwise inserts `kernel_private.execution_bindings` and `kernel_private.task_admissions`. The admission row's
   `payload` holds the full objective text. Dispatch to Restate happens afterwards, in a second transaction. The
   `public.tasks` row is created later by the workflow. So `task_admissions` is the first durable copy of any
   operator text, and it is immutable.
3. **Model-origin identity candidates cannot be approved today.** P7A's `identity_candidates` CHECK
   `origin = 'OPERATOR_INSTRUCTION' or state in ('HELD','REJECTED')` means a `MODEL_PROPOSAL` candidate can never
   reach `APPROVED`. The activation guard requires `APPROVED` (or a HELD operator C/D candidate).
4. **The version guard does not protect model candidates.** `identity_version_guard` binds a version to the
   candidate's proposing task only when `proposed_by_task` is set, and relies on the activation guard for model and
   Shared Brain origins. A version row moves `identity_head` even when it is never activated (INFERENCE from reading
   the trigger; not exercised). Section 10 closes this before P8 creates any model candidate.
5. **The identity-change workflow** creates only `OPERATOR_INSTRUCTION` candidates (`identity-workflow.ts`). It has two
   request kinds, `PROPOSE` and `ROLLBACK`, requires a HUMAN actor and requires the actor to be the profile's
   `owner_principal_id`. Stale protection is the P7A compare-and-swap: the candidate's
   `base_version`/`base_identity_core_digest` must equal the head at apply time.
6. **Approvals bind a candidate through an event, not a column.** `public.approvals` holds `id`, `task_id`,
   `requested_from` and `status`. The activation guard proves the binding by finding the task's immutable
   `POLICY_CHECKED` event whose invocation input is `{candidateId, identityCoreDigest}` under the class gate
   capability, with decision `APPROVAL_REQUIRED`.
7. **Class C/D is frozen by default.** `identity_activation_guard` refuses C/D while
   `coalesce(identity_governance_state.frozen, true)`; production has no governance row and no C/D policy rule.
   G13 did not unfreeze it (ADR-0021 erratum, ADR-0022 section 14).
8. **Faculties.** `validateFacultyPin` hard-codes `permittedRecipes.includes(MISSION_RECIPE)`. `routeFaculty` maps
   only `RUNTIME_ANALYSE` to intelligence and `RUNTIME_REVIEW` to verifier. Verifier isolation (no memory classes,
   zero memory tokens, `review = KERNEL_RECONCILIATION`) is applied only when `operation === "RUNTIME_REVIEW"`.
   The `FacultyVersion` contract enumerates exactly those two operations.
9. **P7B framing** applies only to the mission analyst. `identity-ceiling.ts` gives the verifier an empty framing
   ceiling. The completion oracle runs only for `repo-analysis-mission/v1`.
10. **P5.** `submitModelCandidate` produces HELD model memory candidates. The protected-promotion carrier is broken and
    fenced (ADR-0021). P8 needs neither.
11. **The production worker connects as `postgres`**, the owner (OBSERVED, KJ_P7B1_DEPLOYMENT_RUNBOOK.md and the P7B
    live record). Database grants therefore cannot separate worker code from deployment authority. This drives
    blocker B1 (section 22).
12. **Secret screen.** The pattern set is `looksLikeSecret` in `services/memory/src/canonical/policy.ts`.
    `services/kernel/src/identity/secret-scan.ts` (`findSecretShapedContent`) walks a value and applies it. Mission
    runtime evidence today keeps model output text.
13. **Model independence helper.** `sameModel` in `packages/contracts/src/mission.ts` compares model slugs.

## 2. Decision in one paragraph

Reflection is advisory cognition inside a normal admitted task (`identity-reflection/v1`) that only the Primary
Identity's HUMAN owner can request. It reads a kernel-qualified evidence packet and the current identity **as data**.
It can emit only two kinds of record: bounded **ReflectionProposals** and **SelfModelObservations** (Class E). Both
come from a strict structured-output contract, are evaluated by an isolated, independent verifier, and are classified
and stored by KernelJSON. No raw model output is copied into evidence. From P8A-2, an eligible identity proposal may
become exactly one **HELD `MODEL_PROPOSAL` candidate** in the existing `identity_candidates` table, and in P8A nothing
can approve or activate it. P8B, under a separate review and after blocker B1 is closed, lets the owner adopt a model
candidate through one writer path, `identity-change/v1` `ADOPT`, with a database-proven approval binding and, for
Class C/D, an effective append-only growth window. Reflection never produces canonical behavioural change.

## 3. Why the Codex prototype was not adopted, and what is retained

**Not adopted as the architecture.** It designs only a deterministic review-proposal inbox: one source mission, no
model reflection, no self-model, no identity candidates, no growth path. Its K1 code was written before any hostile
design review. It also uses a different recipe and proposal schema, which would make two incompatible proposal
systems.

**Retained deliberately, as P8A-0 (section 19):**
- the strict, flat request contract (unknown and duplicate keys refused, a small byte cap);
- re-verifying each source task through the existing pure completion seams (mission, faculty and identity
  verifiers) rather than trusting `COMPLETED`;
- a repeatable-read resolution of source facts (read-only; see section 5.4 for why the admission transaction is not
  repeatable-read);
- a domain-separated digest of the source manifest;
- factual, versioned observation codes;
- the rule that no prompt, output, memory or projection text is persisted by P8.

No Codex code is reused. The prototype's K1 implementation is not approved by this ADR.

## 4. Authority model

| Actor | May | May never |
|---|---|---|
| HUMAN owner of the Primary Identity (via the admission door) | request a reflection; dismiss a proposal, candidate or model observation; correct an observation; freeze reflection; close a growth window; in P8B, adopt a model candidate, subject to approval | n/a |
| Other HUMAN tenant members | nothing in P8 | request, dispose, correct, freeze or adopt |
| KernelJSON (door, workflow, ledger, database) | scan and refuse; reserve quota; qualify evidence; parse and classify; deduplicate; enforce caps; store records; create a HELD model candidate; complete the task | activate identity from a model output; change routing, faculty, memory permission, policy, admission or schedule |
| Reflecting model (intelligence faculty) | propose edits and observations as structured JSON | create state, tasks, approvals or activations; choose a faculty, provider or model; assert a governance class, confidence, eligibility or staleness |
| Evaluating model (verifier faculty) | give an advisory verdict on each record | approve, classify, make a record eligible on its own, or create anything |
| Deployment authority (change window) | raise the reflection mode; in P8B, open a growth window | operate from inside the worker (code fence in P8A; database privilege after B1) |

Reflection records are **outputs of a task**, never permission tokens. One admission door, many event and execution
doors, one task authority: unchanged.

## 5. Reflection task contract

### 5.1 Recipe and kinds

**Recipe `identity-reflection/v1`**, routed to `KernelWorkflowV1` (the same execution binding and release provenance
as missions). It is added to the door's static catalogue in P8A-1, not before.

The objective is one strict JSON object, at most 4096 bytes, with exactly the keys of its kind:

| Kind | Fields | Model call | Approval | Quota slot |
|---|---|---|---|---|
| `REFLECT` | `sourceTaskIds` (1 to 10 UUIDs), `focus` (`OUTCOMES`, `COMMUNICATION`, `IDENTITY` or `POST_CHANGE`; `POST_CHANGE` also needs `activationId`), `operatorFeedback` (0 to 2000 bytes) | yes | no | yes |
| `DISPOSE` | `subject` (a proposal, candidate or observation id), `disposition` (`DISMISS` or `CORRECT`), `reason` (1 to 500 bytes), and `correction` (1 to 300 bytes) for `CORRECT` only | no | no: it only narrows or corrects | no |
| `FREEZE` | `reason` (1 to 500 bytes) | no | no: it only narrows | no |

- **Plan for `REFLECT`:** `REFLECT_QUALIFY` (deterministic), then `REFLECT_PROPOSE` (intelligence), then
  `REFLECT_EVALUATE` (verifier), then `REFLECT_RECORD` (deterministic). Any refusal ends the task FAILED with a
  stable code and evidence.
- **No daemon, loop or background agent.** A reflection task never admits another task. Section 16 removes every path
  from records to admission.
- **The only live trigger in P8 is an explicit request by the HUMAN owner.** Verifier failures, feedback, provider
  metrics and scheduler events are **not** triggers. A future event policy would need its own ADR and must still
  enter through admission.
- **No Telegram command is designed here.** If one is added later, it must call the same pure pre-admission function
  of section 5.3 before it stores any operator text, and it must still admit through the door.

### 5.2 Who may call (caller ownership)

A request under `identity-reflection/v1`, and an `ADOPT` request under `identity-change/v1`, is admitted only when
**all** of these hold. Each is checked at the door inside the admission transaction, before any row is written:

1. the bearer authenticates, and the existing tenant membership authorisation for `submit` passes (unchanged);
2. `actor.kind = HUMAN`;
3. the tenant has a Primary Identity profile (`identity_profiles.tenant_id` is unique), else `REFLECTION_NO_IDENTITY`;
4. `actor.id = identity_profiles.owner_principal_id` for that profile, else `REFLECTION_NOT_OWNER`.

The same rule is enforced a second time in the database, independently of the door: the triggers on
`reflection_admission_reservations`, on HUMAN dispositions, on `OPERATOR_CORRECTION` observations and on
`identity_model_adoptions` each compare the owning task's `principal_id` with `owner_principal_id` and the principal's
`kind` with `HUMAN`, exactly as `identity_candidate_classify()` does for operator candidates today.

This creates no new inspection capability for other HUMAN members and does not change any membership role label.

### 5.3 Pre-admission pipeline (B-SEC)

For every P8 request the door runs these steps **in this order**. Steps 1 to 6 are a pure function over the request
bytes and run before the admission transaction opens. Nothing is written until step 9.

| # | Step | Refusal (stable code, HTTP) |
|---|---|---|
| 1 | bearer authentication (existing) | `UNAUTHENTICATED`, 401 |
| 2 | body and `PublicSubmission` parse (existing) | `INVALID_REQUEST`, 400 |
| 3 | strict bounded parse of the objective: one JSON object, at most 4096 bytes, exactly the keys of its kind, every value of the declared type and enumeration | `REFLECTION_REQUEST_INVALID`, 400 |
| 4 | duplicate-key refusal: the objective is parsed by a strict parser that refuses a repeated key, compared after JSON unescaping, at any depth | `REFLECTION_REQUEST_INVALID`, 400 |
| 5 | text limits: each free-text field within its byte cap; no U+0000, no U+FFFD, no unpaired surrogate, no C0 or C1 control character except LF and TAB | `REFLECTION_TEXT_INVALID`, 400 |
| 6 | **secret-shaped content scan** of every free-text field | `REFLECTION_SECRET_SHAPED_CONTENT`, 400 |
| 7 | tenant membership authorisation and the existing admission limiter (existing, first statements of the transaction) | `FORBIDDEN` 403, `ADMISSION_DENIED` 429 |
| 8 | HUMAN and owner authorisation (section 5.2); for `REFLECT`, reflection mode is not `DISABLED` | `REFLECTION_NOT_OWNER` 403, `REFLECTION_NO_IDENTITY` 409, `REFLECTION_DISABLED` 409 |
| 9 | canonical admission (section 5.4) | `REFLECTION_QUOTA_EXCEEDED`, 429 |

Rules that make this deterministic:

- **Free-text fields covered:** `operatorFeedback`, `reason` and `correction` under `identity-reflection/v1`, and
  `reason` of `identity-change/v1` `ADOPT`. Any later P8 free-text field joins this list in the same change that adds
  it; a contract test enumerates every string field of the P8 request schemas and fails if one is not scanned.
- **Nothing reaches a durable store before step 6 passes.** On any refusal in steps 3 to 8 there is no
  `execution_bindings` row, no `task_admissions` row, no reservation, no dispatch event, no Restate invocation, no
  `tasks` row, no task event, and the idempotency key is not consumed. The U+FFFD rule exists because the door
  decodes bodies non-fatally today; a replaced byte sequence is refused rather than admitted.
- **No content echo.** A refusal returns only the stable code and the correlation id. The scanner's internal shape
  name, the field name and the field value are not returned and not logged. The door already logs no request body.
- **One scanner.** The pattern set and the walker move, unchanged, into one neutral pure module,
  `packages/contracts/src/secret-shape.ts`, exporting `looksLikeSecret` and `findSecretShapedContent`.
  `services/memory/src/canonical/policy.ts` and `services/kernel/src/identity/secret-scan.ts` re-export from it. No
  pattern is copied. A test asserts the three import paths resolve to the same function objects, and the existing P5
  and P7 scanner tests must pass unchanged. The door imports only the neutral module.
- **Worker-side scanning stays, as defence in depth only.** The workflow re-runs the same function on the admitted
  contract at its first step and fails closed on a hit. That path is not the first defence and is never the only one.
- **The outer body.** `PublicSubmission` is produced by `JSON.parse`, so a repeated outer `objective` key resolves to
  its last value. That last value is the only one that is parsed, scanned and persisted, so it is not a bypass.

Not changed here: `identity-change/v1` `PROPOSE` and `ROLLBACK` are P7 requests. Their text reaches
`task_admissions` before the workflow's own scan today (OBSERVED in `identity-workflow.ts`). Moving them behind the
same pre-admission function is RECOMMENDED as separate hardening with its own authorisation; this ADR does not alter
P7 behaviour.

### 5.4 Atomic admission quota (B-RL)

**Rule.** At most 6 `REFLECT` tasks are canonically admitted per tenant in any rolling 24 hours.

**Store.** `kernel_private.reflection_admission_reservations`, immutable (`reject_ledger_mutation` on update, delete
and truncate), one row per canonically admitted `REFLECT` task:

| Column | Meaning |
|---|---|
| `task_id` | primary key |
| `tenant_id` | not null |
| `admitted_at` | set by the trigger to `clock_timestamp()`; a caller value is overwritten |
| `(task_id, tenant_id)` | foreign key to `kernel_private.task_admissions(task_id, tenant_id)` |

The same migration adds `unique (task_id, tenant_id)` to `task_admissions` (additive; `task_id` is already its primary
key) so that the foreign key proves the reservation and the admission are the same task in the same tenant.

**Enforcement is one BEFORE INSERT trigger on the reservation table**, `reflection_admission_reserve()`:

1. refuse unless `current_setting('transaction_isolation') = 'read committed'`
   (`REFLECTION_ADMISSION_ISOLATION`), because the count in step 5 needs a snapshot taken after the lock;
2. `pg_advisory_xact_lock(hashtextextended(tenant_id::text || ':reflection-admission', 0))`;
3. read the admission row: its recipe must be `identity-reflection/v1`, its objective kind `REFLECT`, its
   `principal_id` the identity owner and a HUMAN principal;
4. set `admitted_at := clock_timestamp()`;
5. count reservations for the tenant with `admitted_at > new.admitted_at - interval '24 hours'`; if the count is 6 or
   more, raise `REFLECTION_QUOTA_EXCEEDED` (errcode 23514).

**The inverse is a deferred constraint trigger on `task_admissions`,** checked at COMMIT (the pattern of the
ADR-0022 latch invariant): an admission whose recipe is `identity-reflection/v1` and whose kind is `REFLECT` must have
a reservation row. A `REFLECT` task therefore cannot be admitted without consuming a slot, by any code path.

**The admission transaction** (the door's existing single transaction, extended) is, in order:

1. membership authorisation and the admission limiter;
2. the existing idempotency-key advisory lock;
3. replay check: if an admission exists for this key with the same request digest, return its binding and stop;
4. section 5.2 checks and the mode check;
5. take the per-tenant reflection lock (the same key as the trigger; advisory locks are re-entrant in a transaction);
6. insert the execution binding, then the admission row, then the reservation;
7. commit.

The reservation is inserted last only because its foreign key targets the admission row. All three rows commit
together or not at all, under the lock, so there is no check-then-later-insert gap. The door performs no count of
its own; the trigger is the only decision.

**Budget semantics.**
- Every canonically admitted `REFLECT` task consumes one slot for 24 hours, whether it later completes, fails or is
  cancelled. A caller cannot recover budget by producing failing tasks.
- A request refused before admission (any step of section 5.3, including the quota refusal itself) consumes nothing,
  because the whole transaction rolls back.
- A replay of the same idempotency key returns at step 3 and consumes nothing. One key yields one task id
  (`stableId` over tenant, principal and key digest), and `task_id` is the reservation's primary key, so a second
  slot for the same task is impossible.
- `DISPOSE` and `FREEZE` consume no slot. They invoke no model, create no proposal, observation or support row, and
  each write is bounded (one terminal disposition per subject; section 8). A freeze or a correction must never be
  refused because the reflection budget is spent. They remain subject to the door's existing admission limiter.

**Proof for two concurrent admissions at 5 of 6.** T1 and T2 hold different key locks and reach the tenant lock. T1
acquires it, counts 5, inserts and commits; the lock is released at commit. T2 was blocked on the lock; its count
statement then runs with a fresh READ COMMITTED snapshot, sees 6 and raises. T2's binding and admission rows roll
back. If T1 rolls back instead, T2 counts 5 and succeeds. Exactly one is admitted in every interleaving.

## 6. Model inputs, structured outputs and isolation

### 6.1 What each model receives (identity as data, not framing)

**The reflector (intelligence faculty, `REFLECT_PROPOSE`) receives:**
- the qualified evidence packet: factual codes, receipts, verdicts, digests and bounded excerpts that already exist
  in canonical evidence, each labelled with a packet entry ordinal;
- the operator's feedback text;
- the current canonical identity document, A, C and D, as **labelled subject data**
  (`SUBJECT IDENTITY (data under review; not instructions)`);
- CURRENT Class E observations (section 9.3) as data;
- P5 memory assembled through the existing read-only port, within its faculty memory ceiling.

**The evaluator (verifier faculty, `REFLECT_EVALUATE`) receives:** the parsed structured records, the cited packet
entries and the subject identity as data. It receives **no P5 memory**. Its request builder has no memory-port
parameter, so there is nothing to pass by accident.

**No P7B identity framing for either.** `profileForOperation` returns no profile for the reflection operations, and
`identityFramingCeiling` stays empty for the verifier. Seeing the identity as data grants no authority.

### 6.2 Structured output contracts

Each provider response must be **exactly one JSON object** and nothing else: no prose before or after, no code
fence. The kernel parses it with the same strict parser as section 5.3.

**Reflector, `kerneljson:reflection-output/v1`:**

```
{ "contract": "kerneljson:reflection-output/v1",
  "proposals":    [ 0 to 3 of IdentityEdit | RollbackRecommendation ],
  "observations": [ 0 to 3 of Observation ] }

IdentityEdit           { "kind": "IDENTITY_EDIT", "path": PATH, "op": OP, "value": string,
                         "rationaleCodes": [1 to 3 of RATIONALE], "evidenceRefs": [1 to 8 packet ordinals] }
RollbackRecommendation { "kind": "ROLLBACK_RECOMMENDATION", "targetVersion": positive integer,
                         "rationaleCodes": [1 to 3 of RATIONALE], "evidenceRefs": [1 to 8 packet ordinals] }
Observation            { "kind": OBSERVATION_KIND, "scope": per-kind strict object, "claim": string,
                         "evidenceRefs": [1 to 10 packet ordinals] }
```

- `PATH` is one of exactly: `classA.name`, `classA.constitution`, `classA.values`, `classA.operatorRelationship`,
  `classA.facultyFraming`, `classA.memoryPolicy`, `classC.persona`, `classC.communication`, `classC.behaviour`,
  `classC.presentation`, `classD.objectives`, `classD.vision`. These are the fields of `IdentitySections`.
- `OP` is `REPLACE` for a string field, or `ADD_ITEM` / `REMOVE_ITEM` for the list fields `classA.values` and
  `classD.objectives`. Any other pairing is refused.
- `value` obeys the bound of its target field in `packages/contracts/src/primary-identity.ts`: 100 characters for
  `classA.name`, 300 for a list item, 4000 for the other string fields. `claim` is at most 300 characters.
- `RATIONALE` is a closed enumeration of factual codes (for example `VERIFIER_FINDING_REPEATED`,
  `OPERATOR_FEEDBACK_EXPLICIT`, `OUTCOME_PATTERN`, `POST_CHANGE_COMPARISON`). There is **no free-text rationale**.
  The reason a proposal exists is its codes plus its evidence references.
- One proposal is exactly one edit to one path. A `value` is opaque text for that one field; the kernel never parses
  it for further edits, so nothing can be hidden inside it.

**Evaluator, `kerneljson:reflection-evaluation-output/v1`:**

```
{ "contract": "kerneljson:reflection-evaluation-output/v1",
  "verdicts": [ exactly one per record, in record order:
    { "subject": "P0".."P2" | "O0".."O2",
      "verdict": "SUPPORT" | "OPPOSE" | "INSUFFICIENT_EVIDENCE",
      "concerns": [0 to 4 of CONCERN] } ] }
```

`CONCERN` is a closed enumeration (`EVIDENCE_MISMATCH`, `AUTHORITY_EXPANSION_SUSPECTED`, `PREFER_NO_CHANGE`,
`OVERGENERALISED`). There is no free-text field in the evaluator contract at all.

**The whole output is refused** (task FAILED `REFLECTION_OUTPUT_REFUSED`, no record written) on any of: an unknown
key; a duplicate decoded key; any text outside the single object; an unsupported path or path/op pairing; an
oversize value or array; text failing the step 5 rules of section 5.3; an unknown enumeration value; a missing
required key; a verdict list that does not match the records one for one; an evidence reference that is not an entry
of this task's packet. Refusal is all-or-nothing: there is no partial acceptance of a malformed response.

**A secret-shaped `value` or `claim`** fails the task `REFLECTION_OUTPUT_SECRET` with no record written.

**An empty output** (no proposals, no observations) is valid. The evaluator call is skipped, `REFLECT_EVALUATE`
records the factual code `NO_RECORDS`, and the task completes with no records.

**What the kernel computes, never the model.** The output contracts have no field for any of these, so a model
cannot assert them:

| Value | Computed by |
|---|---|
| governance class | the database, in `identity_candidate_classify()`, from the document diff |
| authority-impact eligibility | the kernel: the path is on the allow-list, the candidate document differs from the head in exactly that one path, it passes `IdentityDocumentDraft`, and the class implied by the path equals the class the database computed |
| candidate document | the kernel: the head document plus the one edit |
| confidence | the kernel, from distinct supporting source tasks (section 9.5) |
| staleness | derived in a view from the bound base and the head (section 13) |

The evaluator's verdict and concerns can only **remove** eligibility. Eligibility requires `SUPPORT`, an empty
`concerns` list, and every kernel check above. No model output can add eligibility.

### 6.3 Processing order

```
provider response
  -> strict structured-output parse (6.2)
  -> size, enumeration and path validation
  -> secret scan
  -> deterministic KernelJSON classification
  -> canonical bounded structured result
  -> digest and evidence binding (section 15)
```

Nothing from a step is persisted by P8 until every earlier step has passed.

### 6.4 Faculties and verifier isolation (B-ISO; delivered by B2)

**No new faculty.** B2 is a separate Class B change with its own review, required before P8A-1. It consists of:

1. **Contract.** The `FacultyVersion` operation enumeration and the `FacultyPin` routing-reason enumeration gain the
   two reflection values. No other contract field changes.
2. **Static operation table**, replacing the two `if` statements in `routeFaculty` and the hard-coded mission recipe
   in `validateFacultyPin`:

| Operation | Recipe | Faculty | Routing reason | Isolation |
|---|---|---|---|---|
| `RUNTIME_ANALYSE` | `repo-analysis-mission/v1` | intelligence | `repo-analysis/analyst` | analyst |
| `RUNTIME_REVIEW` | `repo-analysis-mission/v1` | verifier | `repo-analysis/independent-reviewer` | **verifier-isolated** |
| `REFLECT_PROPOSE` | `identity-reflection/v1` | intelligence | `identity-reflection/reflector` | analyst |
| `REFLECT_EVALUATE` | `identity-reflection/v1` | verifier | `identity-reflection/independent-evaluator` | **verifier-isolated** |

   An operation not in this table is refused `FACULTY_OPERATION_REFUSED`, as today.
3. **Explicit reviewed allow-list.** `VERIFIER_ISOLATED_OPERATIONS = ["RUNTIME_REVIEW", "REFLECT_EVALUATE"]` is a
   closed constant. `validateFacultyPin` applies the **existing** isolation requirements, unchanged, to every
   operation on it:
   - the pinned faculty is the verifier;
   - `permittedMemoryClasses` is empty;
   - `contextBudget.maxMemoryTokens` is 0;
   - `review` is `KERNEL_RECONCILIATION`;
   - a failure is `FACULTY_REVIEW_ISOLATION_REFUSED`.

   The check is by membership of the list, not by "any operation routed to the verifier". A future verifier operation
   inherits nothing: it must be added to the table and to the list by a reviewed change. A test asserts that every
   table row whose faculty is the verifier is on the list, so a verifier operation cannot be added without isolation.
4. **Recipe check from the table.** The pin is valid only if the faculty version's `permittedRecipes` contains the
   table's recipe for the pinned operation, `permittedOperations` contains the operation, and the plan's recipe
   equals the table's recipe. So `RUNTIME_REVIEW` cannot be used under the reflection recipe, or the reverse.
5. **`REFLECT_PROPOSE`** requires `review = INDEPENDENT_VERIFIER`, the same rule as `RUNTIME_ANALYSE`.
6. **Appended faculty versions.** Intelligence and verifier each get a **new version** that adds
   `identity-reflection/v1` and its one operation. The existing P6 version rows are immutable and are not edited.
   Pins already taken by in-flight tasks keep the version they pinned.
7. **No identity framing and no Class E consumer** for either reflection operation: the framing ceiling stays empty
   for the verifier, `profileForOperation` returns none for both, and the section 16 fence keeps Class E out of
   `faculty/**`.

### 6.5 Evaluator independence

For one reflection, the reflector and the evaluator must not be the same effective model.

- **Definition.** Let `(provider_r, model_r)` be the reflector's effective pair, taken from its validated receipt
  (the provider-reported identity), and `(provider_e, model_e)` the evaluator's. The calls are independent only if
  `sameModel(model_r, model_e)` is false. This is stricter than comparing pairs: the same model reached through two
  providers is not independent, and an identical pair is always refused.
- **Checked twice, fail closed both times.**
  1. Before the evaluator call: the evaluator's pinned model is compared with the reflector's effective model. If
     they are the same model, the task fails `REFLECTION_EVALUATOR_NOT_INDEPENDENT` and the evaluator is not called.
  2. After the evaluator call: the two validated receipts are compared. If routing or a provider fallback produced
     the same effective model, the task fails with the same code and **no record is written**.
- There is no silent continuation and no retry on another route. Both receipts are recorded in evidence in either
  outcome.
- The evaluator stays advisory. KernelJSON decides eligibility by the deterministic rule of section 6.2.

## 7. ReflectionProposal

**Immutable row `public.reflection_proposals`:** `id` (deterministic from task, step and ordinal), `tenant_id`,
`identity_id`, `reflection_task_id`, `proposer` (`MODEL`), `kind`, `base_version_id`, `base_identity_version`,
`base_identity_core_digest`, `edit` (jsonb: `path`, `op`, `value`, or `targetVersion`), `rationale_codes` (1 to 3
enumeration values), `evidence_refs` (jsonb, 1 to 8 packet entries), `proposal_key`, `proposal_digest`, `created_at`.
Foreign keys are composite and same-tenant (section 23). There is no free-text rationale column.

**Kinds:**
- `IDENTITY_EDIT`: exactly one field edit, as section 6.2 defines. The governance class is **never** taken from the
  model: the database classifies the resulting candidate.
- `ROLLBACK_RECOMMENDATION`: names a prior version. It is advice only and is never executable (section 14).

**Evaluation (immutable, one per proposal or observation):** `public.reflection_evaluations` holds the verdict
enumeration, the concern enumerations, the evaluator call id and its `MODEL_CALLED` binding. It holds no text.

**Status** is derived from immutable facts, never edited in place: evaluation, then dispositions (section 8), then,
once a candidate exists, the candidate's own state. A proposal is never a second identity workflow.

## 8. Dispositions, lifecycle mapping and audit

**`public.reflection_dispositions`** is append-only. It stores at most one terminal disposition per subject (a
proposal, a model candidate or an observation), unique by subject:

| Disposition | Set by | Applies to |
|---|---|---|
| `INELIGIBLE` | kernel: evaluator not supportive, a kernel check failed, stale at record time, a cap was hit, or the scope is operator-corrected (section 9.4); carries a reason code | proposals, model observations |
| `CANDIDATE_CREATED` | kernel; links the candidate id | proposals |
| `DISMISSED` | HUMAN owner, via `DISPOSE`; carries the `DISPOSE` task id | proposals, model candidates, model observations |

There is no `SUPERSEDED` disposition. Supersession is derived (section 9.3), never written.

**The governance lifecycle maps onto existing objects**, with nothing duplicated:

| Lifecycle stage | Represented by |
|---|---|
| PROPOSED | the proposal row |
| CLASSIFIED | the database classification on candidate insert; before that, a kernel pre-check only |
| EVALUATED | the evaluation row |
| APPROVAL_REQUIRED, APPROVED or REJECTED | the candidate state, ApprovalStore and, in P8B, the adoption binding |
| APPLIED | `identity_versions` + `identity_activations` (P8B) |
| OBSERVED | a `POST_CHANGE` reflection |
| ROLLED_BACK | a ROLLBACK through the existing path |

**Nothing is ever deleted.** Every table here is immutable through `reject_ledger_mutation`; rejected, dismissed and
ineligible records remain auditable.

**HUMAN dismissal of a HELD model candidate** uses the existing candidate transition HELD to REJECTED, written by the
`DISPOSE` task. The P8A-0 migration replaces `identity_candidate_transition_guard` so that, for a `MODEL_PROPOSAL`
candidate, HELD to REJECTED is accepted only when a `DISMISSED` disposition for that candidate, written by a
`DISPOSE` task of the HUMAN owner, exists **in the same transaction** (the transaction-id technique of section 18.2).
Dismissal only narrows, so it needs no approval, and it works while the mode is `DISABLED`.

## 9. SelfModelObservation (Class E), separate durable state

### 9.1 Not part of the identity document

**Class E is not added to the Primary Identity document.** Doing so would change `identity_core_digest` semantics, the
Class A digest, the P7B projection, G5 continuity, version comparison and activation governance.

### 9.2 Rows

**Immutable `public.self_model_observations`:** `id`, `seq` (generated identity, the ordering tiebreaker),
`tenant_id`, `identity_id`, `reflection_task_id`, `origin` (`MODEL_REFLECTION` or `OPERATOR_CORRECTION`), `kind`,
`scope` (jsonb, strict per kind), `scope_key` (sha256 of the canonical scope), `claim` (at most 300 characters),
`evidence_refs` (1 to 10), `observation_key`, `corrects_id` (for `OPERATOR_CORRECTION`: the observation the owner
corrected; same tenant, identity, kind and `scope_key`, enforced by trigger), `created_at`.

There is no state column and no `supersedes_id` column. Nothing on the row can be changed.

**Kinds (v1):**
- `TASK_CLASS_OUTCOME`: how evaluated tasks of a recipe or question shape turned out;
- `PROVIDER_ROUTE_OUTCOME`: how a pinned provider/model performed in the cited sample;
- `VERIFIER_FINDING_PATTERN`: what the verifier repeatedly flagged;
- `OPERATOR_COMMUNICATION_PREFERENCE`: inferred from explicit operator feedback.

`DELEGATION_PATTERN` is reserved and unused, because nothing delegates in v1.

### 9.3 CURRENT is derived, not written

There is no writable `ACTIVE` state. A read-only view, `public.self_model_current`, derives at most one CURRENT
observation per **exact scope**, where exact scope is `(tenant_id, identity_id, kind, scope_key)`:

1. if the scope has any `OPERATOR_CORRECTION` row, CURRENT is the one with the highest `seq`;
2. otherwise CURRENT is the `MODEL_REFLECTION` row with the highest `seq` among those that have a supportive
   evaluation and no `INELIGIBLE` or `DISMISSED` disposition;
3. otherwise the scope has no CURRENT observation.

An observation that is not CURRENT, and is neither dismissed nor ineligible, is displayed as superseded. That status
is computed by the view and stored nowhere.

**CURRENT means only: this is the latest non-superseded descriptive observation for its scope.** It grants zero
behavioural authority. No code reads the view to make a decision; section 9.6 and the fence in section 16 forbid a
routing, policy, faculty or memory consumer from importing it.

### 9.4 HUMAN correction and dismissal

`DISPOSE` with `disposition = CORRECT`:
- is available to the HUMAN owner **while the reflection mode is `DISABLED`**, because a correction narrows or
  corrects canonical descriptive state and must stay available during a freeze;
- never invokes a model, never creates a proposal and never creates a candidate;
- inserts one immutable `OPERATOR_CORRECTION` observation with the subject's `kind` and `scope_key`, the owner's
  `correction` text as `claim`, `corrects_id` set to the subject, and `reflection_task_id` set to the `DISPOSE` task;
- never mutates the corrected row;
- makes that correction the derived CURRENT observation for its exact scope (rule 1 of section 9.3).

**A HUMAN correction outranks every model observation in its scope, permanently.**
- A later model observation in a scope that has any `OPERATOR_CORRECTION` is recorded for audit with the kernel
  disposition `INELIGIBLE (OPERATOR_CORRECTED_SCOPE)`. It can never become CURRENT. The kernel does not try to judge
  whether the model claim "conflicts": every model claim in a corrected scope is shadowed.
- A later reflection may **cite** a correction as evidence.
- **Only another HUMAN correction supersedes a HUMAN correction** (the later one has the higher `seq`).
- `DISMISS` of an `OPERATOR_CORRECTION` is refused (`REFLECTION_CORRECTION_NOT_DISMISSIBLE`); the owner issues a new
  correction instead.

`DISPOSE` with `disposition = DISMISS` on a model observation writes a `DISMISSED` disposition and is also available
while `DISABLED`.

The insert trigger on `self_model_observations` enforces: an `OPERATOR_CORRECTION` row's task is a `DISPOSE` task of
recipe `identity-reflection/v1` whose principal is the HUMAN owner; a `MODEL_REFLECTION` row's task is a `REFLECT`
task and the mode is not `DISABLED`.

### 9.5 Confidence

Deterministic and computed by the kernel, never by the model:

| Class | Rule |
|---|---|
| `OPERATOR_ASSERTED` | origin `OPERATOR_CORRECTION` |
| `ANECDOTAL` | 1 distinct supporting source task |
| `EMERGING` | 2 to 4 distinct supporting source tasks |
| `CONSISTENT` | at least 5 distinct supporting source tasks and no cited contradicting task |

A "supporting source task" is a distinct qualified packet entry cited by the observation or by its support rows
(section 11). There is no numeric pseudo-probability.

### 9.6 Authority ceiling

**Class E describes; it never commands.** In P8 the only consumers are:
- the reflector, which reads CURRENT observations as data;
- health checks and Mission Control, read-only.

It must never reach provider, model, faculty or ordering selection, `providerPreferences`, `routingReason`, memory
permissions, policy, approval, admission, scheduling, task creation, or the P7B `IdentityProjection`. "DeepSeek
performed better in this evaluated sample" may be recorded; "therefore route to DeepSeek" has no code path. A breach
of this ceiling is a **qualification failure** (the topology test and its mutations in section 16), not only a
runtime health signal.

## 10. Identity candidate boundary and MODEL_PROPOSAL rules

1. The only identity mutation store is `identity_candidates`. P8 adds no other.
2. A reflection creates **at most one** candidate. A new unique partial index on `proposed_by_task` for
   `MODEL_PROPOSAL` enforces this.
3. **Origin is `MODEL_PROPOSAL` permanently.** No conversion to `OPERATOR_INSTRUCTION`, and no "resubmit as operator"
   laundering. In P8B a HUMAN adoption is recorded as an adoption binding and an activation bound to the model
   candidate; the origin column never changes (the existing transition guard already refuses it).
4. `proposed_by_task` is set to the reflection task, with a same-tenant composite foreign key (section 23), so
   provenance is a foreign key, not a claim. A new trigger requires a `MODEL_PROPOSAL` candidate's task to be a
   `REFLECT` task of recipe `identity-reflection/v1`.
5. **The candidate document** is computed by the kernel: the head document plus the single structured edit. It is
   validated by `IdentityDocumentDraft` and screened for secrets. The database computes the class and base. Stale
   protection is the P7A compare-and-swap; P8 adds nothing weaker.
6. **Conditions for creating the candidate (P8A-2):**
   - reflection mode is `PROPOSE_IDENTITY`;
   - the proposal is eligible under section 6.2 (`SUPPORT`, no concerns, every kernel check);
   - base equals head;
   - the caps hold.
   Otherwise the proposal is recorded `INELIGIBLE` with a reason code.
7. **No version without adoption.** The P8A-0 migration replaces `identity_version_guard` so that a version whose
   candidate has origin `MODEL_PROPOSAL` or `SHARED_BRAIN` is refused outright. This closes context fact 4 before
   any model candidate exists: in P8A a model candidate cannot produce a version, so it cannot move `identity_head`.
   P8B relaxes this for `MODEL_PROPOSAL` only, and only through the adoption binding (section 18).
8. **Class A proposals** may become HELD candidates. Their adoption is HUMAN-approved only, in P8B and forever.
9. **`SHARED_BRAIN` origin stays never-approvable**, mechanically (section 18.1). P8 does not create such candidates.

## 11. Deduplication, replay and idempotency

- **`proposal_key`** = sha256 of the canonical JSON of `{contract: "kerneljson:reflection-proposal-key/v1", tenant,
  identity, base_version, base_identity_core_digest, kind, path, op, normalised value}`. It is UNIQUE per tenant.
- **`observation_key`** = sha256 of `{contract: "kerneljson:self-model-key/v1", tenant, identity, origin, kind,
  canonical scope, normalised claim}`. It is UNIQUE per tenant.
- **A repeat with the same key does not mint a new record.** The record step returns the existing one and appends
  one immutable row to **`public.reflection_support`**. Immutable content is never mutated. This applies to rejected
  proposals too, so a repeatedly rejected idea cannot respawn.
- **Support is bounded.** `reflection_support` has `unique (subject_id, reflection_task_id)`: at most one support row
  per subject per reflection task. Its row id is deterministic from that pair. Only `REFLECT` tasks write support, so
  support growth for any subject is bounded by the admitted-reflection quota: at most 6 rows per tenant per rolling
  24 hours across all subjects.
- **Replay.** Ids are deterministic (task, step, ordinal), and the record step runs in one `ctx.run` and one database
  transaction under an advisory lock on the reflection task. A replay or lost journal re-executes to the same rows
  (`on conflict do nothing` plus digest comparison; a mismatch refuses). A replay therefore appends no second support
  row: the unique key absorbs it.

## 12. Rate limits and spam

Every limit is enforced by the database, by the named mechanism. None is a workflow-held counter.

| Limit | Value | Mechanism |
|---|---|---|
| `REFLECT` tasks admitted per tenant per rolling 24h | 6 | reservation trigger under a per-tenant advisory lock, in the admission transaction, plus the deferred admission constraint (section 5.4) |
| proposals per reflection task | 3 | insert trigger counting rows for the task, under the task advisory lock |
| observations per reflection task | 3 | the same |
| support rows per subject per reflection task | 1 | unique key |
| model candidates per reflection task | 1 | unique partial index |
| undisposed proposals per tenant on the current head | 20 | insert trigger under a per-tenant lock |
| HELD `MODEL_PROPOSAL` candidates per identity on the current head | 3 | insert trigger under the identity-version lock |

- **Stale records do not consume slots** in the last two rows. Stale means the base is not head (section 13). So a
  HEAD change can never deadlock those caps. Admission reservations are never released early.
- **Over a record cap**, the deterministic refusal records `INELIGIBLE (CAP)`. Over the admission quota, the request
  is refused before admission and nothing is recorded.
- The existing **3 APPLIED C/D activations per rolling 24h** is separate and unchanged.

## 13. Stale proposals

- Every identity-related proposal and candidate binds `base_version_id`, `base_identity_version` and
  `base_identity_core_digest` at creation.
- **Stale** means the base is not the current head. It is computed in a view, never written as a mutation.
- A stale proposal cannot become a candidate (`INELIGIBLE (STALE)`).
- A stale candidate cannot be adopted: section 18.4.
- The remedy is a new reflection against the new head. A proposal is never rebased or merged, and an approval is
  never rebound.

## 14. Post-change observation and rollback recommendation

- After a P8B adoption, Mission Control shows the activation as **unreviewed** until the owner requests a
  `POST_CHANGE` reflection. It stays HUMAN-requested; nothing schedules it.
- That reflection's qualified packet compares missions pinned to the new version against the prior version, using
  deterministic counts (verifier verdicts, reconcile decisions). The packet must state, for each side: the sample
  count, the task mix by recipe, and the provider and model distribution. A difference in any of these is a labelled
  packet fact, so the comparison is never presented as like-for-like when it is not.
- **It records comparative observations, not causal truth.** The contract has no kind and no code that asserts
  "the identity change caused X". Until a future evaluation contract can establish causation, no P8 record states it.
- **Allowed outcomes:** Class E observations, a `ROLLBACK_RECOMMENDATION` proposal, and the health signal
  `reflection.adoptedChangeUnreviewed`.
- **The 14 days in that health signal is an alerting default only.** It authorises nothing, expires nothing, and no
  guard reads it.
- **No automatic rollback, ever.** A rollback is a HUMAN `identity-change/v1` `ROLLBACK` through the existing approval
  rules. A recommendation is a structured record with evidence references.

## 15. Evidence, provenance and secrets (B-EV)

### 15.1 Reflection has its own evidence contract

P8 reflection does **not** copy raw reflecting or evaluating model output into immutable runtime evidence. This is a
deliberate difference from mission runtime evidence, which keeps output text today. The reflection contract is
`kerneljson:reflection-model-evidence/v1`.

| Durable P8 runtime evidence may store | It must never store |
|---|---|
| `call_id` | raw model prose |
| provider and model provenance (pinned and provider-reported) | the raw provider response body |
| `request_digest` | the prompt |
| the cognitive assembly digest | the messages |
| the structured-result digest | memory text |
| contract name and version | identity document text |
| the ids of the parsed records, and factual enumeration results (verdicts, concerns, refusal codes) | unparsed model output |

The two model calls still get D1-style `MODEL_CALLED` digest bindings, so provenance matches missions. The ledger's
completion check for this recipe verifies those bindings and the structured-result digest, and refuses reflection
evidence that carries any text field outside the contract.

### 15.2 The Restate journal is not P8 evidence

Restate retains the provider result inside its durable execution journal under the existing execution contract, in
the same way that P7B journals the request. That journal is execution state with its own retention. **P8 creates no
additional immutable copy of it**: not in `evidence`, not in `task_events`, not in any P8 table.

### 15.3 What becomes canonical P8 state

The proposed field `value` and the SelfModelObservation `claim` are the only model-authored text P8 stores. Each
becomes canonical P8 state only after, in order: strict parse, allow-list validation, size bound, secret scan,
independent evaluation and kernel classification. It is stored once, in its own table, and no second copy is added to
runtime evidence (evidence holds the record id and digest).

### 15.4 Memory and P5 retraction

- P8 stores memory **references and digests** as provenance (assembly id, assembly digest, memory ids), never a copied
  memory source excerpt.
- A derived proposal or observation is its own governed canonical claim, not a clone of a memory.
- **Deterministic excerpt guard.** At `REFLECT_RECORD` the kernel compares each `value` and `claim` with the content
  of every memory item in the journaled assembly, after whitespace and case normalisation. A shared contiguous run of
  40 or more characters makes the record `INELIGIBLE (MEMORY_EXCERPT)`; it is recorded without that text reaching a
  candidate or CURRENT. The memory text is compared in process and is not persisted by the check.
- There is no rationale text, so a quoted excerpt cannot be persisted as rationale.
- If a cited memory is later retracted under P5, the P8 record is not altered. Mission Control derives and shows
  "cites a retracted memory" from the stored references, and the owner may dismiss or correct. This has no authority.

### 15.5 Packet and provenance

- **Packet entries** are references to canonical evidence: task id, evidence id, digest and a factual code.
  - Sources are COMPLETED or FAILED tasks of the same tenant, each re-verified through the existing pure completion
    seams.
  - Operator feedback is cited through the reflection task's own contract digest.
- **Every proposal and observation proves:** tenant, identity, source admitted task, packet refs, base version,
  proposer type, evaluator call binding, disposition, timestamps and content digest. A provider conversation is never
  canonical state; only kernel-parsed structured outputs are.

### 15.6 Secrets

- Operator text is scanned before admission (section 5.3), which is the canonical first defence.
- Model-authored `value` and `claim` are scanned before any record is written (section 6.2).
- The kernel-computed candidate document is scanned before the candidate insert.
- All three use the one scanner module. Credentials, tokens, database URLs, signing material and provider bodies
  never enter P8 state.

## 16. Structural fences (transitive runtime-import test, like ADR-0022 section 6)

- **Modules:** `services/kernel/src/reflection/**`, with `self-model.ts` holding Class E and `evaluate.ts` holding the
  evaluator request builder.
- **Forbidden importers of `reflection/**`:**
  - the gateway (admission), except the pure request contract in `packages/contracts`;
  - `scheduler/**`;
  - `faculty/**` (routing and registry);
  - `policy.ts` and `approval-*`;
  - `services/memory/**` (promotion authority);
  - `ledger.ts` (completion authority), except a pure reflection completion verifier with no write path;
  - `identity/projection.ts`, `identity/cognition-binding.ts`, `mission/analyst-assembly.ts` and `mission/prompts.ts`;
  - `identity-workflow.ts`, except for the one narrow pure contract module `reflection/adoption-contract.ts` in P8B.
- **Inverse fence:** `reflection/**` may not import faculty routing or registry write paths, memory write paths,
  approval decision code, or the P7B projection or assembler. `reflection/evaluate.ts` may not import the memory port
  at all.
- **Class E:** `reflection/self-model.ts` and the `self_model_current` view may be consumed only by the reflection
  workflow, health and Mission Control read paths.
- **Mutations** inject forbidden imports into faculty policy, the scheduler, the gateway, the ledger, the P7B
  assembler, the memory service and the evaluator builder (a memory-port import); each must be killed. A surviving
  mutation fails qualification.

## 17. Freeze, windows and precedence

### 17.1 Reflection mode (P8A)

`kernel_private.reflection_governance` is an append-only event table (one row per change) holding `tenant_id`,
`mode`, `set_by`, `reason` and `at`. The current mode is the latest row; no row means `DISABLED`.

| Mode | New `REFLECT` admissions | New proposals and model observations | New model candidates | `DISMISS`, `CORRECT`, `FREEZE` |
|---|---|---|---|---|
| `DISABLED` | refused | refused by insert triggers | refused | **allowed** |
| `OBSERVE` | allowed | allowed | refused | allowed |
| `PROPOSE_IDENTITY` | allowed | allowed | allowed (HELD only) | allowed |

- **Raising** the mode is deployment authority only: a function run in an authorised change window.
- **Lowering** to `DISABLED` is also available to the HUMAN owner through a `FREEZE` task, because freezing is safe.
- **The insert trigger refuses any non-`DISABLED` row** unless the deployment function inserts it, recognised by a
  transaction-local setting that only that function sets. While the worker is `postgres` this stops a code path, not
  a determined worker; see B1 (section 22).
- **When the mode becomes `DISABLED`:**
  - an in-flight reflection fails closed at `REFLECT_RECORD` with evidence;
  - pending proposals and HELD candidates stay as they are, auditable;
  - `DISMISS` and `CORRECT` still work;
  - normal cognition, the current identity, existing tasks and HUMAN emergency rollback are unaffected.

### 17.2 Growth windows (P8B): two immutable tables (B-GW)

No row is ever updated. Both tables reject update, delete and truncate through `reject_ledger_mutation`.

**`kernel_private.identity_growth_windows`, the OPEN record:**

| Column | Rule |
|---|---|
| `window_id` | primary key |
| `tenant_id`, `identity_id` | composite foreign key to `identity_profiles(id, tenant_id)` |
| `authorisation_ref` | the change-window record and the HUMAN authorisation; not null |
| `reason` | not null |
| `opened_at` | set by the trigger to `clock_timestamp()`; a caller value is overwritten |
| `expires_at` | `check (expires_at > opened_at)` and `check (expires_at <= opened_at + interval '7 days')` |

**`kernel_private.identity_growth_window_closures`, the CLOSE record:**

| Column | Rule |
|---|---|
| `window_id` | primary key, so a window has at most one closure |
| `tenant_id`, `identity_id` | composite foreign key `(window_id, tenant_id, identity_id)` to the window's unique key |
| `closed_by_kind` | `HUMAN_OWNER` or `DEPLOYMENT` |
| `close_task_id` | for `HUMAN_OWNER`: the `FREEZE` task, composite foreign key to `tasks(id, tenant_id)`; null for `DEPLOYMENT` |
| `request_ref` | the idempotency reference of the close request; not null |
| `reason` | not null |
| `closed_at` | set by the trigger to `clock_timestamp()` |

**Effective window.** At an evaluation instant `t`, a window is effective for an identity if and only if:
- an OPEN row exists for that identity;
- `t >= opened_at`;
- `t < expires_at`;
- no closure row exists for its `window_id`.

`t` is `clock_timestamp()` read inside the evaluating trigger **after** it has taken the lock below. It is not
`now()`, which is transaction start time and would let a long transaction act after expiry.

**One lock for everything.** OPEN, CLOSE and activation all take the same per-identity advisory transaction lock,
the key `identity_activation_guard` already uses: `hashtextextended(identity_id::text || ':identity-activation', 0)`.
Each of the three triggers refuses unless the transaction isolation is READ COMMITTED, so the reads after the lock see
every committed open and close.

**OPEN** (BEFORE INSERT trigger): take the lock; set `opened_at`; if any effective window exists for the identity at
`opened_at`, refuse `GROWTH_WINDOW_ALREADY_OPEN`. Because every open for an identity serialises on the lock, there is
at most one effective, non-expired, unclosed window per identity. Opening is deployment authority only.

**CLOSE** (BEFORE INSERT trigger): take the lock; set `closed_at`.
- If no closure exists, insert it. Closing a window that has already expired is permitted and changes nothing.
- If a closure exists with the same `closed_by_kind`, `close_task_id` and `request_ref`, the close function returns
  the existing row (idempotent replay).
- If a closure exists with any different value, refuse `GROWTH_WINDOW_ALREADY_CLOSED`.

Closing is available to deployment authority and to the HUMAN owner through `FREEZE`. In P8B a `FREEZE` task writes
the `DISABLED` mode row and closes any effective window in one transaction.

**Expiry needs no write.** An expired window is simply not effective.

**A window opening is not an approval and grants no task authority.** It creates no task, changes no candidate and
activates nothing. It is one of several facts the activation guard requires.

### 17.3 One precedence, one "unfrozen" truth

Evaluated in this order; the first refusal wins:

1. **Reflection mode `DISABLED`** prevents new reflection records and candidates, and (section 18.2) refuses a
   model-origin adoption binding. Emergency rollback is not affected.
2. **Class C/D activation keeps the P7 rules:** the policy decision, the approval where required, the Class A byte
   identity, and the 3-per-24h cap.
3. **In P8B the replaced activation guard treats an effective growth window as the only authorised exception for
   Class C/D forward growth**, for every origin. Without one, a C/D activation is refused.
4. **A close or an expiry removes that exception for every later activation transaction.** The window is evaluated
   inside the activation transaction, under the shared lock, at `clock_timestamp()`.
5. **HUMAN emergency rollback stays available** under the existing rollback exception (governance class `ROLLBACK`,
   HUMAN approval), with or without a window and whatever the mode.

To leave exactly one truth, the P8B migration:
- replaces the guard function so that it no longer reads `kernel_private.identity_governance_state`;
- replaces `kernel_private.set_identity_freeze` with a function that always raises `IDENTITY_FREEZE_RETIRED`, so
  `set_identity_freeze(..., false)` can no longer authorise C/D growth;
- asserts at apply time that no governance row with `frozen = false` exists, and fails the migration if one does.

It is a new migration. The applied P7A migration file is never edited.

| Adoption | HUMAN approval | Effective growth window |
|---|---|---|
| Class A model candidate | required | **not required** |
| Class C or D model candidate | required | **required** |
| Class C or D operator candidate (after the P8B migration) | per the existing P7 policy path | required |

## 18. P8B adoption mechanics (B-CHK)

A Postgres CHECK constraint cannot contain a subquery, so it cannot consult ApprovalStore. The rule is therefore two
layers: a static CHECK for what is never legal, and a trigger plus an immutable binding row for what is conditionally
legal.

### 18.1 Layer A: static origin and state CHECK

A new migration drops the P7A constraint `origin = 'OPERATOR_INSTRUCTION' or state in ('HELD','REJECTED')` and adds an
exact static allow-list:

```
check (
  (origin = 'OPERATOR_INSTRUCTION' and state in ('HELD','APPROVED','REJECTED','APPLIED'))
  or (origin = 'MODEL_PROPOSAL'     and state in ('HELD','REJECTED','APPROVED'))
  or (origin = 'SHARED_BRAIN'       and state in ('HELD','REJECTED'))
)
```

- The operator row is the existing legal set, unchanged.
- `SHARED_BRAIN` is mechanically incapable of `APPROVED`: no approval row, binding row or trigger can change that,
  because the CHECK is evaluated on every row regardless.
- `MODEL_PROPOSAL` gains `APPROVED` as a legal value only. Whether a given transition to it is allowed is Layer B.

### 18.2 Layer B: adoption binding and transition trigger

**Immutable `kernel_private.identity_model_adoptions`:**

| Column | Rule |
|---|---|
| `candidate_id` | **primary key**: one adoption binding per candidate, ever |
| `tenant_id`, `identity_id` | composite foreign keys to the candidate and the profile (section 23) |
| `adopt_task_id` | unique; composite foreign key to `tasks(id, tenant_id)` |
| `approval_id` | unique; composite foreign key `(approval_id, adopt_task_id)` to `approvals(id, task_id)` |
| `proposed_digest` | the candidate's `proposed_digest`, copied by the trigger; this is the approval's bound target |
| `human_actor` | the ADOPT task's principal, copied by the trigger |
| `base_identity_version`, `base_identity_core_digest` | copied from the candidate by the trigger |
| `adoption_xact` | `pg_current_xact_id()`, set by the trigger |
| `created_at` | `clock_timestamp()`, set by the trigger |

**BEFORE INSERT trigger on the binding.** It takes the identity-version lock, then proves every item from real rows
and refuses on the first failure:

1. the candidate exists in the same tenant, its origin is `MODEL_PROPOSAL` and its state is `HELD`;
2. the ADOPT task's admission has recipe `identity-change/v1` and objective kind `ADOPT` naming this `candidateId`;
3. the task's principal is a HUMAN and equals the identity's `owner_principal_id`, with ACTIVE membership;
4. the approval belongs to that task and its status is `GRANTED`;
5. the approval is bound to this exact candidate, digest and gate: the task's immutable `POLICY_CHECKED` event with
   key `policy-approval:<approval_id>` has invocation input `candidateId` equal to the candidate and
   `identityCoreDigest` equal to `proposed_digest`, capability id equal to the class-specific
   `IDENTITY_ADOPT_MODEL_A`, `_C` or `_D` gate, and decision `APPROVAL_REQUIRED` (the same proof shape the P7A
   activation guard uses, with the new gates);
6. the candidate's `base_version` and `base_identity_core_digest` equal the current `identity_head`;
7. the reflection mode is not `DISABLED`;
8. no disposition exists for the candidate (it has not been dismissed).

Uniqueness of `candidate_id`, `adopt_task_id` and `approval_id` is enforced by the keys.

**Transition trigger** (the replaced `identity_candidate_transition_guard`):
- `MODEL_PROPOSAL`, HELD to APPROVED: permitted only if a binding row for the candidate exists with
  `adoption_xact = pg_current_xact_id()`. A direct `UPDATE` without a binding written in the same transaction is
  refused `MODEL_ADOPTION_BINDING_REQUIRED`.
- `MODEL_PROPOSAL`, HELD to REJECTED: only with a same-transaction `DISMISSED` disposition (section 8).
- `SHARED_BRAIN` to APPROVED: refused by the trigger as well as by the CHECK, whatever approval rows exist.
- Operator transitions: unchanged.

**Deferred constraint trigger on the binding**, checked at COMMIT: the candidate is `APPROVED`, and an
`identity_activations` row exists for the candidate whose `request_task_id` is the binding's `adopt_task_id`.
A transaction that writes a binding but does not complete the whole adoption cannot commit.

**Version guard** (replaced again in the P8B migration): a version for a `MODEL_PROPOSAL` candidate must be created
by the binding's `adopt_task_id`. Versions for `SHARED_BRAIN` candidates stay refused.

**Activation guard** (replaced in the P8B migration): for a `MODEL_PROPOSAL` candidate, at every class, it requires
state `APPROVED`, a non-null `approval_id` equal to the binding's, `request_task_id` equal to the binding's
`adopt_task_id`, and the class-specific ADOPT gate. For Class C/D from any origin it requires an effective growth
window (section 17.2). The 3-per-24h C/D cap and the Class A byte-identity rule are unchanged.

The three gates `IDENTITY_ADOPT_MODEL_A`, `_C` and `_D` are new capability ids, distinct from `IDENTITY_APPLY_*`,
fixed in `packages/capabilities` and in the migration. Production policy has them as `APPROVAL_REQUIRED` only.

### 18.3 One writer path

The only application-level writer is `identity-change/v1` with the new kind `ADOPT { candidateId, reason }`:

1. the door admits a HUMAN owner task normally (sections 5.2 and 5.3 apply to `ADOPT`);
2. the workflow resolves the existing `MODEL_PROPOSAL` candidate in the task's tenant;
3. it proves the candidate is HELD and not stale; if not, the task fails and nothing changes;
4. it obtains the approval through the existing ApprovalStore flow, bound to the candidate id, the proposed digest
   and this task, under the class-specific gate;
5. in **one** governed database transaction (the existing D8 completion transaction, extended) it writes the
   adoption binding;
6. it transitions the candidate HELD to APPROVED, under the trigger;
7. it creates the new identity version;
8. it activates the version under the existing D8 atomic completion contract;
9. it completes the ADOPT task, atomically with steps 5 to 8.

For Class C/D the activation in step 8 also proves an effective growth window, inside that same transaction.

Lock order in that transaction is fixed: task, then identity-version, then identity-activation. Window OPEN and CLOSE
take only the identity-activation lock, so no lock cycle exists.

No other workflow, API, Telegram command or SQL helper is an application-level writer. And none of these changes
candidate state on its own:
- a GRANTED approval;
- an open growth window;
- an acknowledged or supportive reflection proposal;
- a supportive evaluation.

### 18.4 Approval replay and staleness

- An approval is not sufficient if the head moved after it was granted. Binding item 6 re-checks the base against
  the head inside the adoption transaction, under the identity-version lock; `identity_version_guard` re-checks it
  again on the version insert.
- If the head has moved: the transaction fails, the candidate stays HELD (and is now stale), the ADOPT task fails, and
  the approval is spent on a failed task. A new reflection and a new proposal are required.
- **No approval rebinding.** An approval names one candidate id, one digest and one task; nothing rewrites that.
- **One candidate cannot be adopted by two ADOPT tasks.** `candidate_id` is the binding's primary key. Of two
  concurrent ADOPT transactions, both serialise on the identity-version lock; the first commits; the second fails
  item 1 (the candidate is no longer HELD) or the primary key.

## 19. Rollout

The authoritative sequence is `docs/operations/KJ_P8_IMPLEMENTATION_SEQUENCE.md`. In summary:

**P8A-0: substrate, feature off.** Implementation and deployment; no live reflection and no model call.
- Contracts and schema: the reflection tables, evaluations, dispositions, support, Class E table and the
  `self_model_current` view.
- The atomic admission reservation and quota (section 5.4), and the neutral scanner module with the pure
  pre-admission function (section 5.3).
- The reflection governance mode, default `DISABLED`.
- The candidate unique index and cap triggers, the replaced version and transition guards (sections 8 and 10), the
  composite keys of section 23, health rows, fences and the mutation harness.
- The door does **not** accept the recipe.

**B2: Class B faculty-version review** (section 6.4), before P8A-1.

**P8A-1: reflecting cognition, records only.** A separate authorisation. The HUMAN-owner door route opens; mode
`OBSERVE`; bounded reflector and evaluator; no raw model output in evidence.

**P8A-2: HELD model candidates.** A separate authorisation; mode `PROPOSE_IDENTITY`. A `MODEL_PROPOSAL` still cannot
be approved (the P7A CHECK is unchanged), cannot produce a version (section 10 item 7) and cannot be activated.

**B1: dedicated least-privilege worker database role**, with full P1 to P7 requalification (section 22).

**P8B: controlled growth.** A separate ADR addendum, its own hostile review and explicit HUMAN authorisation; never
before B1. The adoption binding, the static CHECK revision, the dynamic approval trigger, the two growth-window
tables, the `ADOPT` workflow and controlled activation. **There is no auto-adoption at any class.**

## 20. Acceptance gates

**P8A-0** (qualification, no production reflection):
1. Two concurrent `REFLECT` admissions at 5 of 6 against real Postgres: exactly one admitted, in both orderings.
2. Six admitted tasks that all FAIL still refuse a seventh.
3. A replayed idempotency key consumes no second slot.
4. A secret-shaped `operatorFeedback`, `reason` and `correction` are each refused with zero rows in
   `execution_bindings`, `task_admissions`, reservations, dispatch events and `tasks`, and the refused text appears
   in no log.
5. A version insert for a `MODEL_PROPOSAL` candidate is refused.
6. Every check has a negative case that fails on purpose, in the same change.

**P8A-1 and P8A-2** (live, with production mode raised in its window):
1. An admitted reflection task completes normally; a non-owner HUMAN is refused before admission.
2. The identity is read and unchanged (versions, activations and head digests are identical before and after).
3. Exactly the bounded records are produced.
4. Each binds the base version and digest.
5. Each cites qualified packet entries.
6. The verifier evaluates each on a different effective model; a forced same-model route fails closed.
7. A SelfModelObservation is recorded, with faculty pins, routes, `providerPreferences` and policy byte-identical
   before and after.
8. Runtime evidence for both calls contains no model text (a search for the journaled output in `evidence` and
   `task_events` finds nothing).
9. A HELD `MODEL_PROPOSAL` candidate exists (P8A-2).
10. No activation occurs, and no version exists for the candidate.
11. Class C/D is still frozen.
12. A replay creates no duplicate and no second support row; a repeat by a new task appends exactly one support row.
13. A HEAD change makes the record stale, and conversion is refused.
14. A dismissed or ineligible record remains auditable; a `CORRECT` succeeds while `DISABLED` and outranks the model
    observation.
15. No Shared Brain access occurs: no connector, no credential, no request.
16. No task is self-generated: the task count delta equals the admitted requests.
17. Health is clean, with NO_OBSERVATION where expected.

**P8B:**
1. B1 is closed: the worker is not `postgres`, and it cannot execute the mode-raise or window-open functions.
2. Explicit HUMAN authorisation is recorded.
3. One approved C or D model candidate is adopted through `ADOPT`, inside an effective window.
4. A direct `UPDATE` of a model candidate to APPROVED is refused; a `SHARED_BRAIN` candidate cannot be APPROVED.
5. The 3-per-24h cap is still effective (a fourth is refused).
6. D8 atomicity holds: a failure at any step leaves no binding, no APPROVED state, no version and no activation.
7. The prior version can still be rolled back.
8. Two simultaneous window opens yield one window; a close racing an activation yields either a completed adoption
   before the close or a refusal after it, never both; an expired window refuses.
9. An approval followed by a head change refuses, and the candidate stays HELD.
10. A second ADOPT task for the same candidate is refused.
11. A `POST_CHANGE` reflection is recorded, with sample and mix differences stated.
12. There is no authority expansion (the policy, faculty and route diff is empty).
13. Class A bytes are unchanged for a C/D adoption.
14. G5 provider continuity still holds on the new version.

## 21. Health and alerting (explicit rows only, no fallback)

| Check | Invariant | Severity |
|---|---|---|
| `reflection.modelApprovalBound` | every `MODEL_PROPOSAL` candidate in `APPROVED` has exactly one valid adoption binding (owner HUMAN, GRANTED approval, matching digest and gate) | **P0** |
| `reflection.sharedBrainNeverApproved` | no `SHARED_BRAIN` candidate is in `APPROVED` or `APPLIED` | **P0** |
| `reflection.modelActivationGoverned` | every activation of a `MODEL_PROPOSAL` candidate has the binding's approval and task | **P0** |
| `reflection.modelGrowthInsideWindow` | every C/D activation of a `MODEL_PROPOSAL` candidate fell inside a window that was effective at `activated_at` | **P0** |
| `reflection.recordsBoundToReflectionTasks` | every proposal, observation, support row and model candidate references a task of recipe `identity-reflection/v1` in the same tenant | **P0** |
| `reflection.noModelVersionWithoutAdoption` | no identity version exists for a `MODEL_PROPOSAL` candidate without a binding, and none for `SHARED_BRAIN` | **P0** |
| `reflection.admissionQuotaHonoured` | no tenant has more than 6 reservations in any rolling 24h, and every `REFLECT` admission has a reservation | P1 |
| `reflection.recordCapsHonoured` | per-task, per-tenant and per-identity caps of section 12 hold | P1 |
| `reflection.oneEffectiveWindow` | at most one effective growth window per identity | P1 |
| `reflection.noDuplicateRecordKeys` | keys are unique; at most one support row per subject and task | P2 |
| `reflection.recordsHaveEvidence` | every record has 1 or more qualified refs, and a CURRENT model observation has a supportive evaluation | P2 |
| `reflection.evidenceCarriesNoModelText` | reflection runtime evidence matches the section 15.1 contract | P2 |
| `reflection.adoptedChangeUnreviewed` | no adopted model change older than the alerting default (14 days) without a `POST_CHANGE` reflection | P3, notified |

- The P0 and P1 rows are detection behind database prevention; each also has a database constraint or trigger.
- A Class E behavioural-consumer or topology breach is a **qualification failure** in CI (section 16). It is not
  left to runtime health.
- NO_OBSERVATION (mode `DISABLED`, or no records) is UNKNOWN at P3 and silent, as in ADR-0022.
- UNKNOWN because the database is unreachable is P3 and silent: the database domain owns reachability.
- A silent UNKNOWN recovers silently.
- Every check ships with a selftest fixture that makes it fail on purpose.

## 22. Threat model, adversarial answers and self-review

### 22.1 Adversarial questions (deterministic answers)

1. **Canonical state without a task?** No. Every record row has a same-tenant composite foreign key to a reflection
   task, and `recordsBoundToReflectionTasks` is P0.
2. **Can it create a task?** No. There is no admission path from `reflection/**` (fence), and the plan has no
   task-minting step.
3. **Can it approve itself?** No. Approvals are HUMAN decisions through ApprovalStore; reflection imports no approval
   code; the binding trigger requires a HUMAN owner task.
4. **Can it activate its own candidate?** No. In P8A the database forbids approval (P7A CHECK) and any version
   (section 10 item 7). In P8B it needs a HUMAN ADOPT task, a GRANTED bound approval, the binding and, for C/D, an
   effective window.
5. **Can it mutate Class A?** Only as a HELD candidate. Adoption is always HUMAN-approved, and the class is computed by
   the database.
6. **Can it route to another provider?** No. Class E has no consumer, the routing table is static, and the fence
   enforces it.
7. **Can it read more memory?** No. The faculty memory ceiling applies unchanged, and the evaluator gets none.
8. **Can Class E alter the P7B projection?** No. It is not in the identity document, and the fence keeps it out of the
   assembler.
9. **Can a stale proposal apply?** No. Sections 13 and 18.4.
10. **Can replay duplicate?** No. Deterministic ids, unique keys and the support unique key.
11. **Can rejected records disappear?** No. They are immutable and recorded as dispositions.
12. **Can model origin become operator origin?** No. Nothing writes the origin, and the transition guard refuses it.
13. **Can secrets be embedded?** Operator text is refused before admission; model text before any record.
14. **Can a Class D aspiration schedule work?** No. Identity has no import into the scheduler or admission, and
    objectives are text only.
15. **Can it write to the Shared Brain?** No. There is no connector, credential or code.
16. **Can it bypass the C/D freeze?** No. P8A changes no activation guard; P8B needs an effective window.
17. **Who opens a growth window?** Deployment authority in an authorised change window, naming the HUMAN
    authorisation, and only after B1.
18. **How is an opening audited?** An immutable OPEN row, plus release-window evidence.
19. **How does the human freeze immediately?** A `FREEZE` task: it writes `DISABLED` and, in P8B, closes any effective
    window. Both take effect for the next transaction.
20. **What happens to pending records when frozen?** They are retained and auditable. They cannot be converted or
    adopted, and can still be dismissed or corrected.

### 22.2 Self-review of revision 2: seventeen attacks

| # | Attack | Result | Why |
|---|---|---|---|
| 1 | two concurrent reflection admissions at count 5 | exactly one admitted | per-tenant advisory lock in the reservation trigger; the loser counts with a fresh snapshot after the lock (section 5.4) |
| 2 | fail tasks on purpose to recover quota | no recovery | a reservation is immutable and counts for 24h whatever the task's outcome |
| 3 | secret in `operatorFeedback` | refused before admission; nothing stored | the scan is step 6, admission is step 9 (section 5.3) |
| 4 | reflector quotes memory into runtime evidence | impossible; and blocked from records | evidence holds digests and ids only (15.1); no rationale text; excerpt guard on `value` and `claim` (15.4) |
| 5 | two simultaneous window opens | one opens, one refused | both serialise on the identity-activation lock; the second sees an effective window |
| 6 | window close racing activation | one clean outcome | same lock; the guard evaluates the window after the lock at `clock_timestamp()` |
| 7 | window expires during ADOPT | refused if expired at guard evaluation | the window is evaluated inside the activation transaction, not at approval time |
| 8 | direct `UPDATE` of a model candidate to APPROVED | refused | the transition trigger needs a same-transaction binding; the binding needs the full proof; the deferred constraint needs the activation |
| 9 | approve a `SHARED_BRAIN` candidate | refused | static CHECK and trigger |
| 10 | approval, then the head changes | refused; candidate stays HELD | binding item 6 and the version guard compare base with head under the lock; no rebinding |
| 11 | two ADOPT tasks for one candidate | second refused | binding primary key on `candidate_id`; candidate no longer HELD |
| 12 | `REFLECT_EVALUATE` receives memory | refused at pin; nothing to pass | operation on the verifier-isolated allow-list; builder has no memory port; fence and mutation |
| 13 | fallback makes the evaluator the reflector's model | task fails closed, no record | receipts compared with `sameModel` before and after the call (section 6.5) |
| 14 | model observation overrides a HUMAN correction | cannot become CURRENT | derivation rule 1; kernel disposition `OPERATOR_CORRECTED_SCOPE` |
| 15 | replay appends duplicate support | absorbed | `unique (subject_id, reflection_task_id)` and a deterministic id |
| 16 | worker as `postgres` in P8A | residual accepted, bounded and stated | B1 below |
| 17 | worker as `postgres` in P8B | not permitted | P8B cannot be implemented or deployed before B1 |

**Findings of this self-review that changed the design:**
- A model candidate could have produced an identity version, moving `identity_head`, without activation
  (context fact 4). Fixed in P8A-0 by section 10 item 7.
- Quota on every reflection recipe request would have let an exhausted budget refuse a freeze or a correction.
  Fixed: only `REFLECT` consumes a slot (section 5.4). This narrows the phrase "every reflection task" to the kind
  that calls a model and writes records; it is stated here so the re-seal can reject it if unacceptable.
- The evaluator's `authority_impact` field in revision 1 let a model assert an authoritative value. Removed: the
  evaluator can only raise concerns, which only remove eligibility (section 6.2).
- Transaction start time would have let a long transaction act after a window expired. Fixed: `clock_timestamp()`
  after the lock (section 17.2).
- A count after an advisory lock is stale under REPEATABLE READ. Fixed: the triggers refuse any isolation other than
  READ COMMITTED (sections 5.4 and 17.2).

**Not verified in this revision (design only):** no trigger, lock or parser described here has been executed. The
READ COMMITTED snapshot behaviour inside triggers, the same-transaction id technique and the deferred constraint
triggers are INFERENCE from Postgres semantics and from existing patterns in this repository, and each is an
acceptance gate in section 20.

### 22.3 Blocking items

**B1: dedicated least-privilege worker database role. Blocks P8B. Does not block P8A.**

The residual, stated plainly: while the worker connects as the `postgres` owner, database privileges cannot prevent
malicious or defective worker code from raising the reflection mode or from writing advisory reflection state
directly. Triggers constrain the shape of what is written; they do not constrain who writes it.

P8A accepts this existing owner-role trust boundary only because:
- P8A cannot approve a `MODEL_PROPOSAL` (the P7A CHECK is unchanged);
- P8A cannot create a version for, or activate, a `MODEL_PROPOSAL` (section 10 item 7 and the P7A guard);
- the Class C/D freeze remains;
- reflection state has no behavioural consumer;
- health and topology checks provide detection.

Before P8B the dedicated role is **mandatory**. P8B cannot be implemented or deployed while the worker remains the
`postgres` owner. The role gets only the table privileges its writes need, and no EXECUTE on the mode-raise function,
the window-open function or any deployment function. The role migration must requalify every existing P1 to P7 worker
operation. B1 needs its own design and review.

**B2: Class B faculty-version change. Blocks P8A-1, by design.** Section 6.4. It is a separate review gate. This ADR
specifies what B2 must contain; it does not author the faculty versions.

## 23. Same-tenant references

No relationship in P8 is a bare UUID where a cross-tenant pair could pass. Each P8 table carries `tenant_id` and a
`unique (id, tenant_id)` key, and every reference is a composite foreign key.

| From | To | Composite key |
|---|---|---|
| `reflection_admission_reservations` | `task_admissions` | `(task_id, tenant_id)`; unique key added to `task_admissions` |
| `reflection_proposals` | `tasks`, `identity_profiles`, `identity_versions` (base) | `(reflection_task_id, tenant_id)`, `(identity_id, tenant_id)`, `(base_version_id, tenant_id)`; unique `(id, tenant_id)` added to `identity_versions` |
| `reflection_evaluations` | its subject, `tasks` | `(subject_id, tenant_id)`, `(reflection_task_id, tenant_id)` |
| `self_model_observations` | `tasks`, `identity_profiles`, the corrected observation | `(reflection_task_id, tenant_id)`, `(identity_id, tenant_id)`, `(corrects_id, tenant_id)` |
| `reflection_support` | its subject, `tasks` | `(subject_id, tenant_id)`, `(reflection_task_id, tenant_id)` |
| `reflection_dispositions` | its subject, the `DISPOSE` task, the linked candidate | `(subject_id, tenant_id)`, `(dispose_task_id, tenant_id)`, `(candidate_id, tenant_id)` |
| `identity_candidates` (model origin) | `tasks` | `(proposed_by_task, tenant_id)`; unique `(id, tenant_id)` added to `identity_candidates` |
| `identity_model_adoptions` | candidate, profile, ADOPT task, approval | `(candidate_id, tenant_id)`, `(identity_id, tenant_id)`, `(adopt_task_id, tenant_id)`, `(approval_id, adopt_task_id)`; unique `(id, task_id)` added to `approvals` |
| `identity_growth_windows` | `identity_profiles` | `(identity_id, tenant_id)` |
| `identity_growth_window_closures` | the window, the `FREEZE` task | `(window_id, tenant_id, identity_id)`, `(close_task_id, tenant_id)` |

`approvals` has no `tenant_id` column. Its tenant is proved transitively: the approval is tied to the ADOPT task by
`(approval_id, adopt_task_id)`, and the task to the tenant by `(adopt_task_id, tenant_id)`. Subject references that
can point at more than one table use one typed column per target, each with its own composite foreign key, and a
CHECK that exactly one is set. Every unique key added to an existing table is additive and arrives in a new
migration; no applied migration is edited.

## 24. Explicit non-goals

- auto-adoption at any class;
- adaptive routing;
- dynamic specialists and swarms;
- the Shared Brain (P9);
- P5 protected-promotion repair or any memory promotion;
- automatic reflection triggers;
- scheduler or admission authority changes beyond one catalogue entry and the pre-admission pipeline;
- Class B (faculty) changes beyond B2;
- autonomous goals;
- automatic rollback;
- causal claims about identity changes;
- reflection framing (no projection profile);
- unfreezing Class C/D in P8A;
- changing P7 request handling (`PROPOSE`, `ROLLBACK`).

## 25. Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Class E inside the identity document | breaks the proven P7 digests and projection (section 9) |
| a second identity-change store | two mutation authorities |
| converting adopted candidates to operator origin | laundering |
| model-computed confidence or eligibility | false precision; a model asserting an authoritative value |
| verifier verdict as approval | collusion risk; advisory only |
| quota checked in `REFLECT_QUALIFY` | after admission; races; not atomic (B-RL) |
| scanning operator text in the workflow first | the text is already immutable by then (B-SEC) |
| keeping model output text in reflection evidence | a second immutable copy of unparsed output, and of any memory it quotes (B-EV) |
| a `closed_at` column on the window row | not append-only (B-GW) |
| a CHECK constraint that consults approvals | not possible in Postgres (B-CHK) |
| isolation for "any verifier operation" | future operations would inherit permission without review (B-ISO) |
| a writable `ACTIVE` state on observations | reads as a permission bit |
| permanent C/D unfreeze, or a standing growth mode | drift by default (section 17) |
| automatic reflection triggers in v1 | autonomous task generation |
| a new "reflector" faculty | not needed; would bypass the P6 review |
| the Codex inbox as the architecture | no growth path; separate schema (section 3) |

## 26. Open questions

No authority-critical ambiguity is known to remain. Open, and not authority-critical:

- B1 and B2 are sequencing blockers with their own reviews (section 22.3).
- One narrowing for the re-seal to confirm: only `REFLECT` consumes an admission slot (section 22.2).
- RECOMMENDATION, out of scope here: apply the pre-admission scan to `identity-change/v1` `PROPOSE` and `ROLLBACK`
  under a separate authorisation (section 5.3).
- The exact text templates for Mission Control are implementation detail for P8A-1.
- The 14-day `POST_CHANGE` figure is a tunable alerting default with no authority.
- The complete text of the hostile review was not found on disk in this worktree, the main checkout or the
  new-system docs. Revision 2 was written against the binding blocker statements in the remediation brief.
