# KJ-P8 ADR-0023 REVISION 2.3 FINAL HOSTILE DESIGN SEAL

**Verdict: APPROVE**

**Exact commit sealed:** `679e3a3dfc7a33f9106ed77913d49cdac19166d5`

**Parent Revision 2.2 (diff parent only; not re-sealed as tip):** `53f2ab011f0de627f3de97fd76d287b2beeb18c9`

**Prior blocked tips (context):** `f2b36fa928a475307c6913f87f0d6dc0e031a243` (six blockers); `90264f4e314313a4bb372ba4e1ea2522e1d1a5e4` (B-DEDUP-NORM). Local prior seal of R2.2 at `53f2ab0` returned APPROVE; user brief states an independent hostile re-seal of R2.2 returned BLOCK on P8-R22-B1-LP and P8-R22-LIST-EDIT with hardening P8-R22-UNICODE-PIN and P8-R22-SUPPORT-PROVENANCE. THIS seal treats the user-stated R2.2 findings as the defects Revision 2.3 claims to close, and re-reviews the whole architecture hostilely — not a rubber-stamp of changed paragraphs.

**Base main:** `750d5b7926f320d8e9d3f64789b8f7035eaa4f3d` (ancestor: YES; remote `origin/main` tip verified equal)

**Branch tip verified:** `design/kjp8-reflection-governed-growth` → `679e3a3dfc7a33f9106ed77913d49cdac19166d5` (no later commit on branch)

**Repo:** `jonnyallum/kerneljson`

**Primary:** `docs/adr/0023-reflection-self-model-governed-growth.md` (PROPOSED, revision 2.3, design only)

**Also:** `docs/operations/KJ_P8_IMPLEMENTATION_SEQUENCE.md`

**Review mode:** READ-ONLY DESIGN SEAL ONLY. No GitHub mutation, merge, implement, deploy, PR edit, production touch, restart-checkpoint mutation, or K2 persistence work. Verdict applies ONLY to SHA `679e3a3dfc7a33f9106ed77913d49cdac19166d5`. Does NOT approve branch name alone, later SHA, working tree, PR #49 (`d2318678de054333c21206d8e8b3431f1babae8b` / `codex/kjp8-proposal-design`), or uncommitted work.

**Local checkout:** `/workspace/kerneljson-p8-seal` at `679e3a3dfc7a33f9106ed77913d49cdac19166d5`

**Production baseline (context only, untouched):** epoch 13, release `cebbb0dfe32e913ac3d4cd2860abce6ca9ecf05e`; P7B complete; cognition ON; Class C/D FROZEN; Shared Brain not integrated; P8 not implemented.

**Prior seals:** `/workspace/KJ_P8_ADR0023_FINAL_HOSTILE_DESIGN_SEAL.md` (BLOCK f2b36fa); `/workspace/KJ_P8_ADR0023_R21_FINAL_HOSTILE_DESIGN_RESEAL.md` (BLOCK 90264f4 on B-DEDUP-NORM); `/workspace/docs/reviews/KJ_P8_ADR0023_R22_HOSTILE_SEAL_53f2ab0.md` (local APPROVE of 53f2ab0 — superseded as authority for R2.2 findings by user-stated independent BLOCK).

**Seal standard:** APPROVE only if two competent implementers independently get the same authority / schemas / lifecycle / Class E / candidate / approval / freeze / window / rollout / dedupe-key / list-edit / runtime-role contracts. Prefer BLOCK with concrete object/section. Authority-critical ambiguity → BLOCK. Fresh full regression of COMPLETE ADR — not rubber-stamp of changed paragraphs. APPROVE = sufficiently complete/coherent to proceed to next separately authorised engineering checkpoint (B1 authorisation still separate; P8A-0 still separate). Does NOT authorise implement / merge / deploy / continue K2.

**AuthorDate of tip:** Thu Oct 1 23:32:58 2026 +0100 (BST / Europe/London).

