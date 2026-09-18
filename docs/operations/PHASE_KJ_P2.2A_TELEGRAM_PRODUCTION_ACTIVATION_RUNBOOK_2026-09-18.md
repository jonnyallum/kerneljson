# KJ-P2.2A — Telegram production activation runbook

Status: **prepared, not executed.** This is the concrete, executable runbook
for putting the KJ-P2.2 Telegram transport live in production, built on
KJ-P2.2's code qualification (`docs/operations/TELEGRAM_TRANSPORT.md`) and
KJ-P2.1A's already-proven activation mechanism
(`docs/operations/PHASE_KJ_P2.1A_PRODUCTION_OUTBOX_ACTIVATION_RESULT_2026-09-17.md`).
Executing this runbook requires its own separate authorisation. **No secret
value appears anywhere in this document.**

## Scope discipline

This window authorises **only**: creating one Telegram bot, storing its
token in jVault, obtaining and verifying one destination chat ID, deploying
the qualified worker release with `ALERT_TRANSPORT=telegram` configured, and
observing exactly one explicitly-authorised test notification through the
real outbox path. It does **not** authorise: any change to alert severity
policy, any change to the 300s runner cadence, enabling email/WhatsApp,
disabling console output as a concept (it remains the code default), or
manufacturing a fake P0/P1/P2 to "prove" delivery outside the one authorised
test notification below.

## Mandatory cross-reference (learned live during KJ-P2.1A — do not skip)

**This runbook changes the deployed worker's `KERNELJSON_RELEASE_ID`.**
Per `docs/operations/RELEASE_PROVENANCE.md`'s MANDATORY section (added
2026-09-17 after a live incident where this was omitted): any runbook that
changes the deployed worker/door release must include the
`activate_release` call in the SAME window, whether or not the release
change is itself "about" release provenance. Step 8 below includes it
explicitly. Skipping it produces real, immediate P1 alerts the moment the
worker starts reporting a release ID the database doesn't yet recognise —
exactly what happened during KJ-P2.1A, documented in
`docs/operations/PHASE_KJ_P2.1A_PRODUCTION_OUTBOX_ACTIVATION_RESULT_2026-09-17.md`.
Also per that same incident: after any change to `KERNELJSON_RELEASE_ID` in
an env file, **verify the actual running container's `printenv` output**,
not just the file content, for every component that reads it (worker AND
door) — the KJ-P2.1A window shipped a real, if brief, mismatch because the
door was not re-verified live.

## Target identity (fixed for this runbook — verify, do not trust)

Same target as every prior KernelJSON production runbook this repository
carries: `kerneljson-prod-01`, `europe-west2-b`,
`project-c407f628-c71c-45fa-994`, account `kerneljson@gmail.com`,
`--tunnel-through-iap`, Supabase project `banqdzddfganzfhckdps`. Approved
release: canonical `main` containing this PR's merge commit, verified
present and CI-green before this runbook runs — read the actual SHA at
execution time; do not assume it from this document, which will be stale
the moment a later commit lands.

## Step 1 — Identify canonical production target (read-only)

Same pattern as every prior runbook: confirm remote, `HEAD`, clean tree on
the VM; confirm current worker/door `KERNELJSON_RELEASE_ID` parity and
health; confirm whether a redeploy is actually needed (ancestor check
against the currently-running release).

## Step 2 — Create the Telegram bot (operator action, outside this session)

Performed by Jonny, via Telegram's own BotFather, not by any agent:
1. Message `@BotFather` on Telegram, `/newbot`, choose a name and username.
2. BotFather returns a bot token. **This value is never typed into a chat
   session, a command argument, or any file outside the immediate
   file-to-file jVault write below.**
3. Add the new bot to the intended destination chat (a private chat with
   Jonny, or a dedicated ops group/channel) and note whether it's a private
   chat, group, or channel — this affects how the chat ID is obtained in
   Step 4.

## Step 3 — Store the bot token in jVault

