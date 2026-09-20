# KJ-P4A - two-way Telegram operator channel

**Status: code complete, PR open, not deployed. Nothing runs in production until a release is built, the migration is
applied and the channel is switched on in a change window.**
**Plan context:** a deliberate early pull-forward of the cognition plan's cross-channel adapter stage. See
`docs/cognition/PLAN_REORDER_AND_KJ_P_MAPPING.md`. Memory authority is settled in `docs/adr/0018-canonical-memory-authority.md`.

Evidence tags: OBSERVED means run in this work. INFERRED means reasoned, not run.

## What it is, and is not

Telegram becomes a way to **ask KernelJSON for things** from a phone, and to get answers back. It is a command channel:
a small fixed vocabulary, deterministic replies, no free-form conversation and no model in the reply path.

It is a **client** of KernelJSON, never an authority. It cannot create, complete or mutate a task. A mission goes through
the same admission door every other client uses, which authenticates, resolves principal and tenant, applies policy and
builds the IntentEnvelope. There is no scheduler, no second task store, no Shared Brain authority and no memory or
personality logic.

## Adapter path

```
Telegram getUpdates (long poll, offset from the durable inbox)
  -> classify: only a fresh text message from the allow-listed private chat is a command
  -> parse: one of four commands, or MALFORMED (a fixed usage reply that never echoes the input)
  -> claim the update in kernel_private.telegram_inbox (durable, keyed by update_id)
  -> rate limit, then (missions only) the per-day cap
  -> /brief and /review:  POST /v1/tasks on the existing admission door
     /status:             read-only aggregates (READ ONLY transaction)
     /task:               the door's own GET routes (tenant-scoped)
  -> reply text from a fixed template, queued in the existing durable outbox, delivered at once
  -> close the update; advance the offset only after the whole batch is handled
```

What the adapter contributes to the IntentEnvelope, and nothing more:

| Field | Value |
|---|---|
| idempotency key | `tg:upd:<update_id>`, so retries and replays converge on ONE task |
| `x-kj-channel` header | `telegram/v1`, recorded as `source: kerneljson:channel/telegram/v1` (an allow-list, see below) |
| `x-correlation-id` | a trace id derived from the update id, stable across replays |
| principal, tenant | from the bearer, exactly as for any door client |

## Commands

| Command | Effect | Counts toward the cap |
|---|---|---|
| `/status` | deterministic read-only summary: release and epoch, task counts, awaiting, missions, latest fire, open alerts, outbox | no |
| `/task <id>` | status, evidence rows (type, source, digest prefix) and, for a mission, the kernel's reconciliation facts | no |
| `/brief owner/repo [findings=N]` | the existing `repo-analysis-mission/v1`; no count means the mission's default brief and contract | yes |
| `/review owner/repo [findings=N]` | the same mission with an exact count (default 3) and a question requiring cited evidence | yes |

Anything else is MALFORMED and gets one fixed usage reply. Only these tokens set a count: the grammar never reads a
number out of prose, and the door's own objective parser has the last word (a command it would refuse is refused here).

## Authentication and limits

- **Allow-list of one.** A command is accepted only from a private chat whose chat id and sender id both equal the
  configured `TELEGRAM_CHAT_ID`. In a private chat those are the same number, so no new secret is needed. Groups,
  channels, other users, bots, edits, forwards, bot-relayed messages, media and button presses are never commands. Anyone
  else is **counted, never answered, never stored**.
- **Rate limit:** 10 accepted commands per rolling minute. A flood earns one notice a minute, not a reply per message,
  and rate-limited messages do not extend the window, so a flood cannot lock the channel.
- **Daily mission cap:** `TELEGRAM_MISSION_DAILY_CAP` (1 to 100, default 5) Telegram-originated missions per UTC day.
  `/status` and `/task` never count. A refusal is deterministic and recorded (`CAP_EXCEEDED`). A failed admission does
  not use up the cap.
- **Secrets:** the bot token and the door bearer come from the environment (jVault) only, never an argument. They appear
  only in the URL or header handed to `fetch`, and errors are classified by type without inspecting the caught value.
  The inbox stores a sha256 of each message, never its text.