**Seal written:** 2026-10-01 23:42 BST.

---

## 1. REVIEW INTEGRITY

### 1.1 Tip resolution

```
origin/main                              = 750d5b7926f320d8e9d3f64789b8f7035eaa4f3d
origin/design/kjp8-reflection-governed-growth = 679e3a3dfc7a33f9106ed77913d49cdac19166d5
git log 679e3a3..origin/design/kjp8-reflection-governed-growth  → empty
parent of 679e3a3 = 53f2ab011f0de627f3de97fd76d287b2beeb18c9
```

**TIP_VERIFIED: YES**
**PARENT_VERIFIED: YES**

### 1.2 Ancestry and scope

```
git merge-base --is-ancestor 750d5b7926f320d8e9d3f64789b8f7035eaa4f3d 679e3a3dfc7a33f9106ed77913d49cdac19166d5
  → YES

git diff --name-status 750d5b7..679e3a3
  A  docs/adr/0023-reflection-self-model-governed-growth.md
  A  docs/operations/KJ_P8_IMPLEMENTATION_SEQUENCE.md

git show --name-only 679e3a3
  docs/adr/0023-reflection-self-model-governed-growth.md
  docs/operations/KJ_P8_IMPLEMENTATION_SEQUENCE.md
  (docs only; +407 / -61 vs parent 53f2ab0)

git log --oneline 750d5b7..679e3a3
  679e3a3 docs(adr): ADR-0023 revision 2.3, close final hostile blockers
  53f2ab0 docs(adr): ADR-0023 revision 2.2, close B-DEDUP-NORM (design only)
  90264f4 docs(adr): ADR-0023 revision 2.1 ...
  12580fd docs(adr): ADR-0023 revision 2 ...
  f2b36fa docs(adr): ADR-0023 ... (PROPOSED, design only)
```

**PASS.** Exactly two design files vs base main. No code, migrations, tests, or production artefacts in the tip commit or the cumulative design branch diff. Docs-only tip. Branch tip equals sealed SHA; no later commit.

### 1.3 Out of scope (explicitly not sealed)

- PR #49 / `codex/kjp8-proposal-design` at `d2318678de054333c21206d8e8b3431f1babae8b` (reference only per ADR §3 / sequence)
- Any SHA after `679e3a3dfc7a33f9106ed77913d49cdac19166d5`
- Uncommitted K2 persistence work
- Production epoch 13 / `cebbb0d`
- B1 / B2 / P8A-* / P8B implementation authorisation

---

## 2. BASE-MAIN CODE VERIFICATION (ADR §1 claims vs `750d5b7`)

Checked at `/workspace/kerneljson-p8-seal` checked out to base main then re-checked against tip ADR prose. No prose-only trust.

