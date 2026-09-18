# Telegram notification transport — KJ-P2.2

Status: code/test/documentation preparation only. **Not deployed or
activated — `ALERT_TRANSPORT` remains unset (console) in production; no
Telegram bot token exists in any runtime env file yet.** Production
activation is a separate, future, explicitly-authorised change window —
see `docs/operations/PHASE_KJ_P2.2A_TELEGRAM_PRODUCTION_ACTIVATION_RUNBOOK_2026-09-18.md`.

## Architecture — unchanged seam, new transport

Nothing about the KJ-P2.1 outbox/delivery-worker contract changes. Telegram
is the first REAL implementation of the existing `Notifier` interface
(`outbox-types.ts`) — the same interface `ConsoleNotifier` has implemented
since KJ-P1.2.

```
alert decision -> durable outbox -> delivery worker -> Notifier.notify() -> ACK
                                                          ^
                                              ConsoleNotifier (unchanged)
                                              TelegramNotifier (new, KJ-P2.2)
```

`delivery-worker.ts` is untouched by this phase — it still calls
`notifier.notify(payload)` exactly once per delivery attempt, classifies the
outcome via `err instanceof PermanentDeliveryError`, and applies the SAME
bounded-backoff/poison state machine (`outbox.ts`'s `decideNextOutboxState`)
regardless of which concrete `Notifier` is wired in. `TelegramNotifier` has
**no retry loop, no sleep, and no scheduler of its own** — it makes exactly
one HTTP attempt per `notify()` call and either resolves or throws; all
retry timing remains the outbox's job, proven by
`tests/telegram-notifier-http.test.ts`'s full pipeline tests. No KernelJSON
task is minted for a notification, at any point — `TelegramNotifier` never
imports anything from the admission/scheduler/ledger path.

## Configuration

| Variable | Contract |
|---|---|
| `ALERT_TRANSPORT` | `console` \| `telegram`. Unset/empty defaults to `console` (the safe default — no external call, no credential needed). Any other value throws. |
| `TELEGRAM_BOT_TOKEN` | Required when `ALERT_TRANSPORT=telegram`. Runtime-injected from jVault only — never a literal in any env file committed to git or typed as a command argument. |
| `TELEGRAM_CHAT_ID` | Required when `ALERT_TRANSPORT=telegram`. Deliberately a SEPARATE variable from the bot token — a destination identifier, not a credential, so it can be set/reviewed independently of the secret. |

`transport-config.ts`'s `loadTransportConfig` **fails closed and loudly**:
selecting `telegram` without both values throws immediately at startup
(before any DB connection, before Restate registration) — it never silently
falls back to console. This was an explicit requirement: an operator who set
`ALERT_TRANSPORT=telegram` believing alerts would page them, but who
actually got silent console-only output because a value was missing, would
be a materially worse failure than a loud one.

A multi-transport shape (`email`/`whatsapp` alongside `telegram`) was
considered and deliberately deferred — `TransportConfig`'s discriminated
union already generalises cleanly (`{mode:"console"}` vs
`{mode:"telegram", ...}` vs a future `{mode:"email", ...}` variant), so
adding a third mode later is additive, not a redesign. Building that
generalisation NOW, before a second real transport exists to validate the
shape against, would be exactly the kind of premature abstraction this
codebase avoids.

## Error classification

Every Telegram HTTP outcome maps to a **distinct error class**
(`telegram-notifier.ts`), not a shared class with different messages — this
matters structurally: `delivery-worker.ts`'s existing, unmodified
`classifyError` records `err.constructor.name` (never `.message`) into
`notification_outbox.last_error`/`notification_delivery_events.error_class`,
so distinct classes are what make each failure mode operationally
distinguishable in the database, without touching that already-qualified
KJ-P2.1 code at all.

| Telegram outcome | Class | `PermanentDeliveryError`? | Outbox behaviour |
|---|---|---|---|
| 2xx with `{"ok":true}` | — (resolves) | — | `DELIVERED` |
| 401 (bad token) | `TelegramUnauthorizedError` | yes | straight to `POISON` |
| 403 (forbidden/blocked) | `TelegramForbiddenError` | yes | straight to `POISON` |
| 400 (bad request / unknown chat) | `TelegramBadRequestError` | yes | straight to `POISON` |
| 429 (rate limited) | `TelegramRateLimitedError` | no | retried, bounded backoff |
| 5xx | `TelegramServerError` | no | retried, bounded backoff |
| Our own timeout firing | `TelegramTimeoutError` | no | retried, bounded backoff |
| `fetch` throwing for any other reason | `TelegramNetworkError` | no | retried, bounded backoff |
| 2xx with an unparseable or `ok`-less body, or any other status | `TelegramUnexpectedStatusError` | no | retried, bounded backoff (fails closed toward "unverified, try again", never silently assumed delivered) |

Telegram uses HTTP 400 for both "chat not found" and a genuinely malformed
request — both are permanent here, since retrying byte-identical input never
succeeds either way. **429's `retry_after` hint is deliberately NOT acted
on** — the instruction was explicit: "keep retries bounded by the existing
outbox policy... do not create a second independent retry policy that
fights the outbox." `TelegramRateLimitedError` is classified transient like
any other and retried on the outbox's own `computeBackoffMs` schedule
(`baseDelayMs=5000` by default) — a second, competing timer was rejected as
unnecessary complexity for this phase, not overlooked.

## Secret handling — adversarial review

Given the three prior secret-leak incidents this session's own work
surfaced (see `~/.claude/CLAUDE.md`), this transport was built and reviewed
specifically against a fourth class: **a token embedded in a URL**, which
Telegram's Bot API shape makes unavoidable (`sendMessage` has no
header-based auth).

