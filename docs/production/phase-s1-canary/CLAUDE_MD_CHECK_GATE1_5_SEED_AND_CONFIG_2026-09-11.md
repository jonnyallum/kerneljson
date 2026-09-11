# S1 Canary Gate 1.5 — seed + gateway + runtime config (repo-only)

Date: 2026-09-11. Author: Claude A (takeover; builder/verifier).
Branch: `feat/s1-canary-gate1_5-seed-and-config` (base: PR #10 HEAD `1d6c718`).
Scope: **Gate 1.5 — repository-only installation tooling + configuration. NO production
mutation.** Closes the gaps found in the Gate 2 preflight without improvising against the
live KernelJSON DB. Gate 2 remains NOT authorised.

## Architectural decision (recorded)
Scheduler persistence stays **recipe-agnostic**: a schedule row defines **when / identity /
policy / lifecycle** only. No `recipe`, `approved_digest`, or `objective` column was added to
`schedule_specs`. The canary's execution binding lives in **scheduler worker/runtime config**
(recipe + approved digest) and the **verifier config** (approved digest), not in the schedule.

## Read-only production identity finding (Step 1)
On the authorised KernelJSON DB `banqdzddfganzfhckdps` (`db.banqdzddfganzfhckdps.supabase.co`,
`postgres`), READ-ONLY: exactly **one principal** `72db0114-839e-8ca9-a2fa-462b561a936b` of kind
**SERVICE** (not HUMAN); one tenant `5f970749-7507-894b-a2e4-872ce20a94b7` ("estate"); one
membership (that principal, role "operator"); **`human_principal_count = 0`**.
**Decision:** condition "owner is HUMAN" FAILS → the canary cannot reuse the existing identity,
and no canary identity was invented/created. **This is a Gate 2-execution blocker requiring a
further identity decision** (designate or create a HUMAN owner principal). The seed tooling below
enforces exactly this (rejects a non-HUMAN owner).

## What was built (repo-only, not executed against production)
- `services/kernel/src/scheduler/canary-seed.ts` — `installDisabledCanary(store, gate, input)`:
  a narrow, fail-closed seed over the existing `ScheduleStore` interface (`upsertSpecVersion`
  + `setState`), NOT raw SQL. Forces `state='disabled'` and `enabledForProduction=false`;
  requires explicit identity + name + timezone + calendar + policies; verifies identity TRUTH
  via an injected `IdentityGate` (tenant/principal/owner exist, owner is HUMAN, membership
  exists); idempotent (exact repeat = "already installed"); conflicting existing state FAILS
  (never overwrites). Touches only spec + state rows — structurally no fire, admission,
  execution or Restate. Ships `PgIdentityGate` (READ-ONLY `SELECT`s) as the production gate.
- `services/kernel/src/scheduler/canary-config.ts` — `loadCanaryConfig(env)` + typed bridge
  `verifyWithCanaryConfig`. Fail-closed: recipe must be exactly `claude_md_check/v1`; the
  approved digest (`SCHED_APPROVED_SHA256`) must be present and **exactly 64 lowercase hex**
  (committed LF SHA-256) — no default, no current-file fallback; the digest reaches
  `verifyClaudeMdCheck({ approvedContentSha256 })` through one typed path.
- `apps/gateway/src/server.ts` — `PublicSubmission` accept-list extended to the EXACT recipe
  `claude_md_check/v1` (explicit enum, no wildcard); recipe→target mapping extracted to an
  exported `recipeTarget` (canary → kernel workflow, not golden). Repo preparation only; not
  deployed/activated.

## Tests (all Docker-free, fail-on-purpose included)
- `tests/canary-seed.test.ts` (11): install (disabled, not-for-prod, zero fires/observations);
  idempotent exact repeat; conflicting-state FAIL; and negatives — non-HUMAN owner, missing
  membership, unknown tenant/principal/owner, `enabledForProduction=true` (strict reject),
  enabled `state` (strict reject), malformed/incomplete + bad timezone, and "no write on
  identity failure".
- `tests/canary-gateway-admission.test.ts` (4): admits `claude_md_check/v1`; keeps existing
  recipes; rejects unrelated/malformed/version-mismatched/wrong-case/no-wildcard ids and
  non-string recipe / empty objective; canary routes to the kernel workflow.
- `tests/canary-config.test.ts` (7): valid load; reject missing/non-authorised recipe; reject
  absent digest; reject malformed digest (length/uppercase/non-hex/whitespace); and the
  configured digest reaching `verifyClaudeMdCheck` (PASS on match, FAIL `CLAUDE_MD_DRIFT` on
  mismatch).

## Digest semantics (Step 6, preserved)
Authoritative target: `jonnyallum/kerneljson` @ `289be33`, `CLAUDE.md`, approved **LF** SHA-256
`27255772beb1418e462fe262a2a747c53bf6a34973c3ad75907f7505a32f2b10`. The config rejects
uppercase / CRLF-transformed / wrong-length digests. Not pinned into any schedule or
production config here.

## Qualification (local)
typecheck 0; lint 0 (`--max-warnings=0`); full suite **398 passed / 32 skipped (430)**; baseline
gate green (224/224, recovery 31, 32 intentional skips, total 430); build 0. No `baseline.json`
change required (new tests are additive passes; the guard still flags any unexpected skip).

## Production mutation = NONE
No merge, no gateway deploy, no migration, no schedule insert, no identity-row change, no enable,
no fire, no admission, no execution, no worker deploy, no production `SCHED_*` configured.

## Remaining before Gate 2 install can run
1. **Identity decision** — designate/create a HUMAN owner principal (+ its tenant membership) on
   the production DB (a separate authorised step). The seed will reject anything else.
2. Gate 2 then uses this tested `installDisabledCanary` seed (not hand-written SQL) to insert the
   single disabled schedule, after applying the scheduler migration.
