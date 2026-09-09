# PHASE 4.1 — EMAIL SHADOW QUALIFICATION REPORT

**Date:** 09 September 2026 (Europe/London / BST)  
**Branch:** eat/track-b-email-shadow-admission  
**Base:** docs/kerneljson-prep-track-c (Track A sealed @ 5ba9534)  
**Draft PR:** https://github.com/jonnyallum/kerneljson/pull/4  
**Mode:** SHADOW ONLY — zero authority transfer  
**Consumer:** kj-admission-shadow-email  
**Identity:** Option C (RFC-style Message-ID normalisation)  
**Desktop report:** C:\\Users\\jonny\\Desktop\\PHASE41_EMAIL_SHADOW_QUALIFICATION.md  
**Repo copy:** docs/production/PHASE41_EMAIL_SHADOW_QUALIFICATION.md

---

## Binary verdict

# EMAIL SHADOW FULLY QUALIFIED

Authority **not** transferred.

---

## 1. Executive summary

Phase 4.1 re-qualified Track B EMAIL shadow admission under **Option C** identity.

- Live public.actions source=email-triage observed read-only: **N=18** (full Brain population under limit 50; N<50 justified — full historical set).
- Re-ran shadow with Option C: **18/18 MATCH** (Phase 4 bracket ACCEPTABLE_DIFFERENCE collapsed as designed).
- Canonical persistence: **18** spawner_shadow_runs + **20** spawner_shadow_compare (18 + 2 replay attempts) with consumer=kj-admission-shadow-email.
- Unit/integration: **28/28** green; typecheck green.
- Zero mutation / zero execution proved.
- Production cron does **not** import the adapter (isolation by non-coupling).

---

## 2. Scope and hard bans (honoured)

| Constraint | Status |
|---|---|
| No EMAIL authority transfer | Honoured |
| No mint_action_for_envelope disable | Honoured |
| No mark-seen change | Honoured |
| No Spawner / NewSystemRuntimeAdapter execution | Honoured |
| No Conductor / dsp / boardroom / WhatsApp / OpenClaw | Honoured |
| No Track A runtime path edits (sealed 5ba9534) | Honoured |
| Shadow failure must not break email ingest | Honoured (non-coupling + dmitEmailShadowSafe) |

---

## 3. Locked identity — Option C (documented)

### email_source_event_id algorithm

1. Prefer Message-ID / messageId / message_id as received.
2. **Normalise (Option C):** trim → strip surrounding <> (repeat) → collapse/remove internal whitespace → lower-case.
3. Retain **
aw_message_id** as provenance on EstateAdmissionRequest / shadow output (brackets/case preserved).
4. Fallback when missing/unusable: hostinger-uid-{mailbox_namespace}-{uid}  
   - mailbox_namespace = non-secret Hostinger mailbox resource id ACee10ad9280d330d279eacd0a3d69 (info@jonnyai.co.uk) — **never credentials**.

### estate_discovery_key

`	ext
email:{email_source_event_id}|email-ingest-live
`

Same Message-ID with/without brackets / case / whitespace → **one** discovery key (intentional Hostinger UID collapse). Same Message-ID different UID → **one** key.

### Would-be 	askId (unchanged pure sim)

simulateWouldBeAdmission only — no gateway submit, no Spawner, no 	ask_admissions / public.actions writes.

---

## 4. Observation method (least invasive)

1. Read-only Brain GET public.actions?source=eq.email-triage&order=created_at.desc&limit=50 via jvault project ntigravity-academy (secrets never printed).
2. Reconstruct envelope + legacy snapshot from source_ref / title / evidence / owner / priority.
3. CompatibilityAdmissionAdapter.admitEmailShadow → **PostgrestShadowStore** primary (spawner_shadow_*) + optional JSONL debug export under rtifacts/local/email-shadow-soak-phase41/.
4. Post-soak RO re-GET actions + shadow tables for mutation / persist proof.

---

## 5. Sample window and counts

| Metric | Value |
|---|---|
| Window | 2026-09-08T01:53:28Z → 2026-09-09T15:00:04Z |
| Justification | Full available email-triage population (limit 50); **N=18** returned — not truncated; soak longer not required |
| Actionable live | **18** |
| Distinct source_ref | **18** |
| Non-actionable live | **0** (not minted; not invented; covered by unit fixtures) |

---

## 6. Comparison matrix (condensed)

All 18 live rows: normalised discovery key matches legacy source_ref after Option C; objectives match titles → **MATCH**.

| # | created_at (UTC) | title (trunc) | Phase 4 verdict | Phase 4.1 verdict |
|---|---|---|---|---|
| 1–18 | 2026-09-08 → 09 | (see matrix JSON) | ACCEPTABLE_DIFFERENCE (brackets) | **MATCH** |

Full matrix: rtifacts/local/email-shadow-soak-phase41/shadow-summary.json.

---

## 7. Verdict taxonomy results

