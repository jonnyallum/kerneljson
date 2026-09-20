# KJ-P4B - Telegram approvals

**Status: code complete, PR open, not deployed. Nothing runs in production until a release is built, the migration is
applied, a control signing key is provisioned and the approval boundary is switched on in a change window.**
**KJ-P4B.1 supersedes the original bearer-token design: the live window found that Restate journals request headers for 24 hours, so the long-lived key is never sent and each request carries a signed assertion instead. See "Restate journals request headers" below.**
**Decision record:** `docs/adr/0019-telegram-approvals-interface.md`. **Builds on:** KJ-P4A (`docs/operations/KJ_P4A_TELEGRAM_OPERATOR_CHANNEL.md`).

Evidence tags: OBSERVED means run in this work. INFERRED means reasoned, not run.

## What it is, and is not

Telegram becomes a way for Jonny to **see and answer** an approval that KernelJSON already asks for. It is an interface.
It does not decide anything. The authority is unchanged: the policy workflow's `approve` handler and the `ApprovalStore`,
for the named approver, against the exact scope digest, before the database-clock deadline, first valid decision wins.

There is no new authority path. The Telegram layer writes no approval, task, evidence or event row (a test scans its
source for every table it writes and asserts the list), never imports the ApprovalStore or the workflow, and depends on
nothing a model can influence. A button press can only ask the door; the ledger decides.

## Architecture

```
  [existing]  uppercase/v1 admitted at the door -> GoldenTaskWorkflowV1
              policy: APPROVAL_REQUIRED -> ApprovalStore.record (approval PENDING, scope digest, deadline)
              task status APPROVAL_REQUIRED; the workflow waits on a durable promise, with the deadline as a timer

  [new]       every poll, the channel adapter reads the ledger for PENDING approvals it has not shown
              -> one card in the chat: task, action, shortened digest, expiry, APPROVE / REJECT
              (kernel_private.telegram_approval_cards + two opaque handles per card)

  [new]       Jonny presses a button
              -> getUpdates delivers a callback_query (now requested via allowed_updates)
              -> same allow-list as commands: the configured private chat and user, on the card's own message
              -> the handle is looked up server side -> (approval, decision); the digest is the ledger's, copied at card creation
              -> the adapter asks the door: POST /v1/tasks/:id/approve {scopeDigest, decision}       [existing route]

  [existing]  door: authenticates the bearer, tenant-scoped task load, execution binding allows `approve`,
              the caller is the named approver with an unexpired ticket for exactly this digest
              -> forwards to the workflow with a signed per-request assertion in X-KJ-Control-* headers (the key is never sent)
  [existing]  workflow `approve`: authenticator names the approver; ApprovalStore.resolve checks named approver, tenant
              membership, exact scope digest, DB-clock expiry, task status; first terminal decision wins; evidence row written
  [existing]  the promise resolves: GRANTED resumes the SAME workflow to completion; DENIED or EXPIRED fails the task

  [new]       the adapter READS the approval status back from the ledger, answers the press with a fixed pop-up,
              and edits the card to "Approved", "Rejected" or "Expired" with the buttons removed
```

## Callback and event path

| Step | Component | Notes |
|---|---|---|
| 1 | `HttpUpdateSource` | asks for `callback_query` as well as `message`, only when approvals are configured |
| 2 | `classifyUpdate` | a press is authorised only from the configured private chat and user, not a bot, on a message in that chat; anyone else is counted and never answered |
| 3 | `handleCallback` | claims the press by Telegram update id (`telegram_callback_inbox`), so a redelivery is handled once |
| 4 | handle lookup | `kj1:<handle>` names a card and a decision server side; unknown, malformed or edited data names nothing |
| 5 | card binding | the press must come from the card's own message id |
| 6 | ledger read | if the approval is already settled or past its deadline, the door is not asked and the pop-up says so |
| 7 | `HttpDoorClient.approve` | the door's existing control route, with the ledger's full digest |
| 8 | ledger read again | the pop-up and card are worded from the ledger's status, never from the door's reply |

