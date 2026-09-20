# KJ-P4B - Telegram approvals

**Status: code complete, PR open, not deployed. Nothing runs in production until a release is built, the migration is
applied, a control credential is provisioned and the approval boundary is switched on in a change window.**
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
              -> forwards to the workflow with the internal control credential
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
| `KJ_CONTROL_TOKEN` | worker and door | secret, at least 32 characters, distinct from the admission bearer; the door presents it to the workflow, the worker checks it in constant time |
| `KJ_APPROVAL_TTL_SECONDS` | worker | optional, 30 to 86400, default 600 |

Cards and buttons additionally require `TELEGRAM_INBOUND_ENABLED=true` (KJ-P4A). All five are declared in the compose
passthrough, the topology checker and the env-merge allow-list and guarded by inventory tests with negative cases.

## Tests

193 new tests, all passing (OBSERVED): `telegram-approvals` 93 (cards, callback data, authorisation, handler, service, poll,
Bot API client, door call, authority scan), `approval-boundary` 51 (config, rule, authenticator, registration, door config,
declarations, env-merge), `approval-test-cli` 11, `telegram-approvals-store.integration` 28 (real Postgres: store SQL,
constraints, the ledger refusing wrong digest, wrong task, wrong approver, expiry on the ledger's own clock),
`telegram-approvals.integration` 10 (real Restate, real golden workflow, real door route).

Whole repository (OBSERVED): typecheck, lint, topology check and build clean; full suite 1298 passed and 62 intentional
skips; baseline gate 224/224 retained with recovery 31 (minimum 27).

Mutation checks (OBSERVED): 15 deliberate breakages of the guards each failed the suite (message binding, sender check,
decision ignored, approver filter, redelivery guard, expiry courtesy, settled short-circuit, parse mode, callbacks without
approvals, authenticator accepting anything, waiting-only filter, unknown handle, a made-up digest, callback data used as
the digest, and the door forwarding the admission bearer to the workflow).

## What remains before the first live approval

Nothing below has been done. Each step needs Jonny's explicit authorisation as a change window.

1. Review and merge this PR.
2. Read-only precheck on the VM: the door principal's membership role in the door tenant allows `submit` and `approve`
   (owner, operator, reviewer do) and its kind is HUMAN; one poll chain, no in-flight tasks; outbox gate clean.
3. Apply `20260920150000_telegram_approvals.sql` (additive, three new tables, no change to existing ones) with a snapshot first.
4. Provision `KJ_CONTROL_TOKEN`: generate at least 43 URL-safe characters, store with `secretctl put` stating the length,
   materialise to a mode-600 file, and set it in BOTH the worker and door env files with the env-merge tool (`--set-from`).
5. With the env-merge tool set the public keys on the worker: `KJ_APPROVAL_ENABLED=true`, the two identity ids (copied from
   the door's own env), and `KJ_APPROVAL_TTL_SECONDS=120` for a quick expiry test.
6. Build and deploy worker and door together, activate the next release epoch, and confirm Restate lists
   `GoldenTaskWorkflowV1` (the deployment must be re-registered so the new service is discovered; INFERRED from how
   `TelegramOperator` was added in KJ-P4A, verify rather than assume).
7. Verify from a fresh session: the five worker keys and the door token by fingerprint only, exactly one `TelegramOperator`
   chain still running, no webhook set, and that a card and a button press work end to end.

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
expires. The control token can stay or be removed from both env files.

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
- **The internal control token travels on every dispatch and control hop** to the workflow endpoint, including for workflows
  that ignore it. It stays on the private compose network and is distinct from the public bearer; whether Restate's own logs
  record request headers was not checked.
- **Not checked:** production (nothing deployed), the production door principal's role, real Telegram behaviour, and Restate's
  discovery of the new service on the production deployment.
