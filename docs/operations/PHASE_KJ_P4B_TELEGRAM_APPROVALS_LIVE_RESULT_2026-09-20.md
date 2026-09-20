# KJ-P4B - Telegram approvals live activation - RESULT

**Status: STOP (a stated precondition failed before deployment; nothing was deployed, no secret was created)**
**Window: 2026-09-20, 18:16Z to 18:25Z**
**PR #40 merged as `ff6bfc720a792e1b6023d310fa67a23a459e226e`. Runbook: `docs/operations/KJ_P4B_TELEGRAM_APPROVALS.md`. Decision: `docs/adr/0019-telegram-approvals-interface.md`.**

Evidence tags: OBSERVED means read or run in this window. INFERRED means reasoned, not run.

## Summary

Phases 1 to 3 passed: the PR was merged, the read-only precheck was clean, and the migration was applied and verified. Phase 4
required, before deployment, a check of whether Restate can persist or log the `Authorization` header on the door-to-workflow
hop, with an instruction to STOP if it can. **It can.** Restate stores every request header, including `Authorization`, in the
invocation's journal `Input` entry, retains it for 24 hours after completion, and exposes it through its admin SQL. The design
of KJ-P4B sends `KJ_CONTROL_TOKEN` as exactly that header, so deploying it as built would place the secret in Restate's durable
store. The window stopped there. No token was generated, no configuration changed, nothing was deployed, no release epoch
changed. The additive migration stays.

## Phase 1 - merge (OBSERVED)

| Item | Value |
|---|---|
| PR #40 head | `fef76968e4435d454cd5c373abb54c9ed60b6837`, CI green on both runs, mergeable |
| **Merge SHA** | `ff6bfc720a792e1b6023d310fa67a23a459e226e` (squash, guarded on the exact head); parent `b915715` |
| Tree check | merged tree `87ca9f1a15e8271fb767e2699430172da5a62978` identical to the reviewed head's; `git diff` between them empty |

## Phase 2 - precheck (OBSERVED, read-only)

| Check | Result |
|---|---|
| Worker and door parity | both `e54107a`, running release id `e54107aab21b44755a34e84600defe501986ee5b` on both |
| Epoch | 7 (request `d29a8d28-cc88-4ac4-b4aa-fcd34972a572`) |
| Poll chain, alert monitor, scheduler | exactly one each (`TelegramOperator` running, `ProductionAlertMonitor` and `ScheduleDriver` scheduled) |
| POISON | 0; outbox 19 delivered, none pending; gate PASS |
| Restarts, health | 0 restarts, all three containers healthy |
| In flight | 0 non-terminal tasks; 0 approvals; 0 `uppercase/v1` admissions ever |
| **Door principal** | `da5c6dfc-38c5-4773-bd47-5c80ed908d75`, kind **HUMAN**, tenant `estate` (`5f970749-7507-894b-a2e4-872ce20a94b7`) |
| **Approver principal role** | **operator**, status ACTIVE (one of owner, operator, reviewer, so the role gate passes) |
| Approval config already present | none: the five approval variables were absent from the worker and door env files and containers |

## Phase 3 - migration (OBSERVED)

`20260920150000_telegram_approvals.sql` was applied in one transaction with a 10 s lock timeout. The file's SHA-256 was
identical on the VM checkout, at the commit and as read inside the worker (`e87fe7ec5fcd92753686c07df2b158cdd59f1c88064fc22ca652caa994e9100c`).

| Check | Result |
|---|---|
| Additive only | 39 tables fingerprinted before; existing tables with changed **columns**, **constraints** or **indexes**: none; tables removed: none |
| Tables added | exactly `telegram_approval_cards` (14 columns), `telegram_approval_handles` (3), `telegram_callback_inbox` (7) |
| Constraints | cards: 7 check, 2 foreign key, 1 primary; handles: 2 check, 1 foreign key, 1 primary, 1 unique; callback inbox: 5 check, 1 primary. Exactly as designed |
| Indexes | the three primary keys, the handles unique key, and `telegram_approval_cards_open` (`WHERE state <> 'RESOLVED'`) |
| Row level security | enabled on all three |
| Grants | none to PUBLIC, `anon` or `authenticated`; `has_table_privilege` false for both |
| Ledger drift | none; row counts of 12 ledger tables identical before and after |
| Rows in new tables | 0, 0, 0 |
| One side effect to know about | the foreign keys add two internal referential-integrity triggers each on `public.approvals` and `public.tasks`. No column, constraint or index of those tables changed. |

## Phase 4 - the header check, and the STOP (OBSERVED)

**Method.** The check was run on the local disposable validation stack rather than production, so that no test credential
touched production Restate. It uses the **same image, `restate:1.7.9`**, and the same configuration (`RESTATE_BASE_DIR` only)
as production, and a **real** `GoldenTaskWorkflowV1` (`run` and `approve` handlers). Two unique synthetic canary strings and
the stack's ordinary test credentials were sent in the `Authorization` header, through the same ingress path the door uses.
Restate's introspection, its container logs and the worker's logs were then searched.

**Result.**

| Question | Answer |
|---|---|
| Does Restate persist the header value? | **Yes.** The journal entry at index 0 (`Command: Input`) of each invocation holds the full header list. Both canary strings and the valid `Bearer test-owner` and `Bearer test-reviewer` appear in it, on the `run` and on the `approve` invocation, including the invocation that was refused at authentication |
| For how long? | `completion_retention` and `journal_retention` are both `PT86400S` (24 hours) after completion, and for as long as the workflow is in flight |
| Who can read it? | anyone with access to Restate's admin SQL (`/query` on the admin port) or its data volume |
| Do Restate or worker logs contain it? | no: 0 matching lines in each |
| Raw file store | a search of the data volume for the canary found nothing, but that is not evidence of absence (values in the store may be compressed or unflushed); the decoded introspection above is what is conclusive |

