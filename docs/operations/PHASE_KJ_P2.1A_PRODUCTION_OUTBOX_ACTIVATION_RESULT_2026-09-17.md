# KJ-P2.1A — Production Outbox Activation — RESULT

**Status: PASS**
**Window: 2026-09-17T21:26Z – 22:00Z (approx.)**
**Runbook: `docs/operations/PHASE_KJ_P2.1A_PRODUCTION_OUTBOX_ACTIVATION_RUNBOOK_2026-09-17.md`
(executed with one live amendment — see "Deviations" below)**
**Code qualification: `docs/operations/PHASE_KJ_P2.1_RELIABLE_NOTIFICATION_DELIVERY_CODE_QUALIFICATION_2026-09-17.md`,
PR #32, canonical merge `1fbe6b22ed35394fb3a52c3735b6b4430d8ac9fa`**

## Summary

The KJ-P2.1 durable notification outbox is now live in production. The
migration (`supabase/migrations/20260917120000_notification_outbox.sql`) is
applied and schema-verified exactly against the reviewed file. The worker and
admission door are both redeployed to the qualified release
(`1fbe6b22ed35394fb3a52c3735b6b4430d8ac9fa`), release-epoch-activated
(epoch 1→2), and verified at true parity. The outbox mechanism proved itself
for real in production during this window: two genuine P1 alerts (a
consequence of the deploy, not induced) were queued, delivered, acknowledged,
and — once the root cause was fixed — recovered/deescalated through the outbox
cleanly, with zero duplicate delivery and zero stuck/poisoned rows. Zero
business-side effect throughout: `task_admissions`, `schedule_fires`,
`execution_bindings`, and canonical schedule state are all unchanged from the
pre-window baseline.

Two real deviations occurred during execution, both disclosed as they
happened and both fully remediated — see "Deviations" below.

## Pre-flight (read-only, before any change)

- Target confirmed: `kerneljson-prod-01`, `europe-west2-b`,
  `project-c407f628-c71c-45fa-994`, remote `jonnyallum/kerneljson.git`, tree
  clean.
- HEAD `49a93bb9a0a3b2c3f77a4ed778229704e3e038e7` — matched the "last known
  deployed release" recorded in the runbook exactly; no drift.
- Worker/door parity confirmed: both `49a93bb...`, both `running`,
  `restarts=0`.
- Restate: admin `/health` 200; 5 services registered including
  `ProductionAlertMonitor`; monitor status
  `{"enabled":true,"cadenceMs":300000,"nextSequence":154}`.
- `kernel_private.alert_state`: 2 rows, both P3 (the known, documented
  `legacyAuthority.b1FreezeObservable` and a historical `RECOVERED`
  `authority.bindingReleaseConsistent`). Zero P0/P1/P2.
- `kernel_private.notification_outbox` / `notification_delivery_events`: did
  not exist. No `20260917120000` row in `schema_migrations`.
- Business baseline: `task_admissions_total=25`, `schedule_fires_total=6`,
  `execution_bindings_total=26`, canonical schedule `enabled`/`v2`.
- Next scheduled wake: `2026-09-18T08:00:00.011Z` — ~10.5h away, well clear of
  the runbook's 2-hour margin threshold.
- `kernel_private.release_epoch`: `epoch=1`, `release_id=49a93bb...` (from
  KJ-P1.3D).

## Migration application

Migration content verified byte-identical to the reviewed, CI-tested git blob
(`git show 1fbe6b2:...` sha256 `2163f11e...`) before application — a local
Windows working-tree hash mismatch was investigated and correctly attributed
to `core.autocrlf` (CRLF conversion), not a content divergence; the canonical
LF blob was used for the actual apply.

Applied inside one transaction with a pre-flight guard (refused if either
table or the `schema_migrations` row already existed — none did). Result:
`{"result":"APPLIED","version":"20260917120000","name":"notification_outbox","statementCount":10}`.

Schema verified column-by-column against the migration file: 18 columns on
`notification_outbox`, 7 on `notification_delivery_events`; 10 constraints
(unique, PK, 2 table-level CHECKs, 5 column CHECKs) on the former, 4 (PK, FK,
2 CHECKs) on the latter; 4 indexes (2 explicit + PK + the unique constraint's
own); RLS enabled on both; zero grants to `anon`/`authenticated`/`public`.
Both tables started empty.

## Deployment

Worker: checked out `1fbe6b22ed35394fb3a52c3735b6b4430d8ac9fa` (ancestor
check against prior `49a93bb...` confirmed true first), built
`kerneljson-worker:1fbe6b2`, verified `Cmd` matches the established
entrypoint, deployed via the existing `execution.compose.yaml` mechanism with
the existing (unchanged) `ALERT_RUNNER_ENABLED=true`,
`ALERT_RUNNER_CADENCE_MS=300000`, `ALERT_STATE_STORE=postgres`. Verified
`healthy`, `restarts=0`, `KERNELJSON_RELEASE_ID=1fbe6b2...`.