Using `AgentHub\scripts\secretctl.py` (the established, mandatory tool for
this — see the global CLAUDE.md's "Use secretctl" section), the SAME
file-to-file discipline used for the KJ-P2.1A bearer rotation:
```
python AgentHub\scripts\secretctl.py put kerneljson/TELEGRAM_BOT_TOKEN --in <mode-600 file> --expect-len <N>
```
`--expect-len` must be stated explicitly (secretctl refuses to run without
one) — Telegram bot tokens have a stable, checkable shape
(`<numeric bot id>:<35-char string>`); confirm the exact expected length
against the actual token BotFather issued before writing it, the same
length-check discipline that caught BOM corruption in every prior secret
incident this operator has documented.

## Step 4 — Obtain and verify the target chat ID

Read-only, via the Bot API's `getUpdates` (never `sendMessage` — this step
proves the chat exists and is reachable, it does not send anything):
1. Send any message to the bot/group/channel from Jonny's own Telegram
   account.
2. `curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates"` — **the token
   is read from the mode-600 jVault-derived file at call time, via
   secretctl's own env-injection, never typed or echoed** — inspect the
   JSON response's `message.chat.id` (a negative number for a group/channel,
   positive for a private chat).
3. Store this value as `kerneljson/TELEGRAM_CHAT_ID` in jVault too, via
   `secretctl.py put` — it is a destination identifier, not a credential,
   but keeping it in jVault alongside the token keeps both values under one
   authority and one audit trail.
4. CHECK: the chat ID resolves to the intended destination (confirm by the
   chat's `title`/`username`/`first_name` in the same response, never by
   trusting the number alone).

## Step 5 — Verify current alert-runner health (read-only, before any change)

Identical to KJ-P2.1A's Step 3: `kerneljson alerts` exit 0, zero P0/P1/P2
beyond the known `legacyAuthority.b1FreezeObservable` P3, Restate healthy,
monitor status `enabled:true, cadenceMs:300000`, next scheduled wake not
imminent (same ~2-hour conservative margin threshold).

## Step 6 — Confirm no risk to in-flight work

Same discipline as KJ-P2.1A's Step 4: this change touches no admission-path
table (no migration at all in this phase — KJ-P2.2 adds no schema). The only
risk is the worker restart itself; verify the next natural wake margin per
Step 5 before proceeding.

## Step 7 — Deploy the qualified release

