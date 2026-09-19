# KJ-P2.2A - Telegram production activation runbook

Status: **prepared, not executed. Amended by KJ-P2.2B (five activation blockers closed).**
Executing this runbook needs its own explicit authorisation, and Step 9 needs a
further, separate authorisation. **No secret value appears anywhere in this document.**

Built on KJ-P2.2's code qualification (`docs/operations/TELEGRAM_TRANSPORT.md`) and
KJ-P2.1A's proven activation mechanism
(`docs/operations/PHASE_KJ_P2.1A_PRODUCTION_OUTBOX_ACTIVATION_RESULT_2026-09-17.md`).

## What KJ-P2.2B closed

An adversarial review of the first version of this runbook found five blockers. Each is now
closed by code or a tested tool, not by prose alone.

| # | Blocker | Closed by |
|---|---|---|
| 1 | Chat-ID discovery put the bot token in a shell command | `pnpm telegram:discover-chat --token-file <path>` (Step 4); `tests/telegram-discover.test.ts`; `tests/docs-token-safety.test.ts` fails the build if any doc carries a token-bearing HTTP example |
| 2 | The D1 deploy path can regenerate `runtime.env` as `DATABASE_URL` only, silently turning the alert runner off | D1 Stage 5 is forbidden here; `scripts/runtime_env_merge.py` is the only way `runtime.env` changes (Step 7); `tests/runtime-env-merge.test.ts` |
| 3 | `execution.compose.yaml` did not declare `ALERT_TRANSPORT`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, so Compose dropped them and the worker stayed on console with no error | The three variables are declared with empty defaults; `scripts/check-execution-topology.mjs` and `tests/kernel-worker-registration.test.ts` fail without them |
| 4 | POISON is not health-checked after cutover, so a bad token or chat could fail silently | `pnpm alerts:outbox-gate` is a hard gate at fixed points (Steps 6, 11, 12, 13); `tests/outbox-gate.test.ts` |
| 5 | Step 9 did not pin the test mechanism | `pnpm alerts:test-notification` (Step 9); `tests/test-notification.test.ts` and `tests/test-notification.integration.test.ts` |

## Scope discipline

This window authorises **only**: creating one Telegram bot, storing its token in jVault, obtaining
and verifying one destination chat ID, deploying the qualified worker and door release with
`ALERT_TRANSPORT=telegram`, calling `activate_release`, and observing exactly one explicitly
authorised test notification through the real outbox path. It does **not** authorise: any change to
alert severity policy, to the 300s runner cadence, or to `ALERT_RUNNER_ENABLED` / `ALERT_STATE_STORE`;
enabling email or WhatsApp; a manufactured P0/P1/P2; or any business task, admission or schedule change.

## Secret-handling rules (apply to every step, including rollback and debugging)

- **R1. The token and chat ID move only as files.** The path is the argument, never the value.
  The tools are `secretctl`, `pnpm telegram:discover-chat`, `scripts/runtime_env_merge.py` and the
  test-notification command. No shell HTTP client is ever given the credential, in any step, including
  rollback and debugging. There is no `bot<...>` URL anywhere in these docs, and a test enforces that.
- **R2. Read env files by key name only.** Never `cat` or `grep` a runtime env file except
  `grep -oE '^[A-Za-z_0-9]+='` (names). Never `printenv` without a key name. Presence checks discard
  the value: `printenv KEY >/dev/null && echo SET || echo UNSET`. Never `docker inspect` the Env block
  to the terminal (it may only be redirected straight into a mode-600 file, as D1 Stage 11 does). Never
  run `docker compose config` with the real env file, because it prints resolved values.
  Use allow-lists, never a deny-list: a second secret in the same file defeats an exclusion filter
  (the KJ-P2.1A leak).
- **R3. If a value reaches output, stop.** Say so plainly, name the key, treat it as burned (revoke the
  bot token in BotFather with `/revoke`, re-issue, re-store), then continue.
- **R4. `runtime.env` is never regenerated.** D1 Stage 5 (a `DATABASE_URL`-only file) is forbidden in
  this window. The file only ever changes through `runtime_env_merge.py`, which preserves every other line.