| # | ADR claim | Verified at base main | Result |
|---|---|---|---|
| 1 | Door catalogue: golden/uppercase family, claude_md_check, mission, identity-change | `apps/gateway/src/server.ts` `PublicSubmission` enum: `uppercase/v1`, `uppercase-reverse/v1`, `claude_md_check/v1`, `MISSION_RECIPE` (`repo-analysis-mission/v1`), `IDENTITY_CHANGE_RECIPE` | **CONFIRMED** (ADR colloquial “golden, uppercase” = uppercase/v1 + uppercase-reverse/v1) |
| 2 | Admission one txn; task_admissions holds objective; tasks later | gateway submit path + ADR-consistent (prior seals + structure) | **CONFIRMED** |
| 3 | MODEL_PROPOSAL never APPROVED (CHECK) | `supabase/migrations/20260925120000_primary_identity.sql` `check (origin = 'OPERATOR_INSTRUCTION' or state in ('HELD','REJECTED'))` | **CONFIRMED** |
| 4 | identity_version_guard lacks origin/state refuse for model; latent | guard ~185–239: task bind when `proposed_by_task` set; no origin check | **CONFIRMED latent** |
| 5 | identity-change owner-only HUMAN; CAS base | classify trigger + workflow (`owner_principal_id`) | **CONFIRMED** |
| 6 | Approvals: requested_from; finish compares actor to approver | ApprovalStore pattern (prior + structure) | **CONFIRMED** |
| 7 | C/D frozen by default | `coalesce(is_frozen, true)` + `set_identity_freeze` revoked from API roles | **CONFIRMED** |
| 8 | validateFacultyPin hard-codes MISSION_RECIPE; isolation only RUNTIME_REVIEW | `faculty/policy.ts` | **CONFIRMED** |
| 9 | P7B framing analyst-only; verifier empty ceiling | prior + ADR-consistent | **CONFIRMED** |
| 10 | Worker connects as postgres | `KJ_P7B1_DEPLOYMENT_RUNBOOK.md` / `KJ_P7B_LIVE_RESULT_2026-09-30.md` OBSERVED `current_user=postgres` | **CONFIRMED** |
| 11 | Secret screen: looksLikeSecret + findSecretShapedContent | memory policy + identity/secret-scan.ts | **CONFIRMED** |
| 12 | sameModel in packages/contracts mission | present | **CONFIRMED** |
| 13 | canonicalStringify / canonicalDigest | `services/kernel/src/identity/canonical.ts` | **CONFIRMED** |
| 14 | classA.values 1–20; classD.objectives 0–20; list item trim 1–300; order semantic | `packages/contracts/src/primary-identity.ts` | **CONFIRMED** (grounds §10.1) |
| 15 | RLS enabled, no policies (owner-only effective access) | migrations ENABLE RLS; CREATE POLICY count = 0 | **CONFIRMED** (grounds B1/§27.4 policy addition) |
| 16 | P5 memory normalise = NFC+trim (distinct from key contract) | `services/memory/src/canonical/service.ts` | **CONFIRMED** |

---

## 3. PRIOR R2.2 FINDINGS — CLOSURE AT `679e3a3`

### 3.1 P8-R22-B1-LP (blocker) — RESOLVED

**Defect claimed:** R2.2 accepted P8A in production while the worker ran as `postgres` owner; dedicated role deferred to before P8B.

**Delivered in R2.3:**

| Requirement | Delivery | Verdict |
|---|---|---|
| Owner-role execution forbidden for every live P8 stage | §19, §22.3, §27.1, sequence: no P8 object while any runtime connects as owner; “no fallback to postgres, no temporary owner mode” | **PASS** |
| B1 first in rollout | Fixed order **B1 → P8A-0 → B2 → P8A-1 → P8A-2 → P8B** (§19 + sequence) | **PASS** |
| Dedicated roles specified | `kj_worker`, `kj_door`: LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT; own nothing; no membership (§27.2) | **PASS** |
| Cannot-do list exact + negative-tested | §27.3 table; §27.6 step 4 requires each denial seen to fail | **PASS** |
| Runtime-role guard on P8 writes | §27.5: `session_user` ∉ {kj_worker, kj_door} → `P8_OWNER_ROLE_REFUSED`; uses `session_user` not `current_user` so definer paths cannot launder | **PASS** |
| Mode raise not via transaction setting | §17.1 withdraws setting-based recognition; raise only via `set_reflection_mode` with no EXECUTE for runtime roles | **PASS** |
| Critical question: can P8 run if runtime falls back to postgres/owner? | **NO.** Guard refuses P8 writes; P0 `database.runtimeRolesLeastPrivilege`; §27.7 “P8 stops working”; sequence invariant | **PASS** (required answer) |
| Fail-closed if B1 cannot qualify | §27.7 / sequence: P8 stays unavailable; never fixed by reconnecting as owner | **PASS** |
| Residual owner acceptance language removed | Diff removes “residual accepted… B1 below” / “Does not block P8A”; attack table rows 16–19 now refuse | **PASS** |

**Hostile attacks on B1 placement:**

