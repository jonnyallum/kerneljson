# KJ-P6 Core Team / Faculties — live production result

**KJ-P6 — PASS.** Faculties are live in production as tenant-scoped, versioned,
advisory-only configuration; deterministic routing and evidence binding proven
against a real task. A real production incident occurred mid-activation
(worker/door deploy landed without an accompanying `activate_release`, a
natural scheduled fire fell into that gap) and was resolved in two parts: a
code-level release-provenance recovery, and a genuine health-model correction
(PR #45) that closes this record.

## Release and authorization

- KJ-P6 code: [PR #44](https://github.com/jonnyallum/kerneljson/pull/44),
  merged `90f0688b379d13bd0f096f11c82654f3e156eccd`. A migration-syntax defect
  (PL/pgSQL misparses a `CASE...END` sitting directly against an `IF`
  statement's own closing `THEN`) and a stale test assertion were found and
  fixed during qualification, before merge — see the PR for detail. Grok
  hostile review: **APPROVE**.
- Health-model correction: [PR #45](https://github.com/jonnyallum/kerneljson/pull/45),
  merged **`76560548613e368723320fe647d735312af94667`**. Grok hostile review:
  **APPROVE** (final head `6b8e624f5dc7fffe1ac95d1498f87d976a82e2c4`, unchanged
  at merge).
- Target: `kerneljson-prod-01`, GCP project `project-c407f628-c71c-45fa-994`,
  zone `europe-west2-b`; database `banqdzddfganzfhckdps`. No access to the old
  estate VM or Shared Brain was used.
- **Deployed release (worker + door, in lockstep): `76560548613e368723320fe647d735312af94667`.**
- **Epoch: 9 → 10 → 11.** Epoch 10 activated the KJ-P6 migration/deploy
  (`90f0688`, request `86d1cb4e-a624-4bf2-b35c-d6074c66c138`). Epoch 11
  activated the health-model correction (`76560548...`, request
  `f3a7c2e1-9b4d-4e6a-8c1f-2d5b6a9e0c73`), a code-only release with no
  accompanying migration.

## Migration proof (PR #44)

Applied only `20260923150000_core_team_faculties.sql`, in one transaction with
a pre-flight guard refusing if `faculty_versions`/`faculty_pins` already
existed. Committed SHA-256 of the exact file content: `79da952fa3b51d530991fe75b414b33275c9b73bc56533984b90910da01944ba`
(independently verified against the canonical git blob, not the working-tree
copy, after discovering Windows CRLF checkout normalisation makes a raw
`sha256sum` of a working-tree file diverge from the committed LF blob — a
tooling trap, not a content defect).

| Object | Type | RLS / protection | Columns match migration |
|---|---|---|---|
| `public.faculty_versions` | table | RLS enabled, 0 grants to public/anon/authenticated | 6/6 |
| `public.faculty_pins` | table | RLS enabled, 0 grants to public/anon/authenticated | 7/7 |
| `public.faculty_current` | view | `security_invoker=true` | — |

## The incident (2026-09-24, resolved 2026-09-25)

Worker was redeployed to `90f0688` without an immediately-following
`activate_release`. The next natural scheduled fire (`2026-09-24T08:00:00Z`,
the `claude_md_check/v1` canary) admitted normally — a real
`kernel_private.task_admissions` row and a real `kernel_private.execution_bindings`
row (stamped `release_epoch=9`, matching the still-active `a577e74` release at
that instant) — but the **already-running `90f0688` worker's own ledger
correctly refused to materialise the task**: `services/kernel/src/ledger.ts`'s
`Ledger.write()` throws `"Task requires its bound worker release"` when the
running worker's release doesn't match a binding's release, by design. Task
`71a00a16-24d9-8193-a64f-ec9c47c41ea0` retried for ~72 minutes (70 attempts)
and Restate correctly parked it `paused` rather than losing it.

Resolution, once found:
1. Confirmed via the canonical `/v1/tasks/:id/cancel` HTTP endpoint (`404
   TASK_NOT_FOUND`) that no canonical-task-cancellation path could apply — the
   task was never created, so it can never be transitioned, only the dead
   Restate invocation could be cleaned up (`DELETE /invocations/:id?mode=Kill`,
   `202`, issued only after the canonical route was tried and definitively
   refused).
2. Full admission quiesce (door container **stopped**, not merely "asked not
   to send") for the entire migrate/build/deploy/activate window on both the
   original recovery and the PR #45 deploy below.
3. Worker **and** door rebuilt and redeployed together to `90f0688`, parity
   verified, `activate_release` called (epoch 9→10).
4. A genuine health-model bug was found in the resulting alert picture:
   `authority.admittedFiresHaveCanonicalTasks` mapped this — a fire with a
   **real** `task_admissions` record whose `public.tasks` row simply never
   materialised — to the same P0 "scheduler minted without KernelJSON"
   authority-corruption alert as a fire with **no** admission record at all.
   `services/kernel/src/scheduler/persistence.ts`'s own `ADMITTED` doc-comment
   says explicitly this is wrong: ADMITTED means KernelJSON's admission
   succeeded; `public.tasks` materialisation is a separate, downstream
   concern. Fixed and hostile-reviewed as PR #45 (below) before being
   deployed as its own, separate, properly-quiesced release window.

**Historical incident data is untouched, as required — verified once more at
close of this window:**

```json
{"fire":[{"state":"ADMITTED","admitted_child_task_id":"71a00a16-24d9-8193-a64f-ec9c47c41ea0"}],
 "task_admissions":[{"task_id":"71a00a16-24d9-8193-a64f-ec9c47c41ea0"}],
 "execution_bindings":[{"task_id":"71a00a16-24d9-8193-a64f-ec9c47c41ea0"}],
 "public_tasks":[]}
```

No task row was fabricated, no historical row was rewritten or deleted.

## Health-model correction proof (PR #45)

Two review rounds. Round 1 (head `5fd5135`) fixed the severity split itself.
Grok's review of that head caught a real remaining hole before it shipped:
the collector SQL pre-filtered on `t.id is null` (public.tasks missing)
*before* checking whether `task_admissions` existed — silently hiding the
exact authority breach the P0 check exists to catch (a fire whose task
happens to already have a `public.tasks` row despite having **no**
`task_admissions` row at all). Round 2 (head `6b8e624`, the head actually
deployed) fixes the collector to classify every admitted fire unconditionally,
and adds a real-Postgres collector-level regression suite reproducing that
exact hidden case, using `session_replication_role=replica` to simulate the
one path that could violate the real FK
(`schedule_fires.admitted_child_task_id → kernel_private.task_admissions(task_id)`)
— a trusted-owner raw-DDL write — and independently proving the same FK
genuinely refuses the un-bypassed write.

Post-deploy, verified live (not merely in CI):

| Check | Before | After |
|---|---|---|
| `authority.admittedFiresHaveCanonicalTasks` | CRITICAL, `observed:["71a00a16..."]` | **HEALTHY**, `observed:[]` |
| `authority.admittedFiresMaterialised` (new) | — | **DEGRADED**, `observed:["71a00a16..."]` |

Alert state (`kernel_private.alert_state`), fresh read post-deploy:

| check_id | severity | fingerprint | state |
|---|---|---|---|
| `authority.admittedFiresHaveCanonicalTasks` | P0 | `84ce34a1...` | **RECOVERED** `2026-09-25T00:27:16Z` |
| `authority.admittedFiresMaterialised` | P2 | `18ea8a26...` | OPEN (correct, permanent, expected) |

Distinct fingerprints confirmed. No stale P0/P1 remained open beyond the
already-known, unrelated `legacyAuthority.b1FreezeObservable` (P3,
pre-existing, `notify:false`, predates this incident). `authority.noReleaseMismatchIncidents`
stayed separate and unaffected throughout (never opened during this window).

## Faculty seed proof

`scripts/seed-core-team.ts 5f970749-7507-894b-a2e4-872ce20a94b7 76560548613e368723320fe647d735312af94667`
— transactional, safety-gated (refuses if any task in flight / pending
approval / POISON), idempotent on digest match.

```json
{"tenantId":"5f970749-7507-894b-a2e4-872ce20a94b7","facultyCount":8,"enabled":["intelligence","verifier"],"changeRef":"76560548..."}
```

Verified independently from the DB, not just the script's own report: exactly
8 rows at version 1, enabled set exactly `{intelligence, verifier}`, and
**every single one** of the 8 — enabled or not — has
`authorityCeiling=ADVISORY_TEXT_ONLY` and `toolPermissions=[]`. No faculty
owns task authority.

## Live proof

Mission admitted through the real door
(`mission-cli.ts admit --repo jonnyallum/kerneljson --label kj-p6-live-proof-20260925 --findings 3`):
task `518628d1-3d86-87e7-a442-9213b5ad9c58`, `COMPLETED`, with a
`TOOL_RECEIPT`, two `ARTIFACT` (analyst + reviewer) and one
`DETERMINISTIC_RESULT` (reconcile) evidence row.

Faculty pins verified against `faculty_versions` directly (not just that a
pin exists — that its digest matches the live deployed config exactly):

| faculty | version | operation | routing reason | provider | digest matches `faculty_versions` |
|---|---|---|---|---|---|
| intelligence | 1 | RUNTIME_ANALYSE | repo-analysis/analyst | deepseek | yes |
| verifier | 1 | RUNTIME_REVIEW | repo-analysis/independent-reviewer | openrouter | yes |

A second, fully independent proof point: the natural `2026-09-25T08:00:00Z`
scheduled canary fire (task `4900bf2d-1b40-8976-aa14-eed6491245da`) — the
first scheduled fire since the epoch-11 activation — completed `COMPLETED`
with real evidence under ordinary, unassisted operation.

## Safety sweep

- Restate: 7 services registered, one deployment id (`dp_102mQV9dTjV8dj4uhDhuIIF`),
  **zero duplicates**. Only the expected always-on durable chains present
  (`ProductionAlertMonitor` tick, `TelegramOperator` poll, `ScheduleDriver`
  fire) — no paused/stuck invocations.
- POISON: **0** throughout (before, during and after both deploy windows).
- Restarts: worker **0**, door **0** throughout both deploy windows (every
  container replacement was a controlled `docker compose up`/`start`, not a
  crash).
- Growth: 23 total tasks / 14 total fires at close — normal accumulation
  (daily canary since 2026-09-12, prior mission proofs, this window's one
  intentional live-proof task, today's natural fire) plus zero unexplained
  rows.
- Secret leakage: self-contained scan (a script run inside the worker
  container, reading its own env and the deploy-window's worker+door logs,
  reporting only pass/fail per key — the operator never sees a value) found
  **zero** literal occurrences of `DATABASE_URL`, `KJ_ADMISSION_BEARER`,
  `KJ_CONTROL_SIGNING_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
  `MISSION_DEEPSEEK_API_KEY` or `MISSION_OPENROUTER_API_KEY` in either log.
- Business isolation: faculty seed touched only `public.faculty_versions`;
  the live-proof mission and the natural fire each created exactly one task
  through the normal admission path, nothing else.

## Runtime observations at close

| Check | Observed |
|---|---|
| Worker / door / Restate health | all healthy |
| Restart counts | 0 / 0 / 0 |
| Tasks in flight / pending approvals / POISON | 0 / 0 / 0 |
| Overall health | DEGRADED (1 known, correctly-classified, permanent residual) |
| Critical issues | 0 |
| Open P0/P1 | none |

## Stop boundary and residual risks (non-blocking)

- `authority.admittedFiresMaterialised` stays permanently OPEN/P2 for
  `71a00a16-24d9-8193-a64f-ec9c47c41ea0` — by design; that task can never
  materialise under any future release, and no fabricated row will ever be
  written to silence it. This is the correct, honest end state for this
  specific historical fire, not a bug to chase further.
- `legacyAuthority.b1FreezeObservable` (P3, `notify:false`) remains the
  pre-existing, already-documented Shared Brain cross-system gap; unrelated
  to KJ-P6, out of scope here.
- The other 6 disabled faculty templates (primary-executive, architect,
  builder, operator, archivist, guardian) remain configuration-only,
  unexercised by any live task — expected; only `intelligence`/`verifier`
  serve the currently-admitted recipe (`repo-analysis-mission/v1`).
- No live faculty **disable/revoke/cross-tenant/cross-recipe refusal** was
  exercised against production in this window (those are covered by the
  disposable-Postgres mutation and integration suites in PR #44's
  qualification, not re-proven live here — re-proving refusal paths live
  would mean deliberately trying to break production authority, which this
  program's scope discipline forbids).

Machine-readable evidence retained in-session (SQL transcripts, health-CLI
JSON, alert_state snapshots, mission-cli output) is not separately archived
as a file in this freeze commit; this document is the record.
