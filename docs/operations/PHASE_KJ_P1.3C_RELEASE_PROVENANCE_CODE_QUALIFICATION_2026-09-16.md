# KJ-P1.3C — release provenance seam, code qualification (PASS)

Date: 2026-09-16. Status: **PASS.** PR #31 (canonical release epochs and binding
provenance) is merged to canonical main and re-verified from a clean checkout of
that canonical state, independent of the PR's own CI run. This record is
**code qualification only** — production is untouched; see
`docs/operations/PHASE_KJ_P1.3D_RELEASE_PROVENANCE_PRODUCTION_ACTIVATION_RUNBOOK_2026-09-16.md`
for the separate, not-yet-executed activation plan.

---

## 1. Canonicalisation

- PR #31 (`feat: add canonical release epochs and binding provenance (KJ-P1.3C)`)
  was independently adversarially reviewed (transaction ordering, trigger
  enforcement, runtime DB privileges verified live against production read-only,
  activation authority, health semantics, deployment protocol, lock duration,
  migration safety) and returned **APPROVE**, then merged by the human.
- Canonical merge SHA: **`488744c`** (kerneljson `main`). Local `main` fast-forwards
  cleanly to `origin/main` at this SHA with zero divergence.
- CI (`validate`, both required checks) on the PR's own head: **PASS** (confirmed
  via `gh pr checks 31` before merge).

## 2. Re-verification from canonical main (independent of the PR's own CI run)

| Check | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | clean, 0 errors |
| `npx eslint packages services apps runtimes tests evals vitest.config.ts --max-warnings=0` | clean, 0 warnings |
| `npm run build` | clean |
| `npm run check:topology` | **PASS** — localhost-only, worker unpublished, shared `kerneljson-exec` network, persistent Restate storage, read-only repo mount, no Postgres container, gateway `:8081` localhost-only |
| `tests/release-provenance.test.ts` (deterministic, pure) | **11/11 passed** |
| `tests/release-provenance-postgres.test.ts` (real disposable Postgres, repo's own automated `knowledgeDatabase()` infra — fresh throwaway DB per run, migrated, torn down automatically) | **13/13 passed** |
| `npm run test:unit` | **243/243 passed** |
| Full `vitest run` (all suites) | **645 passed, 51 skipped (all intentional), 0 failed** (696 total, 59 files) |
| `node scripts/check-baseline.mjs` | baseline retained: 224/224 passing; recovery 31>=27; intentional env-gated skips 51; total 696 |

No regression anywhere. The disposable-Postgres provenance suite used the
repository's own existing automated test infrastructure
(`tests/support/knowledge-db.ts`'s `knowledgeDatabase()` — brings up a throwaway
Postgres via the existing `kerneljson-validation` compose stack, creates a
uniquely-named database, applies every migration, seeds baseline fixtures, and
tears down after) — no manual container setup was required this time, unlike
KJ-P1.2A/B's standalone `postgres:16` containers, because this suite is wired
into the project's normal test harness. Docker was healthy and already running;
its lifecycle was not managed by this task, per the global Docker Desktop safety
rule.

## 3. What is qualified

Everything already established by the KJ-P1.3C adversarial review (transaction
ordering correct under READ COMMITTED and fail-safe under REPEATABLE
READ/SERIALIZABLE; trigger enforcement complete and un-spoofable, including
against direct SQL; runtime DB privileges verified live — production connects
and will continue to connect as `postgres`, table owner, RLS-bypassing;
activation authority (CAS, idempotent retry, conflict-on-changed-payload,
immutable history); health semantics correctly distinguish historical epoch-0
data from genuine post-cutover drift, tested both in pure and real-Postgres
suites; deployment protocol addresses the "draining alone isn't a gate" trap;
lock duration confirmed low-risk from the actual transaction bodies; migration
safety proven by applying the real migration file, as authored, to a
disposable database reconstructing the pre-migration schema) is unchanged by
this record — this is a **re-verification**, not a new review. Full detail in
the adversarial review already delivered to the user and in
`docs/operations/PHASE_KJ_P1.3C_RELEASE_PROVENANCE_RESULT_2026-09-16.md` (PR
author's own self-report, cross-checked during review and found accurate).

## 4. Production status

**Unchanged.** Verified read-only immediately before this qualification run:
`kernel_private.release_epoch`/`release_activations` do not exist in production;
`execution_bindings` still has only its original four columns; no
`schema_migrations` record for `20260916205049`; production release still
`5a2335b41d8fe525ff940a3bd86912c98dae68af`; worker/door/Restate restart counts
all `0`. The PR #31 merge to `main` is a **git-only** event — it has zero
production footprint until the separately-authorised KJ-P1.3D activation runs.

## 5. Canonical status after this record

- **KJ-P1.3C code qualification = PASS.**
- Production migration status: **unapplied**.
- Next step: **KJ-P1.3D — Release Provenance Production Activation** (runbook
  prepared, not yet executed — separate record).
