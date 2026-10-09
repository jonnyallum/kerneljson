# ADR-0023: Reflection, self-model and governed identity growth (KJ-P8)

Status: PROPOSED, revision 2.7.9 candidate (design only). Nothing here is implemented, migrated or deployed.
Date: 09/10/2026 (revisions 2.7.3 to 2.7.9). Revisions 2.7, 2.7.1 and 2.7.2 are dated 08/10/2026, revision 2.3 01/10/2026, revision
2.4 02/10/2026, revision 2.5 05/10/2026 and revision 2.6 06/10/2026.
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

Revision 2.1 is a further docs-only commit on top of revision 2 (`12580fd0b9c36f328c8868d8ddf4a2abcc44cb98`). It
corrects four defects the author found in revision 2 before the re-seal, and states one residual:

| Revision 2 defect | Corrected in |
|---|---|
| the support bound was stated as 6 rows per tenant per 24h; the true bound is 36 | section 11 |
| the memory excerpt guard left normalisation undefined, so two implementers would differ | section 15.4 |
| a record that hit the excerpt guard was still stored with its text as an `INELIGIBLE` row | section 15.4 |
| the adoption binding did not require the approval to be requested from the identity owner | section 18.2 item 4 |
| residual: expiry between the guard's check and commit | section 17.2 |

Revision 2.2 is a further docs-only commit on top of revision 2.1 (`90264f4e314313a4bb372ba4e1ea2522e1d1a5e4`). The
hostile re-seal of 2.1 closed the original six blockers and returned BLOCK on one new item:

| Blocker | Revision 2.1 defect | Resolved in |
|---|---|---|
| B-DEDUP-NORM | `proposal_key` and `observation_key` used "normalised value" and "normalised claim" without defining them, so two implementers would diverge on mint versus support and on rejected-key stickiness | section 11 |

While closing it the author found one further defect in 2.1: an owner correction whose text repeated an earlier
correction would have matched the earlier key and written no new row, so it could not become CURRENT. Corrections
are now never deduplicated (section 11.2).

Revision 2.3 is a further docs-only commit on top of revision 2.2 (`53f2ab011f0de627f3de97fd76d287b2beeb18c9`). The
independent hostile re-seal of 2.2 returned BLOCK. Revision 2.2 is not rewritten.

| Finding | Kind | Revision 2.2 defect | Resolved in |
|---|---|---|---|
| P8-R22-B1-LP | blocker | P8A was accepted in production while the worker ran as the `postgres` owner; the dedicated role was deferred to before P8B | section 27 (new), with sections 1, 2, 4, 17, 19, 20, 21, 22 and 26 and the sequence document made consistent |
| P8-R22-LIST-EDIT | blocker | `ADD_ITEM` and `REMOVE_ITEM` did not define how the candidate document is built, so two implementations could produce different bytes and digests | section 10.1 (new) |
| P8-R22-UNICODE-PIN | hardening | the key normalisation left the Unicode table version to the runtime | section 11.1 |
| P8-R22-SUPPORT-PROVENANCE | hardening | the support row was under-specified, so confidence could not be reconstructed from durable facts | sections 9.5 and 11.4 |

Two further changes were made by the author for determinism while closing these:
- the reflection mode can no longer be raised by a transaction-local setting, which any role can set; it is raised
  only through a function the runtime roles cannot execute (section 17.1);
- the `CONSISTENT` confidence class no longer depends on an undefined "contradicting task" (section 9.5).

Section 27 is new and is placed last so that no earlier section is renumbered.

Revision 2.4 is a narrow docs-only delta on top of revision 2.3. Revision 2.3
(`679e3a3dfc7a33f9106ed77913d49cdac19166d5`) was independently sealed APPROVE and is not rewritten.

**Trigger.** Implementing B1 under non-owner roles found a fact revision 2.3 did not model: the existing P1.3 trigger
function `kernel_private.stamp_binding_provenance()` performs a real `UPDATE` of `kernel_private.release_epoch`. As
`SECURITY INVOKER` it would force both runtime roles to hold a write that section 27.3 forbids. Changing a function
from invoker to definer is a security-authority change even when its body, signature, callers, stored values and
observable behaviour are unchanged, so it is resolved here in the design and not as an implementation erratum.

| Item | Revision 2.3 text | Resolved in |
|---|---|---|
| P8-R23-DEFINER | section 27.8 said B1 changes no P1 to P7 trigger, and section 27.4 described triggers as `security invoker`; neither can hold together with section 27.3 for this one function | section 27.9 (new), with sections 1, 20, 21, 26, 27.3, 27.4, 27.6 and 27.8 and the sequence document made consistent |

This does **not** invalidate the B1 least-privilege objective. It makes one previously implicit P1 to P7 capability
boundary explicit. Nothing else in the design changes: P8A-0, B2, reflection, Class E, model proposals, dedupe, the
Unicode pin, support provenance, growth windows, adoption, approval, the scheduler and the Shared Brain are untouched.

Revision 2.5 is a narrow docs-only delta on top of revision 2.4 (`8a17de18b26edd12a9f3af7ab6179552ff0cd20e`). The
independent hostile re-seal of 2.4 passed the section 27.9 exception itself and returned BLOCK on one item. Revision 2.4
is not rewritten.

| Finding | Revision 2.4 defect | Resolved in |
|---|---|---|
| P8-R24-B1 | sections 21, 27.6 step 2 and 27.9.4 required the `SECURITY DEFINER` functions to be only the section 27.9 exception, contradicting the definer functions sealed revision 2.3 already authorises at P8A-0 (`freeze_reflection`) and P8B (`close_growth_window_by_owner`); and the inventory scanned only `public` and `kernel_private`, while 27.9.2 requires the stamp function's name to be unique in any schema | section 27.10 (new, the single stage-aware inventory rule), with sections 17.1, 17.2, 20, 21, 26, 27.6, 27.9.2, 27.9.4 and 27.9.5 and the sequence document made consistent |

Revision 2.5's semantic changes are exactly three, all required by that repair:

1. **Stage-aware inventory.** At every rollout stage the complete `SECURITY DEFINER` inventory outside the excluded
   PostgreSQL schemas equals the frozen platform baseline together with the KernelJSON stage manifest for the stages
   applied so far (section 27.10). It is one rule, referenced by sections 20, 21, 27.6 and 27.9.4.
2. **Exact signatures of the two later definer functions.** Sealed revision 2.3 named them only by parameter names.
   Revision 2.5 pins them as new precision, not as something revision 2.3 already fixed:
   `kernel_private.freeze_reflection(task_id uuid) returns void`;
   `kernel_private.close_growth_window_by_owner(task_id uuid, window_id uuid) returns
   kernel_private.identity_growth_window_closures`; and `window_id` is `uuid` in both window tables (sections 17.1,
   17.2, 27.10.3). Rationale: `public.tasks.id` is `uuid`; sealed P8B behaviour returns the existing closure row on an
   idempotent replay; `freeze_reflection` has no return payload.
3. **Platform definers are inventoried, not ignored.** Definer functions in platform-owned schemas are not hidden by a
   guessed schema exclusion. A read-only catalogue snapshot taken before B1 freezes them as an explicit, reviewed
   baseline (section 27.10.4).

The catalogue, ACL, configuration, trigger-topology and negative-probe wording of sections 27.9.2, 27.9.4 and 27.9.5 is
tightened as hardening of the same boundary; it adds no authority. The section 27.9 decision, body, digest procedure,
owner, empty `search_path`, EXECUTE ACL, trigger topology, write ceiling, release authority and concurrency semantics
are unchanged. Reflection, Class E, proposals, dedupe, the Unicode pin, support provenance, growth-window behaviour,
adoption, approval, the scheduler, the Shared Brain and the rollout order are untouched.

Revision 2.6 is a narrow docs-only ruling on top of revision 2.5 (`424f85c283a543ba00a650ecc2ecc3a4346623df`), which was
independently hostile-sealed APPROVE and is not rewritten. The B1 implementation `54a469cb9daab043c72db4d7908439a8dad24248`
was then hostile-reviewed. Every engineering surface passed except one blocker:

| Finding | Defect | Resolved in |
|---|---|---|
| B1-R25-B1 | the design did not define when a catalogue privilege is a runtime capability fact. Read as raw ACLs, privileges and policies inherited through `PUBLIC` inside schemas the runtime role cannot USAGE appear as runtime facts, and the B1 cutover plan offered two unsealed workarounds (revoke platform grants, or add target-specific platform grants to the runtime manifest) | section 27.11 (new), with sections 21, 26, 27.4, 27.6 step 2 and 27.7 and the sequence document made consistent |

Revision 2.6's only authority-relevant change is the capability fact model of section 27.11: an object privilege is a
runtime capability fact only inside a governed schema on which the role has effective USAGE. **It grants nothing.** It
defines when an existing catalogue ACL is actually usable by a runtime role. The runtime roles still have USAGE on
`public` and `kernel_private` only, no CREATE on any schema, no TEMPORARY, no membership and no owner fallback; schema
facts stay exact, so any new schema USAGE is itself an unexpected fact. The section 27.10 `SECURITY DEFINER` inventory
is unchanged and remains global over every governed schema. Section 27.11.6 records five implementation hardenings of
the sealed mechanism from the same review; they add no authority. Nothing else in the design changes.

Revision 2.7 is a narrow docs-only ruling on top of revision 2.6 (`7712702020ef5d3d841f68f4d425d9707fb703eb`), which is
not rewritten. It answers a target-qualification finding, not a review blocker. A read-only adjudication of the
production database (07/10 and 08/10/2026; nothing written) found a pre-existing platform `SECURITY DEFINER` function
inside a KernelJSON schema, which revision 2.6 cannot qualify:

| Finding | Defect | Resolved in |
|---|---|---|
| B1-R26-CORESIDENT | production holds `public.rls_auto_enable()`, a `SECURITY DEFINER` event-trigger function bound to the enabled event trigger `ensure_rls`, byte-identical to the Supabase Studio auto-enable-RLS installer. Section 27.10.4 forbids a baseline entry in `public`, so B1 cannot qualify; the frozen B1 migration's pre-COMMIT check (`count = 1` over `public` and `kernel_private`) would abort on it; and B1's blanket `REVOKE EXECUTE ... FROM PUBLIC` would silently change its ACL | section 27.12 (new), with sections 26, 27.6 step 2, 27.8, 27.10.1, 27.10.4, 27.10.7, 27.11.1 and 27.11.4 and the sequence document made consistent |

Revision 2.7 preserves that platform control exactly as it is. It does not relocate, delete, disable or re-grant it,
and it does not relax the section 27.10.4 prohibition generally. It adds one exact, fail-closed exception surface,
the **co-resident platform exception** of section 27.12: a platform function inside `public` or `kernel_private` is
admissible only if this ADR enumerates it by exact identity and fingerprint, together with its event-trigger topology,
and the target declares it in a frozen, system-identifier-bound artefact. The one entry is
`public.rls_auto_enable()` with `ensure_rls`. **It grants nothing to any role.** It changes what qualification
accepts, by one enumerated object, and it narrows B1: B1 no longer touches that function's ACL. The frozen B1 count
check is replaced by exact set equality (27.12.7). Nothing else in the design changes.

Revision 2.7.1 is an author amendment on top of revision 2.7 (`4d1e809b9487e4862a1759521a220180bc7c1050`), which is
not rewritten. It was made before the hostile review of 2.7, from the author's own answers to eight review questions
and the owner's ruling on them. It changes only sections 26, 27.12.6, 27.12.7, 27.12.8 and 27.12.9:

| Finding | Defect in 2.7 | Resolved in |
|---|---|---|
| R27-P2-TOPOLOGY | P2 checked that each event trigger present matched a sealed binding, but did not require a present pinned function to have its sealed binding. A dropped `ensure_rls` was caught before COMMIT only by the operator-supplied P3 digest | 27.12.7 P2 (c) |
| R27-P3-ABSENCE | P3 read two unset settings as an empty declaration, so a missing declaration on an empty target passed silently | 27.12.7 P3: three settings, all mandatory on every target; absence is never an empty declaration |
| R27-P3-FORMAT | malformed setting values were unspecified; a cast would have raised `22P02`, not `23514` | 27.12.7 P3 step 2 |
| R27-P3-DATABASE | P3 did not check the database name, though health did | 27.12.7 P3 step 3 |
| R27-PROVENANCE | nothing bound the pre-COMMIT values to the committed declaration | 27.12.6 cutover runner; 27.12.8 items 7 and 8 |
| R27-HEALTH-DECL | health did not list a missing, malformed or incomplete declaration as P0 | 27.12.6 |
| R27-THREAT | the threat model of P3 and the physical-clone limitation were unstated | 27.12.7 |

It grants nothing, widens no admission condition of 27.12.2 and changes no pin.

Revision 2.7.2 remediates the hostile verdict `BLOCK_R27_1_DESIGN` on revision 2.7.1
(`cf3b953e2f381f7f8d80de5cdf16e17ae9efe9cc`, not rewritten). It closes exactly its two blockers, with five small
clarifications the owner authorised:

| Finding | Defect in 2.7.1 | Resolved in |
|---|---|---|
| R271-B1 | frozen B1 holds a second schema-wide function ACL statement, `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public, kernel_private FROM kj_worker, kj_door`, which 2.7.1 did not redesign. OBSERVED on PostgreSQL 17.6 (27.12.12): it turns the pinned null `proacl` of `public.rls_auto_enable()` into `{=X/postgres,postgres=X/postgres}`, so the positive B1 case was impossible | 27.12.5: no schema-wide routine ACL operation in B1; one enumerated cleanup for both grantee sets; static guard; cases ACL-A to ACL-C |
| R271-B2 | 2.7.1 made a committed runner the only way to apply B1 but said nothing about the migration ledger, so a conforming runner could apply B1 and leave `20261002090000` unrecorded | 27.12.11: B1 is applied by the standard engine (the pinned Supabase CLI), whose ledger write is atomic with the migration (OBSERVED); the runner refuses unless the ledger is exactly the sealed base set; exact post-B1 ledger equality; cases LEDGER-A to LEDGER-F |

Clarifications: the line serialisation is defined only over P2-admitted members and gains a populated golden vector;
runner integrity against `skip-worktree`, `assume-unchanged` and untracked migration files; one more P3 case; a static
test on who may supply the three settings; the post-P2 race stated. The declaration's provenance now reuses the
platform baseline's provenance object, so the two artefacts cannot disagree on target or ledger, and the undefined
`ledgerSetSha256` of 2.7.1 is withdrawn. The six historical ledger rows stay unresolved and unauthorised: production
still cannot pass the runner's ledger gate. It grants nothing.

Revision 2.7.2 (`3acd6b2180ad6d231e1b1693aa63bc49c07cf780`) was hostile-sealed `APPROVE_R27_2_DESIGN`
(`docs/reviews/KJ_P8_ADR0023_R272_HOSTILE_SEAL_3acd6b2.md`) and is not rewritten. Revision 2.7.3 is a bounded correction
of two contradictions found when B1 remediation began, before any code was written. The owner ruled the first a design
blocker on 09/10/2026:

| Finding | Defect in 2.7.2 | Resolved in |
|---|---|---|
| R272-EPHEMERAL | The runner reads the declaration only as a blob of the release commit `R` (27.12.6 step 2); declarations of CI, local and disposable targets are "snapshotted, committed, frozen" (27.12.6, 27.12.7); every B1 application, CI included, goes through the runner (27.12.8 item 9); and P3 step 4 and health require the declaration's system identifier to equal the live one. A disposable database is created after `R` exists, with a new system identifier each time (OBSERVED, 27.12.14), so no declaration committed at `R` can name it. The positive path of every disposable application (cases 1, 23, 41, ACL-A, LEDGER-A and the whole regression suite) was unsatisfiable | 27.12.13: two declaration modes, `HOSTED_COMMITTED` (2.7.2 unchanged, mandatory for every hosted or persistent target) and `EPHEMERAL_RUN_BOUND` (only for a database cluster the runner itself created in the same run, proved by the eligibility predicate); new cases EPH-1 to EPH-15 |
| R272-VARIANT | Cases ACL-B and 6 apply "a B1 variant" through the runner, but runner step 7 refuses any exported file other than the sealed base set and the pinned B1 blob, so the variant could never reach the engine | 27.12.13.8: a negative-fixture path, named and closed, that drives the pinned engine directly and can never qualify anything |
| R272-ENGINE-PLATFORM | 27.12.8 item 13 pinned "the SHA-256 of its binary", but the pinned release ships two executables per platform and CI and local runs use different platforms | 27.12.13.7: one version, 2.120.0, with both executables pinned per supported platform; anything else refuses |

One wording correction with no semantic change: 27.12.11 "Production consequence" now states the observed behaviour
precisely (hardening item 4 of the 2.7.2 seal record). Everything else in revision 2.7.2 stands unchanged, including the
co-resident pins, P1 to P3, the ACL rule, the ledger gate and post-B1 equality, the rollout order and every production
fence. It grants nothing.

Revision 2.7.3 (`e93657198cb4ac363ad8af6c96d6d678f9e8883e`) was hostile-reviewed and blocked on two findings; it is not
rewritten. Revision 2.7.4 closes exactly those two, with three bounded clarifications the owner authorised (H1, H2,
H5 of that review):

| Finding | Defect in 2.7.3 | Resolved in |
|---|---|---|
| R273-B1 | The platform baseline had no normative mode or run binding. Only the declaration carried `mode` and `run`, so a run-local baseline could be committed, could satisfy hosted gate 3b or deployed health, or could be swapped across runs or modes while the declaration stayed correct | 27.10.4 (baseline `mode` and `run`, origin per mode, self-reference stated); section 20 gate 3b; section 21 and 27.12.6 health; 27.12.6 hosted runner step 2; 27.12.13.4 S3 and S4; 27.12.13.6 repository test; cases EPH-16 to EPH-20 |
| R273-B2 | "Optional fixture hooks for the committed tests" were open: no registry, no rule on what a hook may change, nothing stopping a hooked run from reporting itself qualified, and the negative-fixture path of 27.12.13.8 read as a second way to drive the engine | 27.12.13.3; 27.12.13.8 (closed committed hook registry, two setup profiles, `negativeFixture` set by the runner from the registry, L5 not bypassable, one entry point); 27.12.13.6 (qualification status computed, never supplied); cases EPH-21 to EPH-25 |
| H1 | the engine's `PATH` and `PGPASSFILE` handling were not explicit | 27.12.13.7 item 4 |
| H2 | the full 27.10 inventory was checked only after COMMIT, so drift outside `public` and `kernel_private` was found only after B1 committed | 27.12.11 step 8 (read-only equality before application); case EPH-8 |
| H5 | REPOSITORY_QUALIFIED had no completion rule | 27.12.13.6 |

Nothing else changes: the pins, P1 to P3, the ACL rule, the ledger gate, post-B1 ledger equality, the hosted procedure
other than the added refusals, the rollout order and every production fence stand. It grants nothing.

Revision 2.7.4 (`0436cff8a331c9129dfa9fa6248a5851988798a8`) was hostile-reviewed and blocked on one finding; it is not
rewritten. Revision 2.7.5 closes exactly that one:

| Finding | Defect in 2.7.4 | Resolved in |
|---|---|---|
| R274-B1 | The `REPOSITORY_QUALIFIED` predicate required that "every application" passed, but no application count. A run with zero applications, for example one refused at L2 or L5 with teardown recorded, satisfied it vacuously | 27.12.13.3 L1 (the planned application sequence, fixed before L2); 27.12.13.6 (non-vacuous predicate over recorded outcomes, the same for runner and consumer); 27.12.13.8 static qualification; 27.12.13.10; cases EPH-26 and EPH-27 |

Nothing else changes: the R273-B1 and R273-B2 closures, H1, H2, the hook registry, the pins, P1 to P3, the ACL rule,
the ledger gate, post-B1 ledger equality, the hosted procedure, the rollout order and every production fence stand. It
grants nothing.

Revision 2.7.5 (`c7c0fba524655b19e06deb39cec5b6d5426c4ce4`) was hostile-approved (`APPROVE_R275_DESIGN`, record
`docs/reviews/KJ_P8_ADR0023_R275_HOSTILE_SEAL_c7c0fba.md`) and is not rewritten. B1 remediation against it stopped
before any code on one integration finding. Revision 2.7.6 resolves exactly that one:

| Finding | Defect in 2.7.5 | Resolved in |
|---|---|---|
| R275-HARNESS | The existing regression suite applies every migration, B1 included, through a plain helper, runs production code as the runtime roles that only B1 creates, creates its own databases, and reaches the database from compose containers. Revision 2.7.5 forbids each of these (27.12.8 item 9; 27.12.13.3 L1; 27.12.13.8 rule 5 and the last static bullet; L2 and L3), and gave no conforming way for the suite to use a database holding B1 | 27.12.15 (four lanes; stage T for regression consumers after S7; committed plans selected only by a registered suite id; a run network); 27.12.13.3 L1, L2, L3 and L6; 27.12.13.8 (registry, rule 5, static qualification); 27.12.8 items 9 and 14; 27.12.13.10; cases CON-1 to CON-14 |

Nothing else changes: P1 to P3, the pins, the ACL rule, the engine and blob binding, the ledger gate and post-B1
ledger equality, hosted declarations and baselines, the eligibility predicate, the qualification-status predicate,
the rollout order and every production fence stand. It grants nothing.

Revision 2.7.6 (`93a00d11d97b9054f29fbefd5945492666504223`) was hostile-reviewed and blocked on two findings; it is
not rewritten. Revision 2.7.7 closes exactly those two:

| Finding | Defect in 2.7.6 | Resolved in |
|---|---|---|
| R276-B1 | Stage T and `regressionOutcome` dropped existing B1 qualification gates: the refusal trace, zero `42501` including absorbed refusals, the discover inventory, the protected-test baseline, intentional-skip accounting, the recovery minimum of 27, the per-suite pass and skip rules (replaced by a weaker per-file rule), and the faculty, identity and cognition mutation coverage of 27.6 item 3. It also described every mutation as a base-migration mutation, which is wrong | 27.6 item 3; 27.12.15 "Retained B1 regression gates", "Trace and database-log evidence", corrected "Mutation suites"; cases CON-15 to CON-23 and CON-31 |
| R276-B2 | The registered suites' file lists were maintained by hand, with no invariant that every committed test belongs to exactly one required lane, no partition of mixed files, and a CI gate that checked only the suite that happened to run | 27.12.15 "Coverage partition" and "CI gate over every registered suite"; corrected inventory; 27.12.13.8 (a third setup profile and recorded-outcome hook expectations, needed to keep the definers file's positive fixtures without downgrading them); cases CON-24 to CON-30 and CON-32 |

Nothing else changes: the four-lane model, stage T's place in the lifecycle, the status predicate, P1 to P3, the
pins, the ACL rule, the engine and blob binding, the ledger gate and post-B1 ledger equality, hosted mode, the
eligibility predicate, the rollout order and every production fence stand. It grants nothing.

Revision 2.7.7 (`5ee7f6ce54cf44e80a79cf4efdc3a454ee15cc22`) was hostile-reviewed (`BLOCK_R277_DESIGN`: R276-B1
closed, R276-B2 open) and is not rewritten. Revision 2.7.8 closes exactly the three findings of that review:

| Finding | Defect in 2.7.7 | Resolved in |
|---|---|---|
| R277-B1 | The partition took test identity from `vitest list --json`. Observed by the reviewer on the frozen tree: 104 of 107 files collected, `.each` tests unexpanded, `describe.skip` titles lost, duplicate (file, name) pairs, 112 of 224 protected tests and 0 of 62 intentional skips matchable, so the completeness rules fail on correct code, and matching at template level would let a `.each` probe row disappear | 27.12.15 "Test identity and coverage" (collection proves source coverage only; identity is the expanded report entry with its location); "B1 evidence rows"; CI gate; cases CON-28 (corrected) and CON-33 to CON-37 |
| R277-B2 | Probe suites had a blanket refusal exception: the database-log check was off, probe refusals were not traced, duplicate trace events collapsed, and the log names the session user, so a refusal after `SET ROLE` or caught inside PL/pgSQL is invisible to it | 27.12.15 "Refusal accounting" (an exact expected multiset for every stage T suite, empty unless the suite is a probe suite; trace and log must each equal it; probes only through genuine login sessions; settings re-read before the log is trusted); cases CON-38 to CON-42 |
| R277-B3 | Outcome-valued hook expectations could pass without the perturbation having taken effect, or on the wrong rule, and the frozen `_ledger` test's six exact messages were reduced to three bare "S3 refuses" hooks | 27.12.13.8 (every expectation names the exact step and rule or message; every hook carries a precondition check; the fixture SQL pinned and statically bounded); the inventory (six `_ledger` hooks restored); cases CON-43 to CON-46 |

It also corrects three facts the review found (the identity mutation suite has 57 mutations; `tests/baseline.json`
was last changed by commit `1fbe6b2`; B1 does more than grant, so case CON-32 pins its whole shape and 27.6 item 3 no
longer says B1 "cannot change any fact"), and folds in the two harness clarifications the review made a condition of
cases CON-15 and CON-20 (genuine login pools are watched in every mode). Nothing else changes; it grants nothing.

Revision 2.7.8 (`8c0f8e73435386623fff2b252bbb37a1515491e3`) was hostile-reviewed (`BLOCK_R278_DESIGN`: R276-B1,
R277-B2 in substance and R277-B3 closed; the execution-report identity model closed) and is not rewritten. Revision
2.7.9 closes exactly the two remaining findings:

| Finding | Defect in 2.7.8 | Resolved in |
|---|---|---|
| R278-B1 | The collection that proves source coverage was not pinned to an invocation that works on correct frozen code: static parse ignores the environment flags and loses the skipped suites, and three flags leave out `gate3-executor` and the six `KJ_TEST_PG_URL` files. 2.7.8 also wrongly expected collection to show a `.each` template with zero rows, and matched skips per entry, which a removed skip gate whose `beforeAll` fails can satisfy | 27.12.15 "Test identity and coverage" (the pinned command and environment, the zero-expansion rule, the report success rule); cases CON-35 and CON-37 corrected, CON-47 |
| R278-B2 | The log side of the refusal accounting was ambiguous and its fingerprint unsound: one refusal writes `ERROR`, `CONTEXT` and `STATEMENT` lines that all carry `42501`; the statement is not always the next line; whitespace collapsing merges distinct SQL; the frozen harness truncates at 600 characters; and the log cannot carry the test, so two tests issuing the same denied statement could collapse into one | 27.12.15 "Database log" (pinned `log_line_prefix`), "Log extraction" (primary events only, the `STATEMENT` of the same backend), the exact fingerprints on both sides, the log projection; case CON-48 |

It also makes the `_acl` hook's precondition read the `proacl` items directly (a condition the review set on case
CON-43), and corrects the inventory's description of B1's four `SELECT`s. Nothing else changes; it grants nothing.

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
   Shared Brain origins. It has no check on the candidate's origin or state. A version row moves `identity_head`
   even when it is never activated; `identity_current` follows activations and would not move (INFERENCE from
   reading the trigger; not exercised). This is latent, not reachable through application code today: the only
   writer, `completeAndActivateIdentity`, inserts the version and the activation in one transaction, the activation
   guard refuses, and both roll back; and nothing creates model candidates yet. It is reachable by direct SQL or by
   the worker acting as owner. Section 10 closes it before P8 creates any model candidate.
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
    live record). Database grants therefore cannot separate worker code from deployment authority. The door's
    database role was not established by this review; it builds its pool from `DATABASE_URL` like the worker.
    Every table has row level security enabled and **no migration creates a policy** (OBSERVED by search), so today
    only an owner, which bypasses row level security, can read or write them. Existing private functions such as
    `activate_release` and `set_identity_freeze` are `security invoker` and are revoked only from the API roles.
    The trigger function `kernel_private.stamp_binding_provenance()` (BEFORE INSERT on
    `kernel_private.execution_bindings`) is also `security invoker` and performs
    `update kernel_private.release_epoch set epoch = epoch where singleton returning epoch`, a deliberate no-op write
    that locks the epoch row so binding persistence serialises with release activation (OBSERVED in migration
    `20260916205049_release_provenance.sql`; found during B1 implementation). Section 27.9 governs it.
    This drives prerequisite B1 (section 27): no P8 object may reach production while any runtime process is the
    owner.
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
can approve or activate it. No P8 stage is deployed to production until the worker and the door run as dedicated least-privilege database
roles (B1, section 27). P8B, under a separate review, lets the owner adopt a model
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
| Deployment authority (the database owner, used by a human operator in a change window) | apply migrations; activate a release; raise the reflection mode; in P8B, open a growth window | be used by any running service. The runtime roles cannot execute these functions and cannot assume the owner (section 27) |
| Runtime database roles `kj_worker` and `kj_door` | exactly the reads, inserts, updates and function calls of the section 27 grant manifest | own or alter any object; disable a trigger; change row level security; raise the mode; open a window; apply a migration; activate a release; assume another role |

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
  `classD.objectives`. Any other pairing is refused. How each operation builds the candidate document is defined
  exactly in section 10.1.
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
required key; two records with the same dedupe key (section 11.3); a verdict list that does not match the records one for one; an evidence reference that is not an entry
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
`scope` (jsonb, strict per kind), `scope_key` (`canonicalDigest` of the scope, section 11.1), `claim` (at most 300 characters),
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
| `CONSISTENT` | at least 5 distinct supporting source tasks |

**Reconstruction rule.** The set of supporting source tasks of a subject is the set of distinct `source_task_id`
values found in:
- the `evidence_refs` of the subject's own row; and
- the `evidence_refs` of every `reflection_support` row for that subject (section 11.4).

The class is a pure function of the size of that set and the origin. It is computed in a view from those durable
rows and is stored nowhere, so it can always be recomputed and audited. There is no numeric pseudo-probability, and
revision 2.3 removes the earlier "no cited contradicting task" condition, because nothing defined a contradiction.

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
5. **The candidate document** is computed by the kernel: the head document plus the single structured edit, by the
   exact contract of section 10.1. It is validated by `IdentityDocumentDraft` and screened for secrets. The database
   computes the class and base. Stale protection is the P7A compare-and-swap; P8 adds nothing weaker.
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

### 10.1 Candidate construction contract (P8-R22-LIST-EDIT)

Contract **`kerneljson:reflection-candidate-construct/v1`**, one pure function in `packages/contracts`:
`construct(headDocument, edit)` returns either exactly one candidate document or exactly one ineligibility code.
One structured proposal maps to at most one candidate document, byte for byte.

**Facts at base main this depends on** (read in `packages/contracts/src/primary-identity.ts` and
`services/kernel/src/identity/canonical.ts`): `classA.values` is an array of 1 to 20 items and `classD.objectives`
an array of 0 to 20 items; each item is a string trimmed to 1 to 300 characters; duplicates are permitted; array
order is semantic and `canonicalStringify` preserves it.

**Common steps, in order:**

1. Start from the head document with its `version` member removed (a candidate never embeds a version, per P7A).
2. Parse `value` with the Zod schema of the target: the field's own schema for `REPLACE`, the list item schema for
   `ADD_ITEM` and `REMOVE_ITEM`. This applies the existing trim and length bounds and nothing else. A parse failure
   has already refused the whole output (section 6.2).
3. Apply the operation below to the one target path. **Every other member of the document is carried over
   unchanged**, and no array is sorted, deduplicated or reordered.
4. Validate the result with `IdentityDocumentDraft`. A failure here is `INELIGIBLE (INVALID_DOCUMENT)`.

**Equality** everywhere in this contract is exact equality of the stored strings, code unit for code unit, after
step 2. It is **not** the dedupe key normalisation of section 11.1: two items that differ only in case or spacing
are different items here, because the identity document stores them as different bytes.