## Durability and replay safety

A row in `kernel_private.telegram_inbox` is **claimed (RECEIVED) before any work and closed (DONE) after**, keyed by
Telegram's own `update_id`. Every step between is idempotent. The offset advances only after the whole batch is handled,
and never backwards.

| Crash or retry point | What happens |
|---|---|
| Telegram redelivers a batch (offset write lost) | the inbox sees DONE rows: no second task, no second reply |
| Process dies after the door admitted, before the row is closed | next poll resumes the RECEIVED row; the door's key returns the SAME task; the reply id is derived from the update, so one reply |
| The adapter's own state is lost entirely | the door's idempotency key still converges the replay onto the same task |
| Telegram is down when a reply is sent | the reply stays PENDING on the outbox's backoff; it is retried at the start of the next poll and by the monitor's tick |
| The door is down | the command is answered "nothing was started" and recorded `ADMISSION_FAILED`; it does not use the cap; the user resends |

The poller is a single Restate virtual-object chain, shaped exactly like the alert monitor (numbered tick, delayed
self-send), so two polls can never run at once. It is not a scheduler: it decides nothing about when work is admitted.

## Two changes to existing, qualified code, both narrow

1. **The door records the channel as `source`, from an allow-list.** `x-kj-channel` accepts only `telegram/v1`; any
   other value is a 400 and admits nothing; no header keeps the original `kerneljson:gateway/v1` for every other client.
   The header is not a credential: the bearer still decides principal and tenant.
2. **An operator reply keeps its own text.** The delivery worker deliberately replaces every outbox row's text with
   `<checkId>: <kind> (<severity>)`, because an alert message can carry observation data. That is why the existing
   mission notice reads like a check id, and it means the outbox could not carry a reply as it stood. Exactly one
   check-id shape, `OPERATOR.reply.<update id>`, now keeps its text. That is safe because the text is a branded
   `ReplyText` that only the reply templates can mint, from validated fields: nothing a Telegram message, a repository
   or a model wrote ever reaches the chat (an outcome summary, for example, is never shown). Look-alike ids do not
   qualify, and a test pins both halves. The delivery path also gains a "deliver these rows now" function, because the
   monitor's tick is five minutes and a chat cannot wait; it claims each row atomically and does **not** run the
   stale-`SENDING` recovery that relies on the monitor's exclusive lock.

## Configuration

| Variable | Meaning |
|---|---|
| `TELEGRAM_INBOUND_ENABLED` | `true` turns the channel on; unset, empty or `false` leaves it off; anything else refuses to start |
| `TELEGRAM_MISSION_DAILY_CAP` | whole number 1 to 100, default 5 |

Enabling also requires `ALERT_TRANSPORT=telegram`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (a positive private-chat id),
`KJ_ADMISSION_URL`, `KJ_ADMISSION_BEARER` and `DATABASE_URL`; a missing or wrong one stops the worker at startup and
names the variable, never a value. Both new variables are declared in the compose passthrough, the topology checker and
the env-merge allow-list, and guarded by the same inventory tests that caught the earlier silent-drop defects.

## Findings during the build

- **The outbox could not carry a reply** (above). Found by reading the delivery worker before designing, not by a test.
- **A production bug that 63 unit tests missed.** `public.tasks.status` is a Postgres enum, so `/status` would have
  failed on its first live call with `operator does not exist: task_status <> text`. The integration test against real
  Postgres caught it; it is fixed and covered.
- **A door-only admission creates no task row.** The door records an admission and a binding; the kernel workflow writes
  the task. So the channel and the door together leave `public.tasks` untouched, which is a stronger form of "the
  channel cannot create a task", and the tests assert it. Consequence: `/task` for a task admitted a moment ago can say
  "no task that I can see" until the workflow's first write lands.
- **A test gap found by breaking the code on purpose.** Removing the chat-id comparison changed nothing, because in a
  private chat the sender comparison masked it. The two checks are now each pinned on their own.

## Tests

All deterministic; the end-to-end ones run the real door against real Postgres.