| Attack | Result |
|---|---|
| Ship P8A-0 schema while worker still postgres | Forbidden by §19 / sequence production rule | **PASS** |
| Incident response reconnects worker as postgres to “keep P8 up” | P8 writes refuse; P0 alert; no break-glass | **PASS** |
| Raise mode via `set_config` custom setting (R2.2 path) | Withdrawn; EXECUTE privilege is the boundary | **PASS** |
| `kj_worker` SET ROLE to owner | NOINHERIT + no membership; SET ROLE / SESSION AUTHORIZATION fail | **PASS** |
| `freeze_reflection` security definer used to raise mode | Writes only DISABLED; raise function separate and unexecutable by runtime | **PASS** |
| P8A “bounded residual” re-accepted in sequence | Sequence puts B1 first; no residual language remains | **PASS** |

**P8-R22-B1-LP: RESOLVED**

### 3.2 P8-R22-LIST-EDIT (blocker) — RESOLVED

**Defect claimed:** `ADD_ITEM` / `REMOVE_ITEM` did not define candidate document construction → divergent bytes/digests.

**Delivered:** §10.1 contract `kerneljson:reflection-candidate-construct/v1`.

| Requirement | Delivery | Verdict |
|---|---|---|
| Named pure function | `construct(headDocument, edit)` → one document or one ineligibility code | **PASS** |
| Common ordered steps | strip version → parse value with field schema → apply one path → IdentityDocumentDraft | **PASS** |
| Equality ≠ key normalisation | Exact code-unit equality after schema trim; not §11.1 | **PASS** |
| REPLACE / ADD / REMOVE table | NO_CHANGE, LIST_FULL, AMBIGUOUS_EDIT, LIST_MINIMUM, append-last, remove-one preserve order | **PASS** |
| Path/op pairing closed | §6.2: ADD/REMOVE only for `classA.values` and `classD.objectives`; other pairing refused | **PASS** |
| Golden vectors | 12 required cases including case/spacing non-collapse, ambiguous remove, Class A minimum, Class D empty | **PASS** |
| Ineligible still auditable | Proposal row + INELIGIBLE disposition; no candidate | **PASS** |

**Hostile attacks:**

| Attack | Result |
|---|---|
| Two implementers sort/dedupe list on ADD | Forbidden: “no array is sorted, deduplicated or reordered” | **PASS** |
| REMOVE of duplicate list item silently removes first | AMBIGUOUS_EDIT | **PASS** |
| Case-only ADD treated as NO_CHANGE via key normalise | Explicitly not; vector 10 appends | **PASS** |
| REPLACE used on list path | Pairing refused at §6.2 | **PASS** |
| Construct invalid then rely on later check | Forbidden; kernel never constructs known-invalid | **PASS** |

**P8-R22-LIST-EDIT: RESOLVED**

### 3.3 P8-R22-UNICODE-PIN (hardening) — RESOLVED

§11.1 pins `v1` to **Unicode 15.1.0** with: assigned-only input (`Cn`/private-use/noncharacter → `REFLECTION_TEXT_INVALID`); conformance digest procedure `UNICODE_15_1_CONFORMANCE_SHA256` (hex deferred to P8A-0 implementation, procedure fixed); fail-closed process-start proof (`REFLECTION_KEY_CONTRACT_UNAVAILABLE`); no “runtime’s current Unicode” fallback. Golden vector requirements expanded (sharp s, Final_Sigma, White_Space set, punctuation preserved).

**P8-R22-UNICODE-PIN: RESOLVED** (hex digest value remaining = intentional P8A-0 artifact, not design ambiguity)

### 3.4 P8-R22-SUPPORT-PROVENANCE (hardening) — RESOLVED

§11.4 specifies immutable `reflection_support` columns (deterministic id, typed subject, ordinal, matched_key/key_contract, evidence_refs, packet_digest, structured_result_digest, evaluator_call_id). Support written only on evaluator SUPPORT with no concerns. Surface text of repeat not stored. §9.5 reconstruction rule: confidence = pure function of distinct `source_task_id` over subject evidence_refs ∪ support evidence_refs; CONSISTENT no longer depends on undefined “contradicting task”.