| Operation | Rule | Result |
|---|---|---|
| `REPLACE` | the parsed value equals the current field value | `INELIGIBLE (NO_CHANGE)` |
| `REPLACE` | otherwise | the field is set to the parsed value |
| `ADD_ITEM` | an equal item already exists in the list (one or more) | `INELIGIBLE (NO_CHANGE)` |
| `ADD_ITEM` | the list already holds 20 items | `INELIGIBLE (LIST_FULL)` |
| `ADD_ITEM` | otherwise | the item is appended once, at the end; existing items keep their positions |
| `REMOVE_ITEM` | no item equals the value | `INELIGIBLE (NO_CHANGE)` |
| `REMOVE_ITEM` | more than one item equals the value | `INELIGIBLE (AMBIGUOUS_EDIT)` |
| `REMOVE_ITEM` | exactly one match, the path is `classA.values`, and the list holds exactly 1 item | `INELIGIBLE (LIST_MINIMUM)` |
| `REMOVE_ITEM` | exactly one match otherwise | that one item is removed; the remaining items keep their relative order |

- The rows of one operation are checked top to bottom; the first that applies decides.
- `LIST_FULL` is a distinct code from `CAP`, which already means a record cap of section 12.
- `classD.objectives` may become empty; its schema allows it.
- An ineligible proposal is still minted as a proposal row with its `INELIGIBLE` disposition and code, so it is
  auditable and sticky for its head (section 11.3). No candidate row is written for it.
- The kernel never constructs a document it knows to be invalid and then relies on a later check to refuse it.
- After construction the database still classifies the candidate. If the class it computes differs from the class
  implied by the path, the proposal is `INELIGIBLE (CLASS_MISMATCH)`; `identity_candidate_classify()` remains the
  authority.

**Golden construction vectors are part of the contract.** Each vector is a head document, an edit and the expected
result: either the full candidate document with its `proposed_digest`, or the ineligibility code. The design
requires at least these, and an implementation that disagrees with one is wrong:

| # | Case | Expected |
|---|---|---|
| 1 | Class A `ADD_ITEM` to `classA.values` | appended last; `proposed_digest` fixed |
| 2 | Class A `REMOVE_ITEM` of one of several values | removed; order of the rest unchanged; digest fixed |
| 3 | Class D `ADD_ITEM` to `classD.objectives`, including to an empty list | appended last; digest fixed |
| 4 | Class D `REMOVE_ITEM`, including removal of the only objective | removed; empty list allowed; digest fixed |
| 5 | duplicate add (item already present) | `NO_CHANGE` |
| 6 | absent remove | `NO_CHANGE` |
| 7 | ambiguous remove (the head holds the item twice) | `AMBIGUOUS_EDIT` |
| 8 | Class A final-item removal | `LIST_MINIMUM` |
| 9 | add to a list of 20 | `LIST_FULL` |
| 10 | item differing from an existing one only by case or internal spacing | appended (not equal under this contract) |
| 11 | `REPLACE` with the current value | `NO_CHANGE` |
| 12 | value with leading and trailing spaces | trimmed by the schema, then treated as cases 1 to 11 |

## 11. Deduplication, replay and idempotency

### 11.1 Key normalisation contract (B-DEDUP-NORM)

One pure function, contract **`kerneljson:reflection-key-normalise/v1`**, in `packages/contracts`. It is the only
normalisation used for dedupe keys. Applied to a string, it performs exactly these steps, in order:

1. Unicode normalisation form NFKC;
2. locale-independent lowercase mapping, as ECMAScript `String.prototype.toLowerCase` defines it (Unicode default
   case conversion, no locale tailoring; this is lowercase mapping, not case folding);
3. NFKC again, because step 2 can produce a sequence that is not normalised;
4. every maximal run of code points with the Unicode `White_Space` property is replaced by one U+0020;
5. leading and trailing U+0020 are removed.

Nothing else is changed. **Punctuation, symbols, digits and word order are kept**: in an identity field or a claim
they can change the meaning, and a dedupe key decides whether two records are the same record.

The reference expression is `s.normalize("NFKC").toLowerCase().normalize("NFKC")` followed by steps 4 and 5. The
contract ships with a fixed table of golden vectors (input, normalised output, key). An implementation that
disagrees with one vector is wrong, whatever its reading of the steps. Changing any step or vector is a new contract
version and a new key contract name; `v1` keys are never recomputed.

**Unicode pin (P8-R22-UNICODE-PIN).** `v1` is defined against **Unicode 15.1.0** and no other version: NFKC from its
normalisation data, lowercase from its `UnicodeData.txt` and the unconditional and `Final_Sigma` rules of its
`SpecialCasing.txt`, and `White_Space` from its `PropList.txt`. "The runtime's current Unicode" is not the
definition. Three rules make a runtime upgrade unable to change `v1` output silently:

1. **Assigned-only input.** A `value` or `claim` containing a code point that is unassigned in Unicode 15.1.0
   (general category `Cn`), a private-use code point or a noncharacter is refused before a key is computed
   (`REFLECTION_TEXT_INVALID`). A character added by a later Unicode version therefore never enters a `v1` key.
2. **Conformance digest.** The contract fixes one constant, `UNICODE_15_1_CONFORMANCE_SHA256`: the sha256 of the
   concatenation, in code point order, of `normalise(c)` for every Unicode scalar value `c` from U+0000 to U+10FFFF
   taken as a one-character string, each followed by U+000A, encoded as UTF-8; followed by `normalise` of every
   source string of the 15.1.0 `NormalizationTest.txt`, in file order, each followed by U+000A. The constant is
   computed once from the 15.1.0 data when P8A-0 is implemented, recorded in the contract file and reviewed. This
   ADR fixes the procedure, not the hexadecimal value, because no code was run for this design.
3. **Fail closed.** An implementation must either carry frozen 15.1.0 tables, or use runtime functions and prove at
   process start that they reproduce the conformance digest and every golden vector. If the proof fails, the
   reflection record step refuses (`REFLECTION_KEY_CONTRACT_UNAVAILABLE`) and no key is computed. It never falls back
   to whatever the runtime provides. The same proof runs in CI.

The golden vectors must include at least: precomposed and decomposed forms of one character; compatibility forms
(full-width, ligature, superscript); capital sharp s and dotted capital I; Greek sigma in final and non-final
position; no-break space, ideographic space, tab and line separators; a string containing only white space; and
punctuation that must be preserved. Moving to a later Unicode version is a new contract (`.../v2`) with new key
contract names; `v1` rows keep their `v1` keys.

**Relation to the excerpt guard (section 15.4).** They are two separate contracts with two purposes, and neither is
used in place of the other:

| | `reflection-key-normalise/v1` | `memory-excerpt-guard/v1` |
|---|---|---|
| Purpose | decide whether two records are the same record | detect verbatim copying of memory text |
| Punctuation and symbols | kept | removed |
| Whitespace | collapsed to one space | removed |
| Result is stored | only inside a key digest | never |
| Errs towards | treating records as different | treating text as copied |

**What is normalised and what is not:**

| Key input | Treatment |
|---|---|
| `value` of an `IDENTITY_EDIT` (for `REPLACE`, `ADD_ITEM` and `REMOVE_ITEM` alike) | the function above |
| `claim` of a model observation | the function above |
| `tenant`, `identity`, `base_identity_core_digest` | exact lowercase UUID or hex string, no normalisation |
| `base_version`, `targetVersion` | JSON integer |
| `kind`, `path`, `op`, `origin` | exact enumeration string |
| `scope` | the parsed strict per-kind object; its members are enumerations, UUIDs and recipe labels, compared exactly |

**Canonical JSON** means `canonicalStringify` in `services/kernel/src/identity/canonical.ts`: object keys sorted
recursively, arrays in given order, JSON primitive encoding. "sha256 of the canonical JSON" is `canonicalDigest`.
`scope_key` is `canonicalDigest(scope)`. The same function moves to, or is re-exported from, `packages/contracts` so
the key function has one implementation; no second canonical encoder is written.

**The stored text is not the normalised text.** A row stores `value` or `claim` exactly as parsed (it has already
passed the text limits of section 5.3 step 5). Normalisation feeds the key only.

### 11.2 The keys

Each key is `canonicalDigest` of exactly the object shown, with exactly these member names. An absent member is
omitted, not null.

**`proposal_key`, `IDENTITY_EDIT`:**

```
{ "contract": "kerneljson:reflection-proposal-key/v1", "tenant", "identity", "baseVersion",
  "baseIdentityCoreDigest", "kind": "IDENTITY_EDIT", "path", "op", "value": normalise(value) }
```

**`proposal_key`, `ROLLBACK_RECOMMENDATION`:**

```
{ "contract": "kerneljson:reflection-proposal-key/v1", "tenant", "identity", "baseVersion",
  "baseIdentityCoreDigest", "kind": "ROLLBACK_RECOMMENDATION", "targetVersion" }
```

**`observation_key`, origin `MODEL_REFLECTION`:**

```
{ "contract": "kerneljson:self-model-key/v1", "tenant", "identity", "origin": "MODEL_REFLECTION",
  "kind", "scopeKey", "claim": normalise(claim) }
```

**`observation_key`, origin `OPERATOR_CORRECTION`:**

```
{ "contract": "kerneljson:self-model-key/v1", "tenant", "identity", "origin": "OPERATOR_CORRECTION",
  "kind", "scopeKey", "correctionTask": <the DISPOSE task id> }
```

- Both keys are UNIQUE per tenant.
- The kernel computes the key; the database enforces its format and uniqueness. The database does not recompute
  it, because Postgres `lower()` is locale-dependent and would not match step 2. A defective worker could therefore
  write a wrong key. That residual is bounded to advisory records: a wrong key can cause a duplicate or a missed
  duplicate, and cannot approve, version or activate anything.
- **An owner correction is never deduplicated.** Its key contains its own `DISPOSE` task, so every correction is its
  own row and takes the highest `seq` in its scope (section 9.3 rule 1), even when its text repeats an earlier
  correction. It is bounded at one row per `DISPOSE` task.

### 11.3 What a key match does (mint versus support)

At `REFLECT_RECORD`, for each record of the output, in ordinal order, inside the one record transaction:

1. **Two records of the same output with the same key:** the whole output is refused
   (`REFLECTION_OUTPUT_REFUSED`); nothing is written.
2. **No existing row has the key:** a new row is minted, then evaluated for eligibility (section 6.2).
3. **An existing row from a different reflection task has the key:** no row is minted. Exactly one
   `reflection_support` row is appended for the existing subject. The new surface text is not stored anywhere.
   **A support row changes nothing else:** it never creates a candidate, never changes a disposition, and never
   makes an ineligible, dismissed or stale record eligible. Its only effect is the distinct-source count behind the
   confidence class (section 9.5).
4. **A row with the same deterministic id exists (a replay of this task):** the stored digest is compared; equal
   returns the existing row, unequal refuses the task.

A candidate is created only in case 2, for a newly minted proposal. Case 3 can never mint a HELD candidate.

**Stickiness, exactly:**

| Record | Key scope | Consequence |
|---|---|---|
| proposal | includes the base version and digest | a proposal that is ineligible (for any reason, including `CAP`), dismissed, or whose candidate was rejected stays so **for that head**. The same edit against a later head has a different key and is a new proposal. |
| model observation | no base; exact scope plus normalised claim | a dismissed or ineligible model observation stays so **permanently** for that claim in that scope. A repeat adds support only. |
| owner correction | its own task | never sticky; never matched |

The owner's route around a sticky proposal is an operator `PROPOSE` under `identity-change/v1`, which is unaffected.

### 11.4 Support bound and replay

**The support row (P8-R22-SUPPORT-PROVENANCE).** Immutable `public.reflection_support`:

| Column | Meaning |
|---|---|
| `id` | deterministic: `stableId` over the contract name `kerneljson:reflection-support/v1`, the subject id and the reflection task id |
| `tenant_id` | same-tenant composite keys on every reference (section 23) |
| `proposal_id` or `observation_id` | the existing subject; exactly one is set (CHECK) |
| `reflection_task_id` | the `REFLECT` task whose output repeated the record |
| `record_ordinal` | the position of the repeat in that task's structured output (`P0` to `P2`, `O0` to `O2`) |
| `matched_key`, `key_contract` | the dedupe key that matched and its key contract name; must equal the subject's key (trigger) |
| `evidence_refs` | 1 to 8 (proposal) or 1 to 10 (observation) packet entries cited by the repeat, each `{source_task_id, evidence_id, digest, code}`; every entry must belong to this task's qualified packet |
| `packet_digest` | the domain-separated digest of this task's source manifest |
| `structured_result_digest` | the digest of this task's canonical structured result, the same value bound in its runtime evidence (section 15.1) |
| `evaluator_call_id` | the evaluator call that judged the repeat |
| `created_at` | set by the trigger to `clock_timestamp()` |

- **A support row is written only when the evaluator's verdict on the repeat is `SUPPORT` with no concerns.**
  Otherwise no row is written and evidence records the ordinal with the factual code `REPEAT_NOT_SUPPORTED`. A
  repeat the evaluator opposed never raises confidence.
- **The repeated surface text is not stored**, in this row or anywhere else. What matched is proved by
  `matched_key`; that the task really produced it is proved by `record_ordinal` together with
  `structured_result_digest`, which the task's own evidence binds; what it rested on is proved by `evidence_refs` and
  `packet_digest`.
- Confidence is reconstructed from these rows by the rule in section 9.5.

- **Support is bounded.** `reflection_support` has `unique (subject_id, reflection_task_id)`, realised as one unique
  key per typed subject column (`proposal_id` or `observation_id`) with the task: at most one support row
  per subject per reflection task. Its row id is deterministic from that pair. Only `REFLECT` tasks write support. One
  task emits at most 3 proposals and 3 observations, and each can match at most one existing key, so one task writes
  at most 6 support rows. With the admission quota of 6 tasks, a tenant gains at most 36 support rows per rolling 24
  hours across all subjects, and any one subject gains at most 6. The table grows without a lifetime cap; rows are
  small and immutable.
- **Replay.** Ids are deterministic (task, step, ordinal), and the record step runs in one `ctx.run` and one database
  transaction under an advisory lock on the reflection task. A replay or lost journal re-executes to the same rows
  (case 4 above). A replay therefore appends no second support row: the unique key absorbs it.

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
- **The primary defence is structural:** P8 evidence holds no text (15.1), there is no rationale text, and the only
  model-authored text stored is one bounded `value` or `claim` per record. The excerpt guard below is defence in depth
  against verbatim copying into those two fields. It is not a privacy boundary and does not detect paraphrase.
- **Deterministic excerpt guard**, contract `kerneljson:memory-excerpt-guard/v1`. At `REFLECT_RECORD`, for each
  `value` and `claim` and for the content of each memory item in the journaled assembly, the kernel computes a
  normalised string by exactly these steps, in order:
  1. Unicode normalisation form NFKC;
  2. locale-independent lowercase mapping;
  3. removal of every code point that is not a Unicode letter or number (general categories L and N), so all
     whitespace, punctuation and symbols are dropped.

  Lengths are counted in code points of the normalised strings. The record is refused if the normalised `value` or
  `claim` shares a contiguous run of **40 or more** code points with any normalised memory item, or wholly contains a
  normalised memory item of 20 to 39 code points. Memory items shorter than 20 normalised code points are not
  compared. Inserted spacing, punctuation, case and compatibility characters therefore do not evade it.
- **A refused record is not written.** No proposal or observation row is created, so the text is stored nowhere by
  P8. Evidence records only the record ordinal and the factual code `MEMORY_EXCERPT_REFUSED`. The other records of
  the same task proceed. The memory text is compared in process and is not persisted by the check.
- A false positive (generic text that happens to match) costs one record. The owner can still make the same change
  as an operator `PROPOSE`, which is unaffected.
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

- **No runtime role can write this table.** `kj_worker` and `kj_door` have SELECT on it and nothing else. Rows are
  written only by two functions owned by the deployment owner:
  - `kernel_private.set_reflection_mode(tenant, mode, reason, authorisation_ref)`: **raising** the mode. It is run by
    the deployment owner in an authorised change window. The runtime roles have no EXECUTE on it.
  - `kernel_private.freeze_reflection(task_id)`: **lowering** to `DISABLED`. It is `security definer`, executable by
    `kj_worker`, and writes only a `DISABLED` row. It refuses unless the task is a `FREEZE` task of recipe
    `identity-reflection/v1` whose principal is the HUMAN identity owner. Freezing is safe, so the owner can always
    do it. Exact signature (revision 2.5 precision): `kernel_private.freeze_reflection(task_id uuid) returns void`.
- Revision 2.2 recognised the deployment function by a transaction-local setting. That is withdrawn: any role can
  set a custom setting, so it separated nothing. Authority now rests on EXECUTE privilege and table grants, which a
  non-owner role cannot give itself (section 27).
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
| `window_id` | `uuid` (revision 2.5 precision), primary key |
| `tenant_id`, `identity_id` | composite foreign key to `identity_profiles(id, tenant_id)` |
| `authorisation_ref` | the change-window record and the HUMAN authorisation; not null |
| `reason` | not null |
| `opened_at` | set by the trigger to `clock_timestamp()`; a caller value is overwritten |
| `expires_at` | `check (expires_at > opened_at)` and `check (expires_at <= opened_at + interval '7 days')` |

**`kernel_private.identity_growth_window_closures`, the CLOSE record:**

| Column | Rule |
|---|---|
| `window_id` | `uuid` (revision 2.5 precision), primary key, so a window has at most one closure |
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
at most one effective, non-expired, unclosed window per identity. Opening is deployment authority only: the runtime
roles have no INSERT on the table and no EXECUTE on `kernel_private.open_growth_window`.

**CLOSE** (BEFORE INSERT trigger): take the lock; set `closed_at`.
- If no closure exists, insert it. Closing a window that has already expired is permitted and changes nothing.
- If a closure exists with the same `closed_by_kind`, `close_task_id` and `request_ref`, the close function returns
  the existing row (idempotent replay).
- If a closure exists with any different value, refuse `GROWTH_WINDOW_ALREADY_CLOSED`.

Closing is available to deployment authority and to the HUMAN owner through `FREEZE`. The runtime roles have no
INSERT on the closure table. For closing, `kj_worker` may execute one `security definer` function,
`kernel_private.close_growth_window_by_owner(task_id, window_id)`, which refuses unless the task is a `FREEZE` task
of the HUMAN identity owner. In P8B a `FREEZE` task writes the `DISABLED` mode row and closes any effective window in
one transaction, through the two definer functions. Exact signature (revision 2.5 precision):
`kernel_private.close_growth_window_by_owner(task_id uuid, window_id uuid) returns
kernel_private.identity_growth_window_closures`; it returns the inserted closure row, or the existing row on an
idempotent replay.

**Expiry needs no write.** An expired window is simply not effective.

**Residual, stated.** The guard reads `clock_timestamp()` once, after the lock. A window can reach `expires_at` in
the interval between that read and the transaction's commit. A close cannot interleave, because the lock is held to
commit. The replaced P8B guard sets the activation's `activated_at` to that same reading (today it defaults to
transaction start), so the P0 health check
`reflection.modelGrowthInsideWindow` compares like with like. The interval is the remainder of one database
transaction and is accepted.

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
4. the approval belongs to that task, its status is `GRANTED`, and its `requested_from` is the identity's
   `owner_principal_id`, so the decision was requested from, and can only have been given by, the HUMAN owner;
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

The authoritative sequence is `docs/operations/KJ_P8_IMPLEMENTATION_SEQUENCE.md`. The production order is fixed:

**B1, then P8A-0, then B2, then P8A-1, then P8A-2, then P8B.**

**The rule above every step:** production acquires no P8 table, function, trigger, recipe or mode row while any
runtime process connects as the database owner. There is no fallback to `postgres`, no temporary owner mode and no
degraded mode that widens authority. If B1 cannot be established and qualified, P8 stays unavailable.

Repository preparation is separate from production deployment. Contracts, schema and tests for a later step may be
written and qualified in an isolated non-production environment, under the runtime roles, before the earlier step is
live. Nothing from P8 is applied to the production database out of order.

**B1: runtime database roles** (section 27). First in both orders: P8A-0's grants and its qualification depend on
the roles existing. Dedicated `kj_worker` and `kj_door` roles, a reviewed grant manifest, explicit row level security
policies, full P1 to P7 requalification and a production cutover in its own change window. It changes no behaviour
and adds no P8 object.

**P8A-0: substrate, feature off.** Implementation and deployment; no live reflection and no model call.
- Contracts and schema: the reflection tables, evaluations, dispositions, support, Class E table and the
  `self_model_current` view.
- The key normalisation contract with its Unicode pin and vectors (section 11.1) and the candidate construction
  contract with its vectors (section 10.1).
- The atomic admission reservation and quota (section 5.4), and the neutral scanner module with the pure
  pre-admission function (section 5.3).
- The reflection governance mode, default `DISABLED`, with its two functions (section 17.1).
- The candidate unique index and cap triggers, the replaced version and transition guards (sections 8 and 10), the
  composite keys of section 23, the runtime-role guard and P8 grants (section 27.5), health rows, fences and the
  mutation harness.
- The door does **not** accept the recipe.

**B2: Class B faculty-version review** (section 6.4), before P8A-1.

**P8A-1: reflecting cognition, records only.** A separate authorisation. The HUMAN-owner door route opens; mode
`OBSERVE`; bounded reflector and evaluator; no raw model output in evidence.

**P8A-2: HELD model candidates.** A separate authorisation; mode `PROPOSE_IDENTITY`. A `MODEL_PROPOSAL` still cannot
be approved (the P7A CHECK is unchanged), cannot produce a version (section 10 item 7) and cannot be activated.

**P8B: controlled growth.** A separate ADR addendum, its own hostile review and explicit HUMAN authorisation. The
adoption binding, the static CHECK revision, the dynamic approval trigger, the two growth-window tables and their
functions, the `ADOPT` workflow and controlled activation. **There is no auto-adoption at any class.**

## 20. Acceptance gates

**B1** (before any P8 object reaches production; detail in section 27.6):
1. The catalogue equals the grant manifest exactly, for both runtime roles: no privilege more, none fewer.
2. The complete existing suite, the mutation suites and the real-Restate tests pass with the worker as `kj_worker`
   and the door as `kj_door`, with zero permission-denied errors and unchanged pass counts.
3. Every denied operation of section 27.6 fails on purpose.
3a. The section 27.9 exception holds exactly: the catalogue assertions of 27.9.4 pass, each has a negative case, and
    every probe of 27.9.5 is refused or overwritten as stated.
3b. The `SECURITY DEFINER` inventory equals `EXPECTED(B1)` of section 27.10, with the platform baseline frozen and
    reviewed as section 27.10.4 requires. Revision 2.7.4: only a `HOSTED_COMMITTED` baseline committed at the release
    commit, with no `run` field, satisfies this gate. An `EPHEMERAL_RUN_BOUND` baseline never does, whatever its
    contents; it supports repository qualification only (27.12.13.6).
4. In production, after cutover: the running worker and door report `current_user` as their runtime roles, a P1 to
   P7 live proof passes, and `database.runtimeRolesLeastPrivilege` is green.

**P8A-0** (qualification under the runtime roles, no production reflection):
1. Two concurrent `REFLECT` admissions at 5 of 6 against real Postgres: exactly one admitted, in both orderings.
2. Six admitted tasks that all FAIL still refuse a seventh.
3. A replayed idempotency key consumes no second slot.
4. A secret-shaped `operatorFeedback`, `reason` and `correction` are each refused with zero rows in
   `execution_bindings`, `task_admissions`, reservations, dispatch events and `tasks`, and the refused text appears
   in no log.
5. A version insert for a `MODEL_PROPOSAL` candidate is refused.
6. Every check has a negative case that fails on purpose, in the same change.
7. Every golden vector of sections 10.1 and 11.1 passes, and the Unicode conformance digest is reproduced.
8. A P8 write attempted while the session role is the owner is refused (`P8_OWNER_ROLE_REFUSED`).
9. `kj_worker` cannot insert a `reflection_governance` row, and cannot execute `set_reflection_mode`.

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
1. B1 still holds: the runtime roles are unchanged, the catalogue still equals the manifest including the P8B
   objects, and `kj_worker` cannot insert a window or a closure or execute `open_growth_window`.
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

| `database.runtimeRolesLeastPrivilege` | the worker and the door are connected as `kj_worker` and `kj_door`; neither role is superuser, owner of any object, member of any role, `BYPASSRLS`, `CREATEDB` or `CREATEROLE`; the catalogue grants and policies, as runtime capability facts under section 27.11, equal the manifest; the `SECURITY DEFINER` inventory equals `EXPECTED(stage)` of section 27.10 for the stage the running release declares (so after B1 and before P8A-0 it is the platform baseline plus the section 27.9 exception only; from P8A-0 it adds `freeze_reflection`; from P8B it adds `close_growth_window_by_owner`), and every attribute 27.10 pins for each expected function holds, including for the section 27.9 exception every assertion of 27.9.4; an unlisted, missing or mismatched definer is P0 at every stage. Revision 2.7.4: in a deployed release the platform baseline and the co-resident declaration must both have `mode` `HOSTED_COMMITTED` and no `run` field; anything else is P0 | **P0** |

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
    authorisation. The runtime roles cannot: they have no INSERT on the table and no EXECUTE on the function.
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
| 4 | reflector quotes memory into runtime evidence | impossible; verbatim copies are also kept out of records | evidence holds digests and ids only (15.1); no rationale text; a record that hits the excerpt guard is not written (15.4) |
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
| 15b | trivially reworded repeat (case, spacing, compatibility characters) mints a second record | matches the existing key; support only | `reflection-key-normalise/v1` with golden vectors (section 11.1) |
| 15 | replay appends duplicate support | absorbed | `unique (subject_id, reflection_task_id)` and a deterministic id; at most 6 rows per task, 36 per tenant per 24h |
| 16 | worker as `postgres` in P8A | not permitted | B1 is the first production step; P8 writes refuse under the owner (section 27.5) |
| 17 | worker as `postgres` in P8B | not permitted | the same |
| 18 | runtime role raises the reflection mode | refused | no INSERT on the table, no EXECUTE on `set_reflection_mode`; the setting-based recognition is withdrawn (17.1) |
| 19 | operations fall back to the owner after an incident | P8 stops working; P0 alert | runtime-role guard on P8 writes; `database.runtimeRolesLeastPrivilege` (27.5, 27.7) |
| 20 | two implementations build different candidate bytes for a list edit | impossible | exact construction contract and golden vectors (10.1) |
| 21 | a runtime Unicode upgrade changes a `v1` key | refused at start | Unicode 15.1.0 pin, assigned-only input, conformance digest (11.1) |

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

### 22.3 Prerequisites and gates

**B1: runtime database roles. A prerequisite for every P8 production stage, not an accepted residual.**

Revision 2.2 accepted the worker running as the `postgres` owner during P8A and deferred the dedicated role to
before P8B. The hostile re-seal rejected that, and revision 2.3 withdraws it. Owner-role execution is not acceptable
for any live P8 stage. B1 is fully specified in section 27 and is the first step of the rollout.

What remains true after B1, stated plainly:
- the deployment owner, used by a human operator in a change window, can still do anything to the database. That is
  the deployment trust boundary and is unchanged;
- a defective `kj_worker` can still write advisory reflection records that pass the triggers, including a wrong
  dedupe key. It cannot raise the mode, open a window, alter an object, disable a trigger, approve, or write a
  version or activation outside the governed transaction and its guards.

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

- B1 is a specified prerequisite step, not an open question: no P8 object reaches production before it is
  qualified (section 27). B2 is a separate review gate before P8A-1 (section 6.4).
- The grant manifest's P1 to P7 baseline in section 27.4 comes from a static survey and is INFERENCE until the B1
  inventory completes and freezes it. The P8 grants in section 27.5 are exact.
- The door's current database role was not observed. B1 gives it a dedicated role whatever it is today.
- The hexadecimal value of the `stamp_binding_provenance()` source digest is fixed at B1 implementation by the
  procedure in section 27.9.3, in the same way as the Unicode conformance digest. The procedure is sealed; the value
  is an implementation artefact that the B1 review checks.
- The hexadecimal value of the Unicode conformance digest is fixed at implementation, by the procedure in 11.1.
- The platform `SECURITY DEFINER` baseline of section 27.10.4 is an engineering artefact of B1 qualification, frozen
  from a read-only catalogue snapshot of the target environment by the sealed procedure. Its entries are not values
  of this ADR; the B1 review checks them.
- Implementation that predates revision 2.6 (not edited by this revision): the B1 candidate
  `54a469cb9daab043c72db4d7908439a8dad24248` reads object privileges and policies in every governed schema without the
  schema-USAGE gate of section 27.11, keys function facts by `schema.name`, and its cutover plan offers the two
  workarounds section 27.11.5 rules out. It also lacks the five hardenings of section 27.11.6. It stays frozen until
  revision 2.6 is hostile-sealed, and is then remediated to section 27.11.
- Implementation that predates revision 2.7 (not edited by this revision): the frozen B1 candidate
  `0ff2919c1bbf722b4842aa56fdc94ef9b74e5a51` counts definers (`n <> 1`) in its pre-COMMIT check, revokes `PUBLIC`
  EXECUTE from every function in `public` and `kernel_private`, refuses any `public` entry in its baseline snapshot
  and has no co-resident artefact or event-trigger capture. It stays frozen until revision 2.7 is hostile-sealed and
  is then remediated as section 27.12.8 lists.
- Four PostgreSQL behaviours section 27.12 relies on are INFERENCE, not executed in revision 2.7, and B1
  qualification must observe each: (1) a direct call of a function returning `event_trigger`, by a role holding
  EXECUTE, fails `0A000` before running the body; (2) firing an event trigger does not check EXECUTE on its function;
  (3) a custom setting passed as a connection startup parameter (`options=-c kj.b1.<name>=<value>`) reaches the
  migration session on the target's actual connection path (OBSERVED on disposable PostgreSQL 17.6 with the Supabase
  CLI, 27.12.12; not observed on hosted Supabase or through its pooler; if a pooler drops it, P3 step 1 aborts, so
  the failure is closed), and `current_setting(name, true)` returns NULL for a custom setting never set in the session
  (revision 2.7.1 treats NULL and empty alike, so either result is safe); (4) a runtime role's `CREATE`, `ALTER` or
  `DROP EVENT TRIGGER`, and its `CREATE OR REPLACE` or `ALTER` of a function it does not own, fail `42501`. If any
  differs, B1 stops and section 27.12 is re-specified by a design revision.
- The six canonical migrations missing from the production ledger (`20260920120000`, `20260920150000`,
  `20260920180000`, `20260921180000`, `20260923150000`, `20260925120000`) are not addressed here. Their current
  state is equivalent to canonical; their historical application is unproven; the B1 target snapshot still refuses on
  the ledger set, and revision 2.7 neither changes that gate nor authorises any ledger repair.
- Implementation that predates revision 2.5 (not edited by this revision): at the frozen B1 candidate
  `108db1b0db5923993eb17888d3039c5a32890c2c`, `services/kernel/src/database/runtime-roles.ts` excludes only
  `pg_catalog`, `information_schema` and `pg_toast` from its definer query, compares only `schema.name`, and has no
  platform baseline; `compareDefinerFunctions()` does not implement section 27.10. It is to be remediated only after
  revision 2.5 is hostile-sealed.
- The B1 entry brief on `main` (`docs/operations/KJ_P8_B1_ENTRY_BRIEF.md`) still states the revision 2.3 position:
  B1 changes no P1 to P7 trigger, and the worker's triggers are `security invoker`. It does not know the section
  27.9 exception or the section 27.10 inventory. After revision 2.5 is hostile-sealed, that brief must be
  reconciled to the sealed revision 2.5 contract before B1 remediation is authorised. Where they differ, this ADR
  governs.
- One narrowing for the re-seal to confirm: only `REFLECT` consumes an admission slot (section 22.2).
- RECOMMENDATION, out of scope here: apply the pre-admission scan to `identity-change/v1` `PROPOSE` and `ROLLBACK`
  under a separate authorisation (section 5.3).
