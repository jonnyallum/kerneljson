# KJ-P4A - two-way Telegram live activation - RESULT

**Status: FAILED-SAFELY**
**Window: 2026-09-20, 11:35Z to 12:18Z (about 20 hours before the next scheduled fire)**
**Design: `docs/operations/KJ_P4A_TELEGRAM_OPERATOR_CHANNEL.md`. Code: PR #38, merged as `2229a698b86d75ad9aef7c064c2dcf0f0df21ed3`.**

Evidence tags: OBSERVED means read live in this window. INFERRED means reasoned, not run. REPORTED means relayed by Jonny.

## The result, stated plainly

**The KJ-P4A channel activation is a success. The first live `/brief` mission failed safely, for a reason that has nothing to do
with the channel.**

- **Inbound Telegram is operational.** Jonny's messages were accepted from the authorised chat and sender, claimed durably, and acted on.
- **Outbound replies are operational.** Both replies were queued in the existing durable outbox and delivered once, `/status` in 137 ms.
- **Admission through the existing door is operational.** The `/brief` created exactly one task through the door, with the Telegram channel
  recorded as `source`, the sender's principal and tenant, a deterministic trace, and the update-derived idempotency key.
- **Replay, deduplication and authentication controls are operational.** Reprocessing the same update creates nothing, the same key at the
  door returns the same task, and stranger traffic is refused with nothing admitted, replied or stored.
- **The first `/brief` failed safely** with `REVIEWER_OUTPUT_LIMIT`: the Claude reviewer's answer exceeded its 2048-token output cap. The
  kernel recorded the failure as evidence, completed nothing, and sent its failure notice. This is a pre-existing KJ-P3.1 mission-runtime
  limit, not a Telegram channel failure, and it is being fixed separately. Jonny decided not to retry the `/brief` in this window.

## Release and deployment (OBSERVED)

| Item | Value |
|---|---|
| Deployed SHA, worker and door | `2229a698b86d75ad9aef7c064c2dcf0f0df21ed3`; tree `e76bcc3` identical to the qualified PR head; images `kerneljson-worker:2229a69` (`5ab62cf0054d`), `kerneljson-admission-door:2229a69` (`d6dd5f1a1962`) |
| Previous release | `59d2dbd5d966e7db735a8fad6149c47eacbde17f`, epoch 5 |
| New epoch | **6**, request `6d57d286-ae91-40e3-9929-e0ac98824cdc`, previous release `59d2dbd...` |
| Epoch verification | fresh DB session (backend pid 1627724): exactly one epoch-6 row; release, previous release and request id as requested |
| Cutover | worker and door recreated 11:42:11Z to 11:42:39Z; `activate_release` returned epoch 6 at 11:42:46Z, after every pre-activation check passed in the same script |

Precheck before any change (read-only, 11:36Z): worker and door on `59d2dbd`, healthy, restarts 0; epoch 5; Restate healthy; one alert monitor
chain (sequence 900) and the scheduler driver both scheduled; outbox gate PASS with POISON 0; all 11 tasks COMPLETED so nothing in flight;
counters 30 admissions, 9 fires, 31 bindings; the 2026-09-20 08:00Z fire had completed cleanly.

### Migration `20260920120000_telegram_operator.sql` (OBSERVED)

Applied once, inside one transaction with a lock timeout, from the worker container. The file's sha256 (`28df27f7...1633`) was identical on the VM
checkout, as committed, and as read inside the worker. Before and after: the two tables were absent, then created **exactly once**
(`telegram_inbox`, `telegram_operator_state`); all 37 existing tables had unchanged column fingerprints; none were removed; the ledger row counts
showed no drift; row level security is on for both; there are no grants to `PUBLIC`, `anon` or `authenticated`; the inbox has its ten designed
columns, eight check constraints, a primary key and two indexes; the offset row was seeded at 0 and the inbox was empty.

### Environment change (OBSERVED)