**P8-R22-SUPPORT-PROVENANCE: RESOLVED**

---

## 4. B2 GATE — SOUNDNESS

| Check | Result |
|---|---|
| B2 before P8A-1 | Sequence order 3 = B2; order 4 = P8A-1 | **SOUND** |
| P8A-0 cannot use reflection faculty ops | P8A-0: no door recipe, mode DISABLED, no model call; faculty ops arrive in B2 | **SOUND** |
| P8A-1 cannot start before B2 | Explicit gate; §6.4 / §22.3 | **SOUND** |
| B-ISO absorbed into B2 | Closed VERIFIER_ISOLATED_OPERATIONS list includes REFLECT_EVALUATE; table membership test | **SOUND** |
| B2 does not authorise growth / adoption | “none until P8A-1”; no window/ADOPT | **SOUND** |

**B2_GATE: SOUND**

---

## 5. P1–P7 GRANT MANIFEST — AUTHORITY BOUNDARY

**Question:** Is discovery/freeze method sufficient, or must the finished privilege table exist at design seal?

**What R2.3 delivers:**

- §27.4: single repository manifest file; B1 migration generated from / checked against it; bidirectional catalogue equality test.
- Static survey baseline labelled **INFERENCE** until inventory (§27.6 step 1) freezes it; open question §26 restates this honestly.
- §27.5 **P8 grants exact** (table-level verbs, including explicit none for mode/window open).
- §27.3 cannot-do list finished.
- §27.6: inventory → equality → positive P1–P7 requalification under roles → negative qualification of every denial → production cutover → soak before P8A-0.
- §4 runtime-role row binds behaviour to “exactly … the section 27 grant manifest” once frozen.

**Hostile judgment:**

A finished exhaustive GRANT list for every P1–P7 object is a **B1 engineering deliverable**, not something that can be honestly frozen without the inventory script against `750d5b7`. Fabricating that list in the ADR would be false precision. The authority-critical P8 boundary (cannot raise mode / open window / own objects / disable triggers / operate P8 as owner; exact P8 grants; session_user guard) **is** finished. The method forbids shipping B1 without freeze + equality + negative proofs, and forbids any P8 object before that.

**P1_P7_GRANT_MANIFEST: SUFFICIENTLY_SPECIFIED**

Residual (non-blocking): B1 hostile review must reject any attempt to treat the §27.4 category prose (“capability tables”, “those the inventory finds”, door SELECT “inventory fixes”) as the shippable manifest; only the frozen file + catalogue equality count.

---

## 6. ORIGINAL SIX BLOCKERS + B-DEDUP-NORM — FULL RE-VERIFICATION

| Blocker | Mechanism at tip | Verdict |
|---|---|---|
| **B-RL** | Reservation table + BEFORE INSERT under per-tenant advisory lock + deferred inverse on task_admissions + READ COMMITTED refuse + FAILED consumes slot + DISPOSE/FREEZE exempt | **PASS** |
| **B-SEC** | §5.3 steps 1–6 pure before admission txn; free-text list; zero durable rows on refuse | **PASS** |
| **B-EV** | §15.1 digests/ids/enums only; no raw model prose; Restate residual §15.2 | **PASS** |
| **B-GW** | Two immutable tables; effectiveness predicate; shared identity-activation lock; FREEZE closes via closure insert | **PASS** |
| **B-CHK** | §18.1 static CHECK; §18.2 binding + same-xact transition + deferred activation; single ADOPT writer; requested_from = owner | **PASS** |
| **B-ISO** | VERIFIER_ISOLATED_OPERATIONS closed list includes REFLECT_EVALUATE; delivered by B2 before P8A-1 | **PASS** |
| **B-DEDUP-NORM** | §11.1–11.4 + Unicode pin + support provenance | **PASS** |

