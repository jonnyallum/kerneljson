# KJ-P2.1 reliable notification delivery — code qualification

Date: 2026-09-17. Scope: implementation, disposable qualification, documentation,
review PR (#32), merge to canonical main. **No migration applied, no deployment,
no production activation, no production mutation of any kind.**

**KJ-P2.1 RELIABLE NOTIFICATION DELIVERY — CODE QUALIFICATION: PASS.**

**Canonical merge SHA: `1fbe6b22ed35394fb3a52c3735b6b4430d8ac9fa`** — squash-merge
of PR #32 (jonnyallum/kerneljson), single parent `9589977` (the last canonical
main before this phase — KJ-P1.3A production alert runner activation freeze).
Reviewed/CI-qualified head before squash: `e5099f130bb87a8ac070e458a15b354d14b65e8e`.
Post-merge diff confirmed identical scope to the reviewed PR — the same 27
files, no unrelated changes.

| Check | Pre-merge (PR #32, head `e5099f1`) | Post-merge (canonical main, `1fbe6b2`) |
|---|---|---|
| Typecheck | PASS | PASS |
| Full lint (`--max-warnings=0`) | PASS | PASS |
| Build | — (CI only) | PASS |
| Execution-topology check | — (CI only) | PASS |
| `tests/outbox-model.test.ts` (pure) | 19/19 | 19/19 |
| `tests/outbox-postgres.integration.test.ts` (real disposable Postgres 17.6) | 11/11 | 11/11 |
| `tests/alert-runner.integration.test.ts` (real disposable Postgres + Restate 1.7.9) | 7/7 | 7/7 |
| `npm run test:unit` (15 files) | 262/262 | 262/262 |
| Full regression (61 files) | 664 passed / 62 skipped / 0 failed (726 total) | 664 passed / 62 skipped / 0 failed (726 total) — identical totals |
| `npm run test:baseline` | 224/224 protected, recovery 31≥27, 62 intentional env-gated skips | identical |
| GitHub CI (`validate`) | PASS (both jobs, on `e5099f1`) | not re-run (post-merge qualification performed locally instead, per this session's instruction) |

Local reports: `artifacts/local/tests.json` (not committed — pre-existing
convention, see `.gitignore`-equivalent handling of `artifacts/`). No
qualification claim in this document is based on a skipped test; every number
above is from an executed run against real disposable infrastructure or the
deterministic suite.

## What changed since KJ-P1.3A closed

`docs/operations/ALERT_RUNNER.md`'s KJ-P1.3 failure-semantics table documented
an accepted gap: "The current engine commits notification intent
(`last_notified_at`) before transport delivery. It is not a delivery receipt
... durable outbox/acknowledged delivery is outside scope." KJ-P2.1 closes
exactly that gap. `tests/alert-runner.test.ts`'s
"deduplicates crash-after-commit replay (notification loss is explicit)" test
— which asserted the old, lossy behaviour as correct — was rewritten to assert
the fixed guarantee instead (same crash scenario, opposite, now-durable outcome).

## Migration (NOT applied)

`supabase/migrations/20260917120000_notification_outbox.sql` — two new tables:

- `kernel_private.notification_outbox` — one row per notification intent,
  identity `unique (fingerprint, first_seen_at, kind, occurrence_count)`.
  Mutable: `status`, `attempt_count`, `last_attempt_at`, `next_attempt_at`,
  `delivered_at`, `last_error` are upserted as delivery progresses.
- `kernel_private.notification_delivery_events` — append-only, one row per
  delivery attempt outcome, FK to `notification_outbox`.

Both RLS-enabled, `revoke all ... from public, anon, authenticated`, same
convention as `20260915220000_alert_state.sql`. **Confirmed not applied to any
Supabase/production project during this qualification** — only applied to
disposable, uniquely-named, localhost-only throwaway Postgres containers,
each destroyed (`docker rm -f -v`) immediately after its test run.

## Delivery guarantee

**AT-LEAST-ONCE with an idempotency key, explicitly NOT exactly-once.** Stated
this way deliberately, per the instruction not to claim a stronger guarantee
than the implementation provides. The idempotency key is
`notification_outbox.notification_id` (`NotificationPayload.notificationId`),
derived deterministically (`outbox.ts`'s `deriveNotificationId`, sha256 of
`fingerprint\nfirstSeenAt\nkind\noccurrenceCount`, hex, first 32 chars) —
re-deriving it from the identical decision always yields the identical id, so
a replay of the same decision can never enqueue a duplicate intent
(`on conflict (notification_id) do nothing`, proven under real Postgres in
`tests/outbox-postgres.integration.test.ts` test 2).

`ConsoleNotifier` (the only wired transport) has no meaningful concept of
duplicate suppression — a duplicate print is harmless. A future real transport
that wants transport-level dedup can use `notificationId` as its own
idempotency key; nothing in KJ-P2.1 claims that has been built.

## Retry / backoff semantics

Bounded exponential backoff, deterministic (no jitter):
`delay = min(baseDelayMs * 2^(attemptCount-1), maxDelayMs)`
(`outbox.ts`'s `computeBackoffMs`). Defaults (`DEFAULT_DELIVERY_CONFIG`,
`outbox-types.ts`): `baseDelayMs=5000`, `maxDelayMs=300000`, `maxAttempts=8`,
`staleSendingMs=120000`. A transient failure moves a row back to `PENDING`
with `next_attempt_at` set to `now + backoff`; it is not re-attempted before
that time (`listDue` filters on `next_attempt_at <= now`, proven under real
Postgres in test 3 and via `runDeliveryWorker` end-to-end in test 7).

## Poison semantics

Exhausting `maxAttempts` on a transient failure — or any single attempt that
throws `PermanentDeliveryError` — moves the row to `status = 'POISON'`
immediately, with no further automatic retry. The delivery-event log still
honestly records `TRANSIENT_FAILURE` for the attempt that tipped a row into
POISON (that IS what happened on that attempt); POISON is the row's own
status, a distinct, separately-queryable "this needs a human" signal, proven
queryable via a plain `select ... where status = 'POISON'` in test 8. Nothing
in KJ-P2.1 throws `PermanentDeliveryError` yet — it is a forward-compat hook
for a real transport (P2.2) to signal an unrecoverable failure without another
`Notifier` interface change.

## Crash-after-delivery-before-acknowledgement duplicate behaviour

The hardest case, proven explicitly rather than merely asserted safe. Sequence
under real Postgres (`tests/outbox-postgres.integration.test.ts` test 9):

1. `markSending` commits `status='SENDING', attempt_count=1` durably (this
   write always lands before the transport is ever called).
2. The transport is called and the notifier genuinely receives the
   notification once (`notifier.sent.length === 1` at this point).
3. A simulated crash (a `PgNotificationOutboxStore` subclass whose
   `applyOutcome` throws instead of committing) prevents the `DELIVERED`
   write and its acknowledgement event from ever landing. The row is left
   exactly as `markSending` left it: `SENDING`, `attempt_count=1`.
4. A later, ordinary run — past `staleSendingMs` — finds the abandoned
   `SENDING` row (`listStaleSending`), recovers it to `PENDING` (logging
   `AMBIGUOUS_RECOVERED`), and delivers it for real.
5. **The same `notificationId` is handed to the notifier TWICE**
   (`notifier.sent.length === 2`, both entries the same `notificationId`) —
   proven, not assumed. `notification_delivery_events` for that id ends with
   exactly `[AMBIGUOUS_RECOVERED (attempt 1), DELIVERED (attempt 2)]` — an
   honest record of what actually happened, including the ambiguity.
6. No duplicate alert episode: delivery never writes `kernel_private.alert_state`
   (episode dedup is entirely the reducer's job, structurally untouched by this
   phase) — confirmed in the same test (`alert_state` row count = 0 throughout,
   since this test never wrote one).

## Runner-level invariants re-confirmed post-merge

- Exactly one continuation chain: `tests/alert-runner.integration.test.ts`'s
  "real durable recurrence survives worker and Restate restart; duplicate
  bootstrap creates no second chain" — 7/7, unchanged.
- Manual/runner lock exclusion holds: the same file's "the actual manual alert
  CLI shares the runner lock" test — the CLI still exits 4 ("already running")
  while the monitor holds the advisory lock, and now also shares the
  KJ-P2.1 outbox/delivery path through that same lock.
- Concurrent claim exclusivity re-proven directly against real Postgres:
  two independent `PgNotificationOutboxStore` instances racing
  `markSending` on the same row — exactly one wins (test 10).

## Deviations found during qualification (both closed)

1. **Test bug, found only by running against real Postgres.**
   `tests/outbox-postgres.integration.test.ts` test 4 originally used
   `"2026-09-17T99:00:00.000Z"` as a lazy far-future sentinel. JS's `Date`
   parses hour=99 leniently (rolls the value over); Postgres's `timestamptz`
   parser correctly rejects it as out of range, failing the test with a real
   SQL error rather than a logic assertion. Fixed to a genuinely valid
   far-future date (`2030-01-01T00:00:00.000Z`), re-run clean. The
   implementation was never at fault — this is exactly the class of bug a
   mocked/local-only pass cannot catch, and the reason this real-integration
   qualification step exists. Committed as `e5099f1` before merge.
2. **`npm install --frozen-lockfile` failed** during post-merge re-verification
   (this repo is pnpm-managed; the flag/tool mismatch is an artefact of this
   session's tooling, not a repository defect). `node_modules` was already
   correctly installed from the pre-merge qualification pass and no dependency
   changed in this PR, so this was skipped without consequence — every
   subsequent check (typecheck through baseline) ran against the real,
   already-installed dependency tree.

## Repository reconciliation and safety

No production connection, admission, schedule mutation, schema migration,
registration, container action, or B1/C1 access was performed at any point in
this phase. Only disposable, uniquely-named, localhost-only qualification
infrastructure was created and destroyed (two separate throwaway
`postgres:17.6` containers for the two rounds of `outbox-postgres.integration.test.ts`;
the `alert-runner.integration.test.ts` suite's own `postgres:17.6` +
`restate:1.7.9` containers, twice; the `infrastructure/docker/validation.compose.yaml`
stack brought up implicitly by the two full-regression runs, explicitly torn
down after each with `docker compose ... down --volumes`). Docker Desktop's
own lifecycle was never managed by this session — the daemon was confirmed
healthy via `docker info` before any use, per the global Windows Docker
Desktop safety rule, and Jonny started it. Existing untracked user files
(`.tmp-kj000000/`, `GROKBOT_PHASE41_ACCEPTANCE_BRIEF.md`, `artifacts/`,
`docs/production/*`) were not staged or changed at any point.

## Changed-file manifest (PR #32, squash-merged as `1fbe6b2`)

- `services/kernel/src/alerting/outbox-types.ts` (new): `NotificationIntent`,
  `NotificationOutboxRow`, `NotificationPayload`, `Notifier`,
  `PermanentDeliveryError`, `DeliveryConfig`, `DeliverySummary`.
- `services/kernel/src/alerting/outbox.ts` (new): pure core —
  `deriveNotificationId`, `intentsFromDecisions`, `computeBackoffMs`,
  `decideNextOutboxState`, `recoverIfStaleSending`.
- `services/kernel/src/alerting/outbox-store.ts` (new): `NotificationOutboxStore`
  interface + `InMemoryNotificationOutboxStore`.
- `services/kernel/src/alerting/pg-outbox-store.ts` (new): `PgNotificationOutboxStore`.
- `services/kernel/src/alerting/delivery-worker.ts` (new): `runDeliveryWorker`
  — the thin async shell (stale-sweep + drain phases).
- `services/kernel/src/alerting/pg-state-store.ts`: `putAll` now accepts
  optional `intents`, inserted in the SAME transaction as the `alert_state`
  upsert (the atomicity fix).
- `services/kernel/src/alerting/state-store.ts`: `AlertStateStore.putAll`
  signature widened (backward-compatible); `InMemoryAlertStateStore` gains an
  optional paired-outbox constructor argument.
- `services/kernel/src/alerting/select-store.ts`: new `selectNotificationOutboxStore`
  sibling selector.
- `services/kernel/src/alerting/engine.ts`: computes and persists intents;
  no longer calls a notifier directly.
- `services/kernel/src/alerting/runner.ts`: `RunnerDeps`/`RunSummary` reshaped
  (`notificationsQueued` + nested `delivery` summary replace
  `notificationsAttempted`/`notificationsFailed`/`NOTIFIER_FAILED`); calls
  `runDeliveryWorker` after the engine phase, inside the same exclusive run.
- `services/kernel/src/alerting/runner-postgres.ts`: constructs/probes a
  paired `PgNotificationOutboxStore` on the same locked session.
- `services/kernel/src/alerting/runner-production.ts`: adds `transport: "console"`.
- `services/kernel/src/alerting/cli.ts`: queues then drains the outbox
  (skipped under `--json`, to avoid interleaving console output into the
  JSON report).
- `services/kernel/src/alerting/notifier.ts` / `format.ts` / `types.ts`:
  `Notifier` moved to `outbox-types.ts`; raw check messages are stripped to a
  synthetic safe summary before ever reaching a transport (same discipline
  the old inline notify loop applied, now the one universal path).
- `supabase/migrations/20260917120000_notification_outbox.sql` (new).
- `tests/outbox-model.test.ts` (new, 19 tests, pure).
- `tests/outbox-postgres.integration.test.ts` (new, 11 tests, `KJ_TEST_PG_URL`-gated).
- `tests/alert-runner.test.ts`: rewritten for the new summary shape; the
  crash-after-commit-replay test now asserts the fixed guarantee.
- `tests/alerting-model.test.ts`: engine end-to-end tests rewritten to exercise
  the full intent → outbox → delivery pipeline in-memory.
- `tests/alert-runner.integration.test.ts` / `tests/support/alert-runner-worker.ts`:
  updated for the new `RunnerDeps`/summary field names.
- `tests/baseline.json`: +11 intentional-skip entries for
  `outbox-postgres.integration.test.ts`.
- `package.json`: `tests/outbox-model.test.ts` added to `test:unit`.
- `docs/operations/ALERT_RUNNER.md`: reconciled — the KJ-P1.3 gap this phase
  closes, and the `runMonitor` summary shape, both updated.
- `docs/operations/NOTIFICATION_OUTBOX.md` (new): full design doc.
- This qualification record.

## Unresolved / left for a later, explicit change window

Unchanged from `docs/operations/NOTIFICATION_OUTBOX.md`: no real transport yet
(console only); delivery shares the 300s alert cadence; no health-model check
wired for POISON rows yet (queryable via direct SQL); and the pre-existing,
unrelated finding that `new-system`'s canonical `STATE_OF_RECORD.md` had no
record of the KJ-P1.x programme as of this session's start.

## Conclusion

**KJ-P2.1 RELIABLE NOTIFICATION DELIVERY — CODE QUALIFICATION: PASS.** Merged
to canonical main at `1fbe6b22ed35394fb3a52c3735b6b4430d8ac9fa`. Migration not
applied. Production untouched. Ready for a separate, explicitly-authorised
KJ-P2.1A production outbox activation change window.