- The exact text templates for Mission Control are implementation detail for P8A-1.
- The 14-day `POST_CHANGE` figure is a tunable alerting default with no authority.
- The complete text of the hostile review was not found on disk in this worktree, the main checkout or the
  new-system docs. Revision 2 was written against the binding blocker statements in the remediation brief.

## 27. Runtime database roles (B1; P8-R22-B1-LP)

### 27.1 Rule

No runtime process connects to the production database as an owner or a superuser. Production acquires no P8 object
until that is true and qualified. This is a design requirement of P8, placed first in the rollout.

### 27.2 Roles

| Role | Used by | Attributes |
|---|---|---|
| deployment owner (the existing `postgres` role) | a human operator in an authorised change window; never a running service | owns every object in `public` and `kernel_private`; applies migrations; runs the deployment functions |
| `kj_worker` | the kernel worker (workflows, ledger, scheduler, channel adapters) | `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`, a connection limit, a password held only in the vault |
| `kj_door` | the admission door (gateway) | the same attributes |

For both runtime roles:
- **Ownership:** they own nothing, in any schema, including every P8 table, view and function.
- **Membership:** they are members of no role and no role is a member of them, so `SET ROLE` and
  `SET SESSION AUTHORIZATION` to another role fail. They cannot assume the owner.
- **Schemas:** USAGE on `public` and `kernel_private` only. No CREATE on any schema (CREATE on `public` is revoked
  from `PUBLIC`), no TEMPORARY on the database. They have no privilege on the migration ledger schema, on the
  vault, or on any other schema.
- A read-only reporting process, if one connects separately, gets a third role with SELECT only, under the same
  attribute rules. Health and Mission Control read paths that run inside the worker or door use those roles.

### 27.3 What the runtime roles can never do

Each line is enforced by Postgres privilege rules for a non-owner, non-superuser role and is a negative test in
section 27.6:

| Operation | `kj_worker` | `kj_door` |
|---|---|---|
| ALTER, DROP or CREATE any table, view, function, trigger, type or schema | no | no |
| disable or enable a trigger; `SET session_replication_role` | no | no |
| enable, disable or force row level security; create, alter or drop a policy | no | no |
| TRUNCATE any table | no | no |
| GRANT or REVOKE anything | no | no |
| apply or record a migration | no | no |
| execute `activate_release`, or write `release_epoch` or `release_activations` (no INSERT, UPDATE or DELETE grant; the lock-and-stamp of section 27.9 is performed by the trigger function with the owner's rights, never by a grant) | no | no |
| execute `set_identity_freeze` | no | no |
| execute `set_reflection_mode`; insert into `reflection_governance` | no | no |
| execute `open_growth_window` or the deployment close; insert into either window table | no | no |
| UPDATE or DELETE on any append-only table (also refused by `reject_ledger_mutation`) | no | no |
| assume another role; bypass row level security | no | no |

**Approval and adoption.** `kj_worker` has no way to approve or adopt directly. It may insert an
`identity_model_adoptions` row and update a candidate's state, but only rows that pass the section 18 triggers,
which it cannot alter or disable. **Identity versions and activations:** it may insert them, as it does today, and
only rows that pass the existing and replaced guards; there is no ungoverned write.

### 27.4 Grant manifest

One file in the repository is the single source of the grants: for each role, each object, the verbs, the columns
for column-level UPDATE, the functions executable, and the row level security policy. The B1 migration is generated
from it or checked against it, and a test compares the live catalogue with it in both directions. What counts as a
runtime capability fact on the catalogue side is defined once, by section 27.11.

**Row level security.** Every table already has it enabled and no policy exists. A non-owner role therefore sees
nothing until policies are added. The B1 migration adds, per table and per verb in the manifest, one explicit policy
`to kj_worker` or `to kj_door`. It does not grant `BYPASSRLS` and does not disable row level security. Tenant
isolation continues to be enforced where it is today, by `withTenant` and the composite keys; the policies do not
weaken it. Views keep `security_invoker`.

**`kj_worker`, P1 to P7 baseline** (static survey of the code at `750d5b7`; INFERENCE until the inventory of 27.6
step 1 completes and freezes it):

| Verb | Objects |
|---|---|
| SELECT | every table and view in `public` and `kernel_private`. Trigger functions are `security invoker`, with the single enumerated exception of section 27.9, and read widely (tasks, admissions, approvals, task events, identity tables), so the worker's reads are not narrowed further |
| INSERT | the tables the worker writes today: `tasks`, `task_steps`, `task_events`, `evidence`, `artifacts`, `outcomes`, `approvals`, `evaluations`, `observations`, `entities`, `relationships`, the capability tables, the memory tables, the schedule tables, `faculty_pins`, the identity tables, `principals`, `tenant_memberships`, and in `kernel_private` `execution_bindings`, `task_admissions`, `dispatch_events`, `effect_receipts`, `control_events`, `control_assertions`, `identity_cognition_latches`, `alert_state`, `terminal_results`, the notification tables and the Telegram tables |
| UPDATE | only where the code updates today: `tasks`, `approvals`, `schedule_fires`, `identity_candidates` (columns `state`, `resolved_at`), `memory_candidates`, `kernel_private.telegram_approval_cards`, and the upsert targets of the alert state store, the ledger and the scheduler store |
| DELETE | `kernel_private.control_assertions` (nonce retention) and `schedule_leases` |
| EXECUTE | the non-trigger private functions the code calls today (`identity_cognition_source_v1`, `identity_core_digest_v1` and those the inventory finds). Trigger functions need no EXECUTE grant |

**`kj_door`, P1 to P7 baseline:** SELECT on what admission, status and the read views need; INSERT on
`kernel_private.execution_bindings`, `kernel_private.task_admissions` and `kernel_private.dispatch_events`; no UPDATE
and no DELETE. The inventory fixes the exact SELECT list.

Nothing is revoked from a path production needs: the baseline is derived from what the code does, completed by the
inventory, and proved by the full suite before cutover.

### 27.5 P8 grants (exact)

| Object | `kj_worker` | `kj_door` |
|---|---|---|
| `kernel_private.reflection_admission_reservations` | SELECT | SELECT, INSERT |
| `kernel_private.reflection_governance` | SELECT | SELECT |
| `public.reflection_proposals`, `reflection_evaluations`, `reflection_dispositions`, `reflection_support` | SELECT, INSERT | none |
| `public.self_model_observations`, view `self_model_current` | SELECT, INSERT (table); SELECT (view) | none |
| `public.identity_candidates` | as the baseline (model-origin inserts from P8A-2) | none |
| `public.identity_profiles` | as the baseline | SELECT (owner check) |
| `kernel_private.identity_model_adoptions` (P8B) | SELECT, INSERT | none |
| `kernel_private.identity_growth_windows`, `identity_growth_window_closures` (P8B) | SELECT | none |
| `kernel_private.freeze_reflection` | EXECUTE | none |
| `kernel_private.close_growth_window_by_owner` (P8B) | EXECUTE | none |
| `kernel_private.set_reflection_mode`, `open_growth_window`, deployment close | none | none |

- No UPDATE, DELETE or TRUNCATE on any P8 table, for either role.
- The `security definer` functions are owned by the deployment owner, set `search_path = ''`, take only ids, validate
  the task as section 17 states, and are revoked from `PUBLIC`.
- **Runtime-role guard.** Every trigger on a runtime-written P8 table (reservations, proposals, evaluations,
  dispositions, support, observations, model-origin candidates and adoption bindings) first checks `session_user`.
  If it is not `kj_worker` or `kj_door`, the write is refused `P8_OWNER_ROLE_REFUSED`. `session_user` is used, not
  `current_user`, so the check holds inside a definer function. P8 therefore cannot operate under the owner at all:
  a return to `postgres` makes P8 stop, it does not make P8 run with wider authority. This is a guard against an
  operational fallback. It is not a defence against a hostile owner, who can alter anything.

### 27.6 Qualification method

1. **Inventory.** A script extracts every SQL statement in `services`, `apps` and `packages` and every table a
   trigger function reads or writes, and produces the object, verb and column list. That list, reviewed, becomes the
   grant manifest. The static baseline in 27.4 is its starting point, not its substitute.
2. **Catalogue equality.** After the B1 migration, role attributes, memberships, table and column grants, function
   grants, ownership and policies read from the catalogue, as runtime capability facts under section 27.11, equal the
   manifest exactly. An extra privilege fails the check, as a missing one does. The same check asserts the `SECURITY DEFINER` inventory rule of section 27.10 for the
   stage being qualified (at B1: `EXPECTED(B1)`, the frozen platform baseline, the target's declared co-resident
   platform exceptions of section 27.12 and the section 27.9 exception), every item of section 27.9.4 for the section
   27.9 exception, and every item of section 27.12.3 and 27.12.4 for each declared co-resident exception.
3. **Positive requalification, P1 to P7.** The complete existing suite, the faculty, identity and cognition mutation
   suites and the real-Restate tests run with the worker connected as `kj_worker` and the door as `kj_door`, against
   a database migrated by the owner. Required: the same pass and skip counts as the baseline run at the same commit,
   and zero `42501` (insufficient privilege) errors in the database log for the whole run.

   Revision 2.7.7 (R276-B1) states how this is met once every B1 application goes through the runner (27.12.15). The
   complete existing suite and the real-Restate tests run in stage T of runner runs, the worker connected as
   `kj_worker` and the door as `kj_door`, against databases the runner migrated, under the retained gates of 27.12.15:
   the protected-test baseline, intentional-skip accounting, the recovery minimum, zero runtime-role `42501` by trace
   and by database log, and the discover inventory.

   The faculty, identity and identity-cognition mutation suites cannot run inside stage T. Each of their mutations
   edits either a base migration, which the runner's export refuses unless its bytes equal its pin (27.12.11 step 7),
   or application code, which leaves the checkout of `R` dirty, which the runner refuses before it opens anything
   (27.12.6 step 1). They therefore run in lane A, with the harness in mode `base`, exactly as they did before B1,
   and each must kill every mutation it lists, as before. What remains B1-specific:
   - every database-backed test file these suites use also runs unmutated in stage T under the runtime roles, under
     the zero-`42501` gates;
   - B1 creates no relation, sequence, view or function, and every GRANT and policy in it names only `kj_worker` or
     `kj_door` (OBSERVED in the frozen B1 migration). Its other statements (corrected in revision 2.7.8) revoke from
     `PUBLIC` (function EXECUTE on the enumerated set, `CREATE` on schema `public`, `TEMPORARY` on the database) and
     from the runtime roles, alter the stamp function's security attributes (section 27.9), and create and alter the
     two runtime roles. Case CON-32 pins that whole shape. So B1 does change catalogue facts, but only by removing
     privileges from `PUBLIC` or the runtime roles or by changing the runtime roles and the stamp function. Without
     B1, lane A's assertions about other grantees are therefore equal or stricter: lane A fails closed, it cannot pass
     where the same assertion with B1 would fail.

   What is not retained: a mutated build is never run with production code under the runtime roles, so whether each
   mutation would still be killed there is not shown. This is a stated residual, not an equivalence.
4. **Negative qualification.** Connected as each runtime role, every operation of section 27.3 is attempted and must
   fail, with `42501` or the named refusal. From P8A-0 the list also covers the P8 denials of 27.5. The committed
   negative suite includes every probe of section 27.9.5. A check that has not been seen to fail is not accepted.
5. **Production cutover**, in its own change window: credentials provisioned through the vault tooling, value never
   in an argument; worker and door restarted on the runtime roles; `current_user` read from each running process;
   a P1 to P7 live proof (a mission, a scheduled fire, an approval, a Telegram round trip); health green.
6. **Soak.** P8A-0 is not applied to production until B1 has run through at least one full scheduler cycle and one
   live mission with zero insufficient-privilege errors.

### 27.7 Fail-closed semantics

- If B1 cannot be established or does not qualify, P8 stays unavailable. Nothing in P8 is deployed.
- A missing grant found after cutover is fixed forward: a reviewed manifest change and a migration in a change
  window. It is never fixed by connecting a service as the owner.
- Before any P8 object exists in production, reverting the role change is an ordinary P1 to P7 rollback and returns
  the system to its recorded pre-B1 state, with P8 still absent.
- Once a P8 object exists in production, running a runtime process as the owner is prohibited. If it happens, the
  runtime-role guard refuses every P8 write and `database.runtimeRolesLeastPrivilege` raises P0. Existing P1 to P7
  paths are not made to depend on P8, so they are not broken by P8 refusing.
- There is no temporary owner mode, no break-glass switch for P8 and no degraded mode that widens authority.
- **An unexpected runtime capability fact found in target qualification stops B1** (section 27.11.5). It is classified
  and reported. A platform grant is not revoked without separate authority, and target-specific authority is not added
  to the repository manifest to make health green. A genuinely required new runtime capability is a reviewed manifest
  change under the design authority, as the second bullet above already requires.

### 27.8 What B1 does not change, and the one thing it may

**Unchanged by B1:**

- externally observable P1 to P7 behaviour;
- application contracts;
- every function body;
- trigger topology: no trigger is created, dropped, altered, enabled, disabled or re-attached;
- table ownership: no table changes owner;
- row level security settings: none is relaxed;
- deployment authority, and release and change-window authority;
- applied migration files: none is edited; B1 is a new migration.

**Permitted security-mechanism change, exactly one:**

- `kernel_private.stamp_binding_provenance()` may change from `SECURITY INVOKER` to `SECURITY DEFINER`, under every
  constraint of section 27.9.

There is no other. The general rule stands: an existing P1 to P7 function stays `SECURITY INVOKER` unless this
design enumerates it by exact identity. A change to any other function's security attribute is outside this design
and needs its own revision and seal.

**Not touched by B1 at all (revision 2.7):** a co-resident platform exception of section 27.12 and its event-trigger
topology. B1 changes none of its attributes, its ACL included: B1's `PUBLIC` EXECUTE cleanup excludes functions
returning `pg_catalog.event_trigger` (27.12.5), and B1's pre-COMMIT check fails if any declared exception differs
afterwards from its sealed pin (27.12.7).

### 27.9 The release-provenance definer exception (P8-R23-DEFINER)

#### 27.9.1 Decision

The existing `execution_bindings` INSERT path must keep performing its bounded release-provenance lock-and-stamp
without either runtime role holding any direct authority over `kernel_private.release_epoch`. The trigger function
therefore runs with the deployment owner's rights.

**Option B, granting the runtime roles `UPDATE` on `release_epoch`, is rejected.** It is the direct write that
section 27.3 forbids, and a row policy cannot restrict an UPDATE to "value unchanged". No direct INSERT, UPDATE or
DELETE on `release_epoch` or `release_activations` is granted to `kj_worker` or `kj_door`.

This is not a general permission to convert P1 to P7 functions. It is one function, named exactly.

#### 27.9.2 Constraints

All of these hold, and each is asserted by 27.9.4 or probed by 27.9.5.

1. **Exact identity.** `kernel_private.stamp_binding_provenance()`: zero arguments, returns `trigger`, exactly one
   function of that name in any schema outside the excluded PostgreSQL schemas of section 27.10.2, whatever its
   arguments, owner or security attribute (section 27.10.6). No second schema copy, no overload, no shadow function,
   no family, no wildcard.
2. **Body immutability.** The B1 migration changes only security attributes of this function. It contains no
   `CREATE FUNCTION` or `CREATE OR REPLACE FUNCTION` for it. The source stays identical to the pre-B1 definition,
   proved by the digest of 27.9.3.
3. **Owner.** The function stays owned by the deployment owner. The runtime roles own nothing.
4. **Search path.** `search_path = ''` is set on the function, re-asserted by the B1 migration and read from the
   catalogue, where `proconfig` must equal exactly the value of 27.9.4. Every relation reference in the body is
   schema-qualified (the body names one relation, `kernel_private.release_epoch`).
5. **EXECUTE ACL.** EXECUTE is revoked from `PUBLIC`. Neither `kj_worker` nor `kj_door` is granted EXECUTE. The
   runtime reaches the function only because its existing trigger fires.
6. **Trigger topology.** The function is attached to exactly one trigger: `execution_bindings_provenance`, BEFORE
   INSERT, FOR EACH ROW, on `kernel_private.execution_bindings`, enabled normally, with no `WHEN` condition (the
   exact catalogue values are in 27.9.4). Qualification fails if it is attached anywhere else, or if that trigger
   differs. The runtime roles cannot create or alter a trigger, attach the function elsewhere, or
   replace or alter the function.
7. **No caller-controlled input.** The function takes no argument, contains no dynamic SQL (`EXECUTE`), no
   caller-controlled identifier, no `SET ROLE`, no session authorization, and calls no replaceable helper. The only
   function call in the body is `pg_catalog.clock_timestamp()`. The source writes it as `clock_timestamp()`; with the
   function's empty `search_path`, only `pg_catalog` can supply it, and PostgreSQL never resolves a function name
   from a temporary schema. The source digest of 27.9.3 remains the ultimate pin of the body.
8. **Write ceiling.** With the owner's rights it does exactly what it does today and nothing more:
   - one `UPDATE kernel_private.release_epoch SET epoch = epoch WHERE singleton RETURNING epoch`, which leaves the
     value unchanged;
   - assignment of `release_epoch` and `persisted_at` on the row being inserted.

   It cannot change the epoch's value, activate a release, write `release_activations` or any other table, perform a
   deployment or migration action, or touch any reflection or P8 object.
9. **Direct table authority.** As 27.9.1: none.
10. **Release authority.** `activate_release` stays unavailable to the runtime roles. Deployment and change-window
    authority are unchanged.
11. **Concurrency is preserved, not altered.** The no-op UPDATE takes the `release_epoch` row lock for the life of
    the inserting transaction, exactly as before. A transaction that has inserted a binding can therefore make
    `activate_release` wait, or fail under a lock timeout, until it ends. That is an existing P1.3 property. B1 does
    not introduce it and revision 2.4 does not change it.

#### 27.9.3 Source digest

- **Definition.** The digest is the lowercase hexadecimal SHA-256 of `pg_proc.prosrc` for the function, encoded as
  UTF-8, after replacing every CRLF with LF. Nothing else is normalised.
- **Pin.** The value is recorded in the B1 frozen manifest beside the function's identity.
- **Two independent derivations must agree** before the value is accepted:
  1. from the catalogue of a database migrated from `main` without the B1 migration;
  2. from the text between the dollar quotes of the function's definition in applied migration
     `20260916205049_release_provenance.sql`.
- **After the B1 migration** the catalogue value must still equal the pin. A different value fails catalogue
  equality and the health check.
- Any later change to this function's body is a new design revision, a new pin and a new seal.

#### 27.9.4 Catalogue assertions

The B1 catalogue check asserts, for this function, and fails on any difference:

| Fact | Required value |
|---|---|
| identity and signature | schema `kernel_private`, name `stamp_binding_provenance`, no arguments (`pronargs = 0`), return type `pg_catalog.trigger`, `proretset = false`, `prokind = 'f'` |
| name uniqueness | exactly one `pg_proc` row named `stamp_binding_provenance` in all schemas outside the excluded PostgreSQL schemas of 27.10.2, whatever its schema, arguments, owner or security attribute, and it is this function (27.10.6); no platform-baseline entry can legitimise a second |
| `prosecdef` | true |
| owner | the deployment owner |
| `proconfig` | exactly a one-element `text[]` whose element is the 14-character text `search_path=""` (SQL literal `'{"search_path=\"\""}'::text[]`); no other element |
| ACL (catalogue) | `proacl` is not null and is exactly one `aclitem`: the owner, privilege EXECUTE, granted by the owner (`{<owner>=X/<owner>}`). So there is no EXECUTE for `PUBLIC`, `kj_worker`, `kj_door` or any other role; and `has_function_privilege` is false for both runtime roles. A null `proacl` fails, because it means the default, which grants EXECUTE to `PUBLIC` |
| source digest | equals the manifest pin (27.9.3) |
| trigger attachment | exactly one `pg_trigger` row has `tgfoid` equal to this function, and in it: `tgname = 'execution_bindings_provenance'`; `tgrelid` is `kernel_private.execution_bindings`; `tgtype = 7` (row-level 1 + BEFORE 2 + INSERT 4: BEFORE INSERT FOR EACH ROW); `tgenabled = 'O'`; `tgqual` is null (no `WHEN` condition); `tgisinternal = false`; `tgnargs = 0`; `tgattr` empty |
| `SECURITY DEFINER` inventory | at B1 the KernelJSON stage manifest contains only this function; at every stage the inventory follows section 27.10 (`EXPECTED(stage)`) |

Each assertion ships with a negative case that makes it fail on purpose.

#### 27.9.5 Negative probes

Committed, automated, run on genuine login sessions of **both** `kj_worker` and `kj_door`, each with a pinned result.
"Refused" means two things, both required: the statement fails with the SQLSTATE given, and a catalogue or table
re-read made by the owner afterwards shows nothing changed. A statement that completes with only a warning is not a
refusal.

| Probe | Required result |
|---|---|
| `select kernel_private.stamp_binding_provenance()` | refused, `42501` (insufficient privilege). Any other SQLSTATE fails the probe, in particular `0A000` ("trigger functions can only be called as triggers"), which would mean the privilege check passed. This probe corroborates the ACL; it is not the proof. The proof is the independent `proacl` assertion of 27.9.4 |
| `UPDATE kernel_private.release_epoch` in the no-op form (`set epoch = epoch`) | refused, `42501`; epoch unchanged |
| `UPDATE kernel_private.release_epoch` changing the value | refused, `42501`; epoch unchanged |
| `INSERT` into `kernel_private.release_epoch` | refused, `42501` |
| `DELETE` from `kernel_private.release_epoch` | refused, `42501`; the row remains |
| `INSERT` into `kernel_private.release_activations` | refused, `42501` |
| `UPDATE` of `kernel_private.release_activations` | refused, `42501`; rows unchanged |
| `DELETE` from `kernel_private.release_activations` | refused, `42501`; rows unchanged |
| execute `kernel_private.activate_release(...)` | refused, `42501`; epoch and activations unchanged |
| `CREATE OR REPLACE FUNCTION kernel_private.stamp_binding_provenance()` | refused, `42501`; source digest unchanged |
| `ALTER FUNCTION ... OWNER TO` either runtime role | refused, `42501`; owner unchanged |
| `ALTER FUNCTION ... SECURITY INVOKER` | refused, `42501`; `prosecdef` still true |
| `ALTER FUNCTION ... SET search_path = public` | refused, `42501`; `proconfig` unchanged |
| `ALTER FUNCTION ... RESET search_path` | refused, `42501`; `proconfig` unchanged |
| `GRANT EXECUTE ON FUNCTION ... TO` either runtime role or `PUBLIC` | refused, `42501` (the role holds no privilege on the function); `proacl` unchanged |
| `CREATE TRIGGER` attaching the function to another table | refused, `42501`; trigger topology unchanged |
| `CREATE TRIGGER` attaching it a second time to `kernel_private.execution_bindings` | refused, `42501`; still exactly one attachment |
| `DROP TRIGGER execution_bindings_provenance` | refused, `42501`; trigger present |
| `ALTER TRIGGER execution_bindings_provenance ... RENAME TO ...` | refused, `42501`; name unchanged |
| `ALTER TABLE kernel_private.execution_bindings DISABLE TRIGGER execution_bindings_provenance` (and `DISABLE TRIGGER ALL`, `ENABLE REPLICA TRIGGER`) | refused, `42501`; `tgenabled` still `'O'` |
| `CREATE FUNCTION public.stamp_binding_provenance() returns trigger ...`, and the same in `kernel_private` | refused, `42501` (no CREATE on any schema); name uniqueness of 27.10.6 still holds |
| `CREATE SCHEMA` (any name), then create a function in it | refused, `42501` (no CREATE on the database) |
| create a temporary table named `release_epoch` | refused, `42501` (no TEMPORARY on the database) |
| create a table in `public` named `release_epoch` | refused, `42501`; so name resolution cannot be redirected |
| change the session `search_path` (for example to `public, pg_temp`), then insert a binding | the stamp is unaffected: the canonical epoch and a fresh timestamp |
| insert a binding with forged `release_epoch` and `persisted_at` values | the insert succeeds and both columns are overwritten with the canonical epoch and a fresh timestamp |
| insert bindings repeatedly | the release epoch's value does not change |

The SQLSTATE values are INFERENCE from PostgreSQL's privilege rules (a non-owner without the privilege gets `42501`;
the EXECUTE check on a function runs at executor start, before the language handler that raises `0A000`). They were
not executed in revision 2.5. B1 qualification must observe each one. If PostgreSQL returns a different SQLSTATE for
a refusal, B1 stops and the probe is re-specified by a design revision; it is never relaxed to "any error".

#### 27.9.6 What the B1 review must verify

A green suite is not sufficient for B1 to pass. The independent B1 hostile review must itself inspect, for this
exception: the function source; its owner; its ACL; its `search_path`; the direct table grants on `release_epoch` and
`release_activations` (none); the trigger topology; the source digest and both of its derivations; the negative
probes and their results; and the separation of `activate_release` from the runtime roles. If any of these is not
as section 27.9 states, B1 does not pass.

### 27.10 The stage-aware `SECURITY DEFINER` inventory (P8-R24-B1)

#### 27.10.1 One rule

This section is the single normative definition of the `SECURITY DEFINER` inventory. Sections 20 (B1 gate 3b), 21
(`database.runtimeRolesLeastPrivilege`), 27.6 step 2 and 27.9.4 refer to it and add nothing to it. Its contract
identity is `kerneljson:security-definer-stage-manifest/v1`. It is repository-controlled and is specified here only;
it is implemented in its authorised stage (the B1 remediation for the B1 entry and the platform baseline, P8A-0 and
P8B for theirs). The invariant is not "there is one `SECURITY DEFINER` function forever". It is:

> At every rollout stage, the complete set of `SECURITY DEFINER` functions in every governed schema is exactly the
> frozen platform baseline, together with the co-resident platform exceptions the target declares under section
> 27.12, together with the KernelJSON functions this design authorises for all stages applied so far.

```
EXPECTED(stage, target) = PLATFORM_BASELINE(target)
                    UNION CO_RESIDENT_PLATFORM_EXCEPTIONS(target)      -- section 27.12 (revision 2.7)
                    UNION KERNELJSON_STAGE_MANIFEST(stage)
ACTUAL                  = { every pg_proc row with prosecdef = true whose schema is governed (27.10.2) }
```

Revision 2.7 adds the middle term only. The three terms are disjoint by construction (27.10.4 eligibility, 27.12.2);
an identity that would fall in two of them fails. Where this design writes `EXPECTED(stage)` it means
`EXPECTED(stage, target)` for the target being qualified or checked.

`ACTUAL` must equal `EXPECTED(stage)` in both directions, under the identity and attributes of 27.10.3 and 27.10.4:

| Difference | Result |
|---|---|
| a function in `ACTUAL` and not in `EXPECTED(stage)` (extra) | fail |
| a function in `EXPECTED(stage)` and not in `ACTUAL` (missing) | fail |
| an expected function present with a different identity: other schema, name or argument types | fail (it is both missing and extra) |
| owner differs | fail |
| return type differs | fail |
| any other pinned attribute differs (configuration, ACL, source digest, language) | fail |

In runtime health every failure is P0. No stage authorises itself: the inventory follows the rollout order of
section 19 and the sequence document, and grants no stage.

#### 27.10.2 Governed and excluded schemas

The only schemas excluded from the inventory are PostgreSQL's own internal and transient schemas, selected by this
exact predicate over `pg_namespace.nspname`:

```
EXCLUDED(nspname) :=  nspname IN ('pg_catalog', 'information_schema', 'pg_toast')
                   OR nspname ~ '^pg_temp_[0-9]+$'
                   OR nspname ~ '^pg_toast_temp_[0-9]+$'
```

Every schema for which `EXCLUDED` is false is **governed**, whatever its name and whatever role owns it. That
includes `public`, `kernel_private` and every platform-owned schema present in the target environment. No phrase such
as "system", "platform" or "relevant" schemas has any other meaning in this design.

Why this cannot be widened by an application: PostgreSQL reserves the `pg_` prefix, refusing `CREATE SCHEMA` with
such a name (SQLSTATE `42939`) unless `allow_system_table_mods` is on, which only a superuser can set; and it names
each backend's temporary schemas `pg_temp_<n>` and `pg_toast_temp_<n>` with `<n>` a decimal number. Both facts are
INFERENCE from PostgreSQL behaviour, not executed in revision 2.5. B1 qualification must observe them: read
`pg_namespace` after the owner creates a temporary table in a qualification session, and attempt
`CREATE SCHEMA pg_kj_probe` as the owner without `allow_system_table_mods`. If either differs, B1 stops and this
predicate is re-specified by a design revision.

#### 27.10.3 The KernelJSON stage manifest

**Identity** of a function is its schema name, its function name and its ordered input argument types, each type
written as `<type schema>.<type name>` from `pg_type` and `pg_namespace` (for example `pg_catalog.uuid`). This is
PostgreSQL's own function identity, which is defined by input argument types and not by return type. It is read
without depending on the session `search_path`. The **return type** is asserted separately, as
`<type schema>.<type name>` of `prorettype`, together with `proretset`.

| Function identity | Return type | In the manifest from | Contract |
|---|---|---|---|
| `kernel_private.stamp_binding_provenance()` | `pg_catalog.trigger` | B1 | section 27.9 (authoritative for every attribute) |
| `kernel_private.freeze_reflection(pg_catalog.uuid)` | `pg_catalog.void` | P8A-0 | sections 17.1 and 27.5 |
| `kernel_private.close_growth_window_by_owner(pg_catalog.uuid, pg_catalog.uuid)` | `kernel_private.identity_growth_window_closures` | P8B | sections 17.2 and 27.5 |

The stage sets are exact:

| Stage | `KERNELJSON_STAGE_MANIFEST(stage)` |
|---|---|
| B1 | `stamp_binding_provenance()` |
| P8A-0 | `stamp_binding_provenance()`, `freeze_reflection(uuid)` |
| B2 | the same as P8A-0 |
| P8A-1 | the same as P8A-0 |
| P8A-2 | the same as P8A-0 |
| P8B | `stamp_binding_provenance()`, `freeze_reflection(uuid)`, `close_growth_window_by_owner(uuid, uuid)` |

No stage contains anything else. There is no inferred future entry and no wildcard. B2, P8A-1 and P8A-2 add no
`SECURITY DEFINER` function: no sealed section authorises one. Any further KernelJSON `SECURITY DEFINER` function
needs its exact identity, a sealed design revision or addendum, an entry in this manifest and a hostile review, all
before it is deployed.

**Attributes asserted for each KernelJSON entry**, in addition to identity and return type (`proretset = false` and
`prokind = 'f'` for all three):

| Attribute | `stamp_binding_provenance()` | `freeze_reflection(uuid)` and `close_growth_window_by_owner(uuid, uuid)` |
|---|---|---|
| `prosecdef` | true | true |
| owner | the deployment owner (27.9.2 item 3) | the deployment owner (27.5) |
| `proconfig` | exactly the value of 27.9.4 | exactly the same value: one element, `search_path=""` (27.5: `search_path = ''`) |
| ACL | exactly the 27.9.4 value: owner EXECUTE only | exactly two `aclitem`s: the owner's EXECUTE and EXECUTE for `kj_worker`; nothing for `PUBLIC` or `kj_door` (27.5) |
| source digest | equals the 27.9.3 pin | the 27.9.3 procedure applied to the function's source at that stage's implementation, recorded in this manifest by that stage and compared from then on |
| trigger topology | 27.9.4 | not a trigger function; attached to no trigger |

Each KernelJSON function's own stage contract (sections 17 and 27.5 for the two P8 functions, section 27.9 for the
stamp function) keeps every authority boundary it already has. This section adds none and removes none.

