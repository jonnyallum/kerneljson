# KJ-P2.2A - Telegram production activation - RESULT

**Status: PASS**
**Window: 2026-09-19, 14:01Z to 14:30Z**
**Runbook: `docs/operations/PHASE_KJ_P2.2A_TELEGRAM_PRODUCTION_ACTIVATION_RUNBOOK_2026-09-18.md` (as amended by KJ-P2.2B)**
**Code qualification: `docs/operations/PHASE_KJ_P2.2B_TELEGRAM_ACTIVATION_BLOCKERS_CODE_QUALIFICATION_2026-09-19.md`**

Evidence tags: OBSERVED means read live in this window. REPORTED means relayed by Jonny.

## Summary

The KJ-P2.2 Telegram transport is live in production. Worker and door were redeployed together at canonical
release `b3a6cb7101254145e05bc79f2cd601a606d3f97b`, the runtime env was preserved by the qualified merge tool,
`activate_release` advanced the epoch from 2 to 3, and one explicitly authorised P3 test notification travelled
the real durable path (`intentsFromDecisions` to the outbox, to the monitor's delivery worker, to
`TelegramNotifier`, to ACK) and reached the phone. One natural P3 notification also went out over Telegram
during the window (see "The natural notification"). POISON stayed at 0 throughout. Business counters did not change.

## Target and release

| Item | Value |
|---|---|
| Host | `kerneljson-prod-01`, `europe-west2-b`, project `project-c407f628-c71c-45fa-994` |
| Deployed release (worker and door) | `b3a6cb7101254145e05bc79f2cd601a606d3f97b` |
| Previous release | `1fbe6b22ed35394fb3a52c3735b6b4430d8ac9fa` (VM checkout, images, epoch 2) |
| Qualification freeze | `main` at `684e7c1` (docs only after `b3a6cb7`) |
| Images | `kerneljson-worker:b3a6cb7`, `kerneljson-admission-door:b3a6cb7` |

Ancestry, `CLAUDE.md` digest (`27255772...a32f2b10`, unchanged and equal to its pin) and a clean checkout were
verified before the source moved. The only infrastructure change between the two releases was the compose
passthrough for `ALERT_TRANSPORT`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

## Step 1 - production pre-flight (OBSERVED, 14:01Z, no divergence)

| Check | Result |
|---|---|
| Release and parity | worker and door both `1fbe6b2`, `EXPECTED_RELEASE_ID` equal, tree clean |
| Health | worker, door, Restate healthy, `restarts=0`; door `healthz=200`, `noauth=401`, `badbearer=401`; ports loopback only |
| Epoch | `release_epoch.epoch = 2`; activation row epoch 2 is `1fbe6b2`, previous `49a93bb` |
| Monitor | enabled, `cadenceMs` 300000, `nextSequence` 641; exactly one `ProductionAlertMonitor/production` and one `ScheduleDriver` non-completed invocation |
| Alerts | zero open P0/P1/P2; one open P3 (the known `legacyAuthority.b1FreezeObservable`, notify off) |
| Outbox | 5 DELIVERED (console), no PENDING or SENDING, POISON 0, no duplicate DELIVERED events |
| Business counters | `task_admissions` 27, `schedule_fires` 8, `execution_bindings` 28 |
| Next business fire | `2026-09-20T08:00:00.009Z`, about 18 hours away |

The counters were two higher each than at KJ-P2.1A close, matching the two natural daily fires of 18 and 19 September.
The fifth outbox row was a natural P3 `RECOVERED` of 18 September, the healthy signal KJ-P2.1A predicted.

## Step 2 - bot and secrets

- Bot created by Jonny in BotFather. The token was saved to a local file, never pasted into chat, and stored with
  `secretctl put`: `kerneljson/TELEGRAM_BOT_TOKEN` (len 46, sha8 `29C06BB7`).
- The token file was confirmed a different token from the older September bot (boolean comparison only).
- Chat ID discovered with the KJ-P2.2B helper `pnpm telegram:discover-chat --token-file <path>`, which fetched
  the token from jVault, was accepted by Telegram, printed only chat id, type and label, and deleted its file.
  It found exactly one private chat. Jonny confirmed it is his own account. `kerneljson/TELEGRAM_CHAT_ID` stored
  (len 10, sha8 `3CF8351B`). The chat ID and label are deliberately not recorded here.