| Verdict | Count | Notes |
|---|---|---|
| MATCH | **18** (+2 replay attempts in DB compares) | Option C collapse proved |
| ACCEPTABLE_DIFFERENCE | 0 on live actionable set | Non-actionable still ACCEPTABLE in unit fixtures |
| MATERIAL_DIFFERENCE | 0 | |
| CONFLICT | 0 | |
| ERROR | 0 | |
| Replay idempotent | **PASS** | Same key+digest → same would-be taskId; store reuses run row |

---

## 8. Zero-execution / zero-mutation proof

| Check | Result |
|---|---|
| Spawner / NewSystemRuntimeAdapter | 0 |
| public.actions POST | 0 |
| mark-seen PATCH | 0 |
| kernel_private.task_admissions | 0 |
| Post-soak actions id set | Identical (18) |
| Post-soak updated_at deltas | **0** |
| spawner_shadow_runs (consumer) | **18** |
| spawner_shadow_compare (consumer) | **20** (18 + replay) |
| Compare verdicts in DB | MATCH only |

Evidence: rtifacts/local/email-shadow-soak-phase41/post-soak-verify.json.

---

## 9. Persistence

- **Primary:** Brain PostgREST → public.spawner_shadow_runs + public.spawner_shadow_compare (consumer=kj-admission-shadow-email).
- Idempotent writer: one logical run per (consumer, input_hash) where input_hash = digest(estate_discovery_key + 
equest_digest); retries PATCH run + append compare attempt (do not invent new logical identities).
- **Optional debug:** local JSONL under rtifacts/local/email-shadow-soak-phase41/ (not primary).
- Schema: 
ew-system/migrations/2026-09-05_shadow_store_ddl.sql.

---

## 10. Phase 4.1 gates — pass/fail

| Gate | Result |
|---|---|
| Option C identity (brackets/case/ws → same key; raw retained; UID fallback with namespace) | **PASS** |
| Same Message-ID different UID → one key | **PASS** |
| Missing/malformed Message-ID covered | **PASS** |
| Canonical spawner_shadow_* writer + integration test | **PASS** |
| Live soak bracket diffs → MATCH | **PASS** (18/18) |
| N≥50 or full historical set justified | **PASS** (N=18 full set) |
| Zero mutation / zero execution | **PASS** |
| Failure isolation (store/sim; Safe wrapper; cron non-coupling) | **PASS** |
| Unit suite green | **PASS** (28/28) |
| Typecheck | **PASS** |
| Authority transfer | **NOT DONE** (correct) |

---

## 11. Final question (answer only — not implemented)

### Smallest reversible EMAIL authority-transfer experiment next

**Single-message dry-run gate (flagged, reversible):**

1. Add a **feature flag** (env) e.g. EMAIL_KJ_ADMIT_SHADOW_AUTHORITY=0|1 default **0**.
2. For **one** pre-selected Message-ID (or next single 
eeds_action mail), when flag=1: call KJ gateway admit with Option C Idempotency-Key / discovery key **instead of** mint_action_for_envelope for that message only; leave all other mail on legacy mint.
3. Keep mark-seen coupled to **whichever path succeeded** for that message; do not change global mark-seen policy.
4. **Rollback:** set flag=0 → immediately back to 100% legacy mint; no schema drop; shadow path remains.
5. Success criteria: one KJ task admission row + no dual public.actions mint for that estate_discovery_key; estate agents still read legacy projection if needed (dual-read, KJ primary for that id only).

This is the smallest reversible experiment: one flag, one message, no Spawner/boardroom/WhatsApp changes, instant rollback.

---

## 12. Conditions / residual gaps

1. Non-actionable live observe still absent from public.actions (unit fixtures cover; optional Hostinger dry-run later).
2. Authority transfer **not** started — correctly blocked until explicit Phase 5 experiment (§11).
3. No unique DB constraint on (consumer, input_hash) yet — application-level idempotency used; optional DDL unique index later.

---

## 13. Final readiness

### EMAIL SHADOW FULLY QUALIFIED

Shadow path, Option C identity, canonical shadow persistence, live MATCH soak, failure isolation, and zero-mutation proofs are complete. **Do not** transfer EMAIL authority until the §11 reversible experiment is explicitly authorised.

---

## 14. Artifacts

| Path | Purpose |
|---|---|
| C:\\Users\\jonny\\Desktop\\PHASE41_EMAIL_SHADOW_QUALIFICATION.md | Desktop report |
| docs/production/PHASE41_EMAIL_SHADOW_QUALIFICATION.md | Repo copy |
| packages/admission/src/identity.ts | Option C algorithm |
| packages/admission/src/shadow-store.ts | PostgREST + idempotent stores |
| 	ests/email-shadow-admission.test.ts | Phase 4.1 fixtures (28) |
| scripts/email-shadow-soak.mjs | Re-runnable soak (DB primary) |
| rtifacts/local/email-shadow-soak-phase41/ | Soak evidence + verify |

Live soak snapshot counts: runs=18, compares=20, verdict_counts={"MATCH": 18}.

---

*End of Phase 4.1 EMAIL SHADOW QUALIFICATION. Authority not transferred.*
