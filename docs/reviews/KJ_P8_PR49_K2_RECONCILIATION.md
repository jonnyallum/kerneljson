# KJ-P8: reconciliation of PR #49 and the uncommitted K2 work against sealed ADR-0023 revision 2.3

Date: 01/10/2026. Read-only forensic classification. Nothing in PR #49 or in the main checkout was changed while
classifying. What was done afterwards, on Jonny's separate authorisation, is recorded in section 6.

Authority: sealed design commit `679e3a3dfc7a33f9106ed77913d49cdac19166d5` (see
`KJ_P8_ADR0023_R23_HOSTILE_SEAL_679e3a3.md`). "ADR" below means
`docs/adr/0023-reflection-self-model-governed-growth.md` at that commit.

**Standing rule.** PR #49 and the K2 files predate the final hostile seal. Nothing in them is safe to reuse because
its intent resembles the ADR. Anything reused later is rewritten or re-reviewed against revision 2.3 in the step
where it belongs, under that step's own authorisation.

## 1. PR #49 as observed

| Item | Observed (`gh pr view 49`, `git ls-remote`) |
|---|---|
| Title | KJ-P8-A K1: evidence-bound reflection proposal contracts |
| State | open, draft, mergeable, no review decision |
| Branch and head | `codex/kjp8-proposal-design` at `d2318678de054333c21206d8e8b3431f1babae8b` |
| Base | `750d5b7926f320d8e9d3f64789b8f7035eaa4f3d` |
| Commits | `9d95aa9` (design), `d231867` (K1 contracts and pure verification) |
| Size | 11 files, 1,118 insertions, 1 deletion |
| Last updated | 30/09/2026 22:40Z; unchanged since first recorded |

## 2. PR #49, element by element

Categories: **A** retain (compatible concept; may be reimplemented later), **B** retain as reference only,
**C** superseded, **D** reject, **E** defer.