- No token value was printed or placed in argv at any point in this window. The chat ID, which is a destination
  and not a credential, appeared in tool output once (the helper's output) and once in a command that wrote its temp file.
- The source file, both temporary copies and the VM staging copies were shredded (staged files at about 14:26Z).

## Step 3 - deploy (OBSERVED)

Baselines of both env files were snapshotted first (also the rollback files). `runtime_env_merge.py` was run with
`--require-keys` for the runner, scheduler and admission keys. Result for the worker `runtime.env`:

| Key | Result | sha8 |
|---|---|---|
| `ALERT_RUNNER_ENABLED` | UNCHANGED | `B5BEA41B` |
| `ALERT_RUNNER_CADENCE_MS` | UNCHANGED | `6CE31896` |
| `ALERT_STATE_STORE` | UNCHANGED | `A942B37C` |
| `DATABASE_URL` | UNCHANGED | `DF9CD1AD` |
| `KJ_ADMISSION_BEARER` | UNCHANGED | `8ABA1F70` |
| `KJ_ADMISSION_URL` | UNCHANGED | `799999E8` |
| `SCHED_ARM_NEXT` | UNCHANGED | `B5BEA41B` |
| `KERNELJSON_RELEASE_ID` | CHANGED | `1FA05656` |
| `ALERT_TRANSPORT` | ADDED | `3F404629` |
| `TELEGRAM_BOT_TOKEN` | ADDED | `29C06BB7` (equals the jVault fingerprint) |
| `TELEGRAM_CHAT_ID` | ADDED | `3CF8351B` (equals the jVault fingerprint) |

The independent `verify` reported `VERIFY OK` for the worker (only those four keys differ) and for the door
`dispatch.env` (only `KERNELJSON_RELEASE_ID` differs). D1 Stage 5 was not used. Both files were installed `root:root 600`.

Worker and door were recreated together at 14:13Z. The running containers were then checked, not the files:

- worker and door `KERNELJSON_RELEASE_ID` both `b3a6cb7...`; `EXPECTED_RELEASE_ID` equal; door image tag `b3a6cb7` (not `:dev`)
- `ALERT_RUNNER_ENABLED=true`, `ALERT_RUNNER_CADENCE_MS=300000`, `ALERT_STATE_STORE=postgres`, `ALERT_TRANSPORT=telegram`, `SCHED_ARM_NEXT=true`
- `TELEGRAM_BOT_TOKEN` SET, `TELEGRAM_CHAT_ID` SET (presence only)
- worker, door, Restate healthy with `restarts=0`; door `127.0.0.1:8081` only, `healthz=200`, `noauth=401`, `badbearer=401`
- Restate registration `200`; `ProductionAlertMonitor` still registered; `nextSequence` 641 before, 643 after (not reset)

This is live proof that the compose passthrough fix works: before it, `ALERT_TRANSPORT` could not have reached the container.

## Step 4 - release provenance (OBSERVED)

`kernel_private.activate_release` was called in a dedicated transaction (`lock_timeout` 10s) at 14:13:37Z, only after
every pre-activation check had passed in the same script: request UUID `c59d5832-f69c-4520-9e1b-53d2fa969965`,
release `b3a6cb7...`, expected epoch 2 (read live), non-secret evidence JSON. It returned epoch 3. Verified from a
separate process and connection (backend pid 1533191):

| Field | Value |
|---|---|
| `release_epoch.epoch` | 3 |
| epoch-3 rows | exactly 1 |
| epoch-3 `release_id` | `b3a6cb7101254145e05bc79f2cd601a606d3f97b` |
| epoch-3 `previous_release_id` | `1fbe6b22ed35394fb3a52c3735b6b4430d8ac9fa` |
| epoch-3 `request_id` | `c59d5832-f69c-4520-9e1b-53d2fa969965` |
| epochs 1 and 2 | unchanged (`4ec8c043...` and `5c8dd08b...`) |

## The natural notification

The first monitor tick after activation (14:14:14Z) opened `authority.bindingReleaseConsistent` as **NEW, P3**
(no binding exists yet under epoch 3, so the check reports no observation). It was queued, delivered through
Telegram on attempt 1 (delivery event `telegram`, `DELIVERED`, 14:14:15Z) and ACKed. This is the same
release-transition signal KJ-P2.1A recorded and it needs no action. It also proved the delivery path before the test.

**Expect one further natural Telegram message**: the alert should recover to a `RECOVERED` P3 after the next binding,
which the `2026-09-20T08:00Z` scheduled fire will create. Zero P0/P1/P2 were open at any point in the window,
so the feared release-parity P1 blip did not occur.

## Step 5 and 6 - the one authorised test (OBSERVED unless tagged)

Queued at 14:15:32Z with `alerts:test-notification --label kj-p22a-20260919 --confirm-queue-one-test-notification`,
run inside the worker container so no secret was in the command.

| Check | Result |
|---|---|
| Outbox row | `27bd243e...`, `TEST.telegramActivationVerification`, kind `NEW`, severity `P3`, created `PENDING` |
| Delivery | `DELIVERED` at 14:19:15.618Z by the monitor's next natural tick |
| `attempt_count` | 1, `last_error` null |
| Delivery events for this notification | exactly 1 (`telegram`, `DELIVERED`, no error class) |
| Phone | both the natural P3 and the TEST message arrived and read correctly (REPORTED by Jonny) |
| Business-side effect | none: counters unchanged (below) |

No direct Bot API send, no raw SQL insert, no fake P0/P1/P2 and no business task, admission or scheduler mutation occurred.

## Two further natural ticks after delivery (OBSERVED)

Ticks 645 (about 14:24Z) and 646 (about 14:29Z) ran with no re-send:

| After | test row | events for test | Telegram deliveries | outbox | gate |
|---|---|---|---|---|---|
| tick 645 | DELIVERED, attempt 1 | 1 | 2 | 7 DELIVERED | PASS, POISON 0 |
| tick 646 | DELIVERED, attempt 1 | 1 | 2 | 7 DELIVERED | PASS, POISON 0 |

At close: `nextSequence` 647, cadence 300000, exactly one `ProductionAlertMonitor/production` and one `ScheduleDriver`
non-completed invocation, worker, door and Restate healthy with `restarts=0`, epoch 3, zero open P0/P1/P2.

## POISON gate record

`alerts:outbox-gate --baseline-poison 0` ran at: pre-window baseline (new image, throwaway container), post-activation,
before queuing the test, after delivery, and after each of the two further ticks. PASS every time; POISON 0; no
PENDING or SENDING left; no duplicate DELIVERED events.

## Business isolation (OBSERVED)

| Counter | Before | After (14:29Z) |
|---|---|---|
| `task_admissions` | 27 | 27 |
| `schedule_fires` | 8 | 8 |
| `execution_bindings` | 28 | 28 |

No admission, fire or binding was created in the window. The next business fire is `2026-09-20T08:00Z`.

## Deviations and notes

1. The first attempt to run a script over `gcloud compute ssh` with the script on stdin failed harmlessly (gcloud
   consumed part of stdin). Scripts were then passed as a base64 argument, which also wrote nothing to production.
2. The Step 1 read was denied once by the session's permission classifier before Jonny's explicit go-ahead, and
   succeeded after it.
3. The merge tool needs `sudo` on the VM because the env files are `root:root 600`; the runbook's plain `$MERGE` lines should read `sudo $MERGE`.
4. The staged token and chat files were mode 664 inside a mode 700 directory (the directory protected them). They
   were shredded about 10 minutes after use rather than immediately after install, as Step 7j intends.
5. The natural P3 notification reached the phone before the test, so the phone showed two messages, not one.
6. The Telegram token now exists in three places by design: jVault, the root-only `runtime.env`, and the running
   worker's environment (which is why the runbook forbids dumping the Env block).

## Residual risks

- A crash between a Telegram send and its ACK can send one duplicate message (at-least-once delivery); the gate
  cannot detect it because the outbox logs one DELIVERED event.
- POISON is a manual gate, not an automatic health check; KJ-P2.1 deliberately has none. A bad token later (for example
  after a BotFather `/revoke`) would POISON individual rows quietly.
- Tomorrow's first natural fire is the first binding under epoch 3, which should clear the open P3 and send one `RECOVERED` message.

## Cleanup

Rollback baselines, candidate env files, staged secrets and the staging directory were shredded or removed on the
VM at 14:30Z. No token file remains on the operator workstation. The env files on the VM are `root:root 600`.

## Result

**KJ-P2.2A TELEGRAM PRODUCTION ACTIVATION: PASS.**