- **R5. Verify the running container, not the file.** For every component that reads a value, check
  `printenv` inside the running container.

## Mandatory: `activate_release` in the same window

This runbook changes the deployed release ID. Per `docs/operations/RELEASE_PROVENANCE.md`, any
runbook that changes the worker or door release must call `activate_release` in the same window (Step 8).
Skipping it produced two real P1 alerts in KJ-P2.1A. **With Telegram live, such a P1 would also page the
phone**, so Step 8 follows the deploy immediately. If a monitor tick lands between the deploy and
activation, at most the two known notifications (`authority.bindingReleaseConsistent`,
`releaseParity.recentBindingsConsistent`) may be sent and must recover on their own. Anything else is a STOP.

## Target identity (fixed, verify do not trust)

`kerneljson-prod-01`, `europe-west2-b`, project `project-c407f628-c71c-45fa-994`, account
`kerneljson@gmail.com`, `--tunnel-through-iap`, Supabase project `banqdzddfganzfhckdps`. This is **not**
the estate VM (`instance-20260717-082134`). Approved release: canonical `main` containing the KJ-P2.2B
merge commit, verified CI-green. Read the actual SHA at execution time.

Open a shell on the VM and keep it:
```
gcloud compute ssh kerneljson-prod-01 --zone=europe-west2-b \
  --project=project-c407f628-c71c-45fa-994 --account=kerneljson@gmail.com --tunnel-through-iap
```
Variables for the VM shell (`SHA` is the approved full SHA, read at execution time):
```
export SHA=<40-hex approved SHA>
export SHORT=${SHA:0:7}
export APP=/opt/kerneljson/app
export EXEC=infrastructure/docker/execution.compose.yaml
export GW=infrastructure/docker/gateway.compose.yaml
export WORKER_IMAGE=kerneljson-worker:$SHORT
export DOOR_IMAGE=kerneljson-admission-door:$SHORT
export RT=/opt/kerneljson/runtime
export STAGE=$RT/stage
export MERGE="python3 $APP/scripts/runtime_env_merge.py"
export W=$(sudo docker ps -q --filter name=worker | head -1)
export DOOR=$(sudo docker ps --format '{{.Names}}' | grep -iE 'door|gateway|admission' | head -1)
```
`W` and `DOOR` must be re-exported after Step 7g, because both containers are recreated.

## Step 1 - Identify the target and capture baselines (read-only)

1a. Source and parity. `python3 --version` must work on the VM (the merge tool is standard library only); if it does not, STOP. `git -C $APP rev-parse HEAD` (record as `PRIOR_SHA`), `git -C $APP status --porcelain`
(must be empty), container list with `state` / `health` / `RestartCount` for worker, door, Restate, door
probes `healthz=200`, `noauth=401`, `badbearer=401` using a clearly fake bearer only, and worker and door
`KERNELJSON_RELEASE_ID` equal to each other. If a redeploy is not actually needed (already at `SHA`), STOP.

1b. Env inventory, names only. For every env file under `$RT` (worker `runtime.env`, door
`dispatch.env` and `baseline.env`):
```
sudo find $RT -type f -printf '%m %u:%g %p\n'
sudo grep -oE '^[A-Za-z_0-9]+=' $RT/worker/runtime.env | tr -d '=' | tr '\n' ' '
```
From the running worker, read only these allow-listed non-secret keys:
```
for k in KERNELJSON_RELEASE_ID EXPECTED_RELEASE_ID ALERT_RUNNER_ENABLED ALERT_RUNNER_CADENCE_MS ALERT_STATE_STORE ALERT_TRANSPORT SCHED_ARM_NEXT; do
  echo "$k=$(sudo docker exec "$W" printenv "$k" 2>/dev/null)"; done
```
CHECK: `ALERT_RUNNER_ENABLED=true`, `ALERT_RUNNER_CADENCE_MS=300000`, `ALERT_STATE_STORE=postgres`,
`ALERT_TRANSPORT` empty (console). RECORD which of these keys are present **by name in `runtime.env`**.
**STOP** if the running worker has an `ALERT_*` value that `runtime.env` does not contain: it is coming
from a shell export, the merge cannot preserve it, and the next recreate would silently drop it.
Resolve that first. Record the list as `REQUIRE` (comma separated), always including `DATABASE_URL`.