#### 27.10.4 The frozen platform baseline

Platform functions in governed schemas are not ignored. They are listed, exactly, in a frozen baseline.

**Artefact.** `kerneljson:security-definer-platform-baseline/v1`, a repository-controlled engineering artefact of B1
qualification, reviewed by the B1 hostile review and committed with the B1 remediation. It is not a value of this
ADR and is not fabricated in it.

**Mode and run binding** (revision 2.7.4, R273-B1). The baseline carries the same `mode` and, when ephemeral, the same
`run` object as the co-resident declaration taken in the same read (27.12.6, 27.12.13.4), with the same exact schema:
`run` is required for `EPHEMERAL_RUN_BOUND` and absent for `HOSTED_COMMITTED`, and no other field is allowed.
- A `HOSTED_COMMITTED` baseline is taken from the named hosted target by the snapshot procedure below, committed at the
  release commit `R` that carries it, reviewed by the B1 hostile review, and frozen. It is the only kind that can
  satisfy section 20 gate 3b, deployed health or target qualification.
- An `EPHEMERAL_RUN_BOUND` baseline is taken only from a database in the cluster the runner created in the current
  run (27.12.13.3), is written once into that run's directory, is immutable after capture, and is never committed.
  It satisfies none of gate 3b, deployed health or target qualification.
- **An ephemeral baseline is self-referential at capture.** It is read from the very database it will be compared with,
  so it proves no independent historical provenance: it does not show that the platform's definers are the ones a
  reviewer accepted, only what they were at S3. It detects drift only after the snapshot, together with the
  pre-application inventory equality of 27.12.11 step 8, the migration's P1 to P3 and post-migration qualification.
  The independent, reviewed baseline exists only in hosted mode.

**Snapshot procedure.** Before the B1 migration is applied to the target environment, the deployment owner runs, in
one `READ ONLY` transaction with `search_path = ''`, the same inventory query as `ACTUAL` over the governed schemas of
27.10.2. Nothing is written. The artefact records, as provenance:
- the environment's name, `system_identifier` from `pg_control_system()`, `current_database()` and `version()`;
- the server time `clock_timestamp()` and `current_user` of the snapshot;
- the head of the applied migration ledger, showing the B1 migration is not yet applied, so every entry existed
  before B1;
- the SHA-256 of the exact query text;
- the SHA-256 of the canonical serialisation of the entries (RFC 8785 JSON, entries sorted by schema, name and
  argument types).

**Each entry** pins: schema; function name; ordered input argument types and return type, both as in 27.10.3;
`proretset`; owner role name; `prosecdef = true`; language name (`pg_language.lanname`); `proconfig` exactly
(including null); and a source digest by this deterministic rule, all SHA-256 over UTF-8 after replacing every CRLF
with LF, lowercase hexadecimal:
1. language `internal` or `c` (where `prosrc` is only a symbol name): the digest of
   `lanname || LF || coalesce(probin, '') || LF || prosrc`;
2. otherwise, if `prosqlbody` is not null (a SQL-standard body, where `prosrc` is empty): the digest of
   `pg_get_function_sqlbody(oid)`;
3. otherwise: the digest of `prosrc`, which is the 27.9.3 rule.

**Eligibility.** The baseline may contain no function whose schema is `public` or `kernel_private`, no function named
`stamp_binding_provenance`, and no function whose identity appears in any stage of 27.10.3. If the snapshot finds
such a function, it is not baselined: B1 does not qualify, and the finding goes to a design revision.

Revision 2.7 keeps this rule unchanged and adds one routing step before the refusal. A `SECURITY DEFINER` function in
`public` or `kernel_private` that is not a KernelJSON stage function is still never a baseline entry. The snapshot
compares it with the co-resident pins sealed in section 27.12.3: if it equals a pin exactly, function and
event-trigger topology together, it is recorded in the target's co-resident artefact (27.12.6), not in the baseline;
otherwise the refusal above applies unchanged. In addition, the baseline may contain no function whose name equals the
name of a sealed co-resident pin, in any governed schema (27.12.2 item 6), so a copy or overload outside `public`
cannot be baselined.

**Immutability.** The baseline is fixed for a qualification run and for the release that carries it. The health check
compares against the baseline in the running release, which must be `HOSTED_COMMITTED` (revision 2.7.4). If the platform later adds, removes or changes a definer
function, `database.runtimeRolesLeastPrivilege` goes red at P0 and B1 qualification fails, until a new snapshot is
taken by the same procedure, reviewed, and committed as a deliberate refresh. There is no silent learning and no
automatic acceptance.

#### 27.10.5 Which stage is applied

The stage used for `EXPECTED(stage)` is the stage declared by the stage manifest in the running release. A release
declares a stage only if it carries that stage's migrations. A database behind its release, or a release behind its
database, therefore fails equality and is P0. An earlier-stage database never requires a later-stage function, and a
later-stage database never fails because a function sealed for that stage exists.

#### 27.10.6 Global uniqueness of the stamp function name

Independently of the baseline and of `prosecdef`: there is exactly one `pg_proc` row named
`stamp_binding_provenance` in all governed schemas, and it is `kernel_private.stamp_binding_provenance()`, with zero
input arguments, returning `pg_catalog.trigger`. A second schema copy, an overload, or a shadow function of that name
fails, whether it is a definer or not. No baseline entry can legitimise one (27.10.4, eligibility).

#### 27.10.7 No schema escape hatch

Because the inventory covers every governed schema:
- creating a new application schema cannot hide a definer: the schema is governed, and the runtime roles cannot
  create one (no CREATE on the database);
- moving a function into another schema cannot hide it: its identity changes, so it is both missing and extra;
- a duplicate `stamp_binding_provenance` in any other schema fails (27.10.6);
- a schema whose name looks like a platform schema, or that a platform role owns, exempts nothing: only `EXCLUDED`
  exempts, and membership in the baseline is per function, never per schema;
- the runtime roles have no CREATE on any schema (27.2);
- KernelJSON migrations must not create KernelJSON-owned application objects inside a schema that holds a baseline
  entry unless a separately sealed design explicitly allows it.
- a co-resident platform exception (section 27.12) attaches to one exact function and its exact event-trigger
  topology, never to a schema. It is not a baseline entry, so `public` holding one does not engage the bullet above,
  and KernelJSON objects stay in `public` as already designed. It makes `public` no more trusted than before: a second
  platform function there, a changed or overloaded `rls_auto_enable`, a copy in any other schema and a second event
  trigger on it each still fail (27.12.9).

Each of these ships with a negative case that makes it fail on purpose: an extra definer in `public`, one in a new
schema created by the owner, a moved function, a second `stamp_binding_provenance`, a baseline entry with a changed
digest, a missing stage function, and a stage function with a wrong return type, owner or ACL.

#### 27.10.8 Existing implementation

The frozen B1 candidate `108db1b0db5923993eb17888d3039c5a32890c2c` predates revision 2.5 and is not changed by it. Its
`services/kernel/src/database/runtime-roles.ts` excludes only `pg_catalog`, `information_schema` and `pg_toast` from
the definer query, has no platform baseline, and its `compareDefinerFunctions()` compares only `schema.name` against
its manifest. It does not implement this section and is to be remediated only after revision 2.5 is hostile-sealed,
together with the reconciliation of `docs/operations/KJ_P8_B1_ENTRY_BRIEF.md` noted in section 26.

### 27.11 The runtime capability fact model (B1-R25-B1)

#### 27.11.1 One rule

This section is the single definition of a runtime-role capability fact: the catalogue side of the grant manifest's
equality in sections 21, 27.4 and 27.6 step 2. It is not the `SECURITY DEFINER` inventory rule (27.11.4).

For a database object inside a schema, a runtime capability fact exists for a runtime role if and only if:

```
EFFECTIVE_OBJECT_CAPABILITY(role, object, privilege) :=
      GOVERNED(schema_of(object))                                   -- section 27.10.2
  AND has_schema_privilege(role, schema_of(object), 'USAGE')        -- effective: direct or through PUBLIC
  AND <the PostgreSQL effective privilege predicate for the object> -- effective: direct or through PUBLIC
```

where the object predicate is `has_table_privilege` for a table, view, materialised view, foreign table or partitioned
table and its partitions; `has_column_privilege` for a column privilege not already held on the whole table;
`has_sequence_privilege` for a sequence; and `has_function_privilege(..., 'EXECUTE')` for an ordinary callable function.

**Ordinary callable function (revision 2.7).** Every `pg_proc` row in a governed schema is an ordinary callable
function for this rule except one whose return type is `pg_catalog.event_trigger`. An event-trigger function cannot
be invoked by a call: a direct call fails `0A000` before its body runs (INFERENCE, observed by the probe of 27.12.9),
and only an event trigger, which only a privileged role can create, runs it. Its EXECUTE ACL is therefore not a
runtime capability fact. This exclusion is closed, not open-ended: in `public` and `kernel_private`, the only schemas
the runtime roles can reach, every function returning `pg_catalog.event_trigger` must be a sealed co-resident
exception whose ACL is pinned exactly (27.12.4 rule E1), so an unpinned one fails instead of disappearing. Functions
returning `pg_catalog.trigger`, and every other function, are unchanged by this paragraph.

Rationale (FACT of PostgreSQL privilege semantics): an object inside a schema can be reached only by a role holding
USAGE on that schema, so an object ACL inherited through `PUBLIC` inside a schema the role cannot USAGE is not runtime
authority. This rule grants nothing. It states when an existing ACL is usable.

#### 27.11.2 Facts the gate does not apply to

These remain exact, independent facts, with nothing filtered:
- role attributes; role memberships, in both directions; ownership of any object;
- database CONNECT, CREATE and TEMPORARY;
- schema USAGE and schema CREATE, for **every** governed schema, effective (direct or through `PUBLIC`).

Because schema facts are exact, a new USAGE grant on any schema other than `public` and `kernel_private`, including a
platform schema, is immediately an unexpected `schema:<schema>:USAGE` fact: qualification fails and health raises P0.
Once that USAGE exists, the object privileges inside that schema are effective and become facts as well. That is the
intended tripwire: the gate cannot hide authority, because the authority it gates is itself a manifest fact.

#### 27.11.3 Function identity and policy facts

- **Function facts** are keyed by exact PostgreSQL function identity: schema, function name and ordered input argument
  types, each type written `<type schema>.<type name>`, read without depending on `search_path` (equivalent to a
  search-path-independent `regprocedure`). Return type is not part of overload identity. Keying by `schema.name`
  alone is not conforming: it collapses overloads.
- **Policy facts.** A row level security policy is not itself a grant of authority. A policy is a runtime-role policy
  fact if and only if:
  - it applies to the role, by name or through `PUBLIC`;
  - its relation's schema is governed and has effective USAGE for the role; and
  - the operation it governs (`SELECT`, `INSERT`, `UPDATE`, `DELETE`, or each of them for `ALL`) is represented by an
    effective relation or column capability fact of the role on that relation (27.11.1).

  Every KernelJSON-managed policy generated from the runtime manifest in `public` and `kernel_private` remains under
  exact equality. A policy on a relation the role cannot reach, or for an operation it holds no privilege for, is
  inert: it is not a fact and is not added to the runtime manifest. If the schema or object authority later becomes
  effective, the unexpected schema or object fact already makes health red, and the policy is then evaluated as part
  of the newly reachable surface. An unexpected policy never creates authority by itself.

#### 27.11.4 The `SECURITY DEFINER` inventory is not narrowed

Section 27.10 is unchanged. The definer inventory continues over every governed schema regardless of whether
`kj_worker` or `kj_door` has USAGE on it: `EXPECTED(stage, target) = PLATFORM_BASELINE UNION
CO_RESIDENT_PLATFORM_EXCEPTIONS UNION KERNELJSON_STAGE_MANIFEST(stage)` (revision 2.7 added the middle term, section
27.12) against every governed `SECURITY DEFINER` function. A definer in `auth`, `storage`, `extensions`, a new
application schema or any other governed schema remains inventoried and fingerprinted. The schema-USAGE gate of
27.11.1 is never applied to section 27.10.

#### 27.11.5 The manifest stays environment-independent; target qualification fails closed

- The runtime-role manifest stays repository-controlled and environment-independent. It does not list target-only
  objects (for example `auth.*`, `storage.*`, `extensions.*`, `graphql.*` or `pg_stat_statements`) merely because they
  carry `PUBLIC` ACLs on the hosted platform. There is no target-specific runtime grant baseline. The platform
  `SECURITY DEFINER` baseline of 27.10.4 remains target-specific, exactly as sealed.
- **In target qualification, if an unexpected runtime capability fact exists after applying 27.11: stop.** Classify it
  and report it. Do not revoke a platform grant without separate authority. Do not add target-specific authority to the
  repository manifest to make health green. A genuinely required new runtime capability is a reviewed manifest change
  under the design authority (section 27.7).

#### 27.11.6 Required B1 implementation hardening (no new authority)

These make the sealed mechanism exact. They are required in the B1 remediation and add no authority:

1. Function capability facts use exact overload identity (27.11.3), not `schema.name`.
2. The target snapshot tool refuses an empty connection-string file, so the PostgreSQL client can never fall back to
   `PG*` environment variables or a local default.
3. The snapshot requires that the migration ledger exists, that its head equals the final base migration of canonical
   `main` expected before B1, and that `kernel_private.stamp_binding_provenance()` exists. Otherwise it refuses.
4. Runtime health verifies that the committed target baseline's `systemIdentifier` equals the live database's system
   identifier; a different database is a P0 baseline mismatch.
5. Cutover wording must state the real transaction behaviour. Checks that run after the B1 migration has committed
   cannot roll it back: they either move inside the migration before COMMIT, or the plan states the actual forward or
   abort behaviour (a failed post-commit check stops the window and invokes the recorded rollback procedure).

#### 27.11.7 Negative cases

Each ships with a negative case that makes it fail on purpose: a `PUBLIC` table and function grant in a governed
schema without USAGE (no fact); the same after a USAGE grant on that schema (unexpected schema fact and object facts);
an overload of a manifest function (separate fact); a `PUBLIC` policy on an unreachable relation (no fact) and on a
reachable one (fact); and a definer in a schema without USAGE (still inventoried by 27.10).

### 27.12 Co-resident platform exceptions (revision 2.7; B1-R26-CORESIDENT)

#### 27.12.1 Decision

FACT, observed read-only on the production database on 07/10/2026 (drift footprint SHA-256
`90f3a0ff2a5408a8e2f0b462ea7304343d74ec8ca839551e0f83af02f1e97524`) and 08/10/2026 (PostgreSQL 17.6,
`system_identifier` `7678069749886157684`, REPEATABLE READ READ ONLY, empty `search_path`, rolled back):

- `public.rls_auto_enable()` exists. It is the only `SECURITY DEFINER` function in `public` and `kernel_private`.
- It is bound to the event trigger `ensure_rls`, enabled, on `ddl_command_end` for `CREATE TABLE`, `CREATE TABLE AS`
  and `SELECT INTO`. It is an active control that enables row level security on every table created in `public`.
- Its source is byte-identical to the auto-enable-RLS installer that Supabase Studio runs only on an explicit opt-in
  (an unticked-by-default option at project creation, or the RLS notice and event-trigger template). Before revision
  2.7, no KernelJSON migration, document or commit created or mentioned it (searched across every ref of the
  repository history).

**Decision.** KernelJSON preserves this control in place and unchanged, and models it exactly. It is not relocated,
deleted, disabled, re-owned or re-granted to make B1 qualify. The section 27.10.4 prohibition on baseline entries in
`public` and `kernel_private` stands. Revision 2.7 adds a third, separately sealed term to the inventory, the
co-resident platform exceptions, admissible only under every condition of 27.12.2.

**Rejected.**
- *Baseline it as an ordinary platform entry.* That attaches trust to whatever sits in `public`, and engages the last
  bullet of 27.10.7 for every KernelJSON object in `public`.
- *Relocate it to a non-KernelJSON schema.* That mutates a platform security control to satisfy an abstraction.
- *Delete or disable it.* That removes an active control; no security reason requires it.
- *"Platform functions in `public` are allowed", "Supabase-owned functions are trusted", or trust by name.* None of
  these is exact, and each would admit a changed or additional function.

#### 27.12.2 Admission conditions

An object is a co-resident platform exception of a target if and only if all of these hold:

1. **Design authority.** This section enumerates it by exact identity, with every value of 27.12.3 and every binding
   of 27.12.4. There is no wildcard, family, name-only entry or schema-wide entry. A new entry, or any change to a
   pinned value, is a new design revision, a hostile review and a new seal.
2. **Schema.** Its schema is `public` or `kernel_private`. A platform function in any other governed schema is
   handled by the ordinary baseline of 27.10.4 and cannot be a co-resident exception.
3. **Not KernelJSON.** It is not named `stamp_binding_provenance`; its identity is not in any stage of 27.10.3; no
   canonical KernelJSON migration creates or replaces a function of its name, qualified or not (a committed
   repository test); and its normalised source digest equals a cited external platform source at cited upstream
   revisions. A co-resident exception can never legitimise a KernelJSON-created definer.
4. **Pre-existence.** It is present in the target snapshot of 27.12.6, taken by the deployment owner before B1 under
   the sealed snapshot procedure of 27.10.4, which refuses if B1 is already applied.
5. **Target evidence.** The target's co-resident artefact (27.12.6) declares it, bound to the target's
   `system_identifier`, and the B1 hostile review has reviewed that artefact.
6. **Name uniqueness.** In all governed schemas there is exactly one `pg_proc` row with the pinned name, whatever its
   schema, arguments, return type, owner or security attribute, and it is the pinned identity. A copy in another
   schema, an overload and a shadow function each fail. No platform baseline entry may carry a pinned name (27.10.4).
7. **No learning and no refresh.** Neither health nor qualification writes, extends or regenerates any artefact. The
   snapshot tool writes a co-resident entry only for an object equal to a sealed pin (27.12.6).
8. **No reduction in coverage.** Section 27.10 stays global over every governed schema and section 27.11.4 is
   unchanged. The exception adds one exact member to `EXPECTED(stage, target)` and removes nothing.

#### 27.12.3 The exact pin: `public.rls_auto_enable()`

| Fact | Required value |
|---|---|
| identity | schema `public`, name `rls_auto_enable`, no input arguments (`pronargs = 0`) |
| return type | `pg_catalog.event_trigger`; `proretset = false`; `prokind = 'f'` |
| owner | the role named `postgres`. Rationale: the role that ran the platform installer, and on this target also the deployment owner of 27.2; pinned by name, as every baseline entry is. Never `kj_worker` or `kj_door`. Any other owner fails, however privileged |
| `prosecdef` | true |
| language | `plpgsql` (`pg_language.lanname`) |
| `proconfig` | exactly a one-element `text[]` whose element is `search_path=pg_catalog` (SQL literal `'{search_path=pg_catalog}'::text[]`); no other element |
| `proacl` | null (section 27.12.5) |
| other attributes | `provolatile = 'v'`, `proisstrict = false`, `proleakproof = false`, `proparallel = 'u'`, `probin` null, `prosqlbody` null |
| source digest | `2782e98b348aca7d6f6f73c420fd78d2e094957dd7a52b0483d4c34f29d2a7a1`, by rule 3 of 27.10.4 (the 27.9.3 rule: SHA-256 of UTF-8 `prosrc` after replacing every CRLF with LF); normalised source length 953 bytes |
| event-trigger topology | exactly the one binding `ensure_rls` of 27.12.4 |

**Provenance** (evidence for condition 3, not a runtime check). The digest equals the text between the dollar quotes of
`AUTO_ENABLE_RLS_EVENT_TRIGGER_SQL` in `apps/studio/components/interfaces/Database/Triggers/EventTriggersList/EventTriggers.constants.ts`
of `supabase/supabase` at `54a96831278818ff2fbdd82c51e225cdd0fecab8` (08/01/2026),
`0433eeb5f5cc6c41b80c85793a3b7be1fc976119` and `c569a29c26d03b084e8162f1c393d18bd9a17734` (30/06/2026). Upstream
changed the body at `536fbd547063cd7420b788e34c3150e542f3bfb8` (08/10/2026) to a different text (1055 bytes, digest
prefix `325ae266`). The Supabase documentation snippet is a third, different text (970 bytes). Neither is this pin.

**The pin does not follow upstream.** A re-install from a current Studio yields a body that fails this pin: health is
P0 and B1 does not qualify until a design revision seals the new body. Nothing restores or accepts it automatically.

**Forensic fields.** The observed raw digest equals the normalised digest and the source contains no CR. Raw digest,
raw length and a has-CR flag are recorded in the target artefact as forensic evidence; equality is decided on the
normalised digest only.

#### 27.12.4 Event-trigger topology

The function's authority is exercised only through its event trigger. The same source re-bound to another event or
other tags is a different control, so the binding is part of the fingerprint. Four rules, over `pg_event_trigger` and
the two KernelJSON schemas only:

- **E1.** Every `pg_proc` row in `public` or `kernel_private` whose return type is `pg_catalog.event_trigger`, whether
  or not it is a definer, is a sealed pin declared in the target artefact. Otherwise fail. KernelJSON therefore
  creates no event-trigger function in its schemas, and an unpinned platform one fails rather than being ignored.
- **E2.** Every `pg_event_trigger` row whose function's schema is `public` or `kernel_private` is a binding sealed for
  that function. Otherwise fail: a second event trigger on a pinned function, or one on any other function in those
  schemas, fails.
- **E3.** Every binding sealed for a declared pin exists exactly, in every column below. Missing, renamed, disabled
  (`'D'`), set to replica (`'R'`) or always (`'A'`) mode, re-bound, re-owned, on another event, or with different tags:
  fail.
- **E4.** Event triggers whose function is in another schema are outside this rule; KernelJSON does not baseline
  them. Any of their functions that is a definer remains inside section 27.10 through the ordinary baseline.

The sealed binding of `public.rls_auto_enable()`; exactly one `pg_event_trigger` row has `evtfoid` equal to it:

| `evtname` | owner | `evtevent` | function | `evtenabled` | `evttags` |
|---|---|---|---|---|---|
| `ensure_rls` | `postgres` | `ddl_command_end` | `public.rls_auto_enable()` | `'O'` | exactly the set {`CREATE TABLE`, `CREATE TABLE AS`, `SELECT INTO`}; order is not significant, a duplicate or any other element fails |

**Interactions** (INFERENCE from the pinned body and section 27.2, observed by the qualification named):
- The runtime roles cannot fire it: they have no CREATE on any schema and no TEMPORARY, and `CREATE TABLE AS` and
  `SELECT INTO` need CREATE too. Already a probe of 27.9.5.
