# Phase 4 Track B — LIVE EMAIL SHADOW SOAK REPORT

**Date:** 09 September 2026 (Europe/London)  
**Branch:** `feat/track-b-email-shadow-admission` @ pre-soak `8d102a6` (+ this soak commit)  
**Mode:** SHADOW ONLY — zero authority transfer  
**Consumer:** `kj-admission-shadow-email`  
**Desktop report:** `C:\Users\jonny\Desktop\PHASE4_EMAIL_SHADOW_REPORT_2026-09-09.md`

---

## 1. Executive summary

Live production `public.actions` rows with `source=email-triage` were observed read-only and fed through `CompatibilityAdmissionAdapter.admitEmailShadow`. **N=18** distinct actionable rows (full Brain population under limit 50). **All 18** classified `ACCEPTABLE_DIFFERENCE` solely due to live raw Message-ID angle brackets vs Track B normalised `estate_discovery_key`. Idempotent replay proved. **Zero** Spawner / `public.actions` POST / mark-seen / `spawner_shadow_*` DB writes. Unit suite still **22/22**.

**Readiness:** **READY WITH CONDITIONS**

---

## 2. Scope and hard bans (honoured)

| Constraint | Status |
|---|---|
| No EMAIL authority transfer | Honoured |
| No `public.actions` mutation | Honoured (post-soak ids/updated_at unchanged) |
| No Spawner / NewSystemRuntimeAdapter | Honoured |
| No Track A edits (sealed `5ba9534`) | Honoured |
| No Conductor / dsp / boardroom / WhatsApp / OpenClaw | Honoured |
| No cron / `email-ingest-live.py` changes | Honoured |
| No `--live` mint / mark-seen | Honoured |

---

## 3. Locked identity (unchanged)

- `email_source_event_id` = normalised Message-ID (strip whitespace/`<>`, lower-case); else `hostinger-uid-{uid}`
- `estate_discovery_key` = `email:{email_source_event_id}|email-ingest-live`
- Would-be `taskId` / digests via `simulateWouldBeAdmission` only (no gateway submit)
- Recipe placeholder: `estate-email-triage/v1` (shadow simulation only)

---

## 4. Observation method (least invasive)

1. **Read-only Brain GET** `public.actions?source=eq.email-triage&order=created_at.desc&limit=50` using estate-standard jvault project `antigravity-academy` (same Brain URL/key family as live ingest). Secrets never printed.
2. Reconstruct `EmailEnvelope` + `LegacyActionSnapshot` from `source_ref` / `title` / `evidence` / `owner` / `priority` / `created_at`.
3. `admitEmailShadow` → in-memory shadow store + **local JSONL** under `artifacts/local/email-shadow-soak/`.
4. **Deferred** `spawner_shadow_*` DB writes (service_role would be a new production write surface this pass). Confirmed `consumer=kj-admission-shadow-email` row count = **0** after soak.

VM `email-ingest.log` not required — Brain RO returned sufficient historical mint evidence.

---

## 5. Sample window and counts

| Metric | Value |
|---|---|
| Window | `2026-09-08T01:53:28Z` → `2026-09-09T15:00:04Z` (~1.5 days since ingest cutover) |
| Justification | Full available `email-triage` population (limit 50); N=18 returned — not truncated |
| Actionable live | **18** |
| Distinct `source_ref` | **18** |
| Non-actionable live | **0** (not minted to `public.actions`; not invented) |
| Fixture non-actionable | Not injected into live soak matrix (unit fixtures already cover) |

---

## 6. Comparison matrix (condensed)

All 18 rows share the same compare reason: live `source_ref` retains Message-ID angle brackets; Track B normalises. Objectives matched legacy titles. Discovery keys matched after `normalizeLiveSourceRef`.

| # | created_at (UTC) | title (trunc) | verdict | would_be_task_id |
|---|---|---|---|---|
| 1 | 2026-09-09 15:00 | DeepSeek V4.1 Flash API Pricing | ACCEPTABLE_DIFFERENCE | 92823d02-…37ca8 |
| 2 | 2026-09-09 12:40 | Resend rotation OK - Marcus/n8n | ACCEPTABLE_DIFFERENCE | 16cad6b7-…7617c |
| 3 | 2026-09-09 12:40 | Added as a staff member | ACCEPTABLE_DIFFERENCE | a16d3578-…26911 |
| 4 | 2026-09-09 11:40 | Rory urgently needs Social Media… | ACCEPTABLE_DIFFERENCE | b577c43b-…505b8e0 |
| 5 | 2026-09-09 10:30 | Richard urgently needs Web Designer | ACCEPTABLE_DIFFERENCE | e7f4031b-…34999 |
| 6 | 2026-09-09 07:25 | Google Workspace overdue | ACCEPTABLE_DIFFERENCE | (see JSONL) |
| 7–18 | 2026-09-09 → 08 | Bark / HubSpot / DMARC / etc. | ACCEPTABLE_DIFFERENCE | (see JSONL) |

Full matrix: `artifacts/local/email-shadow-soak/shadow-summary.json` + `shadow-results.jsonl`.