| # | Path | What it does | Cat. | ADR section | Reason | Cherry-pick later? |
|---|---|---|---|---|---|---|
| 1 | `docs/adr/0023-evidence-bound-reflection-proposals.md` | designs P8-A as a deterministic review-proposal inbox over one completed mission | C | 3 | the sealed ADR replaces it as the architecture; it also occupies the same ADR number, so both cannot be merged | no |
| 2 | recipe `reflection-review/v1` (ADR text, plan) | a separate admission recipe for review proposals | D | 5.1 | one recipe, `identity-reflection/v1`; a second recipe is a second proposal system | no |
| 3 | `docs/operations/KJ_P8A_IMPLEMENTATION_PLAN.md`, checkpoints K1 to K4 and L1 | staged plan: contracts, persistence, admission and workflow, recovery, production | C | 19, sequence doc | the sealed order is B1, P8A-0, B2, P8A-1, P8A-2, P8B; K2 onward is not a valid next step | no |
| 4 | same file, refusal and mutation matrix R01 to R16 | sixteen deliberate violations each paired with a guard-removal mutation | B | 16, 20, 21 | sound technique and several rows map to sealed gates; the rows are written against the superseded schema | no; rewrite per step |
| 5 | same file, K3 "disposition control" through signed task control | a new control endpoint for acknowledging or rejecting a proposal | D | 5.1, 8 | a separate governance path; sealed dispositions are `DISPOSE` tasks through the door, HUMAN owner only | no |
| 6 | same file, "production owner-role ceiling must be stated" | records the owner-role limit as a stated residual | C | 27 | owner-role execution is no longer an accepted residual; B1 is first | no |
| 7 | `docs/operations/KJ_P8A_K1_QUALIFICATION.md` | records the K1 local result (263 tests, 14 mutations) | B | none | historical evidence of what K1 proved; proves nothing about revision 2.3 | no |
| 8 | `packages/contracts/src/reflection.ts`: `parseReflectionStringObject` | strict parser: byte cap before scanning, duplicate keys detected after unescaping, unpaired surrogate and NUL refused, fixed error with no echo | A | 3, 5.3 steps 3 to 5 | the sealed pre-admission pipeline keeps this idea; the code handles only a flat object of strings at 1,024 bytes, while the sealed objective has arrays, 4,096 bytes, any-depth duplicate refusal, and U+FFFD and control-character rules | only as a starting point, after fresh review |
| 9 | same file: `ReflectionRequestV1` (`sourceTaskId`, focus `REVIEW_EXECUTION` or `ASSESS_ANALYST_ROUTE`) | the public request | C | 5.1 | sealed kinds are `REFLECT` (1 to 10 sources, four focuses, operator feedback), `DISPOSE` and `FREEZE` | no |
| 10 | same file: `ReflectionDispositionV1` (`ACKNOWLEDGED`, `REJECTED`, reason codes, idempotency key) | human disposition of a review proposal | C | 8, 9.4 | sealed dispositions are `INELIGIBLE`, `CANDIDATE_CREATED` and `DISMISSED`, plus `CORRECT`; `ACKNOWLEDGED` has no sealed meaning | no |
| 11 | same file: `ReflectionSourceV1` | a strict manifest of one source task: task, plan, outcome and binding digests, release epoch, evidence references, runtime references, identity reference, memory assembly reference | A | 3, 11.4, 15.5 | the domain-separated source manifest digest is retained (`packet_digest`); the sealed packet covers 1 to 10 sources, COMPLETED or FAILED | concept only; reimplement |
| 12 | same file: `ReflectionProposalV1` | the review proposal: fixed observation tuple, `evaluationRequest`, proposal digest, 16 KiB cap | D | 3, 7 | a duplicate proposal schema under the same name with a different meaning; the sealed proposal is an identity edit or rollback recommendation | no |
| 13 | same file: `ASSESS_ANALYST_ROUTE` and `BENCHMARK_ANALYST_ROUTE` | asks for a route benchmark | D | 9.6 | a proposal whose purpose is route assessment points at provider routing; the sealed design gives reflection no routing consequence | no |
| 14 | same file: factual observation codes (`CANONICAL_COMPLETION_VERIFIED` and others) | versioned factual codes, never prose | A | 3, 6.2 | retained as the principle behind packet codes, rationale codes and concern codes | concept only |
| 15 | `services/kernel/src/reflection/verify.ts`: `verifyReflectionSource` | re-verifies a source task through the existing mission, faculty and identity completion predicates instead of trusting `COMPLETED`; swallows diagnostics so no source value leaks | A | 3, 15.5 (`REFLECT_QUALIFY`) | exactly the retained qualification idea; the code is fixed to one COMPLETED mission of four steps and one model call | as a starting point for P8A-0, after fresh review |
| 16 | same file: `buildReflectionProposal`, `verifyReflectionProposal` | builds and checks the superseded proposal | C | 7, 10.1 | builds the wrong object; sealed construction is `reflection-candidate-construct/v1` | no |
| 17 | same file: import of `identity/secret-scan` | screens the manifest for secret-shaped content | C | 5.3 | the sealed design uses one neutral scanner module in `packages/contracts` | no |
| 18 | use of `canonicalDigest` for manifests and proposals | canonical JSON digests with domain separation | A | 11.1 | the sealed keys use the same existing function | yes: it is existing code on main, not PR code |
| 19 | replay order "committed result first" (ADR text, plan R10 and R13) | a replay returns the original result under its recorded contract | A | 5.4 step 3, 11.3 case 4 | same principle in the sealed admission and record steps | concept only |
| 20 | `tests/reflection.test.ts`, `tests/support/reflection-fixture.ts` | 65 focused cases: byte boundaries, semantic reorder, no memory content, no registered recipe | B | 20 | useful techniques; every assertion targets superseded contracts | no; rewrite |
| 21 | `scripts/mutation-check-reflection.mjs` and its step in `.github/workflows/qualification.yml` | 14 guard-removal mutations run in CI | B | 16 | technique retained; the mutations target superseded guards, and a CI change is out of scope until P8A-0 | no |
| 22 | `tests/identity-topology.test.ts` | import fence: reflection verification cannot reach model, prompt, assembler, ledger or store code | A | 16 | the fence principle is sealed; the specific file list is not | concept only |
| 23 | `packages/contracts/src/index.ts` | exports the reflection contracts | C | n/a | exports superseded contracts | no |

**Summary.** No element of PR #49 is adoptable as written. Seven concepts are retained by the sealed design
(rows 8, 11, 14, 15, 18, 19, 22) and are to be reimplemented in P8A-0. Four elements conflict with the sealed
authority model (rows 2, 5, 12, 13). Nothing is deferred: PR #49 contains no work that belongs after P8B.

## 3. Uncommitted K2 work in the main checkout

Observed in `C:\Users\jonny\Desktop\kerneljson` on branch `codex/kjp8-proposal-design` at `d231867`. File times are
30/09/2026 between 23:54 and 23:58. Read only; not edited, staged, moved, copied or formatted.