## Action digest design

The action digest is the existing **scope digest** (`PolicyScope`, ADR-0008): the sha256 of the canonical scope holding task
id, step id, tenant, principal, trace, capability, the digest of the exact invocation (including its input and run id), the
capability descriptor digest and the policy version. It is computed by `evaluatePolicy` and stored in the ledger's own
`POLICY_CHECKED` event. KJ-P4B invents no second digest.

- **Shown** shortened to 12 hex characters, for reading only.
- **Forwarded** in full, copied from the ledger event into the card row when the card is created. It is never taken from
  Telegram, and the callback data does not carry it.
- **Approver, tenant, expiry and policy version** are bound by the same mechanism: the approver and deadline are recorded
  with the approval, the tenant and policy version are inside the scope, and the store enforces all of them.

## The synthetic approval boundary

One rule, in `approval-boundary.ts`: the deterministic `uppercase` capability, for the door's principal in the door's
tenant, is `APPROVAL_REQUIRED` with that same human as approver and a configurable deadline (default 600 s, 30 to 86400).
Uppercasing the task's text touches no file, network or account, so nothing but the approval path is exercised. The trigger
is `services/kernel/src/approval-test-cli.ts`, which submits and reads through the door and cannot approve.

## Security properties, and where each is enforced and tested

| Requirement | Enforced by | Proven by |
|---|---|---|
| Only Jonny's configured user and chat can approve | `classifyCallback` (sender, chat type, chat id, not a bot); the door's bearer and named-approver check | unit (7 cases), poll unit, real-Restate test (other user, group, bot) |
| Duplicate button presses are idempotent | callback inbox by update id; ledger status read before asking; `ApprovalStore` returns the existing resolution | unit, Postgres, real-Restate (one outcome, one evidence row, one capability run) |
| Expired approval cannot resume work | adapter courtesy check; DB-clock check in `ApprovalStore`; the workflow's own timer | unit, Postgres (honest clock and a clock an hour wrong), real-Restate (30 s deadline, task FAILED) |
| Stale approval after the action changes fails | scope digest binds the input; a cancelled or settled approval is not pending | Postgres (wrong digest, wrong task, same-words different task), real-Restate (cancel then press) |
| Forged callback data fails | opaque handle, server-side lookup, message binding | unit, Postgres, real-Restate (unknown handle, task id in the clear, edited handle) |
| Telegram cannot mutate task state directly | the layer only writes its own three tables | source scan test, real-Restate (task moves only via the workflow) |
| Model output cannot mint approvals | card text is a branded `CardText`; no mission or model import; fields validated | type-level test, source scan test, hostile-field test |
| One approval never approves another | scope digest per task, step, input and run | Postgres and real-Restate binding tests |

## Files

New: `supabase/migrations/20260920150000_telegram_approvals.sql`; `services/kernel/src/approval-boundary.ts`,
`approval-test-cli.ts`; `services/kernel/src/channel/telegram/{approval-cards,approvals,bot-api,card-store,pg-card-store}.ts`.
Changed (narrow): `channel/telegram/{updates,operator,production,door-client}.ts`; `apps/gateway/src/main.ts` (control
credential); `services/kernel/src/index.ts` (register the workflow, gated); compose, topology check and env-merge allow-list
(declarations only).
Not changed: the workflow, policy, approval store, scheduler, alerting, mission verification, inbound command grammar.

## Configuration