1c. Fingerprints (lengths and sha8 only): `$MERGE fingerprint $RT/worker/runtime.env` and the same for
the door `dispatch.env`. Keep the output; Step 7 compares against it.

1d. Business and monitor baselines, read-only, as in KJ-P2.1A: `task_admissions_total`,
`schedule_fires_total`, `execution_bindings_total`, canonical schedule state, `release_epoch.epoch` and
`release_id`, Restate `/services` includes `ProductionAlertMonitor`, and the monitor status
(`enabled`, `cadenceMs`, `nextSequence`) via
`curl -s -X POST http://127.0.0.1:8080/ProductionAlertMonitor/production/status` (the call KJ-P2.1A Step 3 used; confirm it
there before relying on it). RECORD `nextSequence`.

## Step 2 - Create the Telegram bot (operator, outside any agent session)

Jonny, via `@BotFather`: `/newbot`, choose a name and username, then add the bot to the destination chat
(private chat, group or channel; note which). Save the token by pasting it into a **new file in an editor**
(not a shell) at `C:\tmp\tg.tok`. Never paste it into a chat session or a command.

## Step 3 - Store the bot token in jVault

```
python AgentHub\scripts\secretctl.py put kerneljson/TELEGRAM_BOT_TOKEN --in C:\tmp\tg.tok --expect-len <N>
python AgentHub\scripts\secretctl.py shred C:\tmp\tg.tok
```
A bot token is `<8 to 10 digit bot id>:<35 characters>`, so `<N>` is 44 to 46. Confirm `<N>` against the
file you saved (`secretctl` refuses to run without an expectation and reads the value back to compare).

## Step 4 - Obtain and verify the destination chat ID (token-safe, read-only)

1. From your own Telegram account, send any message to the bot (or in the group or channel).
2. Materialise the token to a file, run the helper, which deletes the file when finished:
```
python AgentHub\scripts\secretctl.py get kerneljson/TELEGRAM_BOT_TOKEN --out C:\tmp\tg.tok --expect-len <N>
pnpm telegram:discover-chat --token-file C:\tmp\tg.tok
python AgentHub\scripts\secretctl.py shred C:\tmp\tg.tok
```
The helper reads only the file at that path, builds the API URL in-process, never prints or logs it, and
prints only `chat id`, `type` and a display `label`. It sends nothing to any chat. Its errors are fixed
sentences that never contain the token. It refuses a token passed as an argument. Run the final `shred`
only if the file still exists.
3. CHECK the printed `label` and `type` are the intended destination. Never trust the number alone.
4. Save the chat ID into a new file in an editor at `C:\tmp\tg.chat`, then:
```
python AgentHub\scripts\secretctl.py put kerneljson/TELEGRAM_CHAT_ID --in C:\tmp\tg.chat --expect-len <length of the id>
python AgentHub\scripts\secretctl.py shred C:\tmp\tg.chat
```
The chat ID is a destination, not a credential, but it lives beside the token under one audit trail.

## Step 5 - Verify current alert-runner health (read-only)

`kerneljson alerts` exits 0 in read-only form, zero P0/P1/P2 beyond the known
`legacyAuthority.b1FreezeObservable` P3, Restate healthy, monitor `enabled:true, cadenceMs:300000`.
Do not proceed with any open P0/P1/P2: a live page during the window would be indistinguishable
from a test artefact.

## Step 6 - Source, image build and the pre-window POISON baseline

Confirm no in-flight work: no unexpected running invocation, and `task_admissions_total`,
`schedule_fires_total`, `execution_bindings_total` match Step 1d. No migration is part of this phase.