The merge tool changed exactly two keys, independently verified: `KERNELJSON_RELEASE_ID`, and `TELEGRAM_INBOUND_ENABLED=true` added.
`TELEGRAM_MISSION_DAILY_CAP` was not added, so the default of 5 applies. Every other key was unchanged by fingerprint, including the alert runner,
the Telegram credentials, the scheduler and admission settings, and the mission runtimes. The bot token and chat id were never displayed: their
lines were filtered from the tool's output and the `VERIFY OK` line is the proof they were unchanged. The door changed its release id only.
The bot had no webhook, checked before enabling and again before starting the poller.

### One judgement call: a stale backlog

Telegram was holding **5 pending updates** from before the channel existed. Their metadata (never their text) showed all five were plain-text
messages from Jonny's own private chat, between about 2.5 and 21 hours old, none a command and none from anyone else. Left in the queue, the first
poll would have processed them as five stray usage replies and five extra inbox claims. The durable offset was therefore initialised to
`461282853`, just past the highest of them (`461282852`), so the first poll confirmed and dropped them. Had any been an actionable command the
activation would have stopped. Telegram reported 0 pending afterwards.

### Poll chain (OBSERVED)

Started once at sequence 0 at 11:44:10Z: invocation `inv_1dHllGlMYmZC2yXBNON5e1o02o6ihNDL7x`. The guard refused to start unless no `TelegramOperator`
invocation existed. Exactly one chain each for the Telegram operator, the alert monitor and the scheduler driver, on every sample. The sequence
advanced steadily (1, then 4 fifty seconds later, 97 at the final sweep), roughly one long poll every 17 to 20 seconds. No poll errors in the hour.

## First live message: `/status` (OBSERVED)

| Check | Result |
|---|---|
| Accepted only from the authorised chat and sender | yes: one inbox row exists, and `unauthorised_total` is 0 |
| Durable inbox claim | exactly one, update `461282853`, DONE, command STATUS, disposition ANSWERED, no mission, no task |
| Message storage | only a sha256, equal to the digest of exactly `/status`; the text is not stored |
| Task admission | none (counters unchanged at that point) |
| Reply | one deterministic templated reply, below |
| Outbox | exactly one row `OPERATOR.reply.461282853`, `DELIVERED`, `attempt_count` 1, exactly one delivery event (telegram, DELIVERED) |
| Latency | claim at 12:00:10.192Z, delivered at 12:00:10.329Z: 137 ms |
| Offset | the poller's own log for that batch records the offset moving to `461282854`; the final state satisfies "offset is the highest handled id plus one, with every row below it DONE, and last moved after the last update was completed" |

```
KernelJSON status as of 2026-09-20T12:00:10.192Z
Release 2229a69, epoch 6
Tasks: 11 total, 0 in flight, 0 awaiting approval or an event
Missions: 2 total, 0 of 5 started today
Latest fire: dailyAt/09:00|Europe/London|2026-09-20 ADMITTED
Open alerts: P0 0, P1 0, P2 0, P3 2
Outbox: 0 pending, 0 poison
```

## Second live message: `/brief jonnyallum/kerneljson findings=3` (OBSERVED)

| Check | Result |
|---|---|
| Update and task | update `461282854`; task `974189bd-fcca-8942-a963-ed6e92f58687`; claimed and admitted at 12:09:01Z |
| Inbox claim | exactly one, DONE, ADMITTED, counted as a mission; stored digest equals the exact command text |
| IntentEnvelope | one, persisted by the door: recipe `repo-analysis-mission/v1`; **source `kerneljson:channel/telegram/v1`**; principal and tenant equal to the door bearer's identity; trace id and correlation id both `98be805a-b107-47fb-a371-437d8baa2151`, the deterministic trace for this update |
| Idempotency key | `tg:upd:461282854`; the stored key digest equals the digest of that string; the stored request digest equals the digest of the admitted request |
| Objective and contract | `jonnyallum/kerneljson findings=3`; the kernel re-derives an exact contract of 3 |
| Admissions | exactly one task; exactly one admission in the whole ledger carries the Telegram source; exactly one execution binding |
| Operator reply | exactly one row `OPERATOR.reply.461282854`, delivered once, one delivery event; text: "Started a brief of jonnyallum/kerneljson: exactly 3 findings. Task 974189bd-... Missions today: 1 of 5." |