| Variable | Where | Meaning |
|---|---|---|
| `KJ_APPROVAL_ENABLED` | worker | `true` registers the golden workflow with the rule above and enables the Telegram cards; unset, empty or `false` leaves everything as before; anything else refuses to start |
| `KJ_ADMISSION_TENANT_ID`, `KJ_ADMISSION_PRINCIPAL_ID` | worker | the door's own non-secret identity, which is also the named approver |
| `KJ_CONTROL_SIGNING_KEY` | worker and door | secret, at least 32 characters (43 URL-safe characters from 32 random bytes recommended), distinct from the admission bearer. **Never transmitted**: the door signs with it, the worker verifies with it |
| `KJ_CONTROL_KEY_ID` | worker and door | id of that key, 1 to 16 characters, default `v1` |
| `KJ_CONTROL_SIGNING_KEY_PREVIOUS`, `KJ_CONTROL_KEY_ID_PREVIOUS` | worker only | optional, during a controlled rotation only: the worker also recognises this key. Both or neither, and both must differ from the current pair |
| `KJ_CONTROL_FRESHNESS_SECONDS` | worker | optional, 30 to 3600, default 300: how old a first-seen assertion may be, on the database clock |
| `KJ_APPROVAL_TTL_SECONDS` | worker | optional, 30 to 86400, default 600 |

Cards and buttons additionally require `TELEGRAM_INBOUND_ENABLED=true` (KJ-P4A). All are declared in the compose
passthrough, the topology checker and the env-merge allow-list and guarded by inventory tests with negative cases.
`KJ_CONTROL_TOKEN`, from the original design, is no longer read by any code and must not be set.

## Restate journals request headers (measured, KJ-P4B live window)

