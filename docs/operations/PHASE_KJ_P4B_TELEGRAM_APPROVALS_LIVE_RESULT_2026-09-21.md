# KJ-P4B - Telegram approvals live activation (resumed after KJ-P4B.1) - RESULT

**Status: PASS**
**Window: 2026-09-21, 07:26Z to 16:21Z (the deployment and boundary proof by 08:05Z; the human presses at 16:17Z)**
**Supersedes the STOP record `PHASE_KJ_P4B_TELEGRAM_APPROVALS_LIVE_RESULT_2026-09-20.md`. Fix: PR #41. Design: `docs/adr/0019-telegram-approvals-interface.md`. Runbook: `docs/operations/KJ_P4B_TELEGRAM_APPROVALS.md`.**

Evidence tags: OBSERVED means read or run live in this window. INFERRED means reasoned, not run. REPORTED means relayed by Jonny.

## Summary

Telegram is now a working human interface onto KernelJSON's existing approvals, in production. Two harmless approval-test tasks were
decided from Jonny's phone: one approved (the guarded continuation ran exactly once and the task completed), one rejected (nothing
ran). Every decision went Telegram callback, then the door's existing approve control, then a **signed per-request assertion**, then
the workflow's ApprovalStore, which recorded a human-decision evidence row. Before any card was shown, the production Restate journal
and all logs were searched and the long-lived signing key was found nowhere. Replay, tamper, expiry, wrong-digest and
cancel-then-press cases were all refused or idempotent, and none changed truth. No business capability ran other than the one harmless
`uppercase` continuation.

## Phase 1 - merge (OBSERVED)

| Item | Value |
|---|---|
| PR #41 head | `d4e223b5bf98e18c798d79c6ce4d0929e8af2f45`, CI green on both runs |
| **Merge SHA** | `a4078cf96b063db4d8885cf9b2a2f2fedebdd60f` (squash, guarded on the exact head); parent `b0b630d` |
| Tree check | merged tree `921735980958731ab472939fd0525c7390414f19` identical to the PR head's; the only delta from the Grok-reviewed head `3c5e392` is the 3-line test-harness fix |

## Phase 2 - precheck (OBSERVED, read-only, 07:27Z)

Production on `e54107a`, epoch 7, worker and door parity, exactly one `TelegramOperator` chain, one `ProductionAlertMonitor`, one
`ScheduleDriver`, POISON 0, restarts 0, nothing in flight, no approvals. The door principal `da5c6dfc-38c5-4773-bd47-5c80ed908d75` is
kind HUMAN, role **operator**, status ACTIVE, in tenant `estate` (`5f970749-7507-894b-a2e4-872ce20a94b7`).

**The 08:00Z scheduled fire was deliberately not crossed.** The deployment waited for it. It ran on epoch 7 at 08:00:00.280Z: fire
`ADMITTED`, child task `97c9bf85-1b23-87e1-a9e2-42c028dbc510` `COMPLETED` with 1 outcome and 1 evidence row, outbox unchanged. That
also closes the earlier open item "observe the first fire on epoch 7".

## Phase 3 - migration (OBSERVED)

`20260920180000_control_assertions.sql` applied in one transaction (lock timeout 10 s). Its SHA-256 was identical on the checkout, at the
commit and inside the worker (`87c1505406e8787aaa97f755ddc627dcef0d0d354cc90bc79dd3f8c0c2826ae9`). The earlier approvals migration was not repeated.

| Check | Result |
|---|---|
| Additive only | tables before 42, after 43; existing tables with changed columns, constraints or indexes: none; removed: none |
| Exactly one new table | `kernel_private.control_assertions` (8 columns: nonce, key_id, request_digest, issued_at, first_seen_at, service, handler, workflow_key); 6 check constraints and 1 primary key |
| Exactly one new secondary index | `control_assertions_first_seen` on `first_seen_at` (plus the primary-key index) |
| Row level security | enabled |
| Grants | none to PUBLIC, `anon` or `authenticated` |
| Ledger drift | none across 15 ledger tables |
| Rows | 0 at creation |

**Nonce retention is 7 days.** The verifier purges older rows itself. This assumes the legitimate Restate redelivery horizon is
materially shorter than 7 days: Restate's journal retention was measured at 24 hours, so a legitimate redelivery is bounded well
inside it. A purged nonce can only make a very old replay fail as stale, never succeed. A correction to my own pre-flight: I expected
40 to 41 tables; the true figure was 42 to 43 (the three approvals tables were already counted). The delta of one is what mattered.

## Phase 4 - signing key and configuration (OBSERVED)

