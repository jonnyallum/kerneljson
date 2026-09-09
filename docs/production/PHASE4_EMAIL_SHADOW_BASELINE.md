# Phase 4 Track B — EMAIL Shadow Admission Baseline

**Date:** 09 September 2026  
**Mode:** SHADOW ONLY — fixtures this pass; no live soak yet  
**Branch:** `feat/track-b-email-shadow-admission` (from sealed Track A `docs/kerneljson-prep-track-c` @ `5ba9534`)  
**Consumer:** `kj-admission-shadow-email`  
**Shadow tables:** `public.spawner_shadow_runs` + `public.spawner_shadow_compare` (DDL: new-system/migrations/2026-09-05_shadow_store_ddl.sql)

---

## Hard constraints (locked)

- Track A sealed — do **not** modify `NewSystemRuntimeAdapter` / `repository.read` / KJ-000000 paths except additive exports if a genuine compile import requires them.
- **NO** production authority transfer, **NO** `public.actions` writes, **NO** mark-seen, **NO** Spawner / NewSystemRuntimeAdapter execution, **NO** Conductor / dsp / boardroom / WhatsApp / OpenClaw changes.
- Cloud Agents unavailable — Desktop checkout only.

---

## Live baseline (production today)

| Item | Value |
|---|---|
| Path | VM cron `*/5` → `email-ingest-live.py --live` |
| Mailbox | Hostinger API `info@jonnyai.co.uk` |
| Triage | `triage_email_message` (shared with `email-shadow.py`) |
| Mint | `public.actions` `source=email-triage` `source_ref=email:{messageId}\|email-ingest-live` |
| Seen | `\Seen` after successful mint/no-op path |
| Title style | `Email triage: {subject}` |

Live currently stores Message-ID **as received** (often with angle brackets). Track B **normalises** Message-ID for KJ discovery/idempotency stability (see locked identity). Raw-bracket live `source_ref` vs normalised discovery key is an **ACCEPTABLE_DIFFERENCE** during shadow, not a defect in the adapter.

---

## Locked identity (Track B)

### `email_source_event_id`

1. Prefer Message-ID / `messageId` / `message_id`
2. Normalise: strip whitespace + angle brackets, lower-case
3. If missing/empty after normalise: `hostinger-uid-{uid}`

### `estate_discovery_key`

```text
email:{email_source_event_id}|email-ingest-live
```

Must match the **logical** live minted `source_ref` form (producer suffix `email-ingest-live`).

### Idempotency-Key (would-be KJ admission)

Derived deterministically from `(tenant, principal, estate_discovery_key)` via the same digest family KJ gateway uses (`capabilityDigest` → 64-hex, charset-safe for gateway `Idempotency-Key` regex `^[A-Za-z0-9._:-]{8,128}$`).

**Do not** invent a parallel ledger. Shadow compares would-be `taskId` / digests only; writes go to `spawner_shadow_*` with `consumer=kj-admission-shadow-email`, never `kernel_private.task_admissions` / `public.actions`.

### Would-be `taskId` algorithm (pure, no DB writers)

Mirrors gateway + `compileIntent` without side effects:

1. `idempotencyKey = capabilityDigest({ tenantId, principalId, estate_discovery_key })`
2. `keyDigest = capabilityDigest(idempotencyKey)` (gateway hashes the key string)
3. `intentId = stableId(['gateway/v1', tenantId, principalId, keyDigest])`
4. `taskId = stableId({ tenant: tenantId, intentId, recipe })`
5. `requestDigest = capabilityDigest({ recipe, objective })` (PublicSubmission-shaped)

Shadow recipe placeholder (until dedicated estate recipe exists): `estate-email-triage/v1` — used **only** for deterministic identity simulation; never submitted to live gateway in this pass.

Same key + same request digest → replay same would-be `taskId`.  
Same key + different request digest → `CONFLICT`.

---

## Estate / principal mapping constants (documented; not authority)

| Constant | Meaning |
|---|---|
| Tenant | Deterministic UUID `stableId(['estate-tenant/v1', 'estate'])` — estate default |
| Principal (auth) | Deterministic UUID `stableId(['estate-principal/v1', 'service', 'email-ingest'])` kind `SERVICE` — adapter auth mapping |
| Owner hints | `@jonny` / `@keith` stay **COMPATIBILITY-ONLY** hints; they do **not** become KJ principal authority |

---

## EstateAdmissionRequest field classes (email)

**REQUIRED:** `channel=email`, `estate_discovery_key`, `objective` (`Email triage: {subject}` or scrubbed), `received_at`, `tenant_ref` / `principal_ref`

**OPTIONAL:** sender, subject, message-id, thread refs, attachment metadata (names/sizes/mime only), `correlation_id`

**COMPATIBILITY-ONLY:** `action_id`, `source_ref`, urgency, label, client, `needs_action`, owner/priority hints

**FORBIDDEN:** credentials, tokens, raw secret bodies, estate-supplied canonical `taskId`

---

## Verdict taxonomy

| Verdict | Meaning |
|---|---|
| `MATCH` | Discovery key + would-be identity + objective align with optional legacy snapshot |
| `ACCEPTABLE_DIFFERENCE` | Expected migration delta (e.g. normalised Message-ID vs raw live brackets; non-actionable with no legacy mint) |
| `MATERIAL_DIFFERENCE` | Surprising semantic drift worth investigation |
| `CONFLICT` | Same idempotency key, different request digest (changed payload replay) |
| `ERROR` | Mapping/simulation failure |

---

## This pass deliverables

- Additive TS under `packages/admission/`
- Vitest fixtures only — **no live soak**
- Local commit on `feat/track-b-email-shadow-admission` — do not push unless asked

## Next (not this pass)

Live shadow soak: read-only observe live email envelopes → adapter → `spawner_shadow_*` compare; still zero `public.actions` / mark-seen / Spawner authority.

---

## Live soak status (09 September 2026)

**Completed:** live read-only shadow soak against all available `public.actions` `source=email-triage` rows (**N=18**).

- Results: `docs/production/PHASE4_EMAIL_SHADOW_SOAK_2026-09-09.md`
- Desktop report: `C:\Users\jonny\Desktop\PHASE4_EMAIL_SHADOW_REPORT_2026-09-09.md`
- Evidence: `artifacts/local/email-shadow-soak/`
- Verdict: **READY WITH CONDITIONS** — no authority transfer
- DB `spawner_shadow_*` persist deferred (local JSONL used)
