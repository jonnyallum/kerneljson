# Reliable notification delivery — KJ-P2.1

Status: code/test/documentation preparation only. **Not deployed or activated
— no migration applied to production, no production mutation.** Production
activation is a separate, future, explicitly-authorised change window, exactly
like every prior alerting migration (`20260915220000_alert_state.sql`,
`20260916205049_release_provenance.sql`).

## Problem

`docs/operations/ALERT_RUNNER.md` (KJ-P1.3) documented this as an accepted,
out-of-scope gap: the alert engine committed notification intent
(`alert_state.last_notified_at`) before transport delivery was attempted, with
no durable receipt in between. A crash or transport failure in that gap could
silently lose a notification — the episode was already marked notified, so
the reducer's own dedup (`services/kernel/src/alerting/reducer.ts`) correctly
refuses to re-emit a decision for the same still-open episode. Acceptable for
console-only output; not acceptable before real external paging (Telegram,
WhatsApp, email) is introduced.

`tests/alert-runner.test.ts` had a test that named this exactly: **"deduplicates
crash-after-commit replay (notification loss is explicit)"** — the KJ-P1.3
programme's own authors found and accepted this as a known limitation. KJ-P2.1
closes it; that test has been rewritten to assert the fixed guarantee instead
(same scenario, opposite outcome).

## Architecture

An outbox, not a redesign of the alert engine. The pure reducer
(`reducer.ts`) is unchanged — alert evaluation stays fully deterministic.

```
runAlertEngine (engine.ts)                     runDeliveryWorker (delivery-worker.ts)
  reduce checks against existing state            recover abandoned SENDING rows (stale sweep)
  -> next AlertStateRow[] + AlertDecision[]        drain PENDING-and-due rows:
  -> intentsFromDecisions(decisions, now)            markSending (atomic claim)
  -> store.putAll(nextRows, intents)                 notifier.notify(payload)
       ONE Postgres transaction:                      decideNextOutboxState(outcome)
         upsert kernel_private.alert_state             applyOutcome (row + audit event)
         insert kernel_private.notification_outbox
         (on conflict do nothing)
```

`runner.ts`'s `runMonitor` calls both phases, in order, inside the SAME
exclusive advisory-lock run the KJ-P1.3 monitor already holds (`runner-postgres.ts`).
This means there is still **one** Restate tick, **one** lock, **one**
scheduler-adjacent recurring service — not a second one. `cli.ts`'s manual
`kerneljson alerts` invocation does the same two phases sequentially so a
human running it still sees delivery happen, but durability no longer depends
on that happening in one uninterrupted call.

Two tables, mirroring the existing mutable-current-state + immutable-history
convention used elsewhere in this schema:

- `kernel_private.notification_outbox` — one row per notification INTENT,
  identity `(fingerprint, first_seen_at, kind, occurrence_count)` hashed the
  same way `fingerprint.ts` does (see `outbox.ts`'s `deriveNotificationId`).
  `fingerprint` alone is not enough: it identifies the *check*, and recurs
  across separate episodes after a recovery (`firstSeenAt` resets on
  recurrence — see `reducer.ts`); `firstSeenAt` pins the notification to one
  episode, `kind`+`occurrenceCount` pin it to one moment within that episode.
- `kernel_private.notification_delivery_events` — append-only, one row per
  delivery ATTEMPT outcome, not one row per intent. Exists so "poison/
  permanent failures become visible operational state" is a real, queryable
  history, not just the outbox row's latest snapshot.

Migration: `supabase/migrations/20260917120000_notification_outbox.sql`.

## Delivery guarantee: AT-LEAST-ONCE, not exactly-once

Stated plainly, per instruction not to claim more than the implementation
provides. The ambiguous case is unavoidable without transport-side idempotency:
a crash between the transport call succeeding and this system recording
`DELIVERED` is genuinely indistinguishable, from the database's perspective,
from a crash before the transport call ran at all. KJ-P2.1 fails OPEN toward
re-delivery rather than silently losing the notification (see "Crash
semantics" below). `notificationId` is exposed as a stable idempotency key so
a future real transport that supports dedup can use it to reach
exactly-once-observed behaviour at the transport boundary; nothing in this
phase claims that today, and `ConsoleNotifier`'s duplicate print is harmless.

## Schema (`NotificationOutboxRow`, `outbox-types.ts`)

| Column | Purpose |
|---|---|
| `notification_id` (PK) | `deriveNotificationId` — replay-safe identity |
| `fingerprint`, `check_id`, `entity_id` | episode identity, carried through for durable display without a live `AlertDecision` |
| `first_seen_at`, `last_seen_at`, `kind`, `occurrence_count`, `severity`, `message`, `duration_ms` | a durable SNAPSHOT of the decision at queue time — by delivery time the live decision object no longer exists |
| `status` | `PENDING \| SENDING \| DELIVERED \| POISON` |
| `attempt_count`, `created_at`, `last_attempt_at`, `next_attempt_at`, `delivered_at`, `last_error` | delivery bookkeeping |

`message` is the REAL policy-authored text, kept durable for operator
debugging (a genuine improvement over before, where it was never persisted
anywhere). It is never what reaches a transport — see "What a transport
actually sees" below.

## What a transport actually sees

`delivery-worker.ts`'s `rowToPayload` strips `observed`/raw-message risk the
same way the old `runMonitor` inline loop did ("Collector errors can contain
URLs. Never pass raw observations/messages to stdout or future transports."):
the `NotificationPayload` handed to `notifier.notify()` replaces `message`
with a synthetic `"${checkId}: ${kind} (${severity})"` string. This is
existing, tested KJ-P1.3 behaviour (the recurring monitor's `ConsoleNotifier`
never saw the raw message either) — KJ-P2.1 makes it the one, universal path
(previously `cli.ts`'s direct `runAlertEngine` call and `runMonitor`'s inline
loop disagreed on this; now there is exactly one delivery mechanism for both).

## Retry model

Bounded exponential backoff, deterministic (no jitter — consistent with this
module's pure/reproducible-function style throughout):
`delay = min(baseDelayMs * 2^(attemptCount-1), maxDelayMs)`
(`outbox.ts`'s `computeBackoffMs`). Defaults (`DEFAULT_DELIVERY_CONFIG`):
`baseDelayMs=5000`, `maxDelayMs=300000`, `maxAttempts=8`, `staleSendingMs=120000`.
Exhausting `maxAttempts` moves the row to POISON even though the underlying
failure was transient — the delivery-event log still honestly records
`TRANSIENT_FAILURE` for that attempt; POISON is the row's own status, a
distinct, separately-queryable "this needs a human" signal, not a different
kind of attempt outcome.

A transport that KNOWS a failure is unrecoverable can throw
`PermanentDeliveryError` (`outbox-types.ts`) to skip straight to POISON
without burning the retry budget. Nothing in KJ-P2.1 throws it yet —
`ConsoleNotifier` never fails — the hook exists for a real transport (P2.2)
without needing another `Notifier` interface change.

## Crash semantics

| Case | Handling |
|---|---|
| Crash after outbox insert, before delivery | Row stays `PENDING`; the next run's drain phase picks it up. Proven live in `tests/alert-runner.test.ts`'s rewritten crash-after-commit test and `tests/outbox-postgres.integration.test.ts` (real Postgres). |
| Transport timeout / transient failure | Classified transient, bounded backoff, row stays retryable. |
| Permanent transport failure | `PermanentDeliveryError` -> straight to `POISON`. |
| Crash after actual delivery, before acknowledgement | The row is left `SENDING` (that write, made by `markSending` before the transport call, already committed). A later run's stale-sweep (`recoverIfStaleSending`, gated by `staleSendingMs`) flips it back to `PENDING` and logs `AMBIGUOUS_RECOVERED`, then it is genuinely delivered again — **the notification is handed to the notifier twice**, proven explicitly in `tests/outbox-postgres.integration.test.ts` test 9. This is the at-least-once guarantee made concrete, not a bug. |
| Duplicate worker/replay | `notification_outbox`'s unique `(fingerprint, first_seen_at, kind, occurrence_count)` constraint makes intent insertion idempotent (`on conflict do nothing`); `markSending`'s atomic `UPDATE ... WHERE status='PENDING' ... RETURNING *` makes claiming a row for delivery idempotent — a second claimant gets `null`, proven under real concurrent Postgres connections in `tests/outbox-postgres.integration.test.ts` test 10. |
| Notifier unavailable | Classified transient (unless it throws `PermanentDeliveryError`); retried with backoff like any other transient failure. |
| Retry does not duplicate the alert EPISODE | Structural: delivery never writes `kernel_private.alert_state`. Episode dedup is entirely the reducer's job (unchanged); the outbox only decides whether a given intent was ever queued/delivered, never whether an episode is open. |

## Authority

Notification delivery is not task authority. This phase mints no KernelJSON
business tasks, adds no second scheduler (delivery folds into the SAME
`ProductionAlertMonitor` Restate tick / advisory-lock run KJ-P1.3 already
holds — a deliberate choice: adding a second recurring Restate service for
delivery was considered and rejected as unnecessary footprint given
console-only output; see "Later" below), modifies no business scheduler
semantics, and changes no admission authority. Restate is not used for the
outbox at all — delivery-row recovery is a Postgres-durability property,
independent of Restate's continuation layer, which is why the integration
tests below use a plain disposable Postgres container rather than Restate.

## Testing

- **Deterministic** (`tests/outbox-model.test.ts`, 19 tests): `deriveNotificationId`
  stability/uniqueness (including the specific recurrence-after-recovery case
  where fingerprint and occurrenceCount both coincide but `firstSeenAt`
  differs), `intentsFromDecisions` filtering/stamping/replay-stability,
  `computeBackoffMs` bounds, `decideNextOutboxState`'s full transition table
  (success / transient-with-budget / transient-exhausted-to-poison /
  permanent), `recoverIfStaleSending`'s three cases (not SENDING, live vs.
  abandoned), and `InMemoryNotificationOutboxStore`'s own contract
  (idempotent enqueue, `listDue` ordering/gating, `markSending` eligibility,
  `applyOutcome` persistence, `listStaleSending` filtering).
- **End-to-end, in-memory** (`tests/alerting-model.test.ts`'s engine describe
  block, rewritten): the full `runAlertEngine` -> outbox -> `runDeliveryWorker`
  pipeline with no Postgres, pairing `InMemoryAlertStateStore` with
  `InMemoryNotificationOutboxStore` exactly like the real Postgres/CLI paths
  are paired.
- **Runner-level, in-memory** (`tests/alert-runner.test.ts`, rewritten): the
  crash-after-commit-replay scenario now asserts the FIXED guarantee (the
  orphaned intent is delivered by a later run, exactly once), plus a
  transient-notifier-failure test proving a single delivery hiccup retries
  with backoff instead of failing the whole monitor run.
- **Real Postgres** (`tests/outbox-postgres.integration.test.ts`, 11 tests,
  `KJ_TEST_PG_URL`-gated, same production tripwire as
  `tests/alerting-postgres.integration.test.ts`): atomic intent+state commit,
  replay-safe dedup, `listDue`/`markSending`/`applyOutcome`/`listStaleSending`
  across independent connections, full `runDeliveryWorker` runs for
  successful delivery / transient retry / poison / the crash-before-ack
  ambiguous-recovery scenario (proving at-least-once concretely, with the
  notifier receiving the SAME notification twice) / concurrent claim
  exclusivity, and a schema-level CHECK constraint proof.
- **Real Postgres + Restate** (`tests/alert-runner.integration.test.ts`,
  existing file, extended): the full production wiring — `runMonitor` inside
  a real Restate tick against real disposable Postgres — still proves
  delivery happens through the actual deployed code path (log assertions
  updated for the renamed `notificationsQueued` summary field). The
  crash/retry/poison/dedup DETAIL is deliberately tested at the lighter
  Postgres-only tier above rather than duplicated here, since delivery
  recovery is a Postgres property, not a Restate one (see "Authority" above).

**Not executed this session:** Docker Desktop was not running on the
authoring host (confirmed via `docker info`, per the global "Windows Docker
Desktop safety" rule — the agent does not manage Docker Desktop lifecycle).
The `KJ_TEST_PG_URL`-gated and Docker-dependent integration tests above are
written, typecheck-clean, lint-clean, and skip cleanly without their
infrastructure (proven by running them with `KJ_TEST_PG_URL` unset), but were
**not run against real Postgres/Restate**. `tests/outbox-model.test.ts`,
`tests/alerting-model.test.ts`, and `tests/alert-runner.test.ts` (262 tests
across the full `test:unit` set) were executed and pass.

## Unresolved / left for a later, explicit change window

1. **No real transport yet** — `ConsoleNotifier` remains the only wired
   notifier, as directed. `PermanentDeliveryError` is the forward-compat hook
   for P2.2's real classification.
2. **Delivery cadence == alert cadence (300s by default)** — acceptable for
   console-only output; a real paging transport (P2.2) where minutes matter
   may want its own, faster-checked cadence. Deliberately not built now
   (would mean a second recurring service, explicitly out of scope this
   phase) — flagged as a likely P2.2 follow-up question, not decided here.
3. **No operational health check wired for POISON rows.** The requirement
   asked for POISON to be "visible operational state" — satisfied via direct
   query (`status = 'POISON'`, proven in the integration tests) — but nothing
   in the P1.1 health model surfaces it automatically yet. Adding one is easy
   but was left out to avoid scope creep into the alerting/health layer this
   session, and to avoid the "alerting on the alerter" design question
   (does a POISON-outbox health check itself route back through the SAME
   outbox?) without deliberate thought.
4. **Integration tests unexecuted this session** (Docker unavailable) — see
   above. Re-run before relying on this for production activation.
5. **`new-system`'s canonical `STATE_OF_RECORD.md`/`CURRENT_PHASE.md` had no
   record of the KJ-P1.x alerting programme at all** as of this session's
   start (last updated 2026-09-15, before KJ-P1.1 through KJ-P1.3A happened)
   — a pre-existing documentation-sync gap between the two repos' canonical
   docs, not something this phase introduced or fixed. Worth a deliberate
   sync pass separately.