| Item | Value |
|---|---|
| Vault entry | `kerneljson/KJ_CONTROL_SIGNING_KEY`, generated as 32 random bytes in 43 URL-safe characters, `secretctl put` with a stated length; **key id `v1`, sha8 `DB9B9781`** |
| Movement | vault, then a local mode-restricted file, then a mode-600 landing file on the VM, then `root:root 600` staging; local and landing copies shredded; the value was never an argument or output |
| Worker env | added `KJ_APPROVAL_ENABLED=true`, `KJ_ADMISSION_TENANT_ID`, `KJ_ADMISSION_PRINCIPAL_ID`, `KJ_CONTROL_KEY_ID=v1`, `KJ_CONTROL_SIGNING_KEY`, and the release id |
| Door env | added `KJ_CONTROL_KEY_ID=v1`, `KJ_CONTROL_SIGNING_KEY`, and the release id |
| TTL and freshness | left at their defaults (approval 600 s, freshness 300 s); not set |
| Preserved config | every other key identical to its baseline by fingerprint (Telegram, scheduler, alerting, admission, mission, OpenRouter and DeepSeek), proven by the env-merge tool's independent `verify` before install and again after the window |
| `KJ_CONTROL_TOKEN` | absent from both env files and both running containers |
| Staged copies | candidates and the staged key shredded after deployment; rollback baselines shredded at close; stage directory empty |

## Phase 5 - deployment (OBSERVED)

| Item | Value |
|---|---|
| Images | worker `kerneljson-worker:a4078cf` (`93195b1ddcbf`), door `kerneljson-admission-door:a4078cf` (`8ca877c09b7b`), built from the merge SHA |
| **Deployed SHA** | `a4078cf96b063db4d8885cf9b2a2f2fedebdd60f` on worker and door, recreated together (08:01Z to 08:02Z) |
| Parity | `KERNELJSON_RELEASE_ID` equal to the merge SHA in both running containers and in the image tags |
| Running signing key | worker and door both `len=43 sha8=DB9B9781 url_safe=true` (length and fingerprint only) |
| **New epoch** | **8**, request `6d5bf594-f67b-41d8-b5f6-cfedc374d5ff`, previous release `e54107a`; read back from a fresh DB session (backend pid 1720236), exactly one epoch-8 row |
| Registration | `GoldenTaskWorkflowV1` exactly once; `TelegramOperator` exactly once; `CapabilityServiceV1`, `KernelWorkflowV1`, `ProductionAlertMonitor`, `ScheduleDriver`, `TaskWorkflow` and their handlers intact |
| Chains | still one each; the poll chain resumed by replay across the deploy (sequence 3466 to 3469 in the first minute, never reset) |

The pre-activation gate refused to activate unless every check passed (parity, health, restarts 0, env values, key length and
fingerprint, service registration counts, door probes 401, epoch still 7). All passed.

**Lockstep, as a rule.** The KJ-P4B.1 CI failure showed the ledger refuses a task whose bound release differs from the worker's
(`Task requires its bound worker release`). The door binds the release it runs, so the worker and the door must always be deployed
together at the same SHA. This is a task-execution correctness requirement, not just provenance.

## Phase 6 - production secret-boundary proof (OBSERVED, before any approval card existed)

The proof used no task and no card. One genuine signed control invocation was made from inside the worker container with the
production signer and the container's own key, so the value never left that process. It targeted a random workflow key.

| Check | Result |
|---|---|
| The signed request | HTTP **403**, meaning the assertion verified and the approval was refused only because no such approval exists (a failed assertion would have been 401). The nonce table recorded exactly one row for it: key id `v1`, service `GoldenTaskWorkflowV1`, handler `approve`, the right workflow key, a 64-character digest |
| Headers journalled by Restate for that invocation | exactly `x-kj-control-version`, `-key-id`, `-timestamp`, `-nonce`, `-body-sha256`, `-signature`, with value lengths 1, 2, 10, 22, 64, 64; plus Restate's own and the client's ordinary headers |
| `Authorization` header | **absent** |
| Signing key in the Restate journal | searched all **30,645** journal entries (3,817 request inputs, 16.7 MB) in clear, hex, base64 and base64url: **0** hits, and 0 anywhere in the whole response |
| Signing key in Restate logs, worker logs, door logs | **0**, **0**, **0**. The logs were streamed into the container that holds the key, so the value was never on the host |

No long-lived key material appeared anywhere, so the window continued.

## Phase 7 - live approve test (OBSERVED)

An earlier first attempt was **not pressed** and expired safely (recorded below). The decisive run:

