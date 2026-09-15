# KJ-P1.2 — production alerting, code qualification (PASS)

Date: 2026-09-15. Status: **CODE QUALIFICATION PASS.** The deterministic alerting
layer over the KJ-P1.1 health model (`services/kernel/src/alerting/`,
`docs/operations/ALERTING.md`) is merged to canonical main, fully tested
(deterministic + real-Postgres integration), and live-validated read-only against
production. This record covers **KJ-P1.2 code qualification only** — it is
explicitly NOT a production deployment/activation record. See "Important scope
boundary" below.

---

## 1. Canonicalisation

- PR #27 (`feat(alerting): KJ-P1.2 production alerting`, including the
  persistence-wiring review fix) independently reviewed, approved, and
  squash-merged by the human.
- Canonical merge SHA: **`190137c`** (kerneljson `main`).
- Verified: `git diff 7afd3973289a2045fa9bbbeba61687a496a41632 190137c` (the
  reviewed, approved branch head vs. canonical main) is **empty** — the
  squash-merge introduced zero content drift from what was reviewed.
- Scope confirmed exact: 18 files changed vs. the prior main
  (`b8f332f..190137c`) — `package.json`, `docs/operations/ALERTING.md`, the 11
  `services/kernel/src/alerting/*.ts` files, `supabase/migrations/20260915220000_alert_state.sql`,
  and 4 test files (`tests/alerting-model.test.ts`,
  `tests/alerting-postgres.integration.test.ts`,
  `tests/alerting-store-selection.test.ts`, `tests/baseline.json`). No file
  outside the reviewed P1.2 alerting scope was touched.

## 2. Post-merge validation, from canonical main

| Check | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | clean, 0 errors |
| `npx eslint packages services apps runtimes tests evals vitest.config.ts --max-warnings=0` | clean, 0 warnings |
| `tests/alerting-model.test.ts` (deterministic reducer/policy/aggregation tests) | **20/20 passed** |
| `tests/alerting-store-selection.test.ts` (deterministic, mocked `pg.Pool`) | **11/11 passed** |
| `tests/alerting-postgres.integration.test.ts` (real disposable Postgres, `KJ_TEST_PG_URL`) | **3/3 passed** against a fresh local `postgres:16` container (migration applied, tests run, container torn down — never production) |
| `npm run test:unit` | **211/211 passed** |
| Full `vitest run` (all suites) | **592 passed, 51 skipped (all intentional), 0 failed** |
| `node scripts/check-baseline.mjs` | baseline retained: 224/224 passing, recovery >=27, 51 intentional env-gated skips |

No regression anywhere. Docker was healthy and already running; only the
existing daemon was used (per the global Docker Desktop safety rule) — this
session started/tore down its own disposable `postgres:16` containers, never
touched Docker Desktop's lifecycle.

## 3. What is qualified

- **The alerting engine is qualified.** `reducer.ts`'s pure episode-lifecycle
  logic (NEW / ONGOING-dedup / ESCALATED / DEESCALATED / RECOVERED /
  recurrence-after-recovery), the explicit per-check severity policy
  (`policy.ts`, ~30 check ids, each with a stated rationale — not a blind
  1:1 map from `HealthStatus`), and the fingerprinting scheme are all
  exhaustively proven deterministically.
- **The durable Postgres state store is qualified.** `PgAlertStateStore` is
  proven, against a real (disposable) Postgres, to genuinely persist and
  correctly dedupe/recover/reopen episodes ACROSS independent store
  instances/connections — a faithful stand-in for separate `kerneljson alerts`
  process invocations.
- **`postgres` is the production-safe default.** `ALERT_STATE_STORE` defaults to
  `postgres` when unset; `memory` must be explicitly selected (local/dev/smoke
  work only, never assumed).
- **A missing production migration fails closed, proven live.** Run against
  real production (read-only — a failed probe `SELECT` touches nothing) with
  default (`postgres`) mode, the CLI correctly refused to run and exited
  non-zero (`AlertStateStoreUnavailableError`, exit code 4) rather than
  silently falling back to ephemeral state. Confirmed both before and after:
  worker/door `RestartCount` 0 — no production mutation occurred.
- **The production migration remains unapplied.**
  `supabase/migrations/20260915220000_alert_state.sql` is prepared, reviewed,
  and merged to main as a repo artefact — it has **not** been run against the
  production database. `kernel_private.alert_state` does not exist in
  production today.
- **External notification transport remains out of scope.** `ConsoleNotifier`
  (stdout) is the only wired transport. No Telegram/WhatsApp/email/Slack.

## 4. Genuine issue found during this closure's verification

While diffing the merged tree for scope verification, `git diff` reported
`services/kernel/src/alerting/fingerprint.ts` as a **binary** change
(`Bin 0 -> 1643 bytes`) rather than a normal text diff. Investigation found a
literal NUL byte (`\x00`) embedded in the file at byte offset 1063, inside the
template literal that builds the fingerprint's hash input — the separator
between `${checkId}` and `${entityId}` is a NUL byte, not the space character
the surrounding comments and `docs/operations/ALERTING.md` document
(`fingerprint = sha256(checkId + " " + entityId)`).

- **Confirmed present since the file's first commit** (`90475ce`, the original
  PR #27 commit) — not introduced by the squash-merge; `git diff` between the
  reviewed branch head and the merged main tree is empty, so the merge itself
  is exactly what was reviewed, NUL byte included.
- **Scanned every other P1.1/P1.2 source and test file** — isolated to this one
  byte in this one file; not systemic.
- **Functionally harmless**: a NUL byte is a legal character inside a
  JavaScript/TypeScript template literal and a legal byte in a UTF-8 string;
  `fingerprintFor` is computed identically wherever it's called (fingerprint
  generation and fingerprint lookup use the same function), so hashes stay
  internally consistent — no test failure, no observed behavioural defect, no
  duplicate/incorrect fingerprint collision.
- **Real cost**: the file will permanently show as a binary diff in `git diff`/
  code review tooling until fixed, and the shipped byte does not match its own
  documentation. This is exactly the kind of "verify the artefact, not the
  symptom" catch this project's discipline exists for — flagging it rather than
  silently living with it.
- **Not fixed in this turn.** This closure's authorised scope was verification
  and doc freeze only, not a code change. A one-character source fix (replace
  the NUL byte with the intended space) is a small, narrow, low-risk follow-up
  — recommended, not yet authorised.

## 5. Important scope boundary — read before assuming this means "live"

**This is NOT a production deployment/activation record.** KJ-P1.2's code is
qualified and merged; production's actual alerting behaviour is UNCHANGED by
this record — `kernel_private.alert_state` still does not exist in production,
so `kerneljson alerts` run there today still fails closed rather than actually
persisting anything. **Full KJ-P1.2 production deployment is NOT complete.**

The next substep is **KJ-P1.2A — Production Alert-State Migration Activation**:
applying `supabase/migrations/20260915220000_alert_state.sql` to production.
That is a separate, explicitly-authorised production change window (a genuine
schema mutation to the production database) — **not started, not authorised in
this record**, and explicitly not to be smuggled into a code-merge closure.

## 6. Canonical status after this record

- **KJ-P1.2 code qualification = PASS.**
- Production migration status: **unapplied**.
- Next documented step: **KJ-P1.2A — Production Alert-State Migration
  Activation** (not started).
- Recommended, not yet authorised: a small follow-up fix for the
  `fingerprint.ts` NUL-byte finding (section 4).