### The mission failed safely (OBSERVED)

| Item | Value |
|---|---|
| Final task status | **FAILED**, one outcome row, summary `mission FAILED: REVIEWER_OUTPUT_LIMIT`, at 12:09:34Z |
| Captured GitHub head | `2229a698...`, 596 tree entries |
| Analyst | provider `deepseek`, `deepseek-flash`: completed, 13,282 in and 1,100 out tokens, 4,281 characters |
| Reviewer | provider `openrouter`, requested `anthropic/claude-sonnet-5`: error `OUTPUT_LIMIT`, not retryable, `may_have_run` true |
| Evidence | 3 rows (GitHub receipt, analyst artifact, the reviewer's failure record); no reconciliation row, because the mission stopped at the reviewer |
| Events | one each of `TASK_CREATED`, `INTENT_RESOLVED`, `PLAN_COMPILED`, `TASK_READY`, `TASK_STARTED`, `TASK_FAILED`; three each of `STEP_STARTED` and `STEP_COMPLETED`; no `TASK_COMPLETED` |
| Notice | one kernel notice `MISSION.repoAnalysis.974189bd.failed`, P2, delivered once |

**Cause.** The Claude reviewer's answer exceeded `REVIEWER_MAX_TOKENS = 2048`. In KJ-P3.1 I raised the analyst's budget for the added citations
but left the reviewer's unchanged. The successful KJ-P3.1 live mission used 1,529 of those 2,048 tokens, so the margin was thin, and Claude's
answer length varies. The kernel behaved correctly: it did not accept an unreviewed analysis, it recorded exactly what failed, and it told Jonny.
This is a gap in my KJ-P3.1 work, not a defect in KJ-P4A.

**Consequence for this record.** The "exactly one completion" proof for a Telegram-originated mission could not be produced: there is no completion.
The other `/brief` proofs (one envelope, source, key, trace, one admission, one reply, replay safety) all hold.

## Replay and reprocessing (OBSERVED)

Both probes were built so that a failure would fail loudly instead of acting.

| Probe | Result |
|---|---|
| The deployed adapter re-handles the same update against the real inbox, with a door that throws if called and a store whose write path throws | recognised as a duplicate: `duplicates` 1, `commands` 0, `admitted` 0 |
| The same idempotency key and body sent to the door | returned the SAME task id |
| Ledger counters before and after both probes | identical (31 / 9 / 32 / 12 tasks) |

The count of operator replies, Telegram-sourced admissions and outcome rows for the task stayed at one.

## Authentication negative test (OBSERVED, with limits stated)

No real second user was used and none was improvised. The mechanism: the **deployed adapter code, run in-process** inside the worker against synthetic
updates, with in-memory stores, a door and status reader that throw if reached, and the real chat id held only in that process and never printed.
Production state was captured before and after and was byte-identical.

| Case | Result |
|---|---|
| Six stranger shapes: another user, a group, the right chat with another sender, a bot in the right chat, no sender, the right sender in another chat | all six refused (`unauthorised` 6, `commands` 0) |
| Admission, status read, reply, stored message | none of them: the door and status reader were never reached, no reply was queued, no inbox row exists, and the stranger's text appears in nothing the adapter kept |
| Forwarded, bot-relayed, edited and button updates from the authorised sender | four ignored, never commands |
| Positive control: an authorised `/status` through the same harness | answered once, so the negatives could have failed |
| Real production | `unauthorised_total` is still 0: no real stranger has ever reached it |

**What this does not prove:** the increment of the counter on live unauthorised traffic was demonstrated only in-process, because no stranger has messaged
the bot. The behaviour is proven on the deployed code; the live counter path has not been exercised by a real stranger.

## Safety sweep (OBSERVED, 12:17Z)

| Check | Result |
|---|---|
| Chains | exactly one `TelegramOperator` (sequence 97), one `ProductionAlertMonitor` (sequence 908), one `ScheduleDriver`, all as expected |
| Scheduler | unaffected: fires still 9, the latest still the 2026-09-20 08:00Z fire, the driver scheduled |
| Outbox | 15 delivered (10 before), POISON 0, PENDING 0, no duplicate delivery |
| Runtime | worker, door and Restate healthy, restarts 0 |
| Poller | no failed polls in the hour |
| Alerts | only the known `legacyAuthority.b1FreezeObservable` P3 open |

### Counters before and after

| Counter | Before | After | Why |
|---|---|---|---|
| Task admissions | 30 | 31 | the admitted `/brief` |
| Schedule fires | 9 | 9 | unchanged |
| Execution bindings | 31 | 32 | the admitted `/brief` |
| Tasks | 11 | 12 | the `/brief` task (COMPLETED 11, FAILED 1) |
| Outbox rows | 10 | 15 | see below |

The five new outbox rows: the two operator replies; the mission's failure notice; and the usual pair for an epoch change (`authority.bindingReleaseConsistent`
opened at 11:45Z, after activation, and recovered at 12:10Z on the first binding under the new epoch, exactly as it did at the last activation).
All were delivered once.