Restate stores every header of an incoming request in the invocation's `Input` journal entry and keeps it for 24 hours
after completion, readable through its admin SQL (`sys_journal.entry_json`) and its data volume. It is not logged. So a
credential in a header on the door-to-workflow hop is written into a durable store, and "it stays on the private network"
is not a safe claim. The signed-assertion scheme (KJ-P4B.1, ADR-0019) means that what Restate holds is a bounded,
request-bound, non-secret assertion. A test now searches the real Restate's journal for the signing key in clear, hex and
base64 and asserts it is absent, that no signed request carries an `Authorization` header, and that each carries exactly the
six non-secret assertion headers. **Keep this check in any window that changes what crosses that hop**, and repeat it
against production after deployment (read the journal's header names for a fresh approve invocation; never print values).

## Signed control assertions (KJ-P4B.1)

Canonical payload: `kj-control/v1`, a newline, then a JSON array of thirteen strings: version, key id, method, service,
handler, workflow key (task id), tenant id, principal id, scope digest, decision, sha256 of the body, issued-at (unix
seconds), nonce. Signature: HMAC-SHA256 over those bytes. Headers: `X-KJ-Control-Version`, `-Key-Id`, `-Timestamp`,
`-Nonce`, `-Body-SHA256`, `-Signature`. The worker recomputes the payload from what it received and its own configured
tenant and principal, so an assertion verifies only for the exact request. A golden-vector test pins the format against an
independently computed HMAC; changing it invalidates every assertion.

Replay model, on the database clock, in `kernel_private.control_assertions` (nonce, key id, request digest, issued-at,
first-seen-at, route parts; nothing secret): first sight within the window is recorded and accepted; the same nonce with
the identical digest is accepted idempotently (Restate redelivers durable work); the same nonce with a different digest is
rejected; a never-seen assertion outside the window is rejected. The signature is verified before the store is touched.
Rows are purged after seven days.

Rotation, in order: (1) on the worker set the new key as current and the old as `_PREVIOUS`, recreate the worker; (2) set the
new key and id on the door, recreate the door; (3) once no old-key assertion can still be in flight (after the freshness
window), remove `_PREVIOUS` from the worker.

## Tests

KJ-P4B added 193 tests: `telegram-approvals` 93 (cards, callback data, authorisation, handler, service, poll, Bot API client,
door call, authority scan), `approval-boundary` 51, `approval-test-cli` 11, `telegram-approvals-store.integration` 28 (real
Postgres: store SQL, constraints, the ledger refusing wrong digest, wrong task, wrong approver, expiry on the ledger's own
clock), `telegram-approvals.integration` 10 (real Restate, real golden workflow, real door route).

KJ-P4B.1 added 81 more (all passing, OBSERVED): `control-signing` 47 (golden vector against an independently computed HMAC,
every binding, replay model, rotation, key never in headers), `control-signing-store.integration` 14 (real Postgres: nonce table
SQL, concurrency, database-clock freshness, purge, constraints), `approval-boundary` now 59 (+8: signing-key configuration and
the authenticator), and `telegram-approvals.integration` now 22 (+12, real Restate). The real-Restate tests now run the whole
Telegram approval path through the PRODUCTION door with real signing, and add: a signed approve resumes the workflow; an
identical redelivery is accepted idempotently; no assertion, a bearer, or a key-shaped bearer is refused; tampering with the
decision, digest, task, handler, tenant, principal or key is refused; stale and future-dated first-use assertions are refused;
the same nonce with a changed payload is refused; a replay store that cannot answer is retried until it completes rather than
refused; a task admitted through the owner's door runs on a signed dispatch; the door's hop, recorded by a Restate-equivalent
boundary, carries six assertion headers and no `Authorization` and no key; and Restate's own journal, its logs and the
worker's logs contain no signing key in clear, hex or base64.

Whole repository (OBSERVED, after KJ-P4B.1): typecheck, lint, topology check and build clean; full suite 1381 passed and 62
intentional skips; baseline gate 224/224 retained with recovery 31 (minimum 27).

Mutation checks for KJ-P4B.1 (OBSERVED): 17 deliberate breakages each failed the suite (signature comparison removed, body hash
not compared, tenant, principal, task, handler or nonce dropped from the canonical payload, scope digest and decision not read,
identical replay refused, changed digest on a seen nonce accepted, database freshness not applied, stale never-seen accepted,
the key added to the headers, the store written before the signature is checked, key id ignored, a database fault reported as
a refusal, the purge deleting recent rows), plus two on the real stack (an outage turned into a permanent 401; the door
sending an `Authorization` header). One further mutation, a silently widened freshness default, failed only at load time.

Mutation checks for KJ-P4B (OBSERVED): 15 deliberate breakages of the guards each failed the suite (message binding, sender check,
decision ignored, approver filter, redelivery guard, expiry courtesy, settled short-circuit, parse mode, callbacks without
approvals, authenticator accepting anything, waiting-only filter, unknown handle, a made-up digest, callback data used as
the digest, and the door forwarding the admission bearer to the workflow).

## What remains before the first live approval

Nothing below has been done. Each step needs Jonny's explicit authorisation as a change window.

1. Review and merge this PR.
2. Read-only precheck on the VM: the door principal's membership role in the door tenant allows `submit` and `approve`
   (owner, operator, reviewer do) and its kind is HUMAN; one poll chain, no in-flight tasks; outbox gate clean.
3. Apply `20260920150000_telegram_approvals.sql` (additive, three new tables). **Already applied to production on
   2026-09-20**; do not repeat.
4. Apply `20260920180000_control_assertions.sql` (KJ-P4B.1: one new table, `kernel_private.control_assertions`, an index, RLS on,
   no public grants) with the same before-and-after fingerprint check as the earlier migration.
5. Provision `KJ_CONTROL_SIGNING_KEY`: generate 32 random bytes as 43 URL-safe characters, store with `secretctl put` stating the
   length, materialise to a mode-600 file, and set it in BOTH the worker and door env files with the env-merge tool
   (`--set-from`). Never on argv, never printed.
6. With the env-merge tool set the public keys: on the worker `KJ_APPROVAL_ENABLED=true`, the two identity ids (copied from the
   door's own env), `KJ_CONTROL_KEY_ID=v1` (worker and door) and `KJ_APPROVAL_TTL_SECONDS=120` for a quick expiry test.
7. Build and deploy worker and door together, activate the next release epoch, and confirm Restate lists
   `GoldenTaskWorkflowV1` (the deployment must be re-registered so the new service is discovered; INFERRED from how
   `TelegramOperator` was added in KJ-P4A, verify rather than assume).
8. Verify from a fresh session: the worker's approval keys and the door's signing key by fingerprint only, exactly one
   `TelegramOperator` chain still running, no webhook set, and that a card and a button press work end to end.
9. Re-run the header check against production: for a fresh approve invocation, list the header NAMES in Restate's journal and
   confirm there is no `authorization` and exactly the six `x-kj-control-*` names. Never print a value.

Effect to know about: once enabled, every `uppercase/v1` submission through the door needs this approval. Before, such a
submission had no registered workflow to run.

## Live test plan (harmless, one at a time)

Submit each with `approval-test admit --label <id>` from the worker container, using the bearer from its own environment
via a mode-600 file, as the mission tool does.

| Case | Action | Expected |
|---|---|---|
| approve | press APPROVE on the card | task COMPLETED, outcome is the objective uppercased, one human-decision evidence row, card reads "Approved" |
| reject | press REJECT on a second task | task FAILED, approval DENIED, no capability run, card reads "Rejected" |
| duplicate approve | press APPROVE again, then REJECT, on the first task | pop-ups say "Already approved" and change nothing; no new evidence or control rows |
| expired | leave a third task unanswered for the deadline, then press | task FAILED, approval EXPIRED, card reads "Expired"; the late press says "Already expired" |
| wrong digest | call the door's approve route directly from the worker container with a wrong digest | 403 and the approval is unchanged (Telegram cannot produce this case by design) |
| stale after cancel | cancel a fourth task through the door, then press | "Already rejected"; the task stays CANCELLED |
| wrong user or chat | not live-testable without a second Telegram account in the chat; covered by tests | see above |

## Rollback

Set `KJ_APPROVAL_ENABLED=false` with the env-merge tool and recreate the worker: the workflow is no longer registered, cards
stop, and the poller asks for messages only again. The migration is additive and can stay. Any approval still pending simply
expires. The signing key can stay or be removed from both env files, and the nonce table is additive and can stay.

## Limits and risks

- **One human is both requester and approver** in this deployment (the door's single principal). The approval is a real,
  explicit, time-bound, digest-bound human act, but not a two-person control.
- **Card latency** is up to about twenty-one seconds (INFERRED from the 20 s long poll and 1 s pause), because cards are
  shown from the adapter's loop rather than pushed by the workflow. That keeps the workflow and the alerting outbox unmodified.
- **A crash between sending a card and recording it** can produce a second card after two minutes. Both carry the same
  handles, so pressing either is idempotent; the first card's buttons are refused (its message id was never recorded).
- **Real Telegram is not exercised.** The Bot API client is tested against a fake `fetch`; that Telegram accepts an edit to an
  empty inline keyboard is per its documentation (INFERRED). The first live card is the first real test of `sendMessage` with
  a keyboard, `editMessageText` and `answerCallbackQuery`.
- **A mid-mission pause** inside `KernelWorkflowV1` at a mutation boundary is not built. It is a different mechanism from this
  pre-execution gate and needs its own ADR first.
- **Restate journals the assertions for 24 hours.** That is by design non-secret and request-bound (see above); the long-lived
  key is never on the wire. Someone who can read the journal and reach the ingress could resend an identical request, which
  is accepted as an idempotent no-op and can do nothing more.
- **A `run` assertion is judged fresh when the worker first sees it.** If the worker is down for longer than the freshness
  window (default 300 s) between the door sending a submission and the worker running it, the submission is refused as stale
  and that task is stranded. Only the harmless synthetic recipe is affected; `KJ_CONTROL_FRESHNESS_SECONDS` can be raised.
  An outage of the database is different: it is retried, never turned into a refusal.
- **The door's clock must agree with the database's within the freshness window.** The door stamps each assertion with its own
  clock and the worker judges it against the database clock, so a skew larger than the window (default 300 s) would refuse every
  first-seen request. Both hosts run network time; a large skew shows up as every approval refused as stale.
- **A compromised door holds the key** and could sign any request. That is inherent in a shared-key design and is the same trust
  the door already has; the scheme's job is that nothing that crosses Restate, or that a journal reader can obtain, lets anyone
  else act.
- **Not checked:** production (nothing deployed), the production door principal's role, real Telegram behaviour, and Restate's
  discovery of the new service on the production deployment.