Update the source to the exact approved SHA and build both images. Building changes nothing that is running.
```
git -C $APP status --porcelain                      # must be empty, else STOP
sudo git -C $APP fetch origin --tags --prune
git -C $APP cat-file -e "$SHA^{commit}" && echo TARGET_PRESENT
git -C $APP merge-base --is-ancestor <PRIOR_SHA> "$SHA" && echo PRIOR_IS_ANCESTOR
sudo git -C $APP checkout --detach "$SHA"
git -C $APP rev-parse HEAD                          # must equal $SHA
sudo docker build -f infrastructure/docker/worker.Dockerfile  -t "$WORKER_IMAGE" $APP
sudo docker build -f infrastructure/docker/gateway.Dockerfile -t "$DOOR_IMAGE"   $APP
sudo docker image inspect "$WORKER_IMAGE" --format '{{json .Config.Cmd}}'   # node --import tsx services/kernel/src/index.ts
```
Then the **pre-window POISON baseline**, from a throwaway container of the new image (reads only):
```
sudo docker run --rm --env-file $RT/worker/runtime.env "$WORKER_IMAGE" \
  node --import tsx services/kernel/src/alerting/outbox-gate-cli.ts --baseline-poison 0
```
CHECK: `OUTBOX GATE: PASS`. RECORD `PENDING/SENDING/DELIVERED/POISON` counts as the baseline. KJ-P2.1A left
`DELIVERED=4, POISON=0`. If POISON is above 0, STOP: the gate must start clean, and any existing POISON
row needs its own explanation before this window. Exit code 4 means the gate could not run
(for example the env file parses differently under `docker run` than under Compose): STOP and investigate.

## Step 7 - Deploy the worker and door at the same release, preserving the runner env

**Do not run D1 Stage 5. Do not replace `runtime.env` with any newly generated file.**

7a. Stage the secrets in a private directory (the directory is mode 700, so file modes inside cannot leak):
```
sudo install -d -m 700 -o "$USER" $STAGE
```
From the workstation, materialise and copy up, then remove the local copies:
```
python AgentHub\scripts\secretctl.py get kerneljson/TELEGRAM_BOT_TOKEN --out C:\tmp\tg.tok --expect-len <N>
python AgentHub\scripts\secretctl.py get kerneljson/TELEGRAM_CHAT_ID  --out C:\tmp\tg.chat --expect-len <length>
gcloud compute scp C:/tmp/tg.tok C:/tmp/tg.chat kerneljson-prod-01:/opt/kerneljson/runtime/stage/ --zone=europe-west2-b --project=project-c407f628-c71c-45fa-994 --account=kerneljson@gmail.com --tunnel-through-iap --quiet
python AgentHub\scripts\secretctl.py shred C:\tmp\tg.tok C:\tmp\tg.chat
```

7b. Snapshot the baseline (this is also the rollback file):
```
sudo cp -p $RT/worker/runtime.env $STAGE/runtime.env.baseline
sudo cp -p $RT/door/dispatch.env  $STAGE/dispatch.env.baseline
```

7c. Merge (worker). Only the four keys below can change; every other line is copied through byte for byte,
the merge refuses to run if a `REQUIRE` key is missing, and it never overwrites an existing output file:
```
$MERGE merge --base $STAGE/runtime.env.baseline --out $STAGE/runtime.env.new \
  --require-keys "$REQUIRE" \
  --set-public ALERT_TRANSPORT=telegram --set-public KERNELJSON_RELEASE_ID=$SHA \
  --set-from TELEGRAM_BOT_TOKEN=$STAGE/tg.tok --set-from TELEGRAM_CHAT_ID=$STAGE/tg.chat
```
If `EXPECTED_RELEASE_ID` is a key in `runtime.env` (Step 1b), also pass `--set-public EXPECTED_RELEASE_ID=$SHA`
so it cannot pin the old release.