---

## 7. MANDATORY REGRESSION (30 surfaces / questions)

Assessed against the complete ADR at `679e3a3` (sections 0–27 + sequence), not only the R2.3 delta.

| # | Surface | Result | Notes |
|---|---|---|---|
| 1 | Authority model (§4) | **PASS** | Owner / deployment / runtime roles separated; records not tokens |
| 2 | HUMAN-owner trigger (§5.2) | **PASS** | Door + DB principal = owner_principal_id |
| 3 | Pre-admission / B-SEC (§5.3) | **PASS** | Pure scan before txn; zero rows on refuse |
| 4 | Atomic quota / B-RL (§5.4) | **PASS** | Lock + reservation + deferred inverse |
| 5 | Structured outputs (§6.2) | **PASS** | Closed path/op; all-or-nothing refuse |
| 6 | Isolation / B-ISO (§6.4) | **PASS** | B2 gate; closed allow-list |
| 7 | Evaluator independence (§6.5) | **PASS** | sameModel twice; fail closed; no record |
| 8 | Class E (§9) | **PASS** | Derived CURRENT; no writable ACTIVE; ceiling + fence |
| 9 | Confidence (§9.5) | **PASS** | Reconstructible; CONSISTENT cleaned |
| 10 | MODEL_PROPOSAL / candidate (§10) | **PASS** | Origin permanent; P8A version refuse; HELD only |
| 11 | List-edit construction (§10.1) | **PASS** | Closes P8-R22-LIST-EDIT |
| 12 | Dedupe / support / Unicode (§11) | **PASS** | Closes B-DEDUP-NORM + pins + provenance |
| 13 | Rate limits (§12) | **PASS** | DB-enforced; stale free head caps |
| 14 | Stale / replay (§13, §11.3–4, §18.4) | **PASS** | No rebase/rebind |
| 15 | Evidence / excerpt (§15) | **PASS** | No raw text; excerpt refuse-without-row |
| 16 | Fences (§16) | **PASS** | Topology + mutations; Class E consumer ban |
| 17 | Freeze / mode (§17.1) | **PASS** | Raise = owner fn only; freeze_reflection lowers only |
| 18 | Growth windows / B-GW (§17.2–3) | **PASS** | Append-only OPEN/CLOSE; clock_timestamp after lock |
| 19 | P8B adoption / B-CHK (§18) | **PASS** | Binding + CHECK + single writer |
| 20 | Rollout order (§19 + sequence) | **PASS** | B1 first; no owner fallback |
| 21 | Acceptance gates (§20) | **PASS** | B1/P8A-0/P8A/P8B proofs include owner-refuse + Unicode vectors |
| 22 | Health (§21) | **PASS** | P0 runtimeRolesLeastPrivilege added; no silent fallback |
| 23 | Threat / adversarial (§22) | **PASS** | Attacks 16–21 cover owner fallback, list-edit, Unicode |
| 24 | Same-tenant (§23) | **PASS** | Composite FKs; approvals transitive |
| 25 | Non-goals / rejected (§24–25) | **PASS** | No auto-adoption, SB, adaptive routing, etc. |
| 26 | Open questions (§26) | **PASS** | No authority-critical remainder; B1/B2 gates named |
| 27 | Runtime roles B1 (§27) | **PASS** | Closes P8-R22-B1-LP |
| 28 | Self-modification | **PASS** | No auto-adoption; MODEL HELD in P8A; ADOPT HUMAN-only P8B |
| 29 | Classes A/B/C/D/E | **PASS** | E separate; C/D frozen until window; A always HUMAN; B = B2 only |
| 30 | Implementability / sequence file | **PASS** | Single-locus; named contracts; fixed order; docs-only tip |

**REGRESSION_RESULT: ALL 30 PASS** (B1 and B2 remain design-accepted open **engineering** gates, correctly placed; not design-seal blockers).

---