**Confirmed on production, read-only (OBSERVED).** Production Restate is the same image with the same retention. Its
`Input` journal entries already store the header list for existing invocations: for the three most recent `KernelWorkflowV1`
runs the stored header **names** are `x-restate-ingress-path`, `content-type`, `accept`, `accept-language`, `sec-fetch-mode`,
`user-agent`, `accept-encoding`, `content-length`. There is no `authorization` today because the door sends none.
Restate's admin (`127.0.0.1:9070`) and ingress (`127.0.0.1:8080`) are bound to loopback, and the data lives in the named
volume `kerneljson-execution_restate-data`. Restate's logs for the last 24 hours contain no line mentioning authorization.

**Exact exposure path.** door sets `Authorization: Bearer <KJ_CONTROL_TOKEN>` on its request to the Restate ingress, Restate
records the request headers in the invocation journal `Input` command in its RocksDB store, and the value is readable for the
invocation's life plus 24 hours through `sys_journal.entry_json` and in the volume. The same would be true of every
`run`, `approve` and `cancel` on the golden workflow, and of every dispatch the door makes, since the door sends the header on
all of them. The credential would not stay confined to the private network hop.

**Decision.** STOP, as instructed. The secret was not generated, so nothing needs rotating.

## Phases 5 to 10 - not run

No config was merged, no release built or deployed, no epoch activated, no approval task admitted, no Telegram card sent.
Jonny was not asked to press anything. None of the live approve, reject, replay, expiry, wrong-digest or cancel tests ran, so
**none of those live outcomes is claimed**; they remain proven only by the PR's tests.

## Production state at close (OBSERVED)

| Item | Before | After |
|---|---|---|
| Worker and door image, release id | `e54107a` | `e54107a` (never restarted) |
| Epoch | 7 | 7 |
| Task admissions / schedule fires / execution bindings / tasks / approvals | 32 / 9 / 33 / 13 / 0 | 32 / 9 / 33 / 13 / 0 |
| Chains | 1 poll chain, 1 monitor, 1 scheduler | unchanged (poll sequence advanced 1124 to 1142, offset `461282856`) |
| Outbox | 19 delivered, POISON 0 | 19 delivered, POISON 0 |
| Env files | baselines staged | byte-identical to the baselines, then baselines shredded |
| VM checkout | `e54107a` | moved to the merge SHA for the migration, returned to `e54107a`; clean; `CLAUDE.md` hash `27255772...` unchanged |
| `KJ_CONTROL_TOKEN` | absent | absent everywhere (files and containers) |
| New tables | absent | present, empty, RLS on, no public grants |
| Scheduler | latest fire 2026-09-20 08:00Z | unchanged; the 2026-09-21 08:00Z fire is still the first on epoch 7 |

## Why this is a design finding, not an environment problem

ADR-0019 and the runbook record that the control token "stays on the private compose network". The network claim was true;
the storage claim was not checked at build time and is false. Restate is not a transparent hop: it is a durable store that
records what passes through it. The KJ-P4B build proved the approval path against a real Restate with **test** credentials,
which is exactly why the flaw did not show: a test credential in a journal is harmless. This is the case the activation's
pre-deployment header check exists for.

## Options to close it (INFERRED, for Jonny to choose; each needs a new PR and qualification, none is done)

1. **Send a signed assertion, not the secret (recommended).** The door computes an HMAC-SHA256, keyed by `KJ_CONTROL_TOKEN`,
   over the method, workflow path, body digest, a timestamp and a nonce, and sends only `timestamp.nonce.mac` in the header.
   The worker recomputes and compares in constant time, rejects a timestamp outside a short window, and remembers nonces for
   that window. Restate's journal then holds a value that is valid only for that one request and only briefly; the key never
   leaves the door and the worker. Residual: a journal reader could replay the identical request inside the window, which
   repeats the same answer for the same digest.
2. **Single-use handle held server side.** The door stores a random one-time credential in the database for each action; the
   header carries only its opaque id, and the worker consumes it. A spent id in the journal is useless. More moving parts than option 1.
3. **Trust the network path with no header.** Rejected: ADR-0008 requires a real authentication boundary for registration.

Whichever is chosen, the existing pre-deployment check should be kept and re-run against the new header, and a test should
assert that no header value anywhere in the journal equals a secret configured in the worker.

## What the next window needs

1. A code change for one of the options above, its own PR, review and qualification (the workflow, ApprovalStore and Telegram
   layer do not change; only the door's credential and the worker's authenticator).
2. Then, unchanged from the runbook: provision the secret through `secretctl`, merge the intended config with the env-merge
   tool, deploy worker and door together, activate the next epoch, confirm `GoldenTaskWorkflowV1` is registered once, and run the
   live approve, reject, replay, expiry, wrong-digest and cancel tests.
3. The migration is already applied and need not be repeated.

## Not checked

- Whether Restate's raw on-disk files contain the value (the introspection is conclusive for persistence; the file search was
  inconclusive).
- Whether any Restate configuration option strips or redacts headers from the journal: none was found or tried.
- Real Telegram behaviour of the card, buttons and pop-ups (nothing was sent).
- Restate discovery of `GoldenTaskWorkflowV1` on the production deployment (nothing was registered).

## Result

**KJ-P4B TELEGRAM APPROVALS LIVE: STOP.** Merged and migrated; deployment halted before any secret was created because
Restate persists the `Authorization` header for 24 hours, which the control-token design relies on. Production is unchanged
apart from three empty tables. Memory and personality work not started.