- **Token never in logs.** `TelegramNotifier.notify()` never calls
  `console.log`/`console.error`/any logging function — proven by
  `tests/telegram-notifier.test.ts`'s "never appears in the URL a
  console.log/console.error call could see" test (spies on both, asserts
  zero calls across a full successful delivery).
- **Token never in error strings.** Every one of the 8 error classes above
  has a fixed, curated, static `super(...)` message — none of them
  interpolate the token, the URL, or the caught error's own message/stack.
  Proven by `tests/telegram-notifier.test.ts`'s "the bot token never
  appears in any thrown error's message across every failure path" test,
  which runs a fake token through all 6 realistic failure paths and asserts
  `.message`/`String(err)` never contain it, plus an adversarial test where
  the injected `fetch` itself tries to leak the full token-bearing URL
  inside its own thrown error — `TelegramNotifier`'s `catch` block classifies
  by error TYPE only (`err.name === "TimeoutError"` check) and never reads
  `err.message`, so the hostile payload never reaches the thrown
  `TelegramNetworkError`'s own message.
- **Token never in evidence.** `NotificationPayload` (what the outbox
  persists and what `notify()` receives) has no field that could carry a
  bot token — it's a fixed shape derived from `AlertDecision`, entirely
  unrelated to transport credentials. The token lives only in
  `TelegramNotifierConfig`, held in a private class field, constructed once
  from `TransportConfig` (itself constructed once from `process.env`) and
  never passed to, or derived from, anything the outbox persists.
- **Token never in test snapshots.** Every test uses `FAKE_TOKEN`, an
  obviously-synthetic value (`999888777:AAFakeLocalOnlyTokenNeverReal00000`
  / `123456789:AAFakeTokenForTestsOnlyNeverReal000`) — no real credential is
  ever constructed, held, or asserted against anywhere in this codebase.
  Dependency injection (`fetchImpl: typeof fetch`, defaulting to the real
  global `fetch` only in production wiring) means every test substitutes a
  fake or local transport — `tests/telegram-notifier.test.ts` never makes a
  real network call at all; `tests/telegram-notifier-http.test.ts` makes
  real HTTP calls, but only to a disposable, loopback-only, in-process Node
  server the test itself starts and stops.
- **HTTP mocks / URL assertions.** Tests assert against the REQUEST PATH
  (`/bot<FAKE_TOKEN>/sendMessage`), never a logged/printed full URL — since
  the token in these assertions is a synthetic test value, not a real
  secret, this is safe; nothing in the production code path ever performs
  the equivalent assertion/print against a REAL token.

## Message format