| Item | Value |
|---|---|
| Task | `cbaaf658-8e95-8115-a6b4-8f6a9fdd0eab`, label `p4b-live-approve-02`, recipe `uppercase/v1`, admitted through the door by the door principal; dispatch `ACCEPTED` (a signed `run`) |
| Card | Telegram message **26**, sent 16:17:13Z, one card, task id `cbaaf658` |
| Press | Jonny pressed once at **16:17:37.774Z**: Telegram update `461282856`, allow-listed chat and user, disposition `RESOLVED`, pressed `GRANTED` |
| Callback | opaque `kj1:<handle>` only (handles are 22 characters); resolved server side |
| Digest | the card row's full digest `1f572fa2…` **equals** the ledger's own `POLICY_CHECKED` digest; nothing digest-bearing came from Telegram |
| Door route | existing route used: control events `REQUESTED` then `ACCEPTED` for principal `da5c6dfc…` |
| Signed hop | signed `run` and signed `approve` assertions, key id `v1`, one each, recorded in the nonce table |
| Decision | approval `GRANTED` at 16:17:37.971Z by the ApprovalStore |
| **HUMAN_DECISION evidence** | exactly **1** row, type `HUMAN_DECISION`, source `kerneljson:approval/v1`, digest length 64 |
| Same durable workflow | one `TASK_CREATED`, one `APPROVAL_GRANTED`, one `TOOL_CALLED` (`capability:policy-uppercase-1`), one `TASK_COMPLETED`; Restate shows exactly one `run` and one `approve` invocation, both completed |
| Continuation | 1 capability run; outcome `COMPLETED`, summary "APPROVAL TEST P4B-LIVE-APPROVE-02", 2 evidence refs (the human decision and the deterministic result) |
| Task | `COMPLETED` |
| Card | state `RESOLVED` at 16:17:38.180Z, 0.2 s after the decision. That it was edited to "Approved" with its buttons removed is **INFERRED** from that state (the same state is also set if Telegram permanently refuses an edit); Jonny's phone view was not reported |

## Phase 8 - live reject test (OBSERVED)

| Item | Value |
|---|---|
| Task | `20d34841-845b-8a9a-aa2a-49de77f9de95`, label `p4b-live-reject-01` |
| Card | Telegram message **27**, sent 16:17:34Z |
| Press | Jonny pressed once at **16:17:40.349Z**: update `461282857`, pressed `DENIED`, disposition `RESOLVED` |
| Decision | approval `DENIED`; exactly 1 `HUMAN_DECISION` evidence row; card digest equals the ledger's (`4a2ebdea…`) |
| Guarded capability | **did not run**: 0 `TOOL_CALLED`, 0 capability runs, no outcome |
| Terminal state | task `FAILED` via `TASK_FAILED:approval-rejected`, one `TASK_CREATED`; signed `run` and `approve` recorded once each |
| Card | state `RESOLVED` at 16:17:40.670Z (edit to "Rejected" INFERRED as above) |

**The first approve attempt** (task `b2258a93-1218-8ed8-a818-be537e3787d2`, Telegram message 25, sent 08:06:38Z) was not pressed within
its 10-minute window. It expired at **08:16:20Z** by the workflow's own timer: approval `EXPIRED` with one decision-evidence
row, task `FAILED`, 0 capability runs, no outcome, the card digest equal to the ledger's, exactly one `run` invocation, card closed.
That is a live, natural proof of expiry.

## Phase 9 - replay, tamper, expiry, cancel (OBSERVED, production)

A settled card's buttons are removed, so a press cannot be repeated from the phone. These cases were therefore exercised at the
layers a press ultimately reaches: the door's own approve and cancel route with its real bearer, and signed requests made with the
production signer inside the worker container. The Telegram layer contributes only a lookup and a call to that same route.

| Case | HTTP | Outcome |
|---|---|---|
| **Identical signed redelivery** of the original approve, rebuilt exactly (same nonce, timestamp and body) | 200 | accepted idempotently; still exactly 1 nonce row and 1 evidence row; state unchanged |
| **Same nonce, changed payload** (validly signed DENIED) | 401 | rejected; stored digest unchanged; approval still `GRANTED` |
| **Approve then reject**: a fresh validly signed DENIED / the same through the door route | 200 / 409 | existing resolution returned / refused; approval still `GRANTED`, task `COMPLETED`, 1 capability run, 1 evidence row |
| **Duplicate approve** through the door route | 409 | refused; no change |
| **Expired approval**: correct digest signed at the workflow / through the door route | 200 / 409 | still `EXPIRED`, task `FAILED`, 0 capability runs, 0 outcomes, evidence unchanged |
| **Wrong digest**: through the door route / signed at the workflow | 403 / 403 | approval stays `PENDING`, nothing ran |
| Right digest, **signature altered** | 401 | rejected; stays `PENDING` |
| **Cancel** the pending task through the door route | 202 | approval `DENIED`, task `CANCELLED` |
| **Cancel then press**: right digest through the door route / signed at the workflow | 409 / 200 | stays `DENIED` and `CANCELLED`, 0 capability runs, 0 outcomes |