| File | State | What it does | Classification | Why |
|---|---|---|---|---|
| `supabase/migrations/20260930224440_reflection_proposal_persistence.sql` | untracked | creates `kernel_private.reflection_proposals`, `reflection_source_evidence`, `reflection_decisions`, `reflection_decision_requests`, a `reflection_inbox` view, shape-validation functions, guards, a deferred completion constraint and a pre-COMMIT self-check of grants | **CONFLICTS_WITH_R23** | it is a P8 production object designed before B1 (ADR 27.1); its proposal table has the superseded schema under the sealed table's name (ADR 7); its decision tables are a separate disposition store (ADR 8); it revokes from the API roles and grants nothing to `kj_worker` or `kj_door` (ADR 27.5); it has no `session_user` guard, no dedupe keys, no support rows, no admission quota and no version-guard hardening. It must never be applied. |
| `services/kernel/src/reflection/store.ts` | untracked | transaction helpers that insert the superseded proposal and record decisions with idempotency keys | **CONFLICTS_WITH_R23** | writes the superseded schema and the separate decision store |
| `tests/reflection-persistence.integration.test.ts` | untracked | 21 real-Postgres cases: deferred completion invariant, concurrent convergence, immutability, grants and row level security, migration atomicity | **REFERENCE_ONLY** | the techniques are sound and several match sealed gates (ADR 20), but every case tests the conflicting schema; one asserts that all non-owner grants are empty, which is the opposite of ADR 27.5 |
| `tests/support/reflection-db.ts` | untracked | disposable Postgres harness that installs the migration and can simulate Supabase-style default grants | **REUSABLE_CONCEPT** | a harness that reproduces default grants is directly relevant to the B1 negative probes (ADR 27.6); the file itself is bound to the K2 migration and must be rewritten |
| `scripts/mutation-check-reflection-persistence.mjs` | untracked | guard-removal mutations for the K2 migration and store | **REFERENCE_ONLY** | technique only; targets conflicting code |
| `tests/identity-topology.test.ts` | modified (2 lines) | changes the fence to expect `reflection/store.ts` as an importer of `verify.ts` | **SUPERSEDED** | it relaxes the K1 fence for the K2 store; the sealed fences are in ADR 16 |

Against the specific revision 2.3 points:

| Revision 2.3 requirement | K2 work |
|---|---|
| B1 first; no P8 production object before B1 | not met: K2 is a P8 migration with no runtime roles |
| reflection store schema (ADR 7, 8, 9) | different schema, different tables, private schema instead of public |
| support provenance (ADR 11.4) | absent |
| dedupe key contract and Unicode 15.1.0 pin (ADR 11.1) | absent |
| candidate construction (ADR 10.1) | absent; K2 has no identity candidates at all |
| topology fences (ADR 16) | the one change loosens a fence |
| model-origin version guard (ADR 10 item 7) | absent |
| admission quota (ADR 5.4) | absent |
| role ownership and grants (ADR 27) | revokes only; asserts empty non-owner grants |

**Other untracked items in the same checkout are not K2 work and were not inspected:** `.tmp-kj-p6-review/`,
`.tmp-kj000000/`, `.tmp-p7a/`, `.vitest/`, `artifacts/`, `GROKBOT_PHASE41_ACCEPTANCE_BRIEF.md`, four files under
`docs/production/`, `kjp6-apply.js` and `temp-kj-script.js`. Classification: **UNKNOWN**. They are outside P8 and
were left untouched.

## 4. Recommended disposition of PR #49

**CLOSE AS SUPERSEDED.** Not performed; it needs separate authorisation.

- The sealed ADR replaces the PR's architecture, recipe, request, proposal, disposition and plan.
- The PR cannot be merged in any case: it adds a second ADR numbered 0023 and a duplicate proposal schema.
- Closing loses nothing. The branch and both commits remain reachable by SHA, and the seven retained concepts are
  recorded in section 2 with their source rows.
- Keeping it open as a draft invites a future session to continue K2 from it, which is the failure this
  reconciliation exists to prevent.

The K2 files should stay where they are until Jonny decides what to do with them. They are uncommitted, so they
exist only in that checkout; deleting them would be irreversible. Options for a later decision: commit them to a
clearly named archive branch off `d231867`, or discard them. Neither is done here.

## 5. What the reconciliation itself did not do

- It does not merge, close, edit or comment on PR #49.
- It does not touch, move or stage any K2 file.
- It does not start B1 or any P8 implementation.
- It does not change the sealed design.

## 6. Outcome, 02/10/2026

Jonny authorised the following after reading this reconciliation. Each was done and checked.

**PR #49: closed as superseded, not merged.** Closed on 01/10/2026 at 23:15 UTC with an archival comment naming the
sealed design SHA. Its head was still `d2318678de054333c21206d8e8b3431f1babae8b` when closed. The branch
`codex/kjp8-proposal-design` was not deleted and both commits remain reachable.

**The six K2 paths: quarantined, then removed from the working tree.**

| Item | Value |
|---|---|
| Patch | `C:\Users\jonny\Desktop\kerneljson-quarantine\KJ_P8_PRESEAL_K2_QUARANTINE_2026-10-02.patch` |
| Patch SHA-256 | `921c4e168bfbe87823a8621a36dd9873af6a172a1e85539baaf0587043bf0cc5` |
| Manifest | `KJ_P8_PRESEAL_K2_QUARANTINE_2026-10-02.md`, beside the patch |
| Status | PRE-SEAL / NOT AUTHORISED / REFERENCE ONLY |

- The patch is outside every repository working tree and is not committed anywhere.
- Before anything was removed, the patch was applied to a scratch worktree at `d231867` and each of the six files
  was compared with its original: content identical, line endings LF instead of CRLF.
- `tests/identity-topology.test.ts` was then restored to its tracked state, and the five untracked files were
  deleted. None of the six paths is dirty any more.
- No other untracked item in that checkout was touched.

The patch exists on one machine only. If it matters, it should be copied somewhere backed up.