## 8. SECTION / SURFACE VERDICTS (summary)

| Surface | Verdict |
|---|---|
| INTEGRITY / DIFF SCOPE | **PASS** — ADR + sequence only |
| BASE-MAIN FACTS | **PASS** |
| AUTHORITY | **PASS** |
| B1 / OWNER FALLBACK | **PASS** — P8 cannot run as owner |
| B2 PLACEMENT | **PASS / SOUND** |
| P1–P7 GRANT MANIFEST | **PASS / SUFFICIENTLY_SPECIFIED** (freeze method + exact P8 grants + cannot-do) |
| LIST-EDIT §10.1 | **PASS** |
| UNICODE PIN §11.1 | **PASS** |
| SUPPORT PROVENANCE §9.5/11.4 | **PASS** |
| DEDUPE / B-DEDUP-NORM | **PASS** |
| ORIGINAL SIX | **PASS** |
| SEQUENCE FILE | **PASS** — B1 first; no postgres fallback |

---

## 9. BLOCKERS

**NONE**

Closed at this tip (user-stated R2.2 findings):

- **P8-R22-B1-LP** — RESOLVED (§27 + rollout/sequence/guard)
- **P8-R22-LIST-EDIT** — RESOLVED (§10.1)
- **P8-R22-UNICODE-PIN** — RESOLVED (§11.1)
- **P8-R22-SUPPORT-PROVENANCE** — RESOLVED (§9.5, §11.4)

Prior lineage still closed: B-RL, B-SEC, B-EV, B-GW, B-CHK, B-ISO, B-DEDUP-NORM.

---

## 10. NON_BLOCKING_HARDENING

1. **B1 inventory freeze:** §27.4 category prose must not ship; only the frozen manifest file + catalogue equality. Door SELECT list still inventory-bound (stated).
2. **Unicode conformance hex** computed and reviewed at P8A-0 (procedure fixed; value intentionally absent from ADR).
3. **P8A-0 golden vectors** must include White_Space edge cases, BOM/U+FEFF negative, NFKC pairs, Final_Sigma, and all twelve §10.1 construction cases with fixed digests.
4. **P7 identity-change PROPOSE/ROLLBACK pre-admission scan** remains RECOMMENDED out-of-scope (§5.3 / §26).
5. **Expiry residual** between guard `clock_timestamp()` and COMMIT (§17.2) — stated.
6. **Restate journal** retains provider bodies (§15.2) — execution retention, not P8 evidence.
7. **Support table** unbounded lifetime growth at ≤36 rows/tenant/day — operational.
8. **Only REFLECT consumes admission slots** (FREEZE/DISPOSE exempt) — intentional; reconfirmed acceptable (§22.2 / §26).
9. **ADR §1 “golden, uppercase”** colloquial vs exact enum `uppercase/v1` + `uppercase-reverse/v1` — non-authority imprecision.

---

## 11. WHAT APPROVE MEANS / DOES NOT MEAN

**Means:** Design at `679e3a3dfc7a33f9106ed77913d49cdac19166d5` is sufficiently complete and coherent that two competent implementers can share one authority / schema / lifecycle / list-edit / dedupe / runtime-role contract. Next gated engineering checkpoint is **B1 authorisation** (own hostile review, change window, requalification). P8A-0 remains a later separate authorisation after B1 qualifies.

**Does NOT mean:** authorisation to implement B1/B2/P8 code, merge to main, edit PR #49, deploy, open the door recipe, raise mode, create model candidates, adopt, unfreeze C/D, continue K2, or mutate production / restart checkpoints.

---

## 12. FINAL VERDICT

# APPROVE

Exact SHA sealed: **`679e3a3dfc7a33f9106ed77913d49cdac19166d5`**

Base main: **`750d5b7926f320d8e9d3f64789b8f7035eaa4f3d`**

Do not implement from this seal without a separate engineering authorisation starting at B1. Do not treat branch name, PR #49, or any other SHA as sealed.