7d. Verify independently, from the two files (not from the merge's own claim):
```
$MERGE verify --base $STAGE/runtime.env.baseline --new $STAGE/runtime.env.new \
  --changed ALERT_TRANSPORT,TELEGRAM_BOT_TOKEN,TELEGRAM_CHAT_ID,KERNELJSON_RELEASE_ID
```
CHECK: `VERIFY OK`. Any `MISSING` or `CHANGED` line for a runner, scheduler, admission or `DATABASE_URL`
key is a **STOP**. Output shows names, lengths and sha8 only.

7e. Install, preserving owner and mode 600:
```
sudo install -m 600 -o "$(sudo stat -c %U $RT/worker/runtime.env)" -g "$(sudo stat -c %G $RT/worker/runtime.env)" \
  $STAGE/runtime.env.new $RT/worker/runtime.env
sudo stat -c '%a %U:%G %n' $RT/worker/runtime.env      # 600
```

7f. Door: the same procedure, moving only the release id (the door does not need Telegram):
```
$MERGE merge --base $STAGE/dispatch.env.baseline --out $STAGE/dispatch.env.new \
  --require-keys DATABASE_URL,KJ_ADMISSION_BEARER,KJ_ADMISSION_TENANT_ID,KJ_ADMISSION_PRINCIPAL_ID,KJ_RESTATE_INGRESS_URL,PORT \
  --set-public KERNELJSON_RELEASE_ID=$SHA
$MERGE verify --base $STAGE/dispatch.env.baseline --new $STAGE/dispatch.env.new --changed KERNELJSON_RELEASE_ID
sudo install -m 600 -o "$(sudo stat -c %U $RT/door/dispatch.env)" -g "$(sudo stat -c %G $RT/door/dispatch.env)" \
  $STAGE/dispatch.env.new $RT/door/dispatch.env
```
Leave the door's `baseline.env` (its rollback file) untouched.

7g. Recreate. Export the same release id as the files hold; the door needs its image tag set explicitly
(KJ-P2.1A recreated it once without `KJ_GATEWAY_IMAGE` and got a mis-tagged image):
```
export KERNELJSON_RELEASE_ID=$SHA KJ_WORKER_IMAGE=$WORKER_IMAGE KJ_GATEWAY_IMAGE=$DOOR_IMAGE
sudo -E docker compose --env-file $RT/worker/runtime.env -f "$EXEC" up -d worker      # worker only; Restate untouched
sudo -E docker compose --env-file $RT/door/dispatch.env   -f "$GW"   up -d --force-recreate
```

7h. Verify the **running** containers (R5). All of these are required:
```
for c in "$W" "$DOOR"; do echo "$c release=$(sudo docker exec "$c" printenv KERNELJSON_RELEASE_ID)"; done   # both == $SHA
for k in ALERT_RUNNER_ENABLED ALERT_RUNNER_CADENCE_MS ALERT_STATE_STORE ALERT_TRANSPORT SCHED_ARM_NEXT; do
  echo "$k=$(sudo docker exec "$W" printenv "$k" 2>/dev/null)"; done
for k in TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID DATABASE_URL KJ_ADMISSION_BEARER; do
  sudo docker exec "$W" printenv "$k" >/dev/null 2>&1 && echo "$k=SET" || echo "$k=UNSET"; done
sudo docker inspect -f '{{.Config.Image}}' "$DOOR"      # must be $DOOR_IMAGE, not :dev
```
CHECK, exactly: `ALERT_RUNNER_ENABLED=true`, `ALERT_RUNNER_CADENCE_MS=300000`, `ALERT_STATE_STORE=postgres`,
`ALERT_TRANSPORT=telegram`, `SCHED_ARM_NEXT` as in Step 1b, `TELEGRAM_BOT_TOKEN=SET`, `TELEGRAM_CHAT_ID=SET`,
worker and door release both `$SHA`, both `healthy` with `restarts=0`, door `127.0.0.1:8081` only,
`healthz=200`, `noauth=401`, `badbearer=401`. A worker that exits at startup with a transport-config error
means `telegram` was selected without both values: STOP and roll back.

7i. Registration and chain continuity:
```
curl -fsS -X POST http://127.0.0.1:9070/deployments -H 'content-type: application/json' -d '{"uri":"http://worker:9080","force":true}'
curl -fsS http://127.0.0.1:9070/services | grep -o '"name":"[A-Za-z0-9_]*"' | sort -u
curl -s -X POST http://127.0.0.1:8080/ProductionAlertMonitor/production/status
```
CHECK: `ProductionAlertMonitor` still registered alongside the other four services, `enabled:true`,
`cadenceMs:300000`, and `nextSequence` is **greater than or equal to** the Step 1d value (it must not reset to 0).

7j. Remove the staged secrets now. Keep only the two `.baseline` files, mode 600, until Step 13:
```
sudo shred -u $STAGE/tg.tok $STAGE/tg.chat $STAGE/runtime.env.new $STAGE/dispatch.env.new
```

## Step 8 - Release-provenance activation (mandatory, immediately after Step 7)

Call `kernel_private.activate_release` in a dedicated transaction, exactly per
`docs/operations/RELEASE_PROVENANCE.md` and KJ-P2.1A's proven execution: fresh request UUID, the deployed
release ID, and the **current** epoch read live (not assumed; it was 2 at KJ-P2.1A close). Independently
re-verify from a fresh connection: `release_epoch.epoch` advanced by exactly 1, exactly one new
`release_activations` row, and `release_id`, `previous_release_id`, `request_id` all as requested.

Then run the gate once (inside the running worker, which now holds the Telegram config):
```
sudo docker exec "$W" node --import tsx services/kernel/src/alerting/outbox-gate-cli.ts --baseline-poison <baseline POISON>
```
Wait for one natural tick after activation. CHECK: `OUTBOX GATE: PASS`, and any P1 notification sent
during the gap has recovered.

## Step 9 - One explicitly authorised test notification (separate authorisation required)

Only after Jonny explicitly authorises this step, separately from the window.

Preconditions: Step 8 complete, at least one clean natural tick since, gate `PASS` with no `PENDING` or
`SENDING` rows, no open P0/P1/P2.

The canonical path is `services/kernel/src/alerting/test-notification-cli.ts`. It builds one P3 `NEW`
decision (check ID `TEST.telegramActivationVerification`, message beginning `TEST notification`), turns it into an
intent with `intentsFromDecisions`, and enqueues it through the existing outbox store. It does **not**
INSERT rows itself, call Telegram, or run the CLI's `--json` mode. It has no handle to the alert-state store,
ledger, admissions or scheduler, so it cannot touch them. It never delivers: the running monitor's next
tick does, so the proof is the production path. It refuses to run without an exact confirmation flag and a
label, and refuses unless the container is already configured for `ALERT_TRANSPORT=telegram`.
```
sudo docker exec "$W" node --import tsx services/kernel/src/alerting/test-notification-cli.ts \
  --label kj-p22a-<YYYYMMDD> --confirm-queue-one-test-notification
```
Nothing secret is in that command: the process inherits the container's own environment. The label is
a short identifier (`[A-Za-z0-9._-]`, at most 40). Re-running it with the same label queues nothing further.

## Step 10 - Verify Telegram receipt

Jonny confirms in the Telegram client that the message arrived in the intended chat within one tick
(about five minutes). It reads as a P3 `NEW`, check `TEST.telegramActivationVerification`, message
`TEST.telegramActivationVerification: NEW (P3)`, `Occurrences: 1`, and an 8-character `ID`, with MarkdownV2
escaping intact. If nothing arrives, do **not** re-send. Go to STOP conditions.

## Step 11 - Verify delivery ACK and the POISON gate

Read-only. The outbox row for that notification is `DELIVERED` with exactly one
`notification_delivery_events` row (`outcome='DELIVERED'`, `transport='telegram'`). Then the hard gate:
```
sudo docker exec "$W" node --import tsx services/kernel/src/alerting/outbox-gate-cli.ts --baseline-poison <baseline POISON>
```
**Gate: `OUTBOX GATE: PASS`, POISON equal to the pre-window baseline (0), no `PENDING` or `SENDING` row.**

## Step 12 - Verify no duplicate, and POISON after natural ticks

Do not trigger a second attempt. Let at least **two further natural ticks** pass and, after each, re-run the
gate. CHECK: the test row's `attempt_count` is unchanged at 1, no second `DELIVERED` event exists (the gate
also fails on any notification with more than one), and the gate still passes.
**Any new POISON at any point in the window is a STOP: roll the transport back to console** (Rollback below).