---

## 7. Verdict taxonomy results

| Verdict | Count | Notes |
|---|---|---|
| MATCH | 0 | Would require live already-normalised `source_ref` |
| ACCEPTABLE_DIFFERENCE | **18** | Expected bracket normalisation delta |
| MATERIAL_DIFFERENCE | 0 | |
| CONFLICT | 0 | |
| ERROR | 0 | |
| Replay idempotent | **PASS** | Same key+digest → same would-be taskId |

---

## 8. Zero-execution / zero-mutation proof

| Check | Result |
|---|---|
| Spawner / NewSystemRuntimeAdapter calls | 0 (adapter hard-coded false; not imported) |
| `public.actions` POST | 0 |
| mark-seen PATCH | 0 |
| `kernel_private.task_admissions` | 0 |
| `spawner_shadow_*` inserts | 0 (deferred; RO confirm count=0 for consumer) |
| Post-soak actions id set | Identical to pre-soak (18) |
| Post-soak `updated_at` deltas | **0** |

---

## 9. Persistence

- **Primary:** local JSONL `artifacts/local/email-shadow-soak/shadow-results.jsonl` (18 lines) + `shadow-summary.json`
- **DB shadow:** deferred deliberately; document unblock as optional follow-up once a sanctioned shadow writer is approved (still not authority transfer)

---

## 10. Phase 4 gates — pass/fail

| Gate | Result |
|---|---|
| Shadow-only path exists (admitEmailShadow) | PASS |
| Live candidates observed (≥10 or exact N) | PASS (N=18) |
| Compare logic exercised on live envelopes | PASS |
| No MATERIAL_DIFFERENCE / CONFLICT / ERROR on live set | PASS |
| Idempotent replay | PASS |
| Zero estate mutation | PASS |
| Unit regression 22/22 | PASS |
| `spawner_shadow_*` live persist | **DEFERRED** (condition) |
| Non-actionable live observe | **GAP** (none in actions; condition) |
| Authority transfer | **NOT DONE** (correct) |

---

## 11. If EMAIL admission transferred tomorrow — disable / convert legacy

Exact legacy write/state behaviours that **must** be disabled or converted to **projection-only** to prevent dual authority:

1. **`mint_action_for_envelope` / `public.actions` INSERT** in `email-ingest-live.py` (`POST actions?on_conflict=source,source_ref`) — stop being the admission authority; either remove mint or demote to a **read-model projection** of KJ task admission (source of truth = KJ ledger / gateway idempotency, not `public.actions`).
2. **Idempotency owner** — DB uniqueness on `(source, source_ref)` must not compete with KJ `Idempotency-Key` / `task_admissions`; live must not mint a parallel action for the same `estate_discovery_key`.
3. **`\Seen` mark-seen coupling** — today mark-seen follows successful mint/no-op. After transfer, mark-seen must follow **KJ admission success** (or an explicit projection ack), never a legacy actions insert.
4. **Triage → action_triples as write trigger** — `needs_action` / triples may remain classification input, but must not directly author `public.actions` rows.
5. **Any Spawner / board path that treats `source=email-triage` open actions as executable work queue authority** — convert to consume KJ task projections (or dual-read with KJ primary) so estate agents do not execute twice.
6. **Do not** leave cron `--live` mint enabled alongside KJ EMAIL admit in the same cycle without a feature flag that makes legacy mint a no-op.

---

## 12. Conditions / residual gaps

1. Persist shadow compares to `spawner_shadow_*` with `consumer=kj-admission-shadow-email` (approved write surface) for durable estate-visible soak metrics.
2. Optional: observe non-actionable path from Hostinger dry-run / log parse (still zero mark-seen) — not available from `public.actions`.
3. Before authority transfer: implement projection cutover plan for items in §11 with explicit flag and soak under dual-read.

---

## 13. Final readiness

### READY WITH CONDITIONS

Reason: Live shadow compare is green on the full available actionable population (18/18 acceptable normalisation deltas, 0 material/conflict/error, replay OK, zero mutation). Conditions = durable DB shadow persist still deferred; non-actionable live observe absent from actions table; authority transfer runbook (§11) not yet executed (correctly).

**Not** READY FOR CONTROLLED AUTHORITY TRANSFER until §11 disable/projection plan is implemented and flagged.

---

## 14. Artifacts

| Path | Purpose |
|---|---|
| `C:\Users\jonny\Desktop\PHASE4_EMAIL_SHADOW_REPORT_2026-09-09.md` | This report |
| `docs/production/PHASE4_EMAIL_SHADOW_SOAK_2026-09-09.md` | Repo copy of soak results |
| `artifacts/local/email-shadow-soak/live-email-triage-actions.json` | RO snapshot |
| `artifacts/local/email-shadow-soak/shadow-results.jsonl` | Per-row shadow evidence |
| `artifacts/local/email-shadow-soak/shadow-summary.json` | Matrix + counts |
| `scripts/email-shadow-soak.mjs` | Re-runnable shadow soak (local JSONL) |

---

*End of Phase 4 Track B live email shadow soak report. Authority not transferred.*