- B1 creates no table, so it does not fire during B1.
- It fires inside KernelJSON migrations that create tables in `public` (P8A-0's reflection and self-model tables). It
  enables row level security, which those migrations enable anyway (27.4), so their end state is unchanged. On
  failure the pinned body re-raises, so the migration aborts: fail closed. P8A-0 qualification must expect its LOG
  lines and must not treat its effect as drift.

#### 27.12.5 ACL decision

**Decision: preserve.** The pinned `proacl` is null before B1, after B1 and at every health check. B1 does not change
it.

- Null means PostgreSQL's default: EXECUTE for `PUBLIC` and the owner.
- No authority reason requires a change. A direct call fails `0A000` before the body runs, whoever holds EXECUTE;
  firing does not check EXECUTE (both INFERENCE, section 26, observed in B1 qualification); the runtime roles cannot
  fire it (27.12.4). Revoking `PUBLIC` would change a
  platform control's catalogue state for no security gain.
- **No schema-wide routine ACL operation** (revision 2.7.2, R271-B1). B1 performs no GRANT or REVOKE of the form
  `ON ALL FUNCTIONS IN SCHEMA`, `ON ALL ROUTINES IN SCHEMA` or `ON ALL PROCEDURES IN SCHEMA` naming `public` or
  `kernel_private`, for any grantee (`PUBLIC`, `kj_worker`, `kj_door` or any other), and no `ALTER DEFAULT PRIVILEGES`
  on functions or routines. Every function ACL change B1 makes in those schemas names one concrete catalogue object.
  No GRANT or REVOKE in B1 names a function returning `pg_catalog.event_trigger`. Revision 2.7.1 replaced only the
  `PUBLIC` statement; the per-role statement `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public, kernel_private FROM
  kj_worker, kj_door` also materialises a null ACL, even where neither role held anything (OBSERVED, 27.12.12).
- **One enumerated cleanup for both grantee sets.** It replaces both frozen statements, in the same place in the
  migration:
  - **Set.** `C` is every `pg_proc` row whose schema is `public` or `kernel_private`, whose `prokind` is `f`, `a` or
    `w`, and whose `prorettype` is not `pg_catalog.event_trigger`, read once at that point in the migration.
  - **Kinds.** `f`, `a` and `w` are exactly the kinds the frozen `ON ALL FUNCTIONS` statements affected: plain,
    aggregate and window functions, and never procedures (`p`) (OBSERVED, 27.12.12). Procedures stay untouched, as
    they were. Adding `p` would widen B1 and is not part of this revision.
  - **Order.** Ascending `p.oid::pg_catalog.regprocedure::text` under `COLLATE "C"`.
  - **Statements.** For each member, with `<f>` its `regprocedure` text: `REVOKE EXECUTE ON FUNCTION <f> FROM PUBLIC`,
    then `REVOKE ALL ON FUNCTION <f> FROM kj_worker, kj_door`. `ON FUNCTION` accepts all three kinds (OBSERVED for
    `a` and `w`) and refuses a procedure with `42809` (OBSERVED), so a procedure that slipped into `C` would abort
    the migration, not change silently.
  - **Equivalence.** On every member of `C` the resulting `proacl` equals what the two frozen statements produce,
    including a function that already held a grant to a runtime role (OBSERVED, 27.12.12). The only difference is the
    skipped set.
  - **Skipped set.** Every function in those schemas returning `pg_catalog.event_trigger`, of any kind. Each must be
    a sealed pin with its exact null `proacl`: P2 (a) and rule E1 check that before COMMIT in the same transaction,
    so an unpinned skipped function aborts the migration `23514` and nothing commits (case ACL-C).
  - The rule names no target object, so the migration stays environment-independent.
- **Guards.** P2 (a) compares `proacl` exactly, so any ACL operation that materialises the pinned null aborts before
  COMMIT (case ACL-B). A repository test over the generated migration refuses the forbidden forms statically
  (27.12.8 item 12). The static test is defence in depth; P2 is the authority.
- **Capability facts.** Under 27.11.1 an event-trigger function is not an ordinary callable function, so the true
  `has_function_privilege` of `kj_worker` and `kj_door` on it is not a runtime capability fact. It is neither added to
  the runtime manifest nor reported as unexpected. The probe of 27.12.9 case 21 corroborates non-callability.
- **Rejected: normalise the ACL in B1** (revoke `PUBLIC` with before and after sealed). It makes B1 mutate a platform
  control, against 27.8, and buys nothing.
- **Rejected: accept any ACL with the same effect.** A materialised ACL equal in effect is still a change of platform
  state that nobody authorised. Exact null is the narrower pin. If the platform later materialises it, health is P0
  until a design revision.

#### 27.12.6 Artefacts, lifecycle and target binding

Two artefacts, split by environment dependence:

1. **Sealed pins, environment-independent.** `kerneljson:co-resident-platform-pins/v1`, file
   `infrastructure/database/co-resident-platform-pins.json`. It holds exactly the values of 27.12.3 and 27.12.4 and
   nothing target-specific: no system identifier and no environment name. It is a design constant like the stage
   manifest. It is transcribed from this section in the B1 remediation, reviewed against this section by the B1
   hostile review, and changed only by a design revision. It says what an admissible co-resident object must be if one
   is present; it does not say that any target has one. It is not part of the runtime-role manifest and grants nothing.
2. **Target declaration, target-specific.** `kerneljson:co-resident-platform-exceptions/v1`, file
   `infrastructure/database/co-resident-platform-exceptions.json`, beside the platform baseline.
   - **Created by** the deployment owner's read-only snapshot tool, in the same READ ONLY transaction with empty
     `search_path` as the platform baseline snapshot of 27.10.4, before B1. Nothing is written to the database.
   - **Records** every provenance field of 27.10.4 (environment name, `system_identifier`, `current_database()`,
     `version()`, `clock_timestamp()`, `current_user`, ledger head and set, query SHA-256), plus `pinsSha256` (SHA-256
     of the pins file bytes it was validated against), `entries` (each a pin with its bindings, as observed, with the
     forensic fields of 27.12.3) and `setSha256` (the 27.12.7 serialisation digest).
   - The tool writes an entry only when the observed function and bindings equal a pin exactly. It refuses, with the
     finding routed to a design revision, on any other function in `public` or `kernel_private` that is a definer or
     returns `pg_catalog.event_trigger`, and on any event trigger bound into those schemas that is not a sealed
     binding.
   - An empty declaration is valid. It is what a target without the helper has (local, CI, disposable databases):
     `entries` is the empty array and `setSha256` is the SHA-256 of the canonical empty serialisation (27.12.7), which
     is the empty string: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. It is still a
     declaration. It is snapshotted, frozen, bound to its target and supplied to B1 exactly like a non-empty one
     (revision 2.7.1). No declaration is not the same as an empty declaration. Where it is frozen depends on its mode
     (revision 2.7.3, 27.12.13): a `HOSTED_COMMITTED` declaration is committed at `R`; an `EPHEMERAL_RUN_BOUND`
     declaration is frozen in its run directory for one run and is never committed.
   - **Required fields** (revision 2.7.1, provenance shape revised in 2.7.2): `kind` exactly
     `kerneljson:co-resident-platform-exceptions/v1`; `environment`; `provenance`; `pinsSha256` and `setSha256`
     (each 64 lowercase hexadecimal characters); `entries` (an array, possibly empty, each element with every field of
     27.12.3 and its bindings with every column of 27.12.4). An unknown field is refused too, so a mistyped field name
     cannot pass as an absent optional one.
   - **Mode fields** (revision 2.7.3): `mode`, exactly `HOSTED_COMMITTED` or `EPHEMERAL_RUN_BOUND`; and `run`, which
     is required when `mode` is `EPHEMERAL_RUN_BOUND` and must be absent when it is `HOSTED_COMMITTED` (27.12.13.4).
     The schema is exact per mode: every listed field present, no other field, at every level, including inside
     `provenance`, `entries`, each binding and `run`.
   - **`provenance`** (revision 2.7.2) is the platform baseline's provenance object of 27.10.4, with the same fields
     and meaning as the frozen snapshot tool writes them (`platform-baseline-snapshot.ts` at `0ff2919`):
     `systemIdentifier` (decimal text, 27.12.7 P3 step 2), `database`, `serverVersion`, `snapshotAt`, `snapshotUser`,
     `transaction`, `migrationLedger` (`table`, `present`, `head`, `b1Recorded`, `versions`), `stampSecurityDefiner`
     and `querySha256`. Only `querySha256` differs, because it names the co-resident query. There is no second ledger
     representation: the ledger set is `migrationLedger.versions`, the sorted version list, compared by exact set
     equality as the baseline compares it. The `ledgerHead` and `ledgerSetSha256` fields of revision 2.7.1 are
     withdrawn; `ledgerSetSha256` was never defined.
   - **One read, two artefacts.** The snapshot tool reads the provenance once, in the one READ ONLY transaction, and
     writes the identical object into both artefacts. Health, the runner and qualification refuse unless the
     declaration's `provenance` equals the baseline's in every field except `querySha256`. The two artefacts therefore
     cannot disagree on system identifier, database, server version, snapshot time or ledger set.

**Frozen.** A `HOSTED_COMMITTED` declaration is committed with the B1 remediation (or with the release that carries
it) and reviewed by the B1 hostile review together with the baseline; it is fixed for the qualification run and for
the release that carries it. An `EPHEMERAL_RUN_BOUND` declaration is frozen by 27.12.13.4 for one run only. A
repository test refuses any committed file whose `mode` is not `HOSTED_COMMITTED` (27.12.13.6).

**Target identity.** Health and qualification refuse the declaration unless its `system_identifier` and database name
equal the live values (as 27.11.6 item 4). The pre-COMMIT check binds it through 27.12.7 P3.

**Cutover runner** (revision 2.7.1). The B1 migration is applied only by a committed runner, never by hand-typed
settings. The steps below are the `HOSTED_COMMITTED` procedure, unchanged by revision 2.7.3 and mandatory for every
hosted or persistent target; the `EPHEMERAL_RUN_BOUND` procedure of 27.12.13.5 replaces step 2 only, and only for a
cluster the runner created in the same run. Given the exact release commit `R` that carries the migration, before it
opens any database connection it:
1. verifies that it runs from `R` (`HEAD` equals `R`, no tracked change in the working tree), and that no
   authority-critical path carries the `skip-worktree` or `assume-unchanged` flag (`git ls-files -v`): the pins file,
   the declaration, the platform baseline, the stage manifest, everything under `supabase/migrations/`, the runner
   itself and its pinned engine version (revision 2.7.2);
2. reads the declaration and the pins file as blobs of `R` (`git show R:<path>`), never from the working copy, and
   records both blob SHAs. Revision 2.7.4 (R273-B1): it reads the platform baseline the same way, as a blob of `R`,
   records its blob SHA, and refuses, before opening any connection, unless the declaration and the baseline both
   have `mode` `HOSTED_COMMITTED`, neither carries `run`, and their `provenance` objects are equal in every field except
   `querySha256`. The hosted entry point accepts no artefact path, so a run-bound baseline or declaration cannot be
   substituted; a file from a run directory, a working-copy file or an ephemeral artefact committed at `R` is refused;
3. validates the declaration against every required field above and the formats of 27.12.7 P3 step 2, and refuses
   unless its `mode` is `HOSTED_COMMITTED` (revision 2.7.3);
4. verifies that the SHA-256 of the pins blob equals the declaration's `pinsSha256`, that `setSha256` recomputed from
   `entries` equals the declared value, that every entry equals a pin, and that the pins embedded in the migration at
   `R` equal the pins blob (the generator's reproducibility check);
5. refuses on any failure, having opened no connection and no transaction.

Only then does it apply B1, by the procedure of 27.12.11 (revision 2.7.2): the standard migration engine, over
migration files exported byte-exactly from `R`, after a read-only ledger gate, with the three settings of 27.12.7 P3
delivered to the migration session. It records `R`, both blob SHAs, `pinsSha256`, `setSha256` and the items of
27.12.11 in the cutover record. Post-migration qualification reads the declaration again at `R`, refuses unless its
blob SHA equals the recorded one, and compares the live surface to it field by field, with its `setSha256`, system
identifier and database name.

**Health.** `database.runtimeRolesLeastPrivilege` reads both artefacts from the running release and asserts all of:
- the declaration file exists, parses as JSON, has the exact `kind` and version above, has every required field and no
  unknown field, and its `pinsSha256`, `setSha256` and `provenance.systemIdentifier` are well formed (revision
  2.7.1), and its `provenance` equals the baseline's in every field except `querySha256` (revision 2.7.2);
- in a deployed release, its `mode` is `HOSTED_COMMITTED` (revision 2.7.3), and the platform baseline's `mode` is
  `HOSTED_COMMITTED` too, with no `run` field in either (revision 2.7.4). Health inside an ephemeral run reads the
  run-bound artefacts of 27.12.13.4 instead, verified by their recorded digests, requires them to have equal `mode`
  and `run`, and asserts everything else in this list unchanged. Such a health result is evidence for that run only;
- the SHA-256 of the pins file equals the declaration's `pinsSha256`;
- every declared entry equals a pin;
- `setSha256` recomputed from the entries equals the declared value;
- live `system_identifier` and database name equal the declared ones;
- the live co-resident surface serialises to `setSha256`;
- section 27.10 equality with the middle term;
- rules E1 to E3;
- name uniqueness.

Health never writes either artefact.

**Refresh.** Only by re-running the snapshot procedure, reviewing, and committing as a deliberate refresh, as 27.10.4.
A refresh can only reproduce sealed pins. If the live object no longer equals its pin, the snapshot refuses, and only
a design revision can proceed.

**P0 red.** Any health assertion above fails. In particular, each of these is P0 by itself:
- declaration file missing;
- declaration not valid JSON;
- wrong `kind` or version;
- a required field missing, or an unknown field present;
- `pinsSha256` not equal to the SHA-256 of the pins file;
- `setSha256` malformed, or not equal to the digest recomputed from `entries`, or not equal to the live surface;
- target database name not equal to `current_database()`;
- target system identifier malformed, or not equal to the live one;
- a declared exception missing, changed or moved;
- an undeclared one present;
- a binding missing, disabled, re-moded, re-bound or with changed tags, or an extra binding;
- `proacl` not null;
- a declared entry not equal to a pin;
- in a deployed release, a declaration whose `mode` is not `HOSTED_COMMITTED`, or that carries a `run` field
  (revision 2.7.3);
- in a deployed release, a platform baseline whose `mode` is not `HOSTED_COMMITTED`, that carries a `run` field, or
  whose `mode` differs from the declaration's (revision 2.7.4).

#### 27.12.7 B1 pre-COMMIT rule: exact set equality

This replaces the frozen count check (`n <> 1` over `public` and `kernel_private`). Inside the B1 migration, before
COMMIT, all of these must hold, evaluated in the order P1, P2, P3, or the migration raises `23514` and its transaction
rolls back:

- **P1. KernelJSON definers.** The identities of every `prosecdef` function in `public` and `kernel_private` that is
  not a sealed pin identity are exactly {`kernel_private.stamp_binding_provenance()`}. Identity is schema, name and
  ordered input argument types written `<type schema>.<type name>`. Every 27.9.4 assertion the migration already makes
  still applies.
- **P2. Co-resident surface matches the pins, with complete topology** (revision 2.7.1). `CR_ACTUAL` is every
  function in `public` and `kernel_private` that is `prosecdef` or returns `pg_catalog.event_trigger`, other than the
  stamp function, plus every `pg_event_trigger` row whose function is in those schemas. All of these must hold:
  - (a) each function in `CR_ACTUAL` equals a sealed pin in every field of 27.12.3;
  - (b) each event trigger in `CR_ACTUAL` equals, in every column of 27.12.4, a sealed binding of a pin whose function
    is in `CR_ACTUAL`;
  - (c) for each pinned function present in `CR_ACTUAL`, the set of `pg_event_trigger` rows whose `evtfoid` is that
    function equals its complete sealed topology exactly: every sealed binding present and equal in every column, and
    no other row. A pinned function present without its complete sealed topology aborts. A pinned function cannot be
    present while any of its sealed bindings is absent;
  - (d) for each sealed pin name, the `pg_proc` rows carrying that name in all governed schemas (27.10.2) are exactly
    the pinned identity when it is in `CR_ACTUAL`, and none otherwise (27.12.2 item 6).

  P2 is decided from the catalogue and the embedded pins alone. It reads no setting and does not depend on P3, so a
  missing `ensure_rls` aborts by P2 whatever digest the operator supplies. The pins are embedded in the generated
  migration from the pins file as environment-independent constants, the same kind of value as the stamp digest pin
  already in it.
- **P3. Co-resident surface equals the target declaration** (revision 2.7.1). The migration reads three
  transaction-local settings with `current_setting(name, true)`:
  - `kj.b1.co_resident_set_sha256`, the declaration's `setSha256`;
  - `kj.b1.target_system_identifier`, the declaration's `provenance.systemIdentifier`;
  - `kj.b1.target_database`, the declaration's `provenance.database`.

  The cutover runner of 27.12.6 delivers all three to the migration session from the frozen declaration of its mode
  (the blob at the release commit for `HOSTED_COMMITTED`, the run-bound declaration for `EPHEMERAL_RUN_BOUND`,
  27.12.13), as connection startup parameters of the standard engine's connection (27.12.11, revision 2.7.2).
  Revision 2.7.3 narrows the 2.7.2 harness exception (hardening item 5 of the 2.7.2 seal record): only the negative
  fixtures named in 27.12.13.8 may supply them otherwise, with `set_config(name, value, true)` in the migration
  transaction or as startup parameters of the pinned engine; no positive case and no qualification does. P3 reads
  them the same way in every case. They are not secrets. Every
  B1 application supplies all three, on every target, including a target whose declaration is empty. The checks run
  in this order, and each failure raises `23514` with a message naming the failed step:
  1. **Presence.** Each of the three settings is non-NULL and non-empty. One, two or all three missing or empty
     aborts. Absence of the settings is never read as an empty declaration.
  2. **Format.** `kj.b1.co_resident_set_sha256` matches `^[0-9a-f]{64}$`. `kj.b1.target_system_identifier` matches
     `^(0|-?[1-9][0-9]{0,18})$`, the canonical decimal text of a `bigint`. `kj.b1.target_database` is 1 to 63 bytes
     with no character below U+0020. Formats are checked by pattern before any comparison and never by cast, so a
     malformed value raises `23514`, never `22P02`.
  3. **Database.** `kj.b1.target_database` equals `current_database()`, compared as text.
  4. **System identifier.** `kj.b1.target_system_identifier` equals
     `(pg_control_system()).system_identifier::text`, compared as text.
  5. **Set digest.** The serialisation digest of `CR_ACTUAL` equals `kj.b1.co_resident_set_sha256`.

  So `CR_ACTUAL` equals the target's frozen declaration exactly, in both directions, before COMMIT. No count is
  compared anywhere, and no target identity is written into the migration. The migration's first statement repeats
  steps 1 and 2, so a malformed or incomplete cutover aborts before any change is made; the full P3 runs again before
  COMMIT.

**Threat model of P3.** P3 protects against mistakes and drift: the wrong declaration, the wrong target, a stale
release, an operator typing values, and a co-resident surface that has changed since the snapshot. It does not
protect against a hostile deployment owner, who can edit the migration, set any value or alter the catalogue
directly. The defence against the owner is outside the database: the committed runner, the cutover record, the
hostile review of the declaration, and post-migration qualification and health comparing against the committed
declaration.

**Race after P2** (revision 2.7.2). P1 to P3 observe the catalogue at one point before COMMIT. A concurrent DDL by
another owner session after that point, or between the runner's ledger gate and the engine's connection (27.12.11),
is not prevented by this design. Post-COMMIT qualification and continuous health remain the detectors, and either
finding is P0. This revision adds no locking protocol.

**Clone limitation.** A physical clone, replica or restore of the target may keep its `system_identifier`, and its
database name is usually the same. Database-internal identity alone cannot tell such a clone from the target. P3 and
health therefore prove only that the database is the target or a physical copy of it. The deployment target is
established outside the database, by the cutover record naming the connection target. This limitation does not relax
any qualification rule: every check above still applies in full, to the target and to any clone.

**Serialisation**, byte-exact and shared by the snapshot tool, health and the migration:
- One line per member, with fields separated by `|`.
  - A function line: `fn|<schema>|<name>|<argtypes>|<rettype>|<proretset>|<prokind>|<owner>|<prosecdef>|<lanname>|<provolatile>|<proisstrict>|<proleakproof>|<proparallel>|<proconfig>|<proacl>|<digest>`.
  - An event-trigger line: `evt|<evtname>|<owner>|<evtevent>|<function identity>|<evtenabled>|<tags>`.
- Field formats:
  - `<argtypes>`: comma-joined `<type schema>.<type name>`, empty for none; `<rettype>` in the same form.
  - Booleans: `t` or `f`.
  - `<proconfig>` and `<proacl>`: PostgreSQL's array text output, or the literal `NULL`.
  - `<digest>`: per 27.10.4.
  - `<function identity>`: `<schema>.<name>(<argtypes>)`.
  - `<tags>`: elements sorted by byte order, comma-joined, or `NULL`.
- Lines are sorted by byte order (`COLLATE "C"`) and joined by a single LF, with no trailing LF. The digest is SHA-256
  over UTF-8, in lowercase hexadecimal.
- The canonical empty serialisation is the empty string (zero lines). Its digest is
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- **Domain** (revision 2.7.2). The serialisation is defined only over members P2 has already admitted, whose every
  field equals a sealed pin or binding value. It has no escaping, because no sealed value contains `|`, a line feed
  or, inside `<tags>`, a comma. It is not a general encoding of catalogue strings; a non-admitted member never
  reaches it, because P2 aborts first.
- **Golden vector** (revision 2.7.2), the production surface of 27.12.3 and 27.12.4, two lines joined by one LF, no
  trailing LF, 285 bytes:

  ```text
  evt|ensure_rls|postgres|ddl_command_end|public.rls_auto_enable()|O|CREATE TABLE,CREATE TABLE AS,SELECT INTO
  fn|public|rls_auto_enable||pg_catalog.event_trigger|f|f|postgres|t|plpgsql|v|f|f|u|{search_path=pg_catalog}|NULL|2782e98b348aca7d6f6f73c420fd78d2e094957dd7a52b0483d4c34f29d2a7a1
  ```

  SHA-256 `80d365b875ba65ae543e351a47c09f66c6df756db772f6fa494a36639291d721`, computed from this specification, not
  read from a database. The B1 remediation's snapshot tool, health and migration must each reproduce it from the
  disposable helper fixture, as a committed test.
- Each field is also compared individually by P2. The digest binds set membership to the declaration.

**Expected on the production target after B1:**
- P1: {`kernel_private.stamp_binding_provenance()`};
- `CR_ACTUAL`: one `fn` line for `public.rls_auto_enable()` and one `evt` line for `ensure_rls`.

**Expected on a target without the helper** (local, CI, disposable databases): its declaration is empty, and is an
`EPHEMERAL_RUN_BOUND` declaration snapshotted in the same run (revision 2.7.3, 27.12.13), since such a database does
not exist when `R` is committed; the runner sets all three settings from it, with `kj.b1.co_resident_set_sha256` equal to the empty-serialisation
digest; `CR_ACTUAL` is empty; P3 step 5 compares that digest and passes. The same target migrated without the
settings, or without a declaration, aborts `23514` at P3 step 1. So does a target that holds the helper. Revision 2.7
read unset settings as an empty declaration; revision 2.7.1 withdraws that.

#### 27.12.8 Required B1 remediation (specified here, not implemented)

**Required by this revision.** B1 cannot qualify without each of these:
1. **Pins file.** Add `infrastructure/database/co-resident-platform-pins.json`, transcribed from 27.12.3 and 27.12.4,
   with a test pinning its content. `scripts/b1/build-manifest.mjs` embeds the pins in the generated migration.
2. **Function ACL cleanup** (revised in 2.7.2). Replace both `revoke execute on all functions in schema public,
   kernel_private from public` and `revoke all on all functions in schema public, kernel_private from kj_worker,
   kj_door` with the one enumerated cleanup of 27.12.5. Table and sequence cleanup is unchanged.
3. **Pre-COMMIT.** Replace the `n <> 1` definer count with P1 to P3 of 27.12.7, including the topology clause P2 (c),
   the three mandatory settings and the presence and format checks repeated as the migration's first statement.
4. **Target snapshot** (`platform-baseline-snapshot.ts`, `baselineEligibilityProblems` in `security-definers.ts`):
   - route `public` and `kernel_private` definers and event-trigger functions to pin comparison;
   - capture `pg_event_trigger` rows bound into those schemas;
   - write the co-resident declaration;
   - refuse everything else;
   - refuse pinned names in the baseline in any governed schema.
5. **Inventory and health** (`definerInventoryProblems`, `database.runtimeRolesLeastPrivilege`): the middle term of
   `EXPECTED(stage, target)`; rules E1 to E3; name uniqueness; system-identifier and database-name binding; pins
   hash; set digest; declaration presence, parse, `kind`, version, required fields and formats; P0 on any failure
   (27.12.6).
6. **Capability facts** (`runtime-roles.ts`): no function capability fact for a function returning
   `pg_catalog.event_trigger` (27.11.1), relying on E1 holding.
7. **Post-migration qualification:** reads the declaration at the release commit, refuses unless its blob SHA equals
   the one in the cutover record, and checks every item of 27.12.3 and 27.12.4 for each declared entry, the live
   `setSha256`, system identifier and database name against it (27.12.6). In `EPHEMERAL_RUN_BOUND` mode it reads the
   run-bound declaration instead, verified by its recorded SHA-256 (27.12.13.4 S7, revision 2.7.3).
8. **Cutover runner and plan:** the committed runner of 27.12.6 and 27.12.11. It reads the declaration and pins at
   the exact release commit, validates them and verifies `pinsSha256` before opening any connection; exports the
   migrations byte-exactly from `R`; passes the read-only ledger gate; applies B1 through the pinned engine with the
   three settings as startup parameters; and writes the cutover record. The plan states that every target, including
   one with an empty declaration, aborts without the settings, and that production refuses at the ledger gate while
   its ledger lacks base versions.
9. **Every other application of the B1 migration** (CI, local regression, disposable databases, test fixtures) also
   goes through the runner and its engine, with a declaration snapshotted from that database. Revision 2.7.3: for a
   database cluster the runner created in the same run, that declaration is `EPHEMERAL_RUN_BOUND` under 27.12.13; for
   any other target it is `HOSTED_COMMITTED`. A plain migration runner that cannot supply the settings aborts at P3
   step 1; that is intended, and the harness must be changed, not the check. The only exceptions are the negative
   fixtures of 27.12.13.8. Revision 2.7.6: regression that needs a database holding B1 uses one only as a regression
   consumer in stage T, and every repository helper that applies migrations applies the base set only (27.12.15).
10. **Negative suite:** the cases of 27.12.9, run on a disposable database where the owner installs the pinned 953-byte
   body and `ensure_rls` from the cited upstream text, and on a second disposable database without either. The
   canonical CI reference has neither.
11. **B1 documents:** reconcile the implementation report, cutover plan and entry brief to revisions 2.7, 2.7.1 and
   2.7.2.
12. **Static guards** (revision 2.7.2), each a committed repository test with its own failing fixtures:
   - over the generated B1 migration text, comments and string literals included (so a form built inside `EXECUTE`
     is still seen), case-insensitive and whitespace-normalised: fail on `ON ALL FUNCTIONS IN SCHEMA`,
     `ON ALL ROUTINES IN SCHEMA` or `ON ALL PROCEDURES IN SCHEMA`; on any `ALTER DEFAULT PRIVILEGES` whose object
     type is `FUNCTIONS` or `ROUTINES`; on any GRANT or REVOKE naming a sealed pin name; and on any transaction-control
     statement (`BEGIN`, `START TRANSACTION`, `COMMIT`, `END`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`, `PREPARE
     TRANSACTION`) at top level. It must pass `ON ALL TABLES IN SCHEMA` and `ON ALL SEQUENCES IN SCHEMA`;
   - over the repository: only the runner may supply `kj.b1.co_resident_set_sha256`, `kj.b1.target_system_identifier`
     or `kj.b1.target_database` (as startup parameters or by `set_config` or `SET`). The B1 migration may only read
     them with `current_setting(name, true)`. The registered callers of the setting hooks of 27.12.13.8 are the only
     other allowed writers. Any other occurrence in code fails the test;
   - over the runner: it never passes `--include-all` and never invokes `migration repair`, `db push` or `db reset`;
   - over the runner (revision 2.7.3): the hosted entry point contains no call into the ephemeral snapshot or the
     ephemeral cluster code, and the ephemeral entry point accepts no connection URL, connection file or declaration
     path (27.12.13.6).
13. **Engine pin** (revision 2.7.2, made exact per platform in 2.7.3): the Supabase CLI version and the SHA-256 of
   each of its executables for each supported platform, as 27.12.13.7, committed at `R` and checked by the runner
   (27.12.11 step 6). Every LEDGER case runs against that pinned engine.
14. **Ephemeral mode** (revision 2.7.3): the run directory, cluster lifecycle, eligibility predicate, run-bound
   declaration, evidence record and cases EPH-1 to EPH-15 of 27.12.13; and, from revision 2.7.4, the run-bound
   baseline's mode and run binding, the hook registry, the computed qualification status and cases EPH-16 to EPH-25;
   and, from revision 2.7.6, the four lanes, stage T, the committed plans, the run network and cases CON-1 to CON-14
   of 27.12.15; and, from revision 2.7.7, the retained gates G1 to G9, the trace and database-log evidence, the
   coverage partition, the CI gate over every registered suite and cases CON-15 to CON-32; and, from revision 2.7.8,
   test identity from expanded report entries, the exact refusal accounting, structured hook expectations with
   preconditions, and cases CON-33 to CON-46; and, from revision 2.7.9, the pinned collection contract, the report
   success rule, the exact log extraction and fingerprints, the log projection and cases CON-47 and CON-48.

**Not required by this revision.** Separate authorisation; these do not gate B1:
- The forensic drift tool (audit branch `f19a37dea3e20d49eca4c3d34cf221bb3b18089b`, unchanged by this revision)
  should compare function sources by the CRLF-normalised digest, keeping raw digest, raw length and has-CR as forensic
  evidence. That would settle `public.schedule_fire_bind_once()` mechanically: its production body is the canonical
  body with LF converted to CRLF (365 against 355 bytes, ten line endings). It should also capture `pg_event_trigger`.
- The six missing ledger rows (section 26). The B1 snapshot's ledger gate is unchanged, and the runner's ledger gate
  of 27.12.11 refuses production until that separate track resolves them under its own authorisation.

#### 27.12.9 Negative cases

Each is a committed automated case. Cases 1 and 23 are the positive controls; every other case must fail on purpose:
- For inventory and health, failure means a named problem and P0.
- For a pre-COMMIT case, the migration aborts with `23514`, the error names the failed rule or P3 step, and an owner
  re-read shows the catalogue unchanged. Any other SQLSTATE fails the case.
- For a runner case, the runner refuses and the test shows that no database connection was opened.
- Fixtures: the two disposable databases of 27.12.8 item 10, one holding the helper and one without it.
- Cases ACL-A to ACL-C and LEDGER-A to LEDGER-F (revision 2.7.2) apply B1 through the runner and the pinned engine.
  For LEDGER-B, LEDGER-E and LEDGER-F the fixture database is first brought to the stated ledger state by the test
  itself; that fixture setup is not a runner or engine path.
- Revision 2.7.3: every disposable fixture is a cluster the runner created in the same run, and every positive case
  on it uses an `EPHEMERAL_RUN_BOUND` declaration (27.12.13). The B1 variants of cases 6 and ACL-B are applied by the
  negative-fixture path of 27.12.13.8, not through runner step 7. Cases EPH-1 to EPH-15 are in 27.12.13.9.
- Revision 2.7.4: every negative fixture is a registered hook (27.12.13.8), and its run reports
  `NEGATIVE_FIXTURE_RESULT`. Because the gate now checks the full inventory before application (27.12.11 step 8,
  H2), each pre-COMMIT case that introduces drift before application is run twice:
  - without a gate hook, where the gate must refuse before the engine runs;
  - with the registered hook `S6-gate-inventory-skip`, where B1 must abort `23514` at the stated P rule.

  Both layers are therefore shown failing on purpose. Cases EPH-16 to EPH-25, and EPH-26 and EPH-27 of revision 2.7.5,
  are in 27.12.13.9.

| # | Case | Required result |
|---|---|---|
| 1 | exact `rls_auto_enable()` and exact `ensure_rls`, B1 applied with the correct settings | commits; inventory equal; health green |
| 2 | source changed: one byte of the body; also the upstream `536fbd5` body | fail |
| 3 | owner changed to another role | fail |
| 4 | `ALTER FUNCTION ... SECURITY INVOKER` | fail (pin mismatch; E1 still applies) |
| 5 | `proconfig` changed: `RESET search_path`; `SET search_path = public, pg_catalog` | fail |
| 6 | ACL changed: `REVOKE EXECUTE ... FROM PUBLIC` (materialised ACL); `GRANT EXECUTE ... TO kj_worker`; B1 run with the old blanket revoke | fail; the last aborts pre-COMMIT |
| 7 | `ensure_rls` dropped | fail; pre-COMMIT aborts by P2 (c) |
| 8 | `ensure_rls` disabled; also `ENABLE REPLICA` and `ENABLE ALWAYS` | fail |
| 9 | tags changed: only `CREATE TABLE`; `ALTER TABLE` added | fail |
| 10 | `ensure_rls` bound to a different function, in `public` or in another schema | fail; pre-COMMIT aborts by P2 (c) |
| 11 | a second event trigger on `public.rls_auto_enable()` | fail (E2) |
| 12 | a second platform definer in `public` (for example an exact copy under another name); an INVOKER event-trigger function in `public` | fail (27.10; E1) |
| 13 | an overload `public.rls_auto_enable(text)` of any return type | fail (name uniqueness) |
| 14 | a copy `extensions.rls_auto_enable()`, before or after the snapshot; `ALTER FUNCTION ... SET SCHEMA` | fail (name uniqueness; baseline refusal; missing plus extra) |
| 15 | an extra KernelJSON definer, in `kernel_private` or `public` | fail (P1; 27.10) |
| 16 | declaration from another `system_identifier`; pre-COMMIT with a wrong `kj.b1.target_system_identifier` | health P0; pre-COMMIT aborts `23514` at P3 step 4 |
| 17 | silent refresh: a declared entry edited to match a drifted body; `setSha256` edited; the pins file edited without a design revision | fail (pin equality; set digest; `pinsSha256` and the pinned-content test). A static test also shows health has no write path to either artefact |
| 18 | a body equal to the pin with LF converted to CRLF | semantic source equality holds (normalised digest equal); the forensic raw digest, length and has-CR differ and are reported as forensic evidence only |
| 19 | on the database holding the helper: no settings; each of the six partial combinations (any one or any two of the three set); the declaration of the helper target applied to the database without it | abort `23514` (P3 step 1, or step 5 for the last) |
| 20 | a canonical KernelJSON migration containing `CREATE [OR REPLACE] FUNCTION` of `rls_auto_enable` | the repository test fails |
| 21 | as `kj_worker` and as `kj_door`: `select public.rls_auto_enable()` | refused `0A000`; any other SQLSTATE fails the probe |
| 22 | as each runtime role: `CREATE EVENT TRIGGER`; `ALTER EVENT TRIGGER ensure_rls DISABLE`; `DROP EVENT TRIGGER ensure_rls`; `CREATE OR REPLACE FUNCTION public.rls_auto_enable()`; `ALTER FUNCTION public.rls_auto_enable() ...` | refused `42501`; catalogue unchanged |
| 23 | empty target: the database without the helper, its exact empty declaration, all three settings from it (set digest `e3b0c442...b855`) | commits; inventory equal; health green (positive control) |
| 24 | the same empty target with no settings; and with no declaration file, by bypassing the runner | abort `23514` at P3 step 1; never read as an empty declaration |
| 25 | the same empty target with each of the six partial setting combinations; each setting set to the empty string | abort `23514` at P3 step 1 |
| 26 | helper target with `ensure_rls` dropped, the operator supplying the correctly computed digest of a set that omits it (the `fn` line only), with matching system identifier and database | abort `23514` by P2 (c); the error names P2, not P3 |
| 27 | malformed `kj.b1.target_system_identifier`: `abc`; `0123`; a leading or trailing space; 20 digits; `7678069749886157684.0` | abort `23514` at P3 step 2; `22P02` or any other SQLSTATE fails the case |
| 28 | malformed `kj.b1.co_resident_set_sha256`: uppercase hexadecimal; 63 characters; 65 characters; a non-hexadecimal character | abort `23514` at P3 step 2 |
| 29 | malformed `kj.b1.target_database`: 64 bytes; a control character | abort `23514` at P3 step 2 |
| 30 | `kj.b1.target_database` naming another database, everything else correct | abort `23514` at P3 step 3 |
| 31 | health: declaration file missing | P0 |
| 32 | health: declaration not valid JSON; truncated file; a byte-order mark before the JSON | P0 |
| 33 | health: wrong `kind`; `/v2`; `kind` missing | P0 |
| 34 | health: each required field of 27.12.6 removed in turn; one unknown field added | P0 for every one |
| 35 | health: `pinsSha256` one character changed; `setSha256` malformed (uppercase, 63 characters); declared `database` or `systemIdentifier` not the live value; `systemIdentifier` malformed | P0 for every one |
| 36 | runner: run from a commit other than the release commit; tracked file modified in the working tree; declaration edited in the working copy only; `pinsSha256` not equal to the pins blob; pins embedded in the migration differ from the pins blob; a declaration failing case 33 or 34 | refuses before opening a connection |
| 37 | post-migration qualification: the declaration at the release commit replaced by one with a different blob SHA than the cutover record; live surface changed after COMMIT | qualification fails |
| 38 | helper target, correct system identifier and database, `kj.b1.co_resident_set_sha256` set to the empty-serialisation digest | abort `23514` at P3 step 5 |
| 39 | static guard fixtures: a generated migration containing each forbidden form of 27.12.8 item 12 in turn, including one inside an `EXECUTE` string; a `set_config('kj.b1.target_database', ...)` added outside the runner; a runner invoking `--include-all` | each fails its static test; `ON ALL TABLES IN SCHEMA` and `ON ALL SEQUENCES IN SCHEMA` pass |
| 40 | runner integrity: `skip-worktree` or `assume-unchanged` set on the pins file, the declaration or a migration file; an untracked `.sql` file added under `supabase/migrations/`; an exported migration file differing from its blob; the engine binary's SHA-256 or version not the pinned one | refuses; the untracked file never reaches the export directory |
| 41 | the golden vector of 27.12.7, reproduced by the snapshot tool, by health and by the migration from the disposable helper fixture | all three produce `80d365b8...d721` (positive control) |
| ACL-A | exact helper and exact `ensure_rls` with `proacl` null; corrected B1 through the runner; COMMIT | commits; afterwards `public.rls_auto_enable()` has `proacl IS NULL`; every member of the cleanup set `C` has the same `proacl` the frozen statements would give (positive control) |
| ACL-B | same fixture; a B1 variant containing the frozen `revoke all on all functions in schema public, kernel_private from kj_worker, kj_door` | abort `23514` by P2 (a) on `proacl`; after rollback `proacl IS NULL` and the ledger has no B1 row |
| ACL-C | same fixture plus an unpinned function in `public` returning `pg_catalog.event_trigger` (invoker; and a definer copy), which the cleanup skips | abort `23514` by P2 (a) and E1; nothing commits |
| LEDGER-A | exact pre-B1 ledger (`SEALED_BASE_MIGRATION_SET`), B1 through the runner | commits; post-COMMIT ledger equals base plus `20261002090000` exactly, B1 once, its row equal to the recorded contract; qualification passes (positive control) |
| LEDGER-B | B1's catalogue effects committed without its ledger row (the B1 blob applied outside the engine) | post-migration qualification fails on ledger set equality |
| LEDGER-C | ledger already records `20261002090000` before application | the runner's ledger gate refuses after its read-only query, before the engine is invoked; no migration SQL runs and the catalogue is unchanged. The engine alone would have skipped B1 silently (OBSERVED), which is why the gate exists |
| LEDGER-D | a fixture deferred constraint trigger on `supabase_migrations.schema_migrations` that raises at COMMIT for version `20261002090000`, so the failure falls after the ledger row is written | the engine reports the error; afterwards no B1 catalogue effect and no B1 ledger row (mechanism OBSERVED with a test migration, 27.12.12) |
| LEDGER-E | pre-B1 ledger missing one base version (one test per position: oldest, middle, newest) | the ledger gate refuses; the engine is not invoked; the missing row is not added |
| LEDGER-F | pre-B1 ledger holding one extra version not in the base set | the ledger gate refuses; the engine is not invoked |

The SQLSTATEs in cases 21 and 22 are INFERENCE (section 26). If PostgreSQL returns another, B1 stops and the case is
re-specified by a design revision, never relaxed to "any error".

#### 27.12.10 What this revision does not do

Revisions 2.7.1 and 2.7.2 are bound by every item below as well. Revision 2.7.2 records no ledger row, historical or
otherwise; it specifies how B1's own row is written by the engine when B1 is eventually authorised.

- It grants nothing to any role. The runtime roles' attributes, memberships, USAGE, CREATE and TEMPORARY are
  unchanged. The runtime-role manifest is unchanged and stays environment-independent.
- It is not a precedent. Each further co-resident object needs its own exact entry, design revision, hostile review
  and seal.
- It does not change section 27.9 or the rollout order.
- It authorises no production mutation, no ledger repair, no B1 target-baseline capture, no B1 merge or deployment,
  and no start of P8A-0.


#### 27.12.11 Applying B1: engine and migration ledger (revision 2.7.2, R271-B2)

**Canonical ledger contract.** OBSERVED on disposable PostgreSQL 17.6 with Supabase CLI 2.120.0 (27.12.12):
- **Table.** `supabase_migrations.schema_migrations`, exactly three columns: `version text not null` (the primary
  key), `statements text[]` (nullable) and `name text` (nullable). The CLI created no other table in that schema.
- **Row.** For the file `<version>_<name>.sql`: `version` is the 14 digits; `name` is the rest of the file name
  without `.sql`; `statements` is the file split by the CLI's parser into top-level statements, each without its
  terminating semicolon, with a leading comment kept on the statement that follows it. For frozen B1 (`0ff2919`,
  blob SHA-256 `5cbb8b54fdb64d5546bf5acce78a86de23fc5dadfb73a664b252549f7589c8a5`) the row has `name`
  `runtime_least_privilege_roles` and 293 statements; the SHA-256 of the array's JSON text is
  `1b19276eb6a861ea1b63f713a69fa3126a4fc2ade3e387a2c487129bf2fb84d1`.
- **Write.** `INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES($1, $2, $3)`, issued
  by the CLI as the last statement of the migration's own transaction, after every statement of the file.
- **Transactions.** One transaction per migration file holds its statements and its ledger row (equal `xmin`). A
  failure inside the migration leaves neither objects nor row. A failure at COMMIT, after the row was written, leaves
  neither. Each file commits separately, so an earlier file in the same invocation stays committed if a later one
  fails.
- **Existing version.** A version already recorded is skipped silently: its file is never executed, and the CLI
  reports "Local database is up to date".
- **Gaps.** A recorded version with no local file: the CLI refuses. A local version missing from the ledger and older
  than the ledger head: refused unless `--include-all`, which re-executes it. A local version missing from the ledger
  and newer than the head: executed as pending.
- **Hand-applied precedent.** P1.2A, P1.3D and P2.1A were applied by hand in one transaction with an `INSERT` of
  `version`, `name` and `statements`, the CLI's row shape. How they split `statements` was not recorded, and this
  design does not rely on it.

**Selected route: the standard engine.** B1 is applied by the Supabase CLI's `migration up`, run by the committed
runner. The B1 remediation pins an exact CLI version and the SHA-256 of its binary (27.12.8 item 13); 2.120.0 is the
version observed here. The runner never writes the ledger itself. Reasons:
- the CLI writes the canonical row, atomically with the migration (OBSERVED), so no ledger protocol is reimplemented;
- the CLI's `statements` split is defined only by its parser, and another implementation could not be shown to
  reproduce it;
- P3's settings reach the migration session as connection startup parameters (OBSERVED), and the migration bytes
  stay exactly the blob of `R`.

The CLI alone is not safe. It skips an already recorded version silently, and it executes any unrecorded version newer
than the head, historical ones included. So it is invoked only after the runner's gate below has passed, never with
`--include-all`, and the runner never invokes `migration repair`, `db push` or `db reset`.

**Runner procedure**, continuing the steps 1 to 5 of 27.12.6:
6. **Engine.** Verify that the CLI binary's version and SHA-256 equal the pin committed at `R`. Revision 2.7.3 makes
   this exact per platform and per executable, and defines how the verified executables are run (27.12.13.7).
7. **Export.** Create a fresh empty directory. Write `supabase/config.toml` and every file of `R:supabase/migrations/`
   into it with `git cat-file blob` (raw blob bytes, no checkout filter, no line-ending conversion), and compare each
   written file's SHA-256 with its blob's. The engine reads only this directory, so an untracked or modified file in
   the checkout cannot reach it. The exported set must be exactly the sealed base migrations of the stage manifest
   (each file's SHA-256 equal to its `baseMigrations` pin) plus the one B1 file
   `20261002090000_runtime_least_privilege_roles.sql`. Any other file refuses, so nothing but B1 can be pending.
   Record the B1 file's git blob id and SHA-256 as `migrationBlob`.
8. **Ledger gate.** As the deployment owner, in one READ ONLY transaction with an empty `search_path`, refuse, having
   written nothing, unless all of these hold:
   - `supabase_migrations.schema_migrations` exists with exactly the three columns, types, nullability and primary
     key above;
   - its versions equal `SEALED_BASE_MIGRATION_SET` exactly (no missing, no extra, no duplicate), by the
     `ledgerSetProblems` comparison of 27.10.4, and equal `provenance.migrationLedger.versions` of the declaration
     and of the baseline;
   - version `20261002090000` is absent;
   - `kernel_private.stamp_binding_provenance()` exists and is not `SECURITY DEFINER` (B1 not applied, as the
     snapshot already checks);
   - the live system identifier and database name equal the declaration's;
   - (revision 2.7.4, H2) the full section 27.10 inventory, over every governed schema, equals the pre-B1 expected set
     `PLATFORM_BASELINE(target) UNION CO_RESIDENT_PLATFORM_EXCEPTIONS(target)` exactly, by the identity and attributes
     of 27.10.3 and 27.10.4, using the baseline and declaration of this application (blobs of `R` in hosted mode, the
     run-bound files in ephemeral mode). Before B1 the KernelJSON stage manifest contributes nothing, because the
     stamp function is not yet a definer (the bullet above). Rules E1 to E3 and name uniqueness are checked in the same
     read.

   The gate needs a connection; it is read-only and precedes every write. Record its version list as `ledgerBefore`
   and its inventory result.

   The pre-application inventory check narrows a window, it does not close one. Drift that happens before the gate is
   now refused before the engine runs, in every governed schema. A concurrent DDL by another owner session after the
   gate's read, before or during the engine's transaction, is still not prevented: the residual risk of 27.12.7
   ("Race after P2") is unchanged. Inside `public` and `kernel_private`, P1 to P3 still re-check before COMMIT. In other
   governed schemas only post-COMMIT qualification and health detect it, and either finding is P0.
9. **Apply.** Invoke `migration up --workdir <export directory> --db-url <url>`, with the three P3 settings as
   startup parameters in the URL (`options=-c kj.b1.co_resident_set_sha256=<v> -c kj.b1.target_system_identifier=<v>
   -c kj.b1.target_database=<v>`, percent-encoded). The URL carries no password. The password reaches the engine
   only through a mode-600 passfile named by `PGPASSFILE` (OBSERVED working with the CLI), deleted afterwards. The
   URL and the settings are not secrets. A connection path that drops startup parameters makes P3 step 1 abort.
10. **Record** the engine's exit status and output in the cutover record.

**Transaction invariant.** B1's statements, including its pre-COMMIT checks P1 to P3, and B1's ledger row are in one
transaction: both commit or neither does, including on a failure at COMMIT. B1's checks run before the engine writes
the ledger row (OBSERVED order), so they cannot see it; post-COMMIT qualification checks it.

**`SEALED_BASE_MIGRATION_SET`** is the version set of `baseMigrations` in the sealed stage manifest. At `0ff2919` it
is these 22 versions: `20260905153656`, `20260905153700`, `20260905153704`, `20260905153708`, `20260905173500`,
`20260905173800`, `20260905174200`, `20260908233816`, `20260908234518`, `20260908234711`, `20260908234849`,
`20260910180000`, `20260915220000`, `20260916205049`, `20260917120000`, `20260920120000`, `20260920150000`,
`20260920180000`, `20260921180000`, `20260923150000`, `20260925120000`, `20260929120000`. A change to it is a stage
manifest change under B1's own review.

**Post-B1 ledger invariant.** Post-COMMIT qualification requires, read-only as the owner:
- `EXPECTED_POST_B1_LEDGER = SEALED_BASE_MIGRATION_SET UNION {20261002090000}`, by exact set equality: no missing,
  no extra, no duplicate, B1 exactly once. `max(version)` is never sufficient;
- the B1 row has `version` `20261002090000`, `name` `runtime_least_privilege_roles`, and a `statements` array whose
  JSON-text SHA-256 equals the one the same pinned engine wrote for the same blob on the disposable qualification
  database, recorded with the B1 qualification evidence and frozen with the release;
- the B1 file at `R` still has the recorded `migrationBlob`.

Record the version list as `ledgerAfter`.

**Cutover record additions:** the engine version and binary SHA-256; the exported file list with SHA-256s;
`migrationBlob` (blob id and SHA-256) and version `20261002090000`; `ledgerBefore`; `ledgerAfter`; the B1 `statements`
digest.

**Production consequence.** Production's ledger lacks six base versions (section 26), so the gate of step 8 refuses on
production, as it must. This revision authorises no ledger row. The runner adds, deletes and repairs nothing in the
ledger; the only row ever written is B1's own, by the engine, in B1's transaction. Wording corrected in revision 2.7.3,
with no change of rule: the six versions lie behind production's ledger head, and for a local version missing from the
ledger and older than the head the observed CLI refuses unless `--include-all` is given, which would re-execute it
(OBSERVED, 27.12.11 "Gaps"). `--include-all` is never authorised. The runner's gate refuses production before the engine
is invoked, whatever the engine would do. The six rows remain a separate forensic track with its own authorisation.

#### 27.12.12 Disposable PostgreSQL 17.6 evidence (revision 2.7.2)

Run on 08/10/2026 on a disposable local PostgreSQL 17.6 (`PostgreSQL 17.6 on x86_64-windows, compiled by
msvc-19.44.35213, 64-bit`, embedded binaries, trust authentication on 127.0.0.1, fresh database per scenario) with
Supabase CLI 2.120.0. No production access. Scripts and full output are in
`docs/operations/KJ_P8_R272_DISPOSABLE_PG176_EVIDENCE_2026-10-08.md`. Docker was not available, so the CI image
`postgres:17.6` was not used; the server version matches it, the build does not.

ACL, starting from `proacl` null on every routine:

| Statement | `public.rls_auto_enable()` after | Other effect |
|---|---|---|
| `revoke all on all functions in schema public, kernel_private from kj_worker, kj_door` | `{=X/postgres,postgres=X/postgres}` | same materialisation on every `f`, `a` and `w` routine, invoker event-trigger functions included; procedure untouched |
| `revoke execute on all functions in schema public, kernel_private from public` | `{postgres=X/postgres}` | every `f`, `a`, `w`; procedure untouched |
| both frozen statements in order | `{postgres=X/postgres}` | as above |
| `revoke all on all routines in schema ...` | materialised | also the procedure |
| `revoke all on all procedures in schema ...` | null | only the procedure |
| the enumerated cleanup of 27.12.5 | **null** | every member of `C` equal to the frozen pair's result, including a function previously granted to `kj_door`; procedure untouched |
| `revoke all on function public.rls_auto_enable() from kj_worker, kj_door` | materialised | (any per-role statement naming it) |
| `revoke all on function <procedure>` | n/a | `42809 ... is not a function` |

Ledger: the contract of 27.12.11, observed with test migrations, then with the 22 base migrations and frozen B1
exported from `0ff2919` by `git cat-file blob` (bytes equal to the blobs, no CR) and applied by the CLI: 23 rows, the
B1 row in the same transaction as the stamp function's change (`xmin` equal), and a startup parameter visible to the
migration. The frozen B1 was applied only to that disposable database and was not modified.

#### 27.12.13 Target-declaration modes (revision 2.7.3, R272-EPHEMERAL)

##### 27.12.13.1 Rule

Every B1 application uses exactly one of two declaration modes. The mode is fixed by which runner entry point runs.
It is never chosen by a flag, an environment variable, a host name, a loopback address or any part of a connection
string, and no entry point can switch to the other.

| | `HOSTED_COMMITTED` | `EPHEMERAL_RUN_BOUND` |
|---|---|---|
| Targets | production, every hosted, persistent or remote database, and every target not proved ephemeral by 27.12.13.3 | only a database cluster the runner itself created in the same run |
| Declaration source | the blob at the release commit `R` (27.12.6 step 2, unchanged) | the snapshot taken in the same run, frozen in the run directory (27.12.13.4) |
| Who creates the database | not the runner | the runner, from a pinned image, in this run |
| Target named by | the operator (connection file) | nobody: the runner derives the address from the cluster it created |
| P1, P2, P3, ACL rule, ledger gate, post-B1 ledger equality, migration-blob binding | 2.7.2, unchanged | 2.7.2, unchanged and mandatory |
| Health in a deployed release | reads it | refuses it, P0 |
| What a pass establishes | target qualification of the named target | repository qualification only; never target or production qualification |

##### 27.12.13.2 `HOSTED_COMMITTED`: unchanged

This is the procedure of 27.12.6 steps 1 to 5 and 27.12.11 steps 6 to 10 exactly as sealed in revision 2.7.2, with one
added refusal (27.12.6 step 3: `mode` must be `HOSTED_COMMITTED`). It is mandatory for production and for every target
that is not a cluster created by the ephemeral entry point in the same run.

There is no fallback. If any hosted step refuses, the runner exits non-zero. It never retries in ephemeral mode, never
snapshots the target to make a declaration, and never reads a declaration from anywhere but `R`. A hosted invocation
with no declaration at `R` refuses before opening a connection. Every production fence of 27.12.10 and section 26
stands, and production still refuses at the ledger gate while its ledger lacks the six base versions. Verified TLS for
hosted targets (hardening item 3 of the 2.7.2 seal record) belongs to this mode only.

##### 27.12.13.3 Ephemeral cluster lifecycle and eligibility

**Who may invoke.** Only the ephemeral entry point of the committed runner, run by the CI job or by a developer on a
host whose container daemon is healthy. It is the only way to create an ephemeral target. Its inputs are exactly the
release commit `R` (27.12.6 step 1, unchanged: `HEAD` equals `R`, no tracked change, no flagged path), one setup
profile, zero or more hook ids, and zero or one regression suite id (27.12.15, revision 2.7.6), all from the closed
hook registry at `R` (27.12.13.8, revision 2.7.4). It accepts
no URL, connection file, host, port, user, database name, declaration path, baseline path, qualification status or
any other option. An unknown option, an unknown profile or an unknown hook id refuses before L1, so no container is
created. Negative fixtures run inside this same entry point as registered hooks; there is no second entry point and
no path that drives the engine or opens a target connection outside the runner (27.12.13.8).

**Lifecycle.** Each step is recorded in the run record; any failure, missing value or ambiguity refuses, opens no
further connection and never falls back to hosted mode or to another cluster:

- **L1. Run identity.** Create a new empty run directory, mode 0700, outside the repository. Generate `runId` and,
  separately, `clusterNonce`, each 128 bits from a cryptographic random source, as 32 lowercase hexadecimal
  characters. Write the run record once: `runId`, `clusterNonce`, `R`, the runner's blob SHA at `R`, the hook
  registry's blob SHA at `R`, the setup profile, the hook ids, `negativeFixture` (revision 2.7.4: true if and only if
  at least one hook id was given, decided by the runner, 27.12.13.8), `plannedApplications` (revision 2.7.5, below),
  the regression suite id and plan id (revision 2.7.6, 27.12.15), and the host time (informational only). This header is written before L2 and never changed.

  `plannedApplications` is the ordered list of the B1 applications this run will make. Each entry has exactly a
  sequence number, counting from 1, the database it targets, and the migration S6 applies, which is the B1 migration
  of the stage manifest at `R` (version `20261002090000`, `migrationBlob`). The plan is a constant of the committed
  runner at `R`: it is not an input, no option, environment variable, file, profile or hook can add, remove or
  reorder an entry, and it holds at least one entry. A plan that is empty, or has an entry whose migration is not
  that B1 blob, refuses at L1, before L2. Revision 2.7.6: the runner holds a closed set of such constants, the base
  plan and one plan per registered regression suite, and the plan of a run is selected only by its registered
  regression suite id (27.12.15). Selection by anything else is impossible, and every committed plan obeys this
  paragraph.
- **L2. Create.** Create exactly one container through the daemon:
  - image referenced by the pinned digest of 27.12.13.7, never by tag;
  - label `kj.b1.ephemeral.run=<runId>`;
  - data directory `/var/lib/postgresql/data` on `tmpfs`, with no bind mount and no named or anonymous volume;
  - command exactly `postgres -c cluster_name=kj-eph-<clusterNonce>` behind the image's own entry point;
  - port 5432 published on `127.0.0.1` only, with a port the daemon assigns;
  - local trust authentication: the cluster holds nothing but this run's fixtures, and it dies with the container;
  - (revision 2.7.6) attached only to the run network `kj-eph-<runId>`, which the runner creates first with the label
    `kj.b1.ephemeral.run=<runId>`, under the alias `kj-eph-db` (27.12.15).

  Record the container id and the network id the daemon returns.
- **L3. Daemon attestation**, repeated before every connection the runner opens. Inspect the recorded container id and
  require all of:
  - running;
  - `Config.Image` equal to the pinned reference;
  - the exact label;
  - `Mounts` empty, and `HostConfig.Tmpfs` exactly the data directory;
  - `Config.Cmd` exactly `["postgres","-c","cluster_name=kj-eph-<clusterNonce>"]`, and `Config.Entrypoint` exactly
    the image's `["docker-entrypoint.sh"]` (OBSERVED, 27.12.14);
  - exactly one port binding, on `127.0.0.1`;
  - (revision 2.7.6) attached to exactly the run network, which carries the exact label and, until stage T of 27.12.15
    begins, has no other container attached.

  Record `Created`.
- **L4. Address.** Connect only to `127.0.0.1` and the host port from L3, as `postgres`, with no password and no
  passfile. The address is derived, never supplied. Loopback is not evidence of anything (OBSERVED, 27.12.14: a
  loopback port can reach a cluster that existed before the run). It is only where the attested container's port is.
- **L5. Live identity**, the first statement of every runner connection to the target (snapshot, gate, apply
  preflight, post-migration qualification, and every connection handed to a setup profile or a hook), read-only. It
  is not bypassable (revision 2.7.4): the runner's one connection factory runs it unconditionally before returning a
  connection, no registry entry may name it, and no hook receives an address or credential with which to connect by
  itself (27.12.13.8). All must hold:
  - `current_setting('cluster_name')` equals `kj-eph-<clusterNonce>`. The setting has context `postmaster`
    (OBSERVED), so it reaches a server only through its start command or its configuration and a restart;
  - initdb time, `system_identifier >> 32`, is at least `floor(Created)` and at most the postmaster start time.
    PostgreSQL forms the identifier at initdb as seconds `<< 32`, microseconds `<< 12` and the low 12 bits of the PID
    (FACT of the PostgreSQL source; OBSERVED on 17.6, 27.12.14). Both times come from the clock of the container
    host's kernel, never the runner host's clock;
  - `pg_postmaster_start_time()` is at least `floor(Created)`;
  - `version()` equals the pinned server version string of 27.12.13.7;
  - `current_user` has `rolsuper`;
  - the system identifier is not the `systemIdentifier` of any `HOSTED_COMMITTED` declaration or platform baseline
    committed at `R`. This is defence in depth and is never sufficient alone.
- **L6. Teardown.** At the end of the run, on success or failure, remove the container (the `tmpfs` data directory goes
  with it), then the run network (revision 2.7.6), and record both removals. The run directory stays as evidence. A run whose container is gone cannot be
  continued. Running again is a new run with a new `runId`.

**Eligibility proof.** A target is eligible only if every L step passes. Three independent facts follow:
1. The server answering on the derived port reports the nonce minted in this run, which only the start command the
   runner gave could have set.
2. Its data directory was initialised after the container the runner created, on `tmpfs` with no mount. It holds no
   earlier state, and it is destroyed with the container.
3. The daemon attests the image by digest and the exact command, so nothing in the container forwards elsewhere.

A hosted Supabase database fails 1 and 3, and its owner role is not a superuser. A loopback tunnel to any existing
cluster fails 1, 2 and 3 (OBSERVED shape, 27.12.14). The threat model is that of P3 (27.12.7): mistakes and drift, not
a hostile operator who controls the container daemon, who could equally edit the runner.

**One cluster, several databases.** One run creates one cluster, which may hold several databases (the runner
creates them, revision 2.7.6, 27.12.15). Each B1 application targets one database, and has its own snapshot and declaration, numbered in
the run record with the sequence number of its entry in `plannedApplications` (revision 2.7.5). The runner makes the
planned applications in order and makes no application that is not planned.

##### 27.12.13.4 Run-bound declaration and baseline

For each application, in this order, each step recorded with its time and sequence number:

- **S1. Base.** Apply the sealed base migrations through the pinned engine, from a fresh export of `R` holding exactly
  the base files of the stage manifest (the export of 27.12.11 step 7 without the B1 file), never with `--include-all`.
  Afterwards the ledger records exactly `SEALED_BASE_MIGRATION_SET`.
- **S2. Fixture setup.** Only the run's setup profile (`none`, or `pinned-helper`, which installs the pinned helper and
  `ensure_rls`, or from revision 2.7.7 `platform-definer-fixture`, 27.12.13.8), and, in a `negativeFixture` run,
  registered hooks at point `S2` (for example the ledger states of
  LEDGER-B, LEDGER-E and LEDGER-F). Connections come from the runner's factory and pass L3 and L5 first.
- **S3. Snapshot.** The sealed snapshot procedure of 27.10.4 and 27.12.6, in its one READ ONLY transaction, writes the
  platform baseline and the declaration from one read.
  - The declaration has `mode` `EPHEMERAL_RUN_BOUND` and `run` with exactly the fields `runId`, `clusterNonce`,
    `containerId`, `containerCreated` and `application` (the sequence number).
  - The baseline has the same `mode` and an identical `run` object (revision 2.7.4, R273-B1, 27.10.4).
  - Both files are written once into the run directory, mode 0600.
  - Their SHA-256s are recorded in the run record and kept in the runner's memory.
- **S4. Validate.** Steps 3 and 4 of 27.12.6 unchanged: fields, formats, `pinsSha256`, `setSha256` recomputed, every
  entry equal to a pin, migration pins equal to the pins blob. In addition, `run.runId`, `run.clusterNonce` and
  `run.containerId` must equal the current run's. Revision 2.7.4 (R273-B1) adds, for the baseline, before the gate:
  - its exact schema (`kind`, `mode`, `run` and every 27.10.4 field, no other field) and `entriesSha256` recomputed;
  - `mode` `EPHEMERAL_RUN_BOUND`, equal to the declaration's;
  - `run` deep-equal to the declaration's `run`, field by field (`runId`, `clusterNonce`, `containerId`,
    `containerCreated`, `application`), and so to the current run and this application;
  - `provenance` equal to the declaration's in every field except `querySha256`, and its `systemIdentifier` and
    `database` equal to the values L5 read on this application's connection;
  - the eligibility rule of 27.10.4 over its entries.

  Any failure refuses before the gate, and nothing is written to the target.
- **S5. Drift fixtures.** Registered hooks at point `S5` only, in a `negativeFixture` run.
- **S6. Gate and apply.** Steps 8 to 10 of 27.12.11, after L3 and L5. Immediately before deriving the three settings,
  re-read both run files and require their recorded SHA-256s.
- **S7. Post-migration qualification.** 27.12.8 item 7 and the post-B1 ledger invariant of 27.12.11, against the
  run-bound declaration, re-read and verified by digest, in place of the blob at `R`.

**Immutable and single-use.** Nothing rewrites a run file. Any change to the declaration or the baseline after S3
refuses at S6, or fails S7. Another run's declaration or baseline fails S4 on `run`, and if forced further it fails P3
step 4 or the gate, because the system identifier differs (EPH-2, EPH-15, EPH-18).

**The run-bound baseline is self-referential** (27.10.4). It records what the run's own database held at S3. It proves
no reviewed or historical provenance, and it can never stand in for the `HOSTED_COMMITTED` baseline of gate 3b. It
detects only drift after S3, through the pre-application inventory equality of 27.12.11 step 8, P1 to P3 and S7.

**What P3 proves here.** The declaration equals the live surface at S3 by construction. In this mode P3 therefore
detects change between S3 and COMMIT, and misdirection to another database or cluster. That is its whole role here.
P1, P2, the ACL rule, the ledger gate, post-B1 ledger equality and migration-blob binding are unchanged and mandatory.

##### 27.12.13.5 Runner procedure in ephemeral mode

27.12.6 steps 1 and 3 to 5 and 27.12.11 steps 6 to 10 are unchanged. Step 2 is replaced by L1 to L6 and S1 to S4.
Steps 3 and 4 run at S4, with `mode` required to be `EPHEMERAL_RUN_BOUND` for the declaration and the baseline. In step 9 the URL is the derived address
of L4 with `sslmode=disable` and no passfile: loopback to the attested container, which holds no secret.

##### 27.12.13.6 Separation of the modes

- **Entry points.** They are distinct. The hosted entry point has no code path into the ephemeral snapshot or
  cluster code, and the ephemeral entry point accepts no target input (static tests, 27.12.8 item 12).
- **Repository test.** It refuses any committed declaration or platform baseline whose `mode` is not
  `HOSTED_COMMITTED` or that carries `run`, a committed pair whose modes differ, and any committed run record or
  run-directory file. Run directories live outside the repository.
- **Health.** In a deployed release, health accepts `HOSTED_COMMITTED` only, for the declaration and the baseline
  alike; anything else is P0 (27.12.6, section 21).
- **Qualification labels.**
  - Ephemeral results are at most REPOSITORY_QUALIFIED. TARGET_QUALIFIED comes only from a `HOSTED_COMMITTED`
    cutover record against the named target.
  - No ephemeral result satisfies a hosted gate, a change window or production qualification.

**Qualification status** (revision 2.7.4, R273-B2 and H5; predicate made non-vacuous in revision 2.7.5, R274-B1). At
the end of an ephemeral run the runner computes exactly one status from its own in-memory run record, and emits it
together with the SHA-256 of the final run record.

Every L and S step writes an outcome to the run record: `passed`, or `refused` with the check that failed. A step with
no recorded outcome counts as not passed. An application counts as **applied** only if its record shows S6 completed
with engine exit status 0 for the B1 migration of its plan entry, and the S6 ledger read after the engine
(`ledgerAfter`) holds exactly `SEALED_BASE_MIGRATION_SET` plus `20261002090000`.

- **`NEGATIVE_FIXTURE_RESULT`** if `negativeFixture` is true, whatever else happened. The run then records only
  whether each hook's registered expected outcome occurred.
- **`REPOSITORY_QUALIFIED`** only if every one of these holds:
  1. `negativeFixture` is false and no hook id was given.
  2. `plannedApplications`, as written at L1, has at least one entry, and the number of applied applications equals
     the number of planned entries.
  3. Every planned entry names the B1 migration (version `20261002090000`, `migrationBlob` at `R`), and B1 was
     applied in this run, as defined above, for every entry.
  4. Every planned application has outcomes `passed` for S1, S2, S3, S4, S5, S6 and S7, recorded in that order, with
     no refusal.
  5. No step L1 to L6 or S1 to S7, on any connection or application, recorded a refusal or a failed identity,
     lifecycle, validation, migration or qualification check.
  6. Post-B1 ledger equality (27.12.11) was evaluated at S7 for every planned application, and passed. A ledger
     comparison that did not run is a failure, not a pass.
  7. No post-application qualification (S7, 27.12.8 item 7) failed for any application.
  8. L6 teardown is recorded with outcome `passed`.
- **`NOT_QUALIFIED`** in every other case.

A run with zero applications can never report `REPOSITORY_QUALIFIED`: condition 2 needs at least one planned entry,
and as many applied applications as planned entries. A run refused at any L step, or before S6 of any application, is
`NOT_QUALIFIED` however clean its teardown (cases EPH-26 and EPH-27).

An ephemeral run never emits TARGET_QUALIFIED.

The status is never supplied by a caller, an option, an environment variable or a file. Any consumer of run evidence
(the CI summary, a qualification report) recomputes the status from the run record with the same predicate, conditions
1 to 8 above, over the same recorded evidence, and refuses the record if the recomputed status, or the record's
SHA-256, differs from what the runner emitted. A record with
`negativeFixture` true, or with any hook, can never be counted as qualification, so a negative fixture cannot become
ordinary qualification, by itself or by editing.

##### 27.12.13.7 Engine and image pins (R272-ENGINE-PLATFORM)

**Engine.** One approved Supabase CLI version, `2.120.0` (release `v2.120.0` of `supabase/cli`, published
06/10/2026). Each release archive holds two executables. The ledger contract of 27.12.11 was observed with both present,
and the launcher alone reaches the connection stage (OBSERVED, 27.12.14), so which one executes migration statements
is not established. Both are therefore pinned and supplied together. Supported platforms and SHA-256s (OBSERVED,
27.12.14):

| Platform | Release archive (SHA-256, equal to the release's `checksums.txt`) | Executable | SHA-256 |
|---|---|---|---|
| `linux-x64` (CI) | `supabase_2.120.0_linux_amd64.tar.gz`, `7074584113aa00495beeac661c41fb09f1ddd0a483cd7333894b0d080086dc6e` | `supabase` | `e4e5d910546d7eda3bc3c63affce09a12b9954a00685dce5236080cd45f43eda` |
| | | `supabase-go` | `3a2239de4dddd58040920fdb9706a11c7f9b396e0f2975d65b3829cf375834f4` |
| `windows-x64` (local) | `supabase_2.120.0_windows_amd64.tar.gz`, `53920013d24bc9e66180f35ceeea9ddc20e65a7afa883421e9c0ba60ad7457ee` | `supabase.exe` | `1cbedd6e494581a1c1d90113660113a06798d9967d19c857127b66b8a428e836` |
| | | `supabase-go.exe` | `fa2ba7fb02b01d98fa5a3c6d92632239b10c6974dbc42c65b698b6a479847343` |

The runner's engine procedure, refining 27.12.11 step 6:
1. Determine the platform from the operating system and architecture. Any other platform refuses.
2. Copy the two executables named for that platform into a fresh engine directory in the run or cutover directory,
   and hash the copies. The directory must hold exactly those two files with exactly the pinned SHA-256s.
3. Invoke the copied launcher by absolute path, never through `PATH`, and require `--version` to print exactly
   `2.120.0`.
4. Build the engine's environment from nothing, never by inheriting and filtering (hardening item 2; made exact in
   revision 2.7.4, H1). It holds exactly:
   - `PATH`: the engine directory only;
   - `HOME`, and on Windows also `USERPROFILE`: a fresh empty directory;
   - `TMPDIR`, and on Windows `TEMP` and `TMP`: a fresh empty directory;
   - on Windows only, `SystemRoot`, copied from the runner's own environment because process start requires it;
   - in hosted mode only, `PGPASSFILE`, naming a passfile the runner itself created in the cutover directory with mode
     0600, holding exactly one line for the exact target host, port, database and user, and deleted after the engine
     exits. In ephemeral mode there is no `PGPASSFILE`.

   Nothing else passes, whatever the parent process holds: no other `PG*` variable (`PGHOST`, `PGPORT`, `PGDATABASE`,
   `PGUSER`, `PGOPTIONS`, `PGSERVICE`, `PGSERVICEFILE`, `PGSSLMODE` and the rest), no inherited `PGPASSFILE`, no
   `SUPABASE_*` variable and no proxy variable. The runner records the variable names it passed, without values. If
   the pinned engine cannot start in this environment, that is a finding for a design revision, not a reason to widen
   the list.

An unrecognised executable, an extra file, a digest that differs, the other platform's pin, or any other version
refuses before any database connection. The pins are committed at `R` in the engine pin file. Changing the version, a
digest or the platform set is a design revision. Every LEDGER case runs against the engine of the platform that ran it.

**Ephemeral cluster image.** `postgres@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929`. That
is the registry digest of `postgres:17.6` as pulled on 09/10/2026, whose server reports `PostgreSQL 17.6 (Debian
17.6-2.pgdg13+1) on x86_64-pc-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit` (OBSERVED). This version
string is the L5 pin. The CI compose file uses the tag `postgres:17.6` today; the remediation references the digest. A
change of image pin is a pin change under B1's own hostile review, like `SEALED_BASE_MIGRATION_SET`. It does not touch
hosted authority.

##### 27.12.13.8 Setup profiles and the closed hook registry (R272-VARIANT; revision 2.7.4, R273-B2)

**Registry.** `kerneljson:b1-runner-hook-registry/v1`, file `infrastructure/database/b1-runner-hooks.json`, committed
and reviewed with the B1 remediation. The runner reads it as a blob of `R`, like the pins file, never from the working
copy, and records its blob SHA. Its schema is exact at every level, and an unknown field refuses. It holds:
- **`setupProfiles`**: exactly two, and no others; revision 2.7.7 adds a third, and there are exactly three.
  - `none` does nothing.
  - `pinned-helper` has the owner install, at S2, the 953-byte body of 27.12.3 as `public.rls_auto_enable()` and the
    `ensure_rls` binding of 27.12.4.
  - `platform-definer-fixture` (revision 2.7.7) has the owner run, at S2, the committed fixture SQL at `R`
    (`infrastructure/database/b1-fixture-platform-definers.sql`, read as a blob of `R`): schema `auth` and the four
    platform-style definers the frozen definers test creates (an `internal` function, a SQL-standard body, a `prosrc`
    function with `search_path=""` and one without configuration), with `PUBLIC` EXECUTE revoked. It gives the
    snapshot a non-empty platform baseline exercising each digest rule of 27.10.4, as the frozen test did. Revision
    2.7.8 (R277-B3): the registry pins the file's SHA-256, the runner refuses before L1 on any other digest, and a
    static test limits the file to exactly `CREATE SCHEMA auth`, the four `CREATE FUNCTION` statements in schema
    `auth` with their exact identities, and one `REVOKE EXECUTE ... FROM PUBLIC` per function. It cannot touch
    `public`, `kernel_private`, the ledger, any role or any setting, and every L and S step, including S7's
    catalogue equality, still applies.

  A profile changes and skips no L or S step. It only creates the fixture the snapshot will then record.
- **`hooks`**: a closed list. Each entry has exactly:
  - `id`, lowercase, unique;
  - `point`, from a closed set: `S2`, `S5`, `L2-target`, `L3-skip`, `S3-files`, `S4-skip`, `S6-gate-inventory-skip`,
    `S6-apply`;
  - `effect`, a fixed text naming the steps it changes or skips;
  - `callers`, the exact committed test files allowed to name it;
  - `expected`, the refusal or SQLSTATE it must produce, or (revision 2.7.7) a recorded outcome, for example "S6
    commits and S7 passes" or "S3 refuses", which the committed test reads from the run record. Revision 2.7.8
    (R277-B3): `expected` is always structured and exact. It names the step where the run must end or the steps that
    must pass; for a refusal, the SQLSTATE where one exists and the exact message, or an anchored pattern that names
    the failed rule as 27.12.9 requires; and, for a commit, the named post-conditions S7 or the committed test must
    observe. A refusal at the right step for another rule or message fails the case;
  - `precondition` (revision 2.7.8): one committed read-only query and its exact expected result, which shows that the
    hook's perturbation took effect. The runner runs it through its connection factory immediately after the hook,
    before the next step, and records the result. If the result differs, the hook is recorded `not-effective` and the
    case fails, whatever the run did afterwards. A precondition about a function ACL (revision 2.7.9) reads the
    `proacl` items themselves (`aclexplode`, or `proacl::text[]` compared as a set), never `has_function_privilege`
    alone: a null `proacl` grants `PUBLIC` EXECUTE by default and would satisfy a privilege check without the
    perturbation having happened;
  - `cases`, the case numbers of 27.12.9 and 27.12.13.9 it serves.

  No point or effect may name L5, L6, L1, S7 or the qualification status, so L5 cannot be skipped, teardown cannot be
  suppressed, the run header cannot be rewritten and the status cannot be set by a hook.
- **`regressionSuites`** (revision 2.7.6): the closed list of 27.12.15. A regression suite is not a hook, changes no L
  or S step and cannot be combined with a hook.

**Rules.**
1. **Unknown refuses early.** Before L1, the runner validates the registry blob, the profile id and every hook id. An
   unknown profile, an unknown hook id, a registry that fails its schema, or a registry read from anywhere but `R`
   refuses before any container is created.
2. **Every hook makes the run a negative fixture.** `negativeFixture` is true if and only if at least one hook is
   given. The runner decides this at L1 from the inputs, writes it into the run header before L2, and never changes it.
   This holds whether or not the hook changes or skips a step of L1 to L6, S1, S3, S4 or S6. It is not a caller's
   assertion and cannot be passed in.
3. **A negative fixture can never qualify.** A `negativeFixture` run's status is `NEGATIVE_FIXTURE_RESULT`, even if
   every check passes (27.12.13.6). Its outcome is only whether the hook's `expected` result occurred, which the
   committed test asserts.
4. **L5 is never bypassed.** Hooks receive only connections from the runner's factory, which ran L5 on them. A hook at
   `L2-target` substitutes the container or port the factory will use, and the factory still runs L5 on it. A hook at
   `L3-skip` omits the daemon attestation for one connection, and L5 still runs. No hook receives an address,
   credential or engine path with which to connect by itself.
5. **One entry point.** Hooks run only inside the ephemeral entry point. The hosted entry point accepts no profile and
   no hook, and contains no hook code. There is no other path that applies SQL to a target, supplies the three settings
   or invokes the engine. Revision 2.7.6: the regression consumers of 27.12.15 apply test SQL to the databases of their
   suite plan, during stage T only; they never apply a migration file, supply the settings or invoke the engine.
6. **Positive controls are unhooked.** Cases 1, 23, 41, ACL-A, LEDGER-A and EPH-1 run with a setup profile and no hook,
   through the full normal runner: L1 to L6 and S1 to S7, unchanged.

**What used to be the negative-fixture path of 2.7.3.** Every fixture that applies SQL bytes other than the blobs of
`R`, or supplies the three settings other than through the runner, is a registered hook at `S6-apply`, `S2` or `S5`:
- case 6, last part, and ACL-B: the B1 variant replaces the B1 file in the run's export;
- cases 16, 19, 24 to 30 and 38: the settings, given by `set_config` in the migration transaction or as engine
  startup parameters;
- LEDGER-B: the B1 blob applied in an owner transaction instead of through the engine;
- EPH-5 and EPH-15: the forced P3 step 4 parts;
- the ledger fixtures of LEDGER-B, LEDGER-E, LEDGER-F, LEDGER-D and EPH-13.

The static guard of 27.12.8 item 12 allows writers of the three settings only in the registry's listed callers of
those hooks.

**Static qualification** (a committed repository test with failing fixtures of its own). It verifies all of:
- the registry parses under its exact schema, and every `id` is unique;
- every hook's `callers` exist, and each of them names the hook;
- every call of the ephemeral entry point that passes a hook is in a file listed in that hook's `callers`, and names
  the hook by a string literal, never a computed value;
- no call site outside the registry's callers passes any hook;
- the connection factory runs L5 before returning a connection, on a path with no branch that depends on a hook;
- the runner's `plannedApplications` constant has at least one entry, every entry names the B1 migration of the stage
  manifest, and nothing outside the runner's L1 code writes it (revision 2.7.5); from revision 2.7.6 this holds for
  every committed plan, the base plan has exactly one entry, and each regression suite's `databases` equal its plan;
- the runner and the consumer recomputation call one committed status function, which has failing fixtures of its own
  for each of conditions 1 to 8 of 27.12.13.6 (revision 2.7.5);
- the hosted entry point imports no hook, profile or ephemeral code;
- no file outside the runner opens a connection to an ephemeral cluster or invokes the engine, except the committed
  files of a registered regression suite, which connect only during stage T with the addresses the runner gives them
  (revision 2.7.6, 27.12.15), and the regression-consumer prohibitions of 27.12.15.

##### 27.12.13.9 Negative cases

Each is a committed automated case under the rules of 27.12.9. EPH-1 is the positive control. Every other case must
fail on purpose. Every earlier case of 27.12.9 stays in force.

| # | Case | Required result |
|---|---|---|
| EPH-1 | Fresh disposable database. Ephemeral entry point, S1 to S7, no hook: once with setup profile `none` (empty declaration), once with `pinned-helper` | commits; post-migration qualification and ledger equality pass; the declaration and the baseline are `EPHEMERAL_RUN_BOUND` with identical `run`; the run record shows S3 after S1 and S2 and before S6; teardown recorded; applied applications equal `plannedApplications`, at least one; status `REPOSITORY_QUALIFIED`, and the consumer recomputes the same. This realises cases 1, 23, 41, ACL-A and LEDGER-A in this mode (positive control) |
| EPH-2 | Two disposable databases, in two runs | their system identifiers differ; each commits with its own declaration; run A's declaration placed in run B's directory refuses at S4 (`runId`); forced through P3 on B, `23514` at step 4 |
| EPH-3 | Hosted target falsely claiming ephemeral mode: the ephemeral entry point given a URL, connection file, host, port, database name or declaration path; a run record edited to name a container the runner did not create | refuses before any connection on any target input; L3 refuses the foreign container, and with the registered hook at `L3-skip`, L5 refuses (no nonce); status `NEGATIVE_FIXTURE_RESULT` |
| EPH-4 | Local tunnel to a hosted database, simulated by a pre-existing cluster behind a forwarding container on a loopback port, substituted for the run's container or port | L3 refuses (image, command); with the registered hook at `L3-skip`, L5 refuses: `cluster_name` without the nonce, initdb before `Created`; status `NEGATIVE_FIXTURE_RESULT` |
| EPH-5 | Wrong system identifier: the run-bound declaration's `systemIdentifier` changed (digests updated to match); the same value forced into P3 | the gate refuses (live identity not equal to the declaration's), engine not invoked; forced, `23514` at P3 step 4 |
| EPH-6 | Declaration replaced after the snapshot: between S3 and S6; between S6 and S7 | refuses at S6 before the engine runs (digest); S7 fails |
| EPH-7 | Missing or malformed run-bound declaration: file deleted; invalid JSON; byte-order mark; `mode` missing; `HOSTED_COMMITTED` with `run`; `EPHEMERAL_RUN_BOUND` without `run`; unknown field in `run` | refuses at S4, before the gate |
| EPH-8 | Catalogue or baseline changed after the snapshot (S5): extra definer in `public`; `ensure_rls` dropped; helper body changed; extra definer in `extensions` | revision 2.7.4 (H2): the gate's pre-application inventory equality refuses all four before the engine runs. With the registered hook at `S6-gate-inventory-skip`: `23514` by P1, P2 or P3 step 5 for the first three; for the last, B1 commits and S7 fails on 27.10 inventory equality (P1 to P3 cover `public` and `kernel_private` only) |
| EPH-9 | Unpinned engine: another CLI version; an extra file in the engine directory; a `supabase` found through `PATH`. Revision 2.7.4 (H1): the parent process holds `PGHOST`, `PGOPTIONS`, `PGSERVICE`, `PGPASSFILE` and `SUPABASE_ACCESS_TOKEN`, and puts a fake `supabase` and `psql` first on its `PATH` | refuses before any connection for the first three; for the last, the recorded engine environment holds exactly the 27.12.13.7 item 4 names, the fakes never run, and the engine connects only to the derived target |
| EPH-10 | Wrong platform digest: the other platform's executables; one byte changed in `supabase-go`; an unsupported platform | refuses before any connection |
| EPH-11 | Hosted mode with no committed declaration: absent at `R`, or present only in the working copy | refuses before any connection (as case 36) |
| EPH-12 | Attempted fallback: a hosted invocation failing any step; a hosted invocation whose declaration at `R` is `EPHEMERAL_RUN_BOUND` or carries `run`; a committed ephemeral declaration | the runner exits non-zero, creates no container and runs no ephemeral code (instrumented test plus static test); the repository test fails; health P0 |
| EPH-13 | Missing historical ledger version in an ephemeral run: a base row deleted by a registered hook at `S2`, at the oldest, middle and newest position | the gate refuses, the engine is not invoked, the row is not added; S1 never passes `--include-all` (static test) |
| EPH-14 | Migration blob substitution: an exported file differing from its blob; the B1 file edited in the working copy only; the B1 blob at `R` differing from its stage-manifest pin; `migrationBlob` differing at S7 | refuses at 27.12.11 step 7; S7 fails for the last |
| EPH-15 | Cross-run reuse: run A's declaration and baseline used in run B; run A's container id used after A's teardown | S4 refuses (`runId`, `clusterNonce`, `containerId`); L3 refuses the removed container; forced through P3, `23514` at step 4 |
| EPH-16 | Committed ephemeral baseline: a platform baseline with `mode` `EPHEMERAL_RUN_BOUND`, or with a `run` field, committed at `R` | the repository test fails; the hosted runner refuses before connecting (27.12.6 step 2); deployed health P0; gate 3b not satisfied |
| EPH-17 | Hosted run-bound baseline substitution: a baseline path, or a run-directory baseline, offered to the hosted entry point; the baseline at `R` replaced by a run-directory file; a baseline edited in the working copy only | the option is refused; for the others the hosted runner refuses before opening any connection (mode, `run`, dirty tree) |
| EPH-18 | Cross-run baseline reuse: run A's baseline with run B's own declaration, in run B (digests updated to match) | S4 refuses (`run` differs from the declaration's and from the current run); forced past S4 by the registered hook at `S4-skip`, the gate refuses (system identifier) |
| EPH-19 | Mismatched modes: in a run, an ephemeral declaration with a baseline whose `mode` is `HOSTED_COMMITTED` or missing; at `R`, a hosted declaration with an ephemeral baseline | S4 refuses; the hosted runner refuses before connecting; the repository test fails; deployed health P0 |
| EPH-20 | Mismatched run identifiers in one run: the baseline's `run.runId`, `clusterNonce`, `containerId`, `containerCreated` or `application` differs from the declaration's, each in turn | S4 refuses, before the gate, for every one |
| EPH-21 | L3 bypass: the registered hook at `L3-skip` on an otherwise genuine run; an attempt to skip L3 by an unregistered option or environment variable | the genuine run passes L5 but its status is `NEGATIVE_FIXTURE_RESULT`; the unregistered attempt refuses before L1 |
| EPH-22 | Unknown hook: an id not in the registry; an id differing only in case; a registry entry with an unknown field; a registry edited in the working copy only | refuses before L1; the daemon shows no container labelled with a new run |
| EPH-23 | L5 bypass attempt: a registry entry whose `point` or `effect` names L5; a hook that tries to open its own connection; a code change adding a hook-dependent branch around L5 in the connection factory | the registry schema refuses before L1; the hook has no address or credential to connect with; the static test fails |
| EPH-24 | Hooked otherwise-passing run: a registered hook whose effect does not prevent any check from passing (for example `L3-skip` on a genuine cluster), every application completing S1 to S7 | status `NEGATIVE_FIXTURE_RESULT`, never `REPOSITORY_QUALIFIED`; the CI summary does not count it |
| EPH-25 | Qualification-status substitution: after a run, its record edited to clear `negativeFixture`, remove a hook or set a status; a status passed as an option or environment variable; a record claiming `REPOSITORY_QUALIFIED` with a failed S7 or no recorded teardown (H5) | the option or variable refuses before L1; the consumer's recomputation or the record SHA-256 differs from the runner's emitted values, and the record is refused |
| EPH-26 | Revision 2.7.5 (R274-B1). Clean, unhooked run (profile `none`, no hook id, `negativeFixture` false) refused at L2, with L6 teardown recorded `passed`. Shown at two layers: (a) the committed status function and the consumer recomputation, each given a run record of exactly that shape (no application started, every recorded check other than L2 passed); (b) end to end, with the L2 refusal induced only from outside the runner, never by a hook, option or environment variable: the daemon does not hold the pinned image digest and image pulls are blocked | status `NOT_QUALIFIED` from the runner; the consumer recomputes `NOT_QUALIFIED`; zero applied applications against at least one planned; never `REPOSITORY_QUALIFIED` |
| EPH-27 | Revision 2.7.5 (R274-B1). Clean, unhooked run refused at L5, with L6 teardown recorded `passed`. Shown at the same two layers: (a) a run record of exactly that shape given to the status function and the consumer; (b) end to end, induced only from outside the runner: after L2 has recorded the container id, an external `docker exec` in the run's container creates a role without `SUPERUSER` and runs `ALTER ROLE postgres SET role` to it, so the next connection's `current_user` lacks `rolsuper`. The test asserts the recorded refusal stage is L5 and treats any other outcome as its own failure | the next connection refuses at L5 and opens no further connection; L6 runs; status `NOT_QUALIFIED` from the runner; the consumer recomputes `NOT_QUALIFIED`; never `REPOSITORY_QUALIFIED` |

##### 27.12.13.10 Evidence record

**Release provenance**, immutable and read from `R`:
- `R`;
- the blob ids and SHA-256s of the pins file, the B1 migration (`migrationBlob`, version `20261002090000`), the stage
  manifest, the runner and the engine pin file;
- the engine version and the executable SHA-256s of the platform used;
- the image pin;
- in hosted mode, also the declaration's blob SHA, `pinsSha256` and `setSha256`.

**Run evidence**, ephemeral mode only, per run:
- mode; `runId`; `clusterNonce`; container id; `Created`; image reference;
- the hook registry's blob SHA, the setup profile, the hook ids and `negativeFixture` (revision 2.7.4);
- `plannedApplications`, and for every L and S step its recorded outcome (revision 2.7.5);
- the regression suite id, the plan id, the run network id, and stage T's `regressionOutcome` with the report's
  SHA-256 and the results of the post-T database and network reads (revision 2.7.6); and the profile, the
  `refusalPolicy`, the trace files' SHA-256s and analysis, the log extract's SHA-256 and the G-gate results
  (revision 2.7.7); the expected and observed refusal multisets, the re-read log settings, and each hook's
  precondition result (revision 2.7.8); the collection command, environment and summary, and the extracted log
  events with their associations (revision 2.7.9);
- for each application, the SHA-256 of its run-bound baseline next to its declaration's, with their equal `mode` and
  `run` (revision 2.7.4);
- the L3 and L5 results: system identifier, initdb time, postmaster start time and database names;
- for each application, the source (`run-directory`) and SHA-256 of its declaration and baseline, and its `setSha256`;
- the sequence and times of S1 to S7, showing the snapshot after base setup and fixtures and before B1;
- the gate results, `ledgerBefore` and `ledgerAfter`;
- the engine's exit status and output;
- the B1 `statements` digest;
- the engine environment's variable names (revision 2.7.4, H1);
- the teardown time and result;
- the qualification status the runner computed and the final run record's SHA-256 (revision 2.7.4).

**Runner identity** is the runner's blob SHA at `R`. The invoking context (the CI run and job, or the local user name)
is recorded for information only, and is never authority.

The hosted cutover record is that of 27.12.6 and 27.12.11, plus `mode`.

##### 27.12.13.11 What revisions 2.7.3 to 2.7.9 do not change

- **Production and hosted authority.** No production authority is widened. Hosted mode is the 2.7.2 procedure plus
  refusals: the declaration's and the baseline's mode and `run` checks, and the read-only pre-application inventory
  equality of 27.12.11 step 8 (revision 2.7.4), which writes nothing.
- **Pins and rules.** It leaves unchanged:
  - the co-resident pins of 27.12.3 and 27.12.4;
  - rules E1 to E4;
  - P1 to P3;
  - the serialisation and golden vector;
  - the ACL rule of 27.12.5;
  - `SEALED_BASE_MIGRATION_SET`;
  - the ledger gate and the post-B1 ledger invariant;
  - section 27.9;
  - the rollout order.
- **Not authorised.** It authorises no production mutation, no ledger repair or backfill, no `--include-all`, no B1
  target-baseline capture, no B1 implementation, merge or deployment, and no start of P8A-0.
- **The six rows.** The six historical ledger rows remain unresolved and unauthorised.

#### 27.12.14 Disposable evidence for revision 2.7.3

Run on 09/10/2026 with Docker 29.1.5 (Docker Desktop, Linux engine) and the image of 27.12.13.7. Every container was
removed afterwards. No production access. Scripts and full output are in
`docs/operations/KJ_P8_R273_EPHEMERAL_EVIDENCE_2026-10-09.md`.

- **Fresh identifiers.** Two fresh containers reported system identifiers `7694443709250187303` and
  `7694443715115663398`.
- **Run-created cluster.** A container created as L2 describes (nonce label, data directory on `tmpfs`, `Mounts`
  empty, `-c cluster_name=kj-eph-<nonce>`, port on `127.0.0.1`) gave:
  - `Created` 23:39:38.77Z, initdb time (`system_identifier >> 32`) 1791502779 (23:39:39Z) and postmaster start
    1791502780;
  - `cluster_name` equal to the nonce, with context `postmaster`;
  - `rolsuper` true.

  A container created by the pinned digest reports that reference as `Config.Image`, the command as given and the entry
  point `["docker-entrypoint.sh"]`.
- **Production's identifier.** Decoded the same way, production's `7678069749886157684` gives initdb time
  25/08/2026 20:32:01Z.
- **Tunnel shape.** A cluster started before the run, reached through an `alpine/socat` container on a loopback port
  that also started after the run began, answered with initdb time 1791502875, eight seconds before the run started
  (1791502883), an empty `cluster_name` and `rolsuper` true. Loopback reachability and superuser status do not
  distinguish it; the nonce, the initdb-time bound and the daemon attestation each do.
- **Engine.**
  - The archives' SHA-256s equal the release's `checksums.txt`.
  - The Windows executables are byte-identical to those of the npm package used for the 2.7.2 evidence.
  - The Linux launcher printed `2.120.0` and, run in `debian:bookworm-slim` against a fresh container, reproduced the
    27.12.11 contract with the test migrations of the 2.7.2 evidence: the ledger has three columns, `version text not
    null`, `statements text[]` and `name text`; each row's `xmin` equals its migration's `txid`; the startup option
    reached the migration (`linux-startup`); the failing migration left no table and no row.
  - The Windows launcher alone, without `supabase-go.exe`, printed `migration up` help and reached the connection stage.

#### 27.12.15 Repository regression and B1 (revision 2.7.6, R275-HARNESS)

**Finding** (FACT, observed at frozen B1 `0ff2919` when B1 remediation began against revision 2.7.5; the file-by-file
inventory is `docs/operations/KJ_P8_R276_REGRESSION_INVENTORY_2026-10-09.md`):
- `tests/support/local.ts` `migrate()` applies every file of the working copy's `supabase/migrations/`, B1 included,
  in a plain `begin`, query, `commit`. It is called by 25 test files directly and through the knowledge-database
  helper by 13, 37 files in all (one does both). `scripts/b1/qualify-ci.sh` and `scripts/mutation-check-identity-cognition.mjs` apply B1 the same
  way, and three further mutation scripts run test files that call `migrate()`.
- The test harness (`tests/support/runtime-roles.ts`, a vitest setup file) runs production code as `kj_worker` and
  `kj_door`, which only B1 creates. So every database-backed test needs a database where B1 is applied.
- Tests create those databases themselves under random names, connect as the owner and as both runtime roles, and the
  compose worker connects to `db:5432`. Three files recreate the whole compose stack, and one pauses the database
  container.

Revision 2.7.5 forbids each of these: 27.12.8 item 9 (every B1 application through the runner), 27.12.13.3 L1
(`plannedApplications` a runner constant), 27.12.13.8 rule 5 and its last static bullet (no other path applies SQL to
a target or opens a connection to an ephemeral cluster), and L2 and L3 (the cluster's only port is on `127.0.0.1`,
which a container on a CI host cannot reach). Revision 2.7.6 integrates the regression suite without changing any
rule of B1 application, eligibility or qualification.

**Four lanes.** Every test and script falls in exactly one lane by what it needs (the inventory classifies each file):

| Lane | What it is | Database | B1 |
|---|---|---|---|
| A. Base regression | tests and mutation checks of base migrations and of code that needs no runtime role | the compose stack's database, not runner-created | never applied, never present |
| B. Positive B1 qualification | the unhooked ephemeral runs of 27.12.13 | runner-created, planned | applied by the runner only |
| C. Negative B1 fixtures | registered hooks of 27.12.13.8, unchanged | runner-created, planned | applied by the runner, under a hook; never qualifies |
| D. Post-B1 regression consumers | the database-backed suite under the runtime roles, run in stage T below | the run's planned databases | already applied in this run; never applied by a consumer |

- **Lane A never applies B1.** Every repository helper that applies migrations (`migrate()`, the knowledge-database
  helper, the mutation scripts) applies only files whose version is in `SEALED_BASE_MIGRATION_SET`, and refuses,
  before it writes anything: the B1 version or file; any file whose version is not in that set; a database whose
  ledger records `20261002090000`; a cluster in which `kj_worker` or `kj_door` exists; a server whose `cluster_name`
  begins `kj-eph-`; and any call while stage T is running. Lane A runs the harness in mode `base`, in which production
  code connects as the owner, as it did before B1. A lane A pass establishes nothing about B1.
- **Mutation suites are lane A** (corrected in revision 2.7.7). A mutation edits either a base migration or
  application code (services, packages, apps). The first is refused by the export's blob binding (27.12.11 step 7);
  the second leaves the checkout of `R` dirty, which the runner refuses (27.12.6 step 1). A lane A helper applies the
  working copy's base chain, mutated or not, and never B1. What this keeps and what it does not is stated in 27.6
  item 3.
- **The in-test B1 applications** of `tests/runtime-roles-definers.integration.test.ts` and the blocks of other
  files that need a database before B1 are partitioned block by block (revision 2.7.7; the mapping is in the
  inventory): base-chain blocks to lane A; B1 applications with a fixture to lane B through a setup profile, or to
  lane C as registered hooks whose `expected` is a recorded outcome; assertions on the applied database to lane D.

**Stage T: regression consumers.** It runs inside the ephemeral entry point, in the same run, after S7 of the last
planned application and before L6, if and only if all of these hold: `negativeFixture` is false; exactly one
regression suite id was given; and every planned application has outcome `passed` for S1 to S7. Otherwise stage T does
not run, and records `not-run` with the reason.

- **Input.** In addition to 27.12.13.3, the ephemeral entry point accepts zero or one regression suite id, from the
  hook registry at `R`. An unknown id, an id given together with any hook id, or a suite named any other way (option,
  environment variable, file) refuses before L1. The id is written into the L1 header. It changes no L or S step, no
  plan entry and not `negativeFixture`.
- **Registry.** The registry of 27.12.13.8 gains `regressionSuites`, a closed list. Each entry has exactly: `id`;
  `argv`, a fixed argument vector run from the checkout of `R` (27.12.6 step 1 already requires it clean); `harness`,
  `enforce` or `discover`; `files`, the exact committed test files it runs; `databases`, the sequence numbers of the
  plan entries it may use; and `compose`, a committed compose file or null. Revision 2.7.7 adds: `profile`, the setup
  profile the suite runs under (a run whose profile differs refuses before L1); and `refusalPolicy`, `none` or
  `probes` (below). `files` must equal the files the coverage partition assigns to the suite. Its schema is exact like
  the rest of the registry.
- **Process.** The runner launches `argv` as a child process in a fresh empty working directory that is not the run
  directory. It builds the environment from its own, with every `PG*`, `SUPABASE_*`, `KJ_*`, `DATABASE_URL` and proxy
  variable removed, and then adds exactly: for each database the entry lists, its owner address through the derived
  loopback port of L4 and through the network alias below; the run network's name; the harness mode; the report
  path in the working directory; and (revision 2.7.7) the trace directory and the trace run token below. The run
  directory is never named to the suite.
- **Authority of a regression consumer.** Test authority over the planned databases its entry lists, for the duration
  of stage T, and nothing else. It may connect as the owner, `kj_worker` and `kj_door`, read and write rows, and run
  the services of its compose file on the run network. Revision 2.7.7 makes explicit what the frozen definers and
  health tests already do: as the owner it may change catalogue objects in its own planned databases to show that
  health or inventory detects the change (and restore them), which is test authority over a disposable database,
  never a migration. It may not (static tests, each with failing fixtures of its
  own): read or apply any file under `supabase/migrations/`, or name the B1 migration file; call a lane A helper (which
  also refuses at run time); write any of the three settings (27.12.8 item 12, unchanged); create, drop, rename or
  copy a database; start or attach a container other than its compose services; stop, pause, restart, `exec` into or
  remove the cluster container; or read the run directory.
- **After stage T,** the runner, through its connection factory (L3 and L5), reads the cluster's database list and
  requires it to equal the planned databases plus `postgres`, `template0` and `template1`; inspects the run network and
  requires its attached containers to be the cluster and the services of the suite's compose file only; and, before L6, validates the trace and the database log as below.
  Revision 2.7.7 withdraws the 2.7.6 per-file rule ("every file with at least one passed and no skipped test"): it
  was weaker than the frozen gates in one direction and contradicted the intentional skips in the other.
- **`regressionOutcome`** is `passed` only if: the suite exited 0; its report is complete (every test the
  partition's collection assigns to the suite is in the report, and the report holds nothing else); every such test
  passed, or is an accounted intentional skip (below); the trace and log checks passed; and the post-T database and
  network reads passed. Otherwise it is `failed`, or `not-run`. It is recorded with the SHA-256s of the report, of
  every trace file and of the log extract.
- **No effect on the status.** The predicate of 27.12.13.6, conditions 1 to 8, is unchanged and is evaluated over the
  L and S outcomes only. Stage T writes no L or S outcome, and after it starts the runner reads nothing from the run
  directory or from the suite except the report and the two reads above. A regression consumer therefore cannot
  produce or alter `REPOSITORY_QUALIFIED`. The most it can do is make L6 fail (for example by removing the cluster),
  which makes the run `NOT_QUALIFIED`. The CI gate requires, for every registered suite, the recomputed status
  `REPOSITORY_QUALIFIED` and `regressionOutcome` `passed` (revision 2.7.7, "CI gate over every registered suite"
  below). Database state after stage T is never B1 qualification evidence.
- **Health under stage T.** A suite that exercises health receives, in its working directory, read-only copies of the
  run-bound declaration and baseline of each database it lists, with their SHA-256s from the runner's memory, and
  verifies them as 27.12.6 requires for health inside an ephemeral run. The runner never reads the copies back.

**Deterministic databases.** `plannedApplications` remains a constant of the committed runner at `R`, fixed before
L2 and never changed. Revision 2.7.6 makes it one of a closed set of such constants, selected only by the registered
regression suite id:
- with no regression suite, the **base plan**: one entry, database `kj_b1`. Every hooked run and every lane B run
  without a suite uses it, so a negative fixture never applies B1 to more than one database;
- with a regression suite, that suite's **suite plan**: one entry per database its files use, each under a fixed name.

Each plan is committed in the runner at `R` and holds at least one entry, each naming the B1 migration (27.12.13.3 L1,
unchanged). The L1 header records the plan's id and its entries. No option, environment variable, file, profile or
hook can add, remove or reorder an entry, or choose a plan except through a registered suite id. A suite's `databases`
must equal its plan's entries. The static qualification of 27.12.13.8 covers every committed plan, and any consumer of
run evidence also checks that the recorded plan equals the committed plan of the recorded suite id at `R`.

The runner creates each planned database, empty, from `template0`, through its factory, immediately before that
application's S1. Nobody else creates a database in the cluster during L1 to S7. A suite names only its plan's
databases, by string literal (static test). **No database is copied.** A copy of an applied database would hold B1
without its own P1 to P3 and S7, so `CREATE DATABASE ... TEMPLATE` of anything but `template0` is refused by static
test and by the post-T database list. Every database that holds B1 passed its own application.

**Network.** L2 gains one step: before it creates the container, the runner creates a user-defined bridge network
`kj-eph-<runId>` carrying the label `kj.b1.ephemeral.run=<runId>`, and the container is attached to that network only,
under the alias `kj-eph-db`. The loopback port of L2 is unchanged. L3 gains: the container is attached to exactly that
network; the network carries the exact label; and until stage T begins, the cluster is the only container attached to
it. L4 is unchanged: the runner connects only through the loopback port. During stage T the services of the suite's
compose file join the run network as an external network, attach to no other network, and reach `kj-eph-db:5432`. The
committed regression compose files define no database service. L6 removes the container and then the network, and
records both. A test that needs a database outage disconnects its own service from the run network; no consumer
pauses the cluster.

**Hosted mode.** No stage T, no regression suite input and no run network. The hosted entry point imports no
regression-suite code (static test, as 27.12.13.6).

**Coverage.** Lane D runs the whole database-backed suite under the runtime roles, as the frozen B1's `enforce` and
`discover` runs did, including the gated files of `scripts/b1/qualify-ci.sh` and the containerised worker and Restate
files. Lane A keeps the base-migration mutation checks. Known differences, none of which removes a B1 assertion:
- the mutation checks run their test files in harness mode `base`, as they did before B1, not under the runtime roles;
- the database-outage fault of `tests/schedule-restate-live.integration.test.ts` becomes a network disconnect of the
  worker instead of a paused server;
- the definers file's in-test B1 applications become runner runs of lanes B and C;
- a regression run applies B1 once per database of its suite plan, so its duration grows with that plan.

Lane A alone could not replace lane D: without B1 there are no runtime roles, so the suite would not exercise
production code under least privilege, the dynamic statement inventory would have nothing to record, and the
`runtime-roles-*` files could not run.

**Retained B1 regression gates** (revision 2.7.7, R276-B1). Read from the frozen B1 at `0ff2919`
(`.github/workflows/qualification.yml`, `scripts/check-baseline.mjs`, `tests/baseline.json`,
`scripts/b1/qualify-ci.sh`, `scripts/b1/analyse-trace.mjs`, `tests/support/runtime-roles.ts`). Each keeps its frozen
threshold, is computed by the committed script at `R`, and is required by the CI gate. None is replaced by a weaker
check.

| Gate | Frozen B1 | Under 2.7.7 |
|---|---|---|
| G1 manifest drift | `build-manifest.mjs --check` | unchanged; repository job, no database |
| G2 protected baseline and skips | `check-baseline.mjs` over the one whole-suite enforce report: report `success`, zero failed; each of the 224 tests of `tests/baseline.json` passed; no skipped test outside its 62 `intentionalSkips`; no intentional skip absent from the report | the same script and thresholds over the merged report of every primary suite (stage T suites, lane A, runner cases). Intentional-skip accounting is tightened, below |
| G3 recovery minimum | in `check-baseline.mjs`: `recovery.test.ts` passed at least 27 | unchanged, in the suite the partition assigns `recovery.test.ts` to |
| G4 zero refusal, enforce | `analyse-trace.mjs --fail-on-refusal` over the enforce trace: zero `refused` events, zero operations outside the manifest. Gap found: the worker container loads the harness only in discover mode (`tests/support/worker.ts`), and genuine login pools are not watched, so worker refusals were never traced | every runtime-role session is traced, host and container, genuine login pools included; a `42501` on a runtime-role statement is recorded whether or not the application catches it; zero `refused` and zero operations outside the manifest, for every enforce suite; and the database-log check below |
| G5 discover inventory | the discover run must exit 0; its inventory was written, not gated | the discover twin of every enforce suite exits 0 with zero failed, and its inventory is gated: zero `denied`, zero operations outside the manifest. Operations in the manifest never observed are listed, not gated, as frozen |
| G6 gated files | `kj_gated` migrated by `migrate()`; the six `KJ_TEST_PG_URL` files must exit 0; refusal trace gated | suite `regression-gated` in stage T; every test of the six files passed; G4 applies |
| G7 mutation suites | faculties and identity in `validate`; identity-cognition in its own job; each script's own verdict | lane A; each must run, its verdict must list exactly the mutation ids of the script at `R`, every one killed, an apply failure never counted as a kill (the scripts' existing rule), the tree restored. `mutation-check-memory.mjs` is not run by the frozen CI and is not added |
| G8 B1 evidence files | `b1-negative-probes.json`, `b1-definer-probes.json`, `b1-definers.json` under `artifacts/local` | written in the suite's working directory, collected by the runner with SHA-256s; every row present and passed (below) |
| G9 worker image startup | unchanged | unchanged |

**Intentional-skip accounting.** An intentional skip is an entry of `tests/baseline.json` `intentionalSkips` at `R`.
Every skipped test in any report must be one. Each must appear in the merged report. Each must also either pass in
the primary suite the partition assigns it to (the six `KJ_TEST_PG_URL` files run in `regression-gated`), or belong to
a file in the partition's `notRunInCi` list, which today holds exactly the four files that need a live-Restate
environment flag (`gate3-executor`, `schedule-restate-live`, `schedule-restate-rearm-live`,
`schedule-restate-runtime`), as the frozen CI never ran them either. A skip counted as a pass, a skip of a test not
listed, a listed skip in `regression-gated` that does not pass, and a `notRunInCi` file that is not entirely listed
each fail.

**Trace and database-log evidence.** For each stage T suite:
- **Trace.** The runner creates the trace directory fresh inside the suite's working directory and passes its path
  and a trace run token (the `runId` and the suite id). The regression compose file mounts exactly that directory into
  its services. In stage T the harness writes, as the first line of every trace file, a header carrying the token and
  its process id, and a trace write that fails makes the process fail (the frozen "tracing must never change a test
  result" no longer applies inside stage T). After the suite exits and before L6, the runner itself reads the
  directory, never a path the suite names, and requires: at least one file; every file beginning with this run's
  header; at least one `use` event for each runtime role the suite's files exercise; then it hashes every file, runs
  `analyse-trace.mjs` at `R` over it, and applies G4 or G5.
- **Harness coverage** (revision 2.7.8). In every mode, including discover, the harness watches every runtime-role
  session: pools that log in as `kj_worker` or `kj_door`, the shadow pools of enforce mode, the `SET ROLE` emulation,
  and the compose worker, which loads the harness in every stage T mode. Every `42501` on such a session is recorded,
  whether or not the caller catches it, with the role, the SQLSTATE, the statement fingerprint, whether it came from
  a deliberate probe or from production code, and the expanded name of the running test where there is one. Revision
  2.7.9 (R278-B2) withdraws the 2.7.8 whitespace-collapsing fingerprint, which merges distinct SQL (for example
  whitespace inside a string literal). The **trace fingerprint** is the SHA-256, in lowercase hexadecimal, of the
  UTF-8 bytes of the exact, untruncated statement text the driver sends to PostgreSQL (for a parameterised or named
  prepared statement, its text with the `$n` placeholders, as sent at each execution). No truncation (the frozen
  harness's 600-character limit does not apply to it), no whitespace change, no comment, literal, placeholder or cast
  rewriting. Refusal records carry a
  sequence number and are never de-duplicated, so multiplicity is kept.
- **Database log.** At the start of stage T the runner sets `log_line_prefix` to include the SQLSTATE (`%e`) and the
  session user (`%u`), keeps `log_min_error_statement` at `error` so each error line is followed by its statement
  (`ALTER SYSTEM` and `pg_reload_conf()` in its own cluster, recorded), and writes a `RAISE LOG` marker; at the end it
  writes a second marker. Revision 2.7.9 pins the prefix exactly as `kjlog|%p|%l|%e|%u|%d| ` (backend process id,
  per-session line number, SQLSTATE, session user, database, then one space), and the markers as `RAISE LOG` messages
  whose text is exactly `kj-t-begin <runId>` and `kj-t-end <runId>`. Immediately before each marker it re-reads `log_line_prefix`, `log_min_error_statement`,
  `log_min_messages`, `log_destination` and `logging_collector`, and every row of `pg_db_role_setting`, and refuses to
  trust the log unless the settings are the recorded values and no row sets any `log_` parameter or
  `client_min_messages` for any role or database. Before L6 it reads the cluster's log through the daemon.
- **Scope of the log** (revision 2.7.8, R277-B2). `%u` is the session user, so a refusal after `SET ROLE` is logged
  under the owner, and a refusal caught inside a PL/pgSQL exception handler is not logged at all. The log claim is
  therefore narrowed to genuine login sessions of `kj_worker` and `kj_door`, which is how the compose worker, the
  enforce shadow pools and every probe connect. The trace covers the `SET ROLE` paths. No migration defines a PL/pgSQL
  handler that catches `insufficient_privilege`, SQLSTATE `42501` or `others` (OBSERVED at `0ff2919`; pinned by a
  static test over every migration, case CON-42), so a refusal cannot be absorbed inside the database unseen.
- A missing, unreadable or unmarked log, changed log settings, or trace evidence that is missing, empty, from another
  run or changed after it was hashed, fails `regressionOutcome`.

**Refusal accounting** (revision 2.7.8, R277-B2; replaces the 2.7.7 meaning of `refusalPolicy`). Every stage T suite
has an exact expected refusal multiset of entries (expanded test name, role, SQLSTATE, statement fingerprint,
multiplicity):
- for a suite with `refusalPolicy` `none`, it is empty;
- for a suite with `refusalPolicy` `probes`, it is the union of the `refusals` that `tests/b1-required.json` declares
  for the probe tests the suite runs. A probe suite may run only `tests/b1-required.json` probe tests (static test),
  and each probe connects through a genuine login session of the role it probes, never through `SET ROLE`.

Both observations must equal that multiset exactly:
- the trace's refusal records, keyed the same way, with multiplicity;
- the database log's refusal events, extracted as below and keyed by (role, SQLSTATE, log fingerprint), compared with
  the **log projection** of the expected multiset (revision 2.7.9).

**Log projection** (revision 2.7.9, R278-B2). The log carries no test identity, so the expected multiset is projected
mechanically: group its entries by (role, SQLSTATE, statement fingerprint) and sum their multiplicities across every
test that shares that projection. Two tests that each expect `(kj_worker, 42501, X, 1)` project to one log entry
`(kj_worker, 42501, X, 2)`. The observed log multiset must equal the projection exactly; the trace multiset must still
equal the full, test-attributed multiset.

**Log extraction** (revision 2.7.9, R278-B2), over the log between the two markers of this run:
1. **Records.** A line beginning with the pinned prefix starts a record: process id, line number, SQLSTATE, session
   user, database, severity and message. A line without the prefix is a continuation of the immediately preceding
   record only if it begins with exactly one TAB; any other unprefixed line inside the window makes the log
   untrusted, and the suite fails.
2. **Primary events.** Only records whose severity is `ERROR` or `FATAL`, whose SQLSTATE is `42501` and whose session
   user is `kj_worker` or `kj_door` are counted. `STATEMENT`, `CONTEXT`, `DETAIL`, `HINT` and `QUERY` records carry the
   same SQLSTATE and are never counted as refusals.
3. **Association.** For each primary event, the associated statement is the first later `STATEMENT` record from the
   same process id, provided that between them that process wrote only `CONTEXT`, `DETAIL`, `HINT` or `QUERY` records.
   If that process writes any other record first, or the window ends, the association is missing; a `STATEMENT` whose
   user or SQLSTATE differs from its event's makes it ambiguous. A missing or ambiguous association fails the suite.
   "The immediately following line" is not the rule: a function's refusal writes `CONTEXT` before `STATEMENT`
   (OBSERVED, below).
4. **Log fingerprint.** Rebuild the statement's text from its `STATEMENT` record: the message after `STATEMENT:  `,
   then, for each continuation line, a line feed followed by the line with only its first TAB removed (the one
   PostgreSQL inserts after each continuation newline). Nothing else is changed. Its SHA-256, in lowercase
   hexadecimal, of the UTF-8 bytes is the log fingerprint, comparable with the trace fingerprint. If a later
   implementation test shows that ordinary driver behaviour makes this reconstruction inexact, qualification fails and
   the design is revised; the fingerprint is not weakened.
5. **`FATAL` without a statement.** A `FATAL` `42501` for a runtime role with no associated `STATEMENT` fails the
   suite. No expected-refusal form declares one: the frozen probes refuse connections in application code
   (`RuntimeRoleRefusal`), not with a server `FATAL` (OBSERVED in `tests/runtime-roles-connection.integration.test.ts`
   at `0ff2919`).

Messages written concurrently by several backends to the server's standard error can, if large, interleave; any
resulting unprefixed line or mis-attached continuation fails the suite (rules 1 and 4), so interleaving can cause a
false failure but not a false pass.

**Evidence for the extraction** (OBSERVED on 09/10/2026, a disposable cluster from the pinned image of 27.12.13.7,
`postgres@sha256:00bc8661...`, with the repository's `pg` 8.23.0 and the pinned prefix; container removed; method
and results in the inventory document): twelve `42501` refusals by a `kj_worker` login session, including two tests issuing
the same statement, a multiline statement with a TAB and double spaces inside a literal, a SQL function whose refusal
wrote `ERROR`, `CONTEXT`, `STATEMENT`, a named prepared statement executed twice, parameterised statements with
`$n` placeholders, a statement longer than 600 characters and two statements differing only by whitespace inside a
literal. Each refusal wrote separate `ERROR` and `STATEMENT` records, both tagged `42501`, and `%l` advanced on every
record. The extraction reproduced the trace projection exactly (nine keys, three with multiplicity 2). Each
perturbation of case CON-48 failed.

An extra refusal, a missing one, a duplicate beyond the declared multiplicity, a refusal attributed to production code
in a probe suite, and a trace refusal on a genuine login session with no matching log line, or the reverse, each fail
`regressionOutcome`. A blanket "refusals allowed in this suite" does not exist.

**B1 evidence rows.** `tests/b1-required.json` at `R` lists, by file and expanded report name (revision 2.7.8: every
`.each` row by its own expanded name, never a template), every B1-specific test that must pass: the forbidden-power,
separation and 27.9.5 probes of `runtime-roles-negative` (the 27.6 item 4 negative qualification), the catalogue,
connection and definer tests, the 27.12.9 and 27.12.13.9 cases, and the CON cases. Each probe entry also declares its
`refusals` (role, SQLSTATE, statement fingerprint, multiplicity) for the refusal accounting above. Each entry must
appear exactly once, passed, in the report of the suite its file is assigned to. Removing one is a reviewed edit of
that file at `R`. The evidence files of G8 must hold every row their test lists, each passed.

**Coverage partition** (revision 2.7.7, R276-B2). One committed file, `tests/lanes.json`
(`kerneljson:test-lane-partition/v1`), read at `R`, with an exact schema and parsed by a parser that refuses duplicate
keys:
- `suites`: the closed list of required primary suites, each with its lane and kind: the registered stage T suites
  (lane D), `base-regression` (lane A, compose stack, harness `base`), and `runner-cases` (lanes B and C, test files
  that call the ephemeral entry point, run on the host outside any run);
- `files`: every committed `tests/*.test.ts` file mapped to exactly one primary suite;
- `notRunInCi`: as above;
- `secondary`: the discover twin of each enforce suite (same files and profile), and the three mutation suites with
  their script paths.

The unit of partition is the file. A file whose tests need different lanes is split at describe-block boundaries
into single-lane files, so every executable test inherits exactly one lane from its file. The inventory maps every
describe block of the frozen mixed files to its new file and lane; nothing is deleted, skipped or downgraded.

**Test identity and coverage** (revision 2.7.8, R277-B1). Vitest's collection is not a test identity: it lists
`.each` tests as unexpanded templates, loses `describe.skip` titles, repeats some (file, name) pairs and omits files
whose top-level suite is skipped (observed by the reviewer on the frozen tree). So:
- **Collection proves source coverage only.** Revision 2.7.9 (R278-B1) pins the one collection the reviewer and this
  revision both observed to work on the frozen tree. The static test runs the Vitest of the frozen lockfile at `R`
  (5.0.0, its version asserted) by path, with the repository's Node, exactly as:

  ```text
  node node_modules/vitest/vitest.mjs list --no-static-parse --includeTaskLocation --json
  ```

  in an environment built from nothing that holds exactly: the platform's process variables (`PATH`, `HOME` and
  `TMPDIR` on Linux; `PATH`, `SystemRoot`, `TEMP`, `TMP`, `USERPROFILE` and `APPDATA` on Windows); `S1R_LIVE=1`,
  `S1B_REARM_LIVE=1`, `S1R_RUNTIME=1` and `KJ_GATE3_LIVE=1`; and
  `KJ_TEST_PG_URL=postgresql://kj_collect_placeholder@127.0.0.1:54999/kj_collect_placeholder`. Nothing else: no
  `DATABASE_URL`, no other `PG*` or `KJ_*` variable. The placeholder makes the six gated files register their suites;
  collection must never connect to it. The static test binds a TCP listener on `127.0.0.1:54999` before collecting
  (and fails if it cannot), and requires zero accepted connections afterwards. Any other command, option or
  environment, including static parse, a missing `--includeTaskLocation` or `--json`, a missing or changed flag, or
  a missing or different `KJ_TEST_PG_URL`, fails static qualification (case CON-47).
- **Collection result.** Every `tests/*.test.ts` file must be a key of `files`; every key must exist and collect at
  least one entry; every collected entry carries a source location (file, line, column). Runtime collection expands
  each `.each` row into its own entry, located at the call that registers it.
- **Zero-expansion rule** (revision 2.7.9; corrects 2.7.8). Runtime collection reports nothing for a `.each` table
  with zero rows, so collection cannot show that such a template vanished, and none is invented for it. Completeness
  of every protected or B1-relevant parameterised row comes from the row-by-row identities in `tests/baseline.json`
  and `tests/b1-required.json`: a removed row loses its expanded name from the report, and an emptied table loses all
  of them, and either fails qualification. Residual, stated: a new, unprotected test whose `.each` table is empty
  from the start is not detected; it asserts nothing and protects nothing.
- **Identity is the expanded report entry.** Every primary suite runs with the JSON reporter and task locations
  enabled. A test's identity is (file, location, expanded full name) from the report. Expanded full names must be
  unique within a suite's report; a duplicate fails.
- **Coverage.** Every collected location must map to at least one report entry in its own suite's report, with the
  same file and location. A collected test that does not run therefore fails, and so does a file that crashes before
  its tests run.
- **Report success** (revision 2.7.9, R278-B1). Every primary report used for coverage must have its overall `success`
  true and zero failed tests, as `check-baseline.mjs` already requires, and no file result in it may be failed or
  carry a failure message. An accounted intentional skip is accepted only inside such a report. A file whose
  `beforeAll` or other setup failed is a failed file result, whatever status its tests show, and fails the suite.
- **Baselines.** `tests/baseline.json` (protected tests and `intentionalSkips`) and `tests/b1-required.json` are
  matched against the expanded names in the reports, never against the collection.
- **`notRunInCi` files** are bound through reported skip entries: each file's report entries must be exactly its
  `intentionalSkips` entries, each skipped, inside a report that satisfies the report success rule. If a file's skip
  gate is removed, its tests run: either they are no longer skipped, or their setup fails and the file result is
  failed. Either way the binding fails.
- Still static: no file assigned twice (a parser that refuses duplicate keys); each stage T suite's registry `files`
  equal to its partition files; every suite with at least one file; every plan with a database per database-backed
  file; no stage T file importing a lane A helper; no lane A file referring to a runtime role.

A new file without an entry fails; a new test or `.each` row in an existing file is assigned with its file and must
pass there; a removed `.each` row that `tests/b1-required.json` or `tests/baseline.json` names fails by its name.

**CI gate over every registered suite** (revision 2.7.7). The committed gate script at `R` refuses the commit unless,
for every primary and secondary suite of the partition, exactly one valid result exists for this commit:
- each registered stage T suite: one run record whose `R`, runner blob, registry blob and plan equal those at `R`,
  whose suite id and profile match, whose SHA-256 verifies, and whose recomputed status is `REPOSITORY_QUALIFIED` and
  recomputed `regressionOutcome` is `passed`;
- `base-regression` and `runner-cases`: a complete report, every assigned test passed or an accounted skip;
- each mutation suite: its verdict, as G7;
- G1 to G9 and the coverage check below.

A missing, stale (another commit), forged, duplicated or incomplete result fails. The coverage check (revision
2.7.8) merges every primary report and requires: every collected location covered in its own suite as above; every
report entry passed or an accounted skip; no expanded name duplicated within a suite, and no (file, expanded name)
in two primary reports; then G2 and G3 over the merged report, and the `tests/b1-required.json` match. An empty or
partly executed suite cannot pass, because its collected locations would have no report entries.

**Cases** (committed automated cases under the rules of 27.12.9):

| # | Case | Required result |
|---|---|---|
| CON-1 | Positive control: profile `none`, regression suite `regression-enforce`, no hook | every planned application passes S1 to S7; stage T runs; status `REPOSITORY_QUALIFIED` and `regressionOutcome` `passed`, both recomputed by the CI gate |
| CON-2 | Regression suite id unknown, differing only in case, or passed as an environment variable or option | refuses before L1; no container or network created |
| CON-3 | Regression suite id together with any hook id | refuses before L1 |
| CON-4 | A run given a regression suite in which an application does not pass S7, or which is refused at L5 as EPH-27 | stage T `not-run`; the suite is never launched; status `NOT_QUALIFIED` |
| CON-5 | Suite exits 0 having run zero tests; a listed file missing from the report; a listed file skipped; one failed test | `regressionOutcome` `failed`; the CI gate fails; the status is computed as before |
| CON-6 | During stage T a consumer creates a database, drops a planned one, or copies an applied one with `TEMPLATE` | the post-T database list fails `regressionOutcome`; the static test fails on the literal forms |
| CON-7 | A consumer names the B1 file or reads `supabase/migrations/`; a lane A helper is called during stage T; a lane A helper given the B1 file, a file outside the base set, a database recording `20261002090000`, a cluster holding `kj_worker`, or a `kj-eph-` server | each refuses before writing; the static test fails where the form is static |
| CON-8 | A container other than the cluster attached to the run network before stage T | L3 refuses at the next connection; status `NOT_QUALIFIED` |
| CON-9 | The cluster created with a second network, or a run network without the exact label | L3 refuses |
| CON-10 | During stage T a consumer attaches a foreign container, or pauses or removes the cluster | the post-T network check fails `regressionOutcome`; a removed cluster makes L6 fail and the status `NOT_QUALIFIED` |
| CON-11 | A record with `REPOSITORY_QUALIFIED` and a failed `regressionOutcome`; a record edited to `passed` | the CI gate fails; the edit fails recomputation or the record SHA-256 (EPH-25) |
| CON-12 | The hosted entry point given a regression suite | refuses before any connection; the static test shows it imports no regression-suite code and creates no network |
| CON-13 | Lane A positive control: the mutation checks and the lane A files on the compose stack | they pass, and the compose database's ledger never records `20261002090000` and its cluster holds no runtime role |
| CON-14 | Plan selection: a run record whose plan differs from the committed plan of its recorded suite id; a hooked run whose plan is not the base plan; a suite whose `databases` differ from its plan | the consumer of the record refuses it; the static test fails |
| CON-15 | Absorbed refusal: a failing-fixture build whose manifest lacks one grant on a path where application code catches the error, run in an enforce suite on the host | the trace records one `refused`; G4 fails; the database-log check also fails |
| CON-16 | The same refusal inside the compose worker | the container's trace records it and the database-log check fails; `regressionOutcome` `failed` |
| CON-17 | One protected baseline test removed or renamed; its file dropped from the partition | G2 fails; the static test fails for the dropped file |
| CON-18 | Intentional skips: an unlisted skipped test; a listed skip absent from every report; a gated skip that does not pass in `regression-gated`; a skip counted as passed | each fails the accounting |
| CON-19 | `recovery.test.ts` with 26 passed | G3 fails |
| CON-20 | Discover inventory: a manifest fixture missing one grant the suite uses | the discover twin records `denied` or an operation outside the manifest; G5 fails |
| CON-21 | Mutation suites: one not run; its verdict missing; a verdict missing a mutation id, or with one not in the script; a mutation survived; an apply failure counted as a kill | G7 fails |
| CON-22 | Trace evidence: no trace file; a runtime role with no `use` event; a file without this run's header; a file from another run; a file changed after hashing; a trace path supplied by the suite; a trace write failure | `regressionOutcome` `failed` before L6 |
| CON-23 | Database log: a `kj_worker` `42501` between the markers in a `refusalPolicy` `none` suite; a missing marker; an unreadable log | `regressionOutcome` `failed` |
| CON-24 | A new `tests/*.test.ts` file with no partition entry | the static test fails |
| CON-25 | Incorrect partition: a block needing a pre-B1 database left in a stage T file; a lane D file importing a lane A helper; a lane A file needing a runtime role | the helper refuses at run time and the static test fails; the lane A file fails in harness `base` |
| CON-26 | Duplicate assignment: a file listed twice in `tests/lanes.json` (duplicate key) or in two suites' registry `files` | the static test fails |
| CON-27 | Missing suite record: a registered suite never run; its record from another commit; a second record for it; a record with status or outcome not passing; an edited record | the CI gate fails |
| CON-28 | Incomplete report (corrected in revision 2.7.8): a suite file that crashes in `beforeAll`; a collected location with no report entry in its suite; a report with zero tests; a (file, expanded name) reported in two primary suites | the coverage check fails |
| CON-29 | A new test added to an existing file | it is assigned with the file; if it fails or does not run, the coverage check fails |
| CON-30 | A required negative probe removed from `FORBIDDEN`, `SEPARATION`, `PROBES` or the definers `FIXTURES`; an evidence row missing or not passed | the `tests/b1-required.json` check fails; G8 fails |
| CON-31 | Profile binding: a regression suite run with a profile other than its registered one | refuses before L1 |
| CON-32 | Static B1 shape (widened in revision 2.7.8): a generated B1 with a `CREATE FUNCTION`, `CREATE TABLE`, `CREATE VIEW` or `CREATE SEQUENCE`; a GRANT or policy naming any role other than `kj_worker` or `kj_door`; a REVOKE whose target or grantee is outside the pinned list (the enumerated function cleanup, `CREATE` on schema `public` and `TEMPORARY` on the database from `PUBLIC`, the stamp function from `PUBLIC`, and tables, sequences, functions and schemas from the runtime roles); an `ALTER FUNCTION` of anything but the stamp function's security attributes; an `ALTER ROLE` of anything but the two runtime roles' pinned attributes; a `DO` block outside the pinned set (role creation, the enumerated cleanup, `TEMPORARY` and `CONNECT` by `format`, the stamp ACL cleanup and the pre-COMMIT checks) | the static test fails (it underpins the lane A assignment of the default-ACL blocks and 27.6 item 3) |
| CON-33 | Positive control: the identity and coverage checks over the unmodified suite after the partition | they pass; every collected location is covered and every baseline, intentional-skip and required entry matches |
| CON-34 | A `.each` row removed from `FORBIDDEN`, `SEPARATION`, `PROBES` or the definers `FIXTURES` | its expanded name is missing from the report; the `tests/b1-required.json` match fails |
| CON-35 | Corrected in revision 2.7.9: a required `.each` table emptied, or one of its rows removed; a test whose suite crashes before it runs | the required expanded names are missing from the report and the `tests/b1-required.json` or `tests/baseline.json` match fails; the crashed test's collected location has no report entry, and its file result is failed |
| CON-36 | Two tests in one suite with the same expanded full name | the uniqueness check fails |
| CON-37 | Corrected in revision 2.7.9: the skip gate of a `notRunInCi` file removed, so its `beforeAll` fails while its entries still read as skipped; the gate removed and its tests run; a `notRunInCi` file whose report entries differ from its `intentionalSkips` | the report success rule fails the first (failed file result, `success` false); the binding fails the others |
| CON-38 | One unexpected `42501` added to a probe suite (an extra probe statement not declared) | trace and log each exceed the expected multiset; `regressionOutcome` `failed` |
| CON-39 | An expected probe that does not refuse (a grant added in a fixture build) | the multiset is short; fails, and the probe test itself fails |
| CON-40 | One probe refusal duplicated (the statement issued twice) | multiplicity exceeds the declaration; fails |
| CON-41 | A refusal after `SET ROLE kj_worker` on an owner session with the trace record suppressed; a genuine-login refusal with no log line, or a log line with no trace record | the trace and log do not both equal the multiset; fails |
| CON-42 | Log trust: `log_min_error_statement` or `log_line_prefix` changed during stage T; an `ALTER ROLE kj_worker SET log_min_messages` row in `pg_db_role_setting`; a migration fixture adding a PL/pgSQL handler that catches `insufficient_privilege`, `42501` or `others` | the re-read refuses to trust the log; the static test fails for the handler |
| CON-43 | A hook whose effect is a no-op, with `expected` "S6 commits and S7 passes" | the precondition result differs; the hook is `not-effective`; the case fails |
| CON-44 | A hook that ends the run at the expected step for another rule or message (for example S3 refusing on the ledger head when the hook removed the stamp function) | the structured `expected` does not match; the case fails |
| CON-45 | Any one of the six frozen `_ledger` messages missing or different | its hook's case fails |
| CON-46 | The `platform-definer-fixture` SQL with a changed digest, or with a statement outside its pinned set | the runner refuses before L1; the static test fails |
| CON-47 | Collection contract. Positive control: the pinned command and environment on the frozen tree collect entries from all 107 committed test files, every entry located, no uncovered location, zero connections to the placeholder. Each fails: static parse (no `--no-static-parse`); no `--includeTaskLocation`; no `--json`; each of the four flags missing or not `1`; `KJ_TEST_PG_URL` missing or different; a connection accepted on `127.0.0.1:54999` | each departure fails static qualification. Observed on 09/10/2026: static parse collected 104 files, no `KJ_GATE3_LIVE` 106, no `KJ_TEST_PG_URL` 101, the earlier three-flag form 100 |
| CON-48 | Log extraction. Positive fixture on a cluster of the pinned image: two distinct expanded tests issuing the same denied statement once each (log multiplicity 2); a multiline denied statement; a denied function call whose `CONTEXT` precedes its `STATEMENT`; a prepared statement executed twice; a statement longer than 600 characters; two statements differing only by whitespace inside a literal. Perturbations: one of the two identical refusals dropped; a third added; a `STATEMENT` attributed to another process id; the trace text truncated; whitespace collapsed; the next line taken as the statement when it is `CONTEXT`; whitespace inside a quoted literal altered | the positive fixture reconciles exactly and the two literal variants hash differently; every perturbation fails |

These cases are added to 27.12.8 item 14. They change none of the cases of 27.12.9 or 27.12.13.9.

**Implementation obligations from the R2.7.7 review** (nonblocking, recorded, not design changes): results of
`base-regression`, `runner-cases` and the mutation suites bound to the commit, the suite id and a digest; a stage T
suite timeout.

**Implementation obligations from the R2.7.6 review** (nonblocking, recorded, not design changes): database OID
identity in the post-T database read; the run network's id, and the cluster's paused state, in L3; Docker events and
the ordering of service, network and container teardown; security restrictions on the regression compose services
(no privileged mode, no host mounts beyond the trace directory, no daemon socket); the stage T working directory and
environment stated exactly in code; two-layer verification of CON-4 and CON-5 (record-level and end to end, as
EPH-26); and whether CON-9 needs a registered hook to construct its container.