## Step 13 - Verify isolation, continuity, and clean up

Business counters equal Step 1d (the test row is the only new write, and it is in the outbox tables);
canonical schedule state unchanged; `task_admissions`, `schedule_fires`, `execution_bindings` unchanged.
Restate `sys_invocation` shows exactly one `ProductionAlertMonitor/production` non-completed invocation
(one continuation chain) and the unrelated `ScheduleDriver` one; `nextSequence` advanced monotonically;
worker, door and Restate healthy with `restarts=0`. Then `sudo shred -u $STAGE/*.baseline`.

## Rollback and STOP conditions

STOP immediately if: a Step 1/5/6 check is ambiguous; `REQUIRE` cannot be established; the merge or its
verify refuses; the pre-window gate fails or cannot run; Step 7h shows any expectation unmet; Step 8's
`activate_release` errors or is uncertain (never guess); the Step 9 message does not arrive; the gate fails
at any point; or any duplicate is found.

**Transport rollback** (config only, same release, no image change). Merge `ALERT_TRANSPORT=console` into
the current file, verify only that key changed, install, recreate the worker, re-run the 7h checks with
`ALERT_TRANSPORT=console`:
```
$MERGE merge --base $RT/worker/runtime.env --out $STAGE/runtime.env.rollback --require-keys "$REQUIRE" --set-public ALERT_TRANSPORT=console
$MERGE verify --base $RT/worker/runtime.env --new $STAGE/runtime.env.rollback --changed ALERT_TRANSPORT
```
**Full rollback** (release too): restore `$STAGE/runtime.env.baseline` and `$STAGE/dispatch.env.baseline`,
`git -C $APP checkout --detach <PRIOR_SHA>`, recreate worker and door at the prior images, and re-run the
release-parity checks. The database epoch is not rolled back; call `activate_release` for the prior release
if the database and the running release disagree.