The tamper task was `da9fe714-b884-8c4f-a313-b5e6893528e7` (Telegram message 28, never pressed, cancelled). A signed request that
returned 200 returned the EXISTING resolution: no assertion, however valid, changed an approval that was already settled.

## Phase 10 - safety (OBSERVED, 16:21Z)

| Check | Result |
|---|---|
| Chains | one `TelegramOperator` (running), one `ProductionAlertMonitor`, one `ScheduleDriver` |
| Containers | worker, door and Restate healthy, restarts **0**; images `a4078cf` and `restate:1.7.9` |
| Outbox | 19 delivered, pending 0, **POISON 0**, no duplicate delivery gate failure |
| Scheduler | unchanged: latest fire 2026-09-21 `ADMITTED`; fires still 10 |
| Duplicate cards | none: one card per approval (maximum 1), message ids 25 to 28; no duplicate card affected truth |
| Business mutation | none: across the ledger since 08:00Z exactly **1** capability run, the approved harmless `uppercase` test; the door admitted only the 4 test `uppercase/v1` tasks |
| Unauthorised presses | `unauthorised_total` 0; operator offset `461282858` |
| Post-use boundary re-proof | 36,687 journal entries: signing key **0** hits in any form; **0** entries with an `Authorization` header; **15** signed invocations journalled (approve 10, run 4, cancel 1), every one with exactly the six assertion headers and nothing else; Restate, worker and door logs 0 |
| Env files | verified against the baselines: only the intended keys differ; baselines then shredded |
| Checkout | left at the running release `a4078cf`, clean |

## Counters before and after

| Counter | Start of window | End | Why |
|---|---|---|---|
| Task admissions | 33 | 37 | the 4 test tasks |
| Schedule fires | 10 | 10 | unchanged (the 21/09 fire was already in the start figure) |
| Execution bindings | 34 | 38 | the 4 test tasks |
| Tasks | 14 | 18 | the 4 test tasks (COMPLETED 14, FAILED 3, CANCELLED 1) |
| Approvals | 0 | 4 | GRANTED 1, DENIED 2, EXPIRED 1 |
| Nonce rows | 0 | 12 | run 4, approve 7, cancel 1 (including the probes above) |
| Outbox | 19 delivered | 19 delivered | unchanged, POISON 0 |
| Epoch | 7 | 8 | this activation |

## Residual risks and what was not checked

- **Card appearance.** I did not see the Telegram cards. Their content is the fixed template over the ledger fields; that they showed
  the task, action, shortened digest, expiry and two buttons, and that they were edited to Approved, Rejected and Expired, is INFERRED
  from the database. Jonny pressed real buttons on real cards, which does prove the send and the callback path.
- **Duplicate press, wrong user or chat.** Not live-testable from the phone (settled buttons are removed; there is no second account).
  Covered by the PR's tests, and the duplicate and replay semantics were proven live at the door and workflow layers above.
- **Approval window.** The 10-minute default is short for a human who is away, as the first expired card showed. It is configurable
  (`KJ_APPROVAL_TTL_SECONDS`) but was left at its default.
- **`run` freshness.** A `run` assertion is judged fresh when the worker first sees it; a worker outage longer than 300 s between the
  door sending and the worker running would refuse that submission as stale. Only the harmless synthetic recipe is affected.
- **Clock agreement** between the door and the database must stay within the freshness window.
- **One human is both requester and approver.** A real, explicit, time-bound, digest-bound gate, not a two-person control.
- Restate's raw on-disk files were not searched (the decoded journal and all logs were).
- Every `uppercase/v1` submission through the door now requires this approval; nothing else changed behaviour.

## Distillation candidate

The pattern "a channel is an interface, not an authority; anything that crosses a durable middle layer carries a request-bound signed
assertion, never a credential; and a pre-deployment check must test what the middle layer stores" earned its keep twice in this
programme (the header finding, then the signed scheme). It is reusable for the memory stack's write paths.

## Result

**KJ-P4B TELEGRAM APPROVALS LIVE: PASS.** Approve resumed the same durable workflow once; reject ran nothing; replay, tamper, expiry,
wrong-digest and cancel-then-press changed nothing; the signing key never left the door and the worker. Production is on `a4078cf`,
epoch 8. Memory and personality work not started.
