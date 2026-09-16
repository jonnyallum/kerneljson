# KJ-P1.2B — fingerprint source hygiene fix (PASS)

Date: 2026-09-16. Status: **PASS.** A tiny, isolated follow-up to KJ-P1.2's code
qualification (`docs/operations/PHASE_KJ_P1.2_PRODUCTION_ALERTING_RESULT_2026-09-15.md`,
section 4), fixed before starting KJ-P1.2A as requested.

---

## 1. Finding (recap)

`services/kernel/src/alerting/fingerprint.ts`'s `fingerprintFor` computed its
hash input as a template literal joining `checkId` and `entityId` with a literal
**NUL byte** (`\x00`) instead of a real separator character — an authoring
artefact present since the file's first commit (kerneljson `90475ce`), not
introduced by any later edit or merge. Effects:

- `git diff` rendered the file as a binary change (`Bin N -> M bytes`) instead of
  a normal text diff, on every commit touching it.
- The implementation diverged from its own documentation
  (`docs/operations/ALERTING.md` described a space `" "` separator that was
  never actually what shipped).
- Functionally harmless: `fingerprintFor` is always computed identically
  wherever it's called (generation and lookup use the same function), so
  fingerprints stayed internally self-consistent — no test failure, no
  duplicate/incorrect-collision behaviour was ever observed.

## 2. Fix

Replaced the embedded NUL byte with an explicit, printable, source-visible
separator: **`\n`** (the literal two-character escape sequence in source,
evaluating to a real newline byte only when the template literal executes at
runtime — the *source file* itself now contains normal, greppable text).
Neither `checkId` (drawn from the fixed health-check catalogue) nor `entityId`
(from `resolveEntityId`, currently always the canonical schedule id) is ever
user-controlled, so there is no delimiter-injection concern with any printable
separator choice.

```ts
// before (NUL byte, invisible in source, binary diff):
`${checkId}${'\x00'}${entityId}`
// after (explicit \n, visible in source, normal text diff):
`${checkId}\n${entityId}`
```

Updated:
- `services/kernel/src/alerting/fingerprint.ts` — the implementation, plus an
  expanded doc comment recording this fix and why `\n` was chosen.
- `docs/operations/ALERTING.md` — the "Fingerprinting" section now states the
  real, correct separator.
- `docs/operations/PHASE_KJ_P1.2_PRODUCTION_ALERTING_RESULT_2026-09-15.md` —
  deliberately **left unchanged**: it's a frozen historical evidence record of
  what was true and found on 2026-09-15, including the original NUL-byte
  separator it documented at the time. This new file is the record of the fix,
  not a retroactive edit of history.

No test hardcoded an expected fingerprint hash string anywhere in the repo
(checked: `tests/alerting-model.test.ts`, `tests/alerting-store-selection.test.ts`,
`tests/alerting-postgres.integration.test.ts` all compare `fingerprintFor(...)`
output against itself for stability/equality, never against a literal hex
string) — so no test needed updating to a "new canonical expected value";
existing tests continue to pass unchanged and still prove exactly the same
properties (stability, uniqueness across check/entity) against the corrected
implementation.

## 3. Old/new fingerprint compatibility note

**This intentionally changes every fingerprint hash value** (different hash
input bytes -> different SHA-256 output). This is explicitly the correct moment
to make that one-time break: **no production `kernel_private.alert_state` table
exists yet** (KJ-P1.2A, applying
`supabase/migrations/20260915220000_alert_state.sql`, has not happened — see
the KJ-P1.2 result doc, section 5) — so there are zero persisted production
fingerprints anywhere to migrate, orphan, or reconcile. Every disposable/local
Postgres instance used during KJ-P1.2's own qualification was torn down after
its test run; nothing durable used the old (NUL-based) fingerprint scheme.
Fixing this now, strictly before KJ-P1.2A, means production will only ever see
the corrected `\n`-based fingerprints from the very first row it ever persists.

## 4. Verification

| Check | Result |
|---|---|
| No NUL bytes remain anywhere in P1.1/P1.2 source, docs, or tests | confirmed — scanned every `.ts` file under `services/kernel/src/{alerting,health}`, both `tests/alerting-*.ts` and `tests/health-*.ts`, both `docs/operations/*.md`, and the migration `.sql` file |
| `file services/kernel/src/alerting/fingerprint.ts` | now reports `JavaScript source, Unicode text, UTF-8 text` (was `data`, i.e. detected-binary, before the fix) |
| `npx tsc --noEmit` | clean |
| `npx eslint services/kernel/src/alerting tests/alerting-*.test.ts --max-warnings=0` | clean |
| `tests/alerting-model.test.ts` | 20/20 passed, unaffected |
| `tests/alerting-store-selection.test.ts` | 11/11 passed, unaffected |
| `tests/alerting-postgres.integration.test.ts` (real disposable Postgres) | 3/3 passed against a fresh local `postgres:16` container (migration applied, tests run, container torn down) |
| `npm run test:unit` | 211/211 passed |
| Full `vitest run` | **592 passed, 51 skipped (all intentional), 0 failed** |
| `node scripts/check-baseline.mjs` | baseline retained |

**One expected, inherent artefact, not a residual defect:** `git diff` between
this fix's commit and its NUL-containing parent still renders as
`Bin N -> M bytes` — git's binary-diff heuristic flags a diff as binary if
*either side* contains a NUL byte, and the parent commit's version still does.
The new blob itself is confirmed clean (table above). Every diff **from** this
commit **onward** — including this file's history from this point forward —
will render as a normal text diff.

## 5. Production status

**Untouched.** This was a source-only, disposable-Postgres-only fix. No
connection to production Supabase/Postgres was opened during this work; no
production DB was touched. `supabase/migrations/20260915220000_alert_state.sql`
remains prepared, not applied.

## 6. Canonical status after this record

- **KJ-P1.2B = PASS.**
- The KJ-P1.2 alerting source tree no longer contains any embedded NUL bytes;
  `fingerprint.ts` is now normal, reviewable text.
- Next step, as before: **KJ-P1.2A — Production Alert-State Migration
  Activation** — still not started, still requires its own separate,
  explicitly-authorised production change window.