| Required case | Where |
|---|---|
| authorised message becomes exactly one IntentEnvelope | `telegram-channel` (one admission) and `telegram-channel.integration` (the persisted envelope: source, principal, tenant, trace) |
| duplicate update makes no duplicate admission | both, including a lost offset and total loss of adapter state |
| unauthorised chat refused | seven refusal cases, each on its own; nothing admitted, read, replied or stored |
| malformed command gets a deterministic response | fixed usage reply, never echoing the input |
| mission cap exceeded is refused | deterministic, recorded, resets next UTC day, `/status` and `/task` do not count |
| Telegram retry makes no duplicate task | redelivery, crash after admit, and resume onto the same task |
| `/status` read-only | no ledger row written; verified against real tables |
| `/task` read-only | reads through the door's GET routes; model text never repeated |
| `/brief` and `/review` map to the mission path | `telegram-commands`: recipe, objective grammar, exact-count contract |
| existing admission and policy tests stay green | full suite and the protected baseline |

Negative controls: with each of these deliberately broken, the named tests fail: a random idempotency key, an open
channel allow-list, no chat check, no sender check, no cap, reply text withheld again, DONE updates re-handled,
forwarded messages obeyed, no rate limit, and an offset that can move backwards.

## What remains before the first live inbound message

1. Review and merge the PR (not merged here).
2. Apply `supabase/migrations/20260920120000_telegram_operator.sql` to production Postgres, by the route used for the
   outbox migration, in a change window. It is additive (two tables, one seeded row); check the tables exist, RLS is on
   and the offset row is present.
3. Build and deploy a release containing this code to **worker and door together** (the door carries the channel
   allow-list), and activate the epoch by the usual procedure.
4. Add `TELEGRAM_INBOUND_ENABLED=true` (and optionally `TELEGRAM_MISSION_DAILY_CAP`) with the env-merge tool, which
   preserves every other key by fingerprint. Confirm the running worker's environment by fingerprint, not by value.
5. Confirm the bot has **no webhook set**. Long polling and a webhook cannot coexist; the adapter reports a conflict
   error and backs off rather than fighting it.
6. Start the poll chain once, deliberately, by sending `{"sequence": 0}` to the `poll` handler of the `TelegramOperator`
   object (key `operator`) on the Restate ingress, exactly as the alert monitor's chain was started. Then check the
   object's `status` shows the sequence advancing.
7. First live message, in this order: `/status` (expect a reply within a couple of seconds), then `/task` with the id of
   the last mission, and only then `/brief` or `/review`. Confirm exactly one admission and one reply for each.

Rollback: set `TELEGRAM_INBOUND_ENABLED=false` with the merge tool and restart the worker. The service is then not
registered and the chain ends. The migration is additive and can stay.

## Known limits

- No free-form conversation, no memory, no personality (KJ-P5 to KJ-P7).
- No buttons yet. Approvals and cancel are KJ-P4B, and must use the existing policy-workflow control port.
- A finished mission's completion notice still arrives in the existing alert style (`MISSION.repoAnalysis...`). It could
  become a templated result reply later.
- One person, one chat, by design. One poller: a second consumer of the same bot would conflict.
- An admission the door could not take is not retried automatically; the user resends, and a resend is a new update.
- The daily cap counts UTC days.

## Files

- Door: `apps/gateway/src/server.ts` (channel allow-list).
- Alerting, narrow: `services/kernel/src/alerting/{operator-reply,format,delivery-worker}.ts`.
- Adapter: `services/kernel/src/channel/telegram/` (`commands`, `updates`, `views`, `replies`, `door-client`, `status`,
  `inbox-store`, `pg-inbox-store`, `reply-outbox`, `operator`, `operator-config`, `restate-service`, `production`).
- Wiring: `services/kernel/src/index.ts`, `infrastructure/docker/execution.compose.yaml`,
  `scripts/check-execution-topology.mjs`, `scripts/runtime_env_merge.py`.
- Migration: `supabase/migrations/20260920120000_telegram_operator.sql`.
- Docs: this file, `docs/adr/0018-canonical-memory-authority.md`, `docs/cognition/PLAN_REORDER_AND_KJ_P_MAPPING.md`.