**Debugging a failed delivery without exposing the token.** The failure class is already in the gate output
(for example `TelegramUnauthorizedError` is a bad token, `TelegramBadRequestError` an unknown chat). To
re-check the token and the visible chats, use Step 4's helper from the workstation. Do not use a shell
HTTP client with the credential, and do not resend blindly. A bad token or chat POISONs one row and does not
crash the monitor, which is exactly why the gate exists.

## Final go/no-go checklist

- [ ] Bot created, token in jVault only, length-verified; token file shredded.
- [ ] Chat ID found with `telegram:discover-chat`, label confirmed as the intended destination, stored in jVault.
- [ ] Pre-window gate `PASS`; baseline `PENDING/SENDING/DELIVERED/POISON` recorded.
- [ ] `runtime.env` changed only by `runtime_env_merge.py`; `VERIFY OK` shows only the four intended keys differ.
- [ ] From the RUNNING worker: `ALERT_RUNNER_ENABLED=true`, `ALERT_RUNNER_CADENCE_MS=300000`,
      `ALERT_STATE_STORE=postgres`, `ALERT_TRANSPORT=telegram`, Telegram token and chat `SET` (never printed).
- [ ] Worker and door at the same `$SHA` by `printenv`; door image tag is `$DOOR_IMAGE`.
- [ ] `ProductionAlertMonitor` registered, `nextSequence` not reset, exactly one continuation chain.
- [ ] `activate_release` called and re-verified from a fresh connection.
- [ ] Exactly one authorised test notification: received in Telegram, `DELIVERED`, one delivery event.
- [ ] **POISON gate `PASS` (POISON equals baseline) after deploy, after the test delivery, and after two further natural ticks.**
- [ ] Business counters unchanged; staged secrets and baselines shredded; all containers healthy, `restarts=0`.