Deliberately compact for this first version (`format.ts`'s
`formatTelegramMessage`): severity (with a colour emoji), kind
(NEW/ESCALATED/DEESCALATED/RECOVERED), check ID, the same safe synthetic
message every transport already receives (`delivery-worker.ts`'s
`rowToPayload` strips raw collector text before ANY notifier ever sees it —
see `docs/operations/NOTIFICATION_OUTBOX.md`), occurrence count, a
timestamp (`lastSeenAt`), duration (RECOVERED only), and the first 8
characters of `notificationId` for correlating a Telegram message with its
`kernel_private.notification_outbox` row. `NotificationPayload` structurally
cannot carry `observed`, a raw collector message, a credential-bearing URL,
or a DB connection string — there is no field for any of them — so this is
a property of the type the formatter receives, not just formatter
discipline.

Telegram's MarkdownV2 parse mode requires escaping
`` _*[]()~`>#+-=|{}.!\ `` outside an explicit entity, or `sendMessage`
rejects the whole request with a 400. `escapeTelegramMarkdownV2` (`format.ts`)
is applied to every piece of check-derived text before embedding — not just
defensively: real check IDs contain `.` (`authority.bindingReleaseConsistent`)
and the synthetic message contains `(`/`)`, both special, so unescaped text
would break on the very first real alert. Proven by a dedicated hostile-input
test asserting every special character from a deliberately adversarial
check ID/message round-trips as an escaped literal, never silently
stripped or left to break formatting.

## Testing

- **Deterministic, no network** (`tests/telegram-notifier.test.ts`, 26
  tests): `classifyTelegramOutcome`'s full status/body matrix,
  `escapeTelegramMarkdownV2`/`formatTelegramMessage` (including the hostile-
  input round-trip and stable-identity determinism), and `TelegramNotifier`
  against an injected fake `fetch` covering successful delivery, timeout,
  network failure, 429, 500, invalid credentials (401), invalid chat (400),
  and the "exactly one HTTP attempt per call" property — plus the
  adversarial secret-redaction suite described above.
- **Deterministic config** (`tests/transport-config.test.ts`, 9 tests):
  default-to-console, explicit console, valid telegram, every missing/empty
  combination failing closed, an unrecognised transport value rejected, and
  a proof that `loadTransportConfig`'s OWN thrown error never contains a
  secret value.
- **Real local HTTP, no Docker, no external network**
  (`tests/telegram-notifier-http.test.ts`, 6 tests): a disposable Node
  `http` server the test starts and stops, proving the notifier's REAL
  request/response/JSON path (not a hand-rolled mock) — a real 200 request
  the server actually parses, a real 401 response correctly classified,
  and the full `outbox -> delivery-worker -> TelegramNotifier -> real HTTP
  -> ACK` pipeline: ACK happens only after real transport success (a failed
  first attempt leaves the row `PENDING`, never falsely acknowledged),
  transient failures remain retryable under the existing outbox policy (not
  due again before backoff elapses), permanent failures (invalid chat)
  become `POISON`, and a delivered notification is never re-attempted by a
  later run. Never calls the real Telegram API — nothing here is
  network-gated, since it needs no external infrastructure at all.
- **Regression proof, unchanged**: `notifier.ts` (`ConsoleNotifier`/
  `RecordingNotifier`) has zero diff in this PR — confirmed via `git diff`
  before every commit — and the full existing KJ-P2.1 alerting/outbox suite
  (`alert-runner.test.ts`, `alerting-model.test.ts`, `outbox-model.test.ts`,
  `alerting-store-selection.test.ts`) re-run unmodified and green, proving
  `ConsoleNotifier` and the outbox/delivery-worker contract are both
  untouched by this phase.

## Unresolved / left for a later, explicit change window

1. **No production bot/chat exist yet.** Activation
   (`PHASE_KJ_P2.2A_TELEGRAM_PRODUCTION_ACTIVATION_RUNBOOK_2026-09-18.md`)
   is prepared but not executed — no BotFather bot created, no jVault entry,
   no production env change.
2. **`retry_after` is read from nowhere** — deliberately, per "Failure
   mapping" above. If Telegram rate-limiting becomes a real operational
   problem once live, revisiting whether the outbox's `DeliveryAttemptResult`
   should carry an optional transport-suggested delay is a legitimate P2.3+
   question, not decided here.
3. **No message-length handling.** Telegram caps `sendMessage` text at 4096
   UTF-16 code units; this format is short enough in practice that no
   payload has been observed anywhere near that limit, but nothing here
   truncates defensively if a future, much longer message field were added.
4. **Email/WhatsApp remain unstarted**, as directed. `TransportConfig`'s
   shape does not preclude them but nothing has been built toward either.