Door: rebuilt and redeployed to the same release (see "Deviations" — this
was not originally planned, but became necessary for correct parity).
Verified `healthy`, `restarts=0`, `127.0.0.1:8081` only, `healthz=200`,
`noauth=401`, `badbearer=401`, `KERNELJSON_RELEASE_ID=1fbe6b2...` — exact
match with the worker.

Worker re-registered with Restate (`POST /deployments {force:true}`);
`ProductionAlertMonitor` confirmed still present in `/services` alongside the
other 4 expected services, same as before the redeploy — no new registration
event, no second chain.

## Release-provenance activation

`kernel_private.activate_release` called in a dedicated transaction:
request UUID `5c8dd08b-5502-4ac4-b063-9f6633434311`, release
`1fbe6b22ed35394fb3a52c3735b6b4430d8ac9fa`, expected epoch `1`. Function
returned `2`. **Independently re-verified from a fresh connection**
(separate from the activating session):

| Field | Value |
|---|---|
| `release_epoch.epoch` | `2` |
| `release_activations` epoch-2 row count | exactly 1 |
| epoch-2 `release_id` | `1fbe6b22ed35394fb3a52c3735b6b4430d8ac9fa` |
| epoch-2 `previous_release_id` | `49a93bb9a0a3b2c3f77a4ed778229704e3e038e7` |
| epoch-2 `request_id` | `5c8dd08b-5502-4ac4-b063-9f6633434311` |
| epoch-1 row (unchanged, for provenance continuity) | `release_id=49a93bb...`, `request_id=4ec8c043-2db7-41e0-ae9e-981e96076d8b` (KJ-P1.3D's own activation, untouched) |

## The outbox proved itself live (unplanned, but real)

The worker redeploy caused two genuine P1 decisions on the very next tick
(sequence 158) — `authority.bindingReleaseConsistent` and
`releaseParity.recentBindingsConsistent`, both `NEW`, because the worker now
self-reported `1fbe6b2` while the database's release-epoch system still
pointed at `49a93bb` (the root cause — see "Deviations"). This was **not**
induced to manufacture an outbox row; it was a real consequence of the
deploy, and the whole point of this activation was to prove the outbox
handles a real production alert correctly — which it did:

| Tick | Time | Overall | Decisions | Queued | Delivery |
|---|---|---|---|---|---|
| 158 | 21:46:35 | CRITICAL | 2× NEW (P1) | 2 | attempted 2, delivered 2, retried 0, poisoned 0 |
| 159 | 21:51:36 | CRITICAL | 0 (dedup — ONGOING) | 0 | attempted 0 |
| 160 | 21:56:36 | UNKNOWN | 1× RECOVERED (releaseParity), 1× DEESCALATED (authority) | 2 | attempted 2, delivered 2, retried 0, poisoned 0 |

Both original P1 notifications and both recovery/deescalation notifications
show exactly one `DELIVERED` delivery-event row each (4 notifications, 4
events total — zero duplicates). Final `notification_outbox` status
distribution: `{"DELIVERED": 4}` — zero `PENDING`, zero `SENDING`, zero
`POISON`. Final `alert_state`: zero rows at `OPEN` P0/P1/P2 severity; a fresh
`kerneljson health` run after the activate_release fix shows
`criticalIssues:0, degradedIssues:0`, with
`authority.bindingReleaseConsistent`/`releaseParity.recentBindingsConsistent`
both `UNKNOWN: NO_OBSERVATION` (correct and expected — no binding has
occurred under the new epoch yet, since zero task admission happened this
window; this exactly matches the precedent recorded in KJ-P1.3A's own freeze
doc for the analogous post-cutover state).

## Business-side isolation (before / after, identical)

| Counter | Before | After |
|---|---|---|
| `task_admissions_total` | 25 | 25 |
| `schedule_fires_total` | 6 | 6 |
| `execution_bindings_total` | 26 | 26 |
| Canonical schedule state | `enabled`/`v2` | `enabled`/`v2` |

Zero admission, fire, or binding was created by any step in this window.

## Continuation, restart, and health invariants

- Restate `sys_invocation` non-completed rows at close: exactly one
  `ProductionAlertMonitor/production` (`scheduled`) and exactly one
  `ScheduleDriver/acab9ebc-...` (`scheduled`, unrelated, unaffected) — no
  second chain, no orphaned invocation.
- Monitor sequence progressed naturally and monotonically throughout:
  154 (pre-window) → 158 → 159 → 160 → 161 → 162 (close), cadence unchanged
  at `300000`.
- `restarts=0` on worker, door, and Restate throughout — every deploy in this
  window was a deliberate `up -d`/`force-recreate`, never a crash-triggered
  automatic restart.
- Door `127.0.0.1:8081`-only binding re-confirmed after every recreate.

## Deviations (both disclosed live, both fully remediated)

1. **Secret leak.** A `grep -vE '^(DATABASE_URL)='` read of the worker's
   runtime env file, intended to show non-secret config, also contained
   `KJ_ADMISSION_BEARER` — a second secret the exclusion pattern didn't name.
   It printed into the session transcript. Disclosed immediately. Remediated:
   new 43-character value generated file-to-file (never as an argument),
   written to jVault (`kerneljson/KJ_ADMISSION_BEARER`, sha8 `AE2965D1` →
   `8ABA1F70`) and all four VM files that held a copy — the worker's
   `runtime.env`, the door's live `dispatch.env`, the door's rollback
   `baseline.env` (so a future rollback cannot resurrect the burned value),
   and a legacy `admission-door/runtime.env` copy — all verified consistent
   by sha8 fingerprint only, never by printing the value again. All transit
   copies shredded. Door recreated to pick up the new value; verified
   `noauth=401`/`badbearer=401` throughout. **Permanent fix**: see
   `~/.claude/CLAUDE.md`'s secret-handling section, "Fourth leak" entry —
   exclusion-list reads of files that may hold secrets are now a documented
   anti-pattern; use allow-lists instead.
2. **Release-provenance omission.** The runbook's Step 7 deployed a new
   worker/door release without calling `activate_release`, because it was
   written without cross-referencing `docs/operations/RELEASE_PROVENANCE.md`,
   which already documented this exact requirement (from KJ-P1.3C). This
   produced the two real P1 alerts described above. Remediated live via the
   canonical `activate_release` protocol (epoch 1→2, see above), independently
   re-verified. **Permanent fix**: `RELEASE_PROVENANCE.md` now carries a
   MANDATORY section stating this requirement explicitly for any future
   release-changing runbook; `D1_EXECUTION_PATH_DEPLOYMENT_RUNBOOK.md` (the
   shared deployment mechanism every such runbook reuses) carries a matching
   pointer; this runbook's own file is amended with a correction note.
3. **Consequence of #1: an incidental door image build.** While fixing the
   bearer, the door's `gateway.compose.yaml` was recreated once without its
   correct `KJ_GATEWAY_IMAGE` variable set, producing a stray, freshly-built
   `kerneljson-admission-door:dev` image (functionally fine — same source —
   but wrong provenance tagging). Caught immediately by checking the running
   image tag rather than assuming success; rebuilt properly tagged
   (`:49a93bb` at the time, later `:1fbe6b2` once the release moved) and the
   stray `:dev` image removed. No functional impact at any point — door
   health/auth were correct throughout, including during the mistagged
   window.
4. **Consequence of #2: a real worker/door release-ID mismatch window.**
   After updating `KERNELJSON_RELEASE_ID` in both `runtime.env` and
   `dispatch.env`, only the worker was actually redeployed at first — the
   door kept running its prior process env (`49a93bb`) until this was caught
   by an explicit live check (comparing `printenv` output on both running
   containers, not trusting the files). Fixed by rebuilding and redeploying
   the door a second time at the correct release. Verified no admission was
   attempted during the mismatch window (business counters unchanged
   throughout), so this never manifested as a real rejection — but it was a
   real latent risk until fixed, since the next natural schedule fire would
   have hit it. **Lesson embedded in this result**: after any change to
   `KERNELJSON_RELEASE_ID` in an env file, verify the actual running
   container's `printenv` output, not just the file content, for every
   component that reads it.

No rollback was required at any point. No secret value appears anywhere in
this document or was printed more than the one disclosed instance.

## Conclusion

**KJ-P2.1A PRODUCTION OUTBOX ACTIVATION — PASS.** Migration applied and
schema-verified. Worker and door both deployed to the qualified release,
verified at true parity. Release-provenance epoch advanced and independently
re-verified. The outbox delivered two real production alerts correctly,
including their recovery, with zero duplicate delivery, zero stuck/poisoned
rows, and zero business-side effect. Both real deviations (a secret leak and
a missing release-activation step) were caught, disclosed, and fully
remediated, and both are now encoded as permanent operating rules in the
canonical documentation rather than left as one-off fixes.

**Remaining risk:** none identified as unresolved. `authority.bindingReleaseConsistent`/
`releaseParity.recentBindingsConsistent` will report their first genuine
`HEALTHY` (rather than the current, correct `UNKNOWN`) only once a real
binding occurs under epoch 2 — expected at the next natural schedule fire,
`2026-09-18T08:00:00.011Z`, requiring no further action.