## Deviations and notes

1. **The stale backlog was skipped** (above), a judgement call disclosed rather than hidden. Their text was never read.
2. **My first migration attempt did not run.** A bug in my own before-snapshot query (grouping on an aggregate) failed before the transaction began,
   so nothing was applied; the rerun's first line confirmed the tables were still absent. The failure message said "rolled back", which was
   misleading because there was no transaction yet.
3. **My `/status` verifier was rewritten mid-window.** Jonny sent both messages before I verified the first, so "exactly one inbox claim and unchanged
   counters" no longer applied as written. It was reworked to check each message on its own terms and to prove offset ordering as an invariant.
4. **The `/brief` failed** for the reviewer output limit (above).
5. **Not exercised live:** the `/task` command (only `/status` and `/brief` were sent); the daily-cap refusal; the rate limit; recovery of the poller
   across a worker restart (restarts were 0); and a Telegram-originated mission through to COMPLETED.
6. **The rollback baselines were shredded after this record was written**, at Jonny's instruction. A rollback now means rebuilding the environment
   with the merge tool (remove `TELEGRAM_INBOUND_ENABLED`, restore the release id); the previous images including `59d2dbd` remain on the host.
   The migration is additive and can stay.

## Residual risks and follow-ups

- **The reviewer budget (next, separate, tiny).** Raise `REVIEWER_MAX_TOKENS` from 2048 to 4096 and tighten the reviewer prompt so it produces concise
  structured output: headroom without encouraging essay-length reviews. Then one `/brief` after deployment. Not done in this phase.
- The next scheduled fire, 2026-09-21T08:00Z, is the first canary fire on `2229a69` at epoch 6. `CLAUDE.md` is byte-identical across the releases, so
  it is INFERRED safe, but it has not been observed.
- Grounding is still not truth (KJ-P3.1): a reviewer can approve a debatable finding.
- The completion notice for a mission still arrives in the existing alert style, not as a templated reply.
- KJ-P4B (approvals through the existing policy-workflow control port) is the next programme step.

## Result

**KJ-P4A TWO-WAY TELEGRAM LIVE: FAILED-SAFELY.**
Inbound, outbound, door admission, and the replay, deduplication and authentication controls are all operational. The first `/brief` failed safely
because the Claude reviewer exceeded its 2048-token output cap.