Follow `docs/production/D1_EXECUTION_PATH_DEPLOYMENT_RUNBOOK.md`'s
established mechanism exactly as KJ-P2.1A did (checkout the approved SHA,
build `kerneljson-worker:<short-sha>`, deploy via
`execution.compose.yaml`), with these additions to `runtime.env` (mode 600,
values read from jVault via secretctl, never typed):
```
ALERT_TRANSPORT=telegram
TELEGRAM_BOT_TOKEN=<from jVault>
TELEGRAM_CHAT_ID=<from jVault>
```
**Do not change** `ALERT_RUNNER_ENABLED`, `ALERT_RUNNER_CADENCE_MS`, or
`ALERT_STATE_STORE` — carry over unchanged, exactly as KJ-P2.1A's runbook
required. After the worker restarts: verify (`printenv` inside the running
container, not the file) `ALERT_TRANSPORT=telegram` and that
`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are `SET` (never print their
values — presence/absence only, same pattern as every prior secret-presence
check in this programme). If the door's image/release also needs to move
(it will, for `KERNELJSON_RELEASE_ID` parity — see Step 8), redeploy it too
and verify parity by `printenv` on BOTH running containers before
proceeding, not by trusting either env file.

## Step 8 — Release-provenance activation (MANDATORY — see the cross-reference above)

Call `kernel_private.activate_release` in a dedicated transaction, exactly
per `docs/operations/RELEASE_PROVENANCE.md`'s canonical protocol and
KJ-P2.1A's proven live execution of it: fresh request UUID, the deployed
release ID, the CURRENT epoch read live (never assumed from this document),
non-secret evidence JSON. Independently re-verify from a FRESH database
connection: `release_epoch.epoch` advanced by exactly 1, exactly one new
`release_activations` row, `release_id`/`previous_release_id`/`request_id`
all matching what was requested.

## Step 9 — One explicitly-authorised test notification through the real outbox path

**Only after Jonny explicitly authorises this specific step, separately
from authorising the window overall.** Do not manufacture a fake P0/P1/P2 —
per KJ-P2.1A's own precedent, the cleanest, most honest proof is the SAME
mechanism used there: either wait for a genuine natural alert-worthy
condition (none is expected, since production is healthy), or — the
authorised alternative — construct a single deliberate, clearly-labelled
test row directly in the outbox at P3/lowest severity through the same code
path the engine would use (not a raw SQL insert bypassing `intentsFromDecisions`),
with a check id/message that unambiguously identifies it as a manual
verification (e.g. reusing the same technique KJ-P1.3D used for its
`claude_md_check` canary — a deliberately low-blast-radius, explicitly
labelled verification action, not a silent synthetic task). The exact
mechanism for this one test row is a decision for the authorising message,
not pre-committed here.

## Step 10 — Verify Telegram receipt

Confirm the message actually arrived at the destination chat (visually, by
Jonny, in the Telegram client) — the ultimate proof no automated check can
substitute for. Confirm the message content matches
`formatTelegramMessage`'s documented shape (severity, kind, check id,
message, occurrence count, timestamp, shortened notification id) and
renders correctly (MarkdownV2 escaping did not visibly break formatting).

## Step 11 — Verify delivery ACK

Read-only, same pattern as every prior outbox verification this session:
`kernel_private.notification_outbox` row for this notification shows
`status='DELIVERED'`, exactly one `kernel_private.notification_delivery_events`
row with `outcome='DELIVERED'`, `transport='telegram'`.

## Step 12 — Verify no duplicate send

Re-run the delivery worker's natural next tick (do not manually trigger a
second attempt) and confirm the SAME notification is never re-attempted
(`attemptCount` unchanged, `attempted:0` for that row on the next tick) —
the outbox's own idempotent claim (`markSending`'s atomic UPDATE) is what
guarantees this; this step is live confirmation, not a new mechanism.

## Step 13 — Verify alert runner / business scheduler unaffected

Identical business-side isolation check as KJ-P2.1A: `task_admissions_total`,
`schedule_fires_total`, `execution_bindings_total`, canonical schedule state
— all unchanged except whatever the test notification's own outbox row
contributed (zero business-table writes either way, since delivery never
touches `alert_state`/admission/schedule tables — see
`docs/operations/NOTIFICATION_OUTBOX.md`'s crash-semantics table). Restate
continuation chain still exactly one; worker/door/Restate healthy,
`restarts=0`.

---

## Rollback / STOP conditions

STOP immediately if: target/parity/health checks in Steps 1/5/6 reveal
anything ambiguous; Step 4's chat ID cannot be positively confirmed as the
intended destination; Step 7's deploy fails any health/parity check (roll
back exactly per `D1_EXECUTION_PATH_DEPLOYMENT_RUNBOOK.md`'s Stage 14,
`ALERT_TRANSPORT` reverting to unset/console along with the release); Step 8's
`activate_release` errors or its result is uncertain (never guess); Step 9's
test notification does not arrive within a reasonable window (investigate
via Telegram's `getUpdates`/bot settings before retrying — do not blindly
resend); Step 12 finds any duplicate. A worker that fails to start with
`ALERT_TRANSPORT=telegram` but valid-looking token/chat values (a
`loadTransportConfig` throw only happens on MISSING values, not invalid
ones — an invalid token/chat surfaces later, as a `TelegramUnauthorizedError`/
`TelegramBadRequestError` on the first real delivery attempt, correctly
POISONing that one row without crashing the monitor) is itself a signal to
STOP and re-verify Steps 2-4, not to proceed hoping it self-resolves.

## Final go/no-go checklist

- [ ] Bot created, token stored in jVault only, length-verified.
- [ ] Chat ID obtained and confirmed reachable, stored in jVault.
- [ ] Worker (and door, for parity) redeployed to the qualified release;
      `ALERT_TRANSPORT`/token/chat presence verified live (never their values).
- [ ] `activate_release` called and independently re-verified from a fresh
      connection (epoch, release id, request id all match).
- [ ] Exactly one authorised test notification sent, received in Telegram,
      ACKed in the outbox, not duplicated on the next tick.
- [ ] Business counters unchanged beyond the test notification's own row;
      continuation chain still exactly one; all containers healthy,
      `restarts=0`.
