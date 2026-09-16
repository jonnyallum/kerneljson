# KJ-P1.3D — release provenance production activation runbook

Status: **prepared, not executed.** This document is Phase 2 of the KJ-P1.3
fast-lane sequence — a concrete, executable runbook for applying
`supabase/migrations/20260916205049_release_provenance.sql` to production and
activating epoch 1, built on the KJ-P1.3C adversarial review's already-approved
design (`docs/operations/RELEASE_PROVENANCE.md`). Executing this runbook (Phase
3) requires its own separate authorisation, exactly as the KJ-P1.3C review's
"Canonical activation protocol" section states.

## Scope discipline

This window authorises **only**: applying the one named migration, deploying
the approved release (worker + door images/env only), calling
`kernel_private.activate_release` exactly once, and validating the result. It
does **not** authorise: any other pending migration, an alert-policy change, a
scheduler-semantics change, or starting the alert-runner bootstrap (that is
Phase 4 / KJ-P1.3A, a separate authorisation after this one passes).

## Production reality this runbook is built for (read before executing)

KernelJSON production currently has **exactly one live admission source**: the
`claude_md_check` canary schedule (`acab9ebc-dc92-5c3a-90d6-4d6f9ddb0a1b`),
firing once daily at `08:00 UTC` via the admission door
(`127.0.0.1:8081`-only, no public listener — confirmed by
`npm run check:topology`). There is no separate "maintenance mode" flag on the
door today, and building one is explicitly out of scope for this window (see
"Scope discipline"). **Quiescing therefore means: perform this entire window
inside the natural gap between scheduled fires, and independently prove no
in-flight admission exists at the moment of migration/activation** — not
building new infrastructure. Total production admission volume to date is 23
across the whole project's history; this is a low-volume, low-risk window by
construction, not an assumption.

## Target identity (fixed for this runbook — verify, do not trust)

- Production Supabase project: `banqdzddfganzfhckdps` ("kerneljson", per this
  repo's own `supabase/.temp/linked-project.json` link and every prior
  production runbook in this repo — never `lkwydqtfbdjhxaarelaz`, the Shared
  Brain, a different product).
- VM: `kerneljson-prod-01`, zone `europe-west2-b`, project
  `project-c407f628-c71c-45fa-994`, account `kerneljson@gmail.com`,
  `--tunnel-through-iap`.
- Canonical schedule: `acab9ebc-dc92-5c3a-90d6-4d6f9ddb0a1b` — identity/version
  must not change in this window.
- Approved release: the canonical `main` SHA containing PR #31, verified
  present and CI-green before this runbook runs (KJ-P1.3C's own gate).
- Migration: `supabase/migrations/20260916205049_release_provenance.sql`,
  exactly this file, no other pending migration.

All secret handling in this runbook follows the same discipline used
throughout this programme: `DATABASE_URL` and the admission bearer are read
from already-provisioned, mode-600 runtime env files or derived
container-to-container (never typed, echoed, or passed as a literal argument);
no value is ever printed.

---

## Step 1 — Identify canonical production target

```
gcloud compute ssh kerneljson-prod-01 --zone=europe-west2-b \
  --project=project-c407f628-c71c-45fa-994 --account=kerneljson@gmail.com \
  --tunnel-through-iap --command="cd /opt/kerneljson/app && git remote -v"
```
- CHECK: remote is `https://github.com/jonnyallum/kerneljson.git`.
- CHECK (read-only, via a script executed inside the worker container using its
  own `DATABASE_URL`): `current_database()`/table ownership matches
  `banqdzddfganzfhckdps` conventions already established this programme (same
  read used for every prior production check).
- STOP if the target does not match exactly.

## Step 2 — Verify current release and release parity

```
sudo docker exec kerneljson-execution-worker-1 printenv KERNELJSON_RELEASE_ID
sudo docker exec kerneljson-admission-door-gateway-1 printenv KERNELJSON_RELEASE_ID
```
- CHECK: both values are identical (parity) and match the pre-activation
  baseline recorded in this window's evidence (expected `5a2335b...` at time of
  writing — re-read live, never assumed, since time may have passed).
- Record this as the **prior release** for rollback and for
  `activate_release`'s `previous_release_id` bookkeeping.

## Step 3 — Verify current scheduler/Restate health

Run `kerneljson health` (standalone compiled bundle, the established pattern —
`services/kernel/src/health` + `services/kernel/src/alerting`, built from the
exact commit being activated, `docker cp`'d into the worker container,
executed read-only) with `RESTATE_ADMIN_URL` and `EXPECTED_RELEASE_ID` set.
- CHECK: `scheduler.scheduleEnabled` HEALTHY, `enabled`/`v2`.
- CHECK: `scheduler.nextWakeArmedAndFuture` HEALTHY, and the armed
  `scheduled_start_at` is **hours away**, not imminent — record the exact
  margin. If the next wake is within a small safety margin (operator judgement
  at execution time, but treat anything under ~2 hours as too close), STOP and
  reschedule this window rather than race the scheduler.
- CHECK: `restate` domain fully HEALTHY (reachable, all 4 services registered,
  `restate.noStuckInvocation` HEALTHY).
- CHECK: `criticalIssues: 0`, `degradedIssues: 0`.

## Step 4 — Verify alert-state health

Run `kerneljson alerts` (`ALERT_STATE_STORE=postgres`, the default) against
production.
- CHECK: exit code `0` (the postgres probe succeeds — `kernel_private.alert_state`
  from KJ-P1.2A is already live).
- CHECK: no P0/P1/P2 decision. The only expected decision is the known,
  already-documented `legacyAuthority.b1FreezeObservable` at P3/`notify:false`.
- STOP if anything else appears — an unrelated alert firing right before a
  production change is a reason to investigate first, not proceed.

## Step 5 — Quiesce all binding writers

Given the "production reality" above, quiescing is: **confirm the migration +
deploy + activation sequence (steps 7–12) will complete well inside the gap to
the next scheduled fire** (per Step 3's margin), and **do not** manually
trigger any admission (no test task submission, no `/fire/send`) during this
window. No infrastructure change is made to "quiesce" — there is no
maintenance-mode flag to flip, and building one is out of scope for this
window.

## Step 6 — Prove no in-flight binding transactions remain

Read-only, via a script executed inside the worker container:
```sql
select id, status, created_at from sys_invocation
  where target_service_key = 'acab9ebc-dc92-5c3a-90d6-4d6f9ddb0a1b'
  and status not in ('completed','scheduled')
```
(against the Restate admin `/query` endpoint, the established introspection
mechanism this programme has used throughout).
- CHECK: zero rows — no invocation in a `running`/`suspended`/other
  in-progress state for the canonical schedule. The only non-`completed` row
  expected is the single durably-`scheduled` next wake (already accounted for
  in Step 3).
- Additionally: `sudo ss -tlnp | grep 8081` on the VM shows the door listening
  but CHECK no unexpected established connection is mid-request at the moment
  of migration (a lightweight sanity check, not the primary proof — the
  Restate query is the primary evidence since it is the only real writer path).
- STOP if anything is in flight.

## Step 7 — Apply only the reviewed migration

Read the exact file content from the canonical checkout
(`/opt/kerneljson/app/supabase/migrations/20260916205049_release_provenance.sql`,
after `git fetch`/`checkout` to the approved SHA — see Step 9's checkout,
performed here first since the migration file must come from the approved
commit, not a stale local copy) inside **one transaction**, mirroring KJ-P1.2A's
exact pattern (split on top-level `;`, or pass the whole file as one `query()`
call — the KJ-P1.3C Postgres test already proves the file applies correctly as
one combined statement batch):
- Pre-flight guard (fail closed, do not assume): refuse if
  `kernel_private.release_epoch` already exists, or if
  `supabase_migrations.schema_migrations` already has a row for version
  `20260916205049`.
- Apply inside `BEGIN`/`COMMIT`; on any error, `ROLLBACK` and report exact
  state — do not retry blindly.
- Insert the `schema_migrations` tracking row (`version`, `name`,
  `statements`) in the **same transaction**, matching the convention already
  established for every migration this programme has applied
  (`20260910180000_scheduler`, `20260915220000_alert_state`).
- Do not touch any other migration file.

## Step 8 — Verify epoch-0 baseline

Read-only, immediately after commit:
- `select * from kernel_private.release_epoch` — CHECK: exactly one row,
  `epoch=0`.
- `select count(*) from kernel_private.release_activations` — CHECK: `0`.
- `select release_epoch, persisted_at from kernel_private.execution_bindings
  order by release_epoch limit 5` — CHECK: every existing row is
  `release_epoch=0, persisted_at=NULL` (no fabricated historical timestamp —
  exactly what the migration comment and the KJ-P1.3C Postgres test both
  guarantee).
- Verify schema shape matches the repository file exactly (columns, the 2
  explicit indexes + PK, the 6 constraints, RLS enabled) — the same
  verification pattern already used and reported for KJ-P1.2A.

## Step 9 — Deploy the approved release

Established mechanism for this project (see
`docs/production/D1_EXECUTION_PATH_DEPLOYMENT_RUNBOOK.md`, the original
worker/door deployment runbook — reused verbatim, not reinvented):

1. On the VM, `sudo git -C /opt/kerneljson/app fetch && sudo git -C
   /opt/kerneljson/app checkout --detach <APPROVED_SHA>`; verify `git status
   --porcelain` is empty and `HEAD` == the approved SHA.
2. Build images from that checkout: `sudo docker build -f
   infrastructure/docker/worker.Dockerfile -t
   kerneljson-worker:<short-sha> /opt/kerneljson/app` and the equivalent for
   `gateway.Dockerfile` / `kerneljson-admission-door:<short-sha>`. Do not push
   images externally.
3. Update `KERNELJSON_RELEASE_ID` to `<APPROVED_SHA>` in both
   `/opt/kerneljson/runtime/worker/runtime.env` and a freshly-derived
   `/opt/kerneljson/runtime/door/dispatch.env` (derived from the door's own
   live env, per the D1 runbook's Stage 11 pattern — mode 600 throughout,
   value never printed).
4. `sudo -E docker compose --env-file .../runtime.env -f <execution-compose>
   up -d worker` with `KJ_WORKER_IMAGE=kerneljson-worker:<short-sha>`
   exported; verify healthy, `restarts=0`, correct `KERNELJSON_RELEASE_ID`.
5. Re-register the worker with Restate (`POST /deployments`,
   `{"uri":"http://worker:9080","force":true}`); verify `/services` lists all
   4 expected services.
6. `sudo -E docker compose --env-file .../dispatch.env -f
   <gateway-compose> up -d --force-recreate` for the door, with the same
   `KJ_WORKER_IMAGE` export (harmless for the gateway compose) and
   `KJ_RESTATE_INGRESS_URL=http://restate:8080` (service name — **never**
   `127.0.0.1:8080`, which inside the door container is the door itself).
   Verify `:8081` still `127.0.0.1`-only, `healthz=200`, unauthenticated
   `POST /v1/tasks` still `401`.

## Step 10 — Verify worker/door parity

```
sudo docker exec kerneljson-execution-worker-1 printenv KERNELJSON_RELEASE_ID
sudo docker exec kerneljson-admission-door-gateway-1 printenv KERNELJSON_RELEASE_ID
```
- CHECK: both equal the approved SHA, exactly.
- CHECK: both containers healthy, `restarts=0`.
- Re-run Step 3/4's health/alert checks — CHECK: still 0 P0/P1/P2, scheduler
  still enabled/healthy, next wake still hours away and unchanged (the deploy
  must not have touched schedule state).

## Step 11 — Call `activate_release` exactly once

As the deployment database owner (the same `postgres` connection already
verified this session to own every `kernel_private` object), in a **dedicated
transaction**, exactly as `RELEASE_PROVENANCE.md` specifies:

```sql
BEGIN;
SET LOCAL lock_timeout = '10s';
SELECT kernel_private.activate_release(
  :request_uuid,        -- freshly generated for this window, used for every retry within it
  :approved_release_id, -- the exact deployed SHA from Step 9/10
  0,                    -- expected_epoch: 0, verified in Step 8
  :evidence_json         -- non-secret: operator identity, change-window reference,
                          -- verified parity, quiescence margin, baseline qualification —
                          -- no secret value, ever
);
COMMIT;
```
- One request UUID for the whole window — if the call must be retried (e.g.
  `lock_timeout` fires), retry with the **same** UUID; `activate_release`'s
  own idempotency guarantees a retry cannot create a second epoch.
- On timeout/error: do **not** guess success. Keep the window open, inspect
  `kernel_private.release_epoch`/`release_activations` state directly, and
  only retry once the actual state is known.
- Do not call this function a second time with a different UUID "just to be
  sure" — that would be a second, real activation attempt, not idempotent
  verification.

## Step 12 — Verify the new epoch committed

- `select * from kernel_private.release_epoch` — CHECK: `epoch=1`.
- `select * from kernel_private.release_activations where epoch=1` — CHECK:
  one row, `request_id` matches Step 11's UUID, `release_id` matches the
  approved SHA, `previous_release_id` is `NULL` (activating from the epoch-0
  baseline).
- A committed-epoch check alone is not proof — also independently re-read
  `release_epoch` in a **fresh** connection/transaction (not reusing Step 11's
  session) to confirm the commit is durably visible.

## Step 13 — Reopen admissions

There is no maintenance-mode flag to reverse (see Step 5) — "reopening" here
means: the door is already serving (Step 9/10 already verified `healthz=200`
and correct `401` responses). Confirm no artificial block was ever introduced,
and that the system is now simply waiting for the next natural admission.

## Step 14 — Wait for one legitimate natural post-cutover binding

Do **not** manually trigger a fire or submit a synthetic task — the KJ-P1.3C
review and `RELEASE_PROVENANCE.md` are both explicit: "never mint synthetic
production work to turn the gate green." Wait for the schedule's own next
natural wake (already durably armed, verified in Step 3/10). Given the
observed ~daily cadence, this may require the same kind of chained,
capped-at-1-hour `ScheduleWakeup` countdown used during S1D2's own natural-wake
observation, checked against the production server's own clock (not the
scheduler's displayed local time — S1D2 found a real clock-offset gotcha
there).

## Step 15 — Prove it landed in the active epoch

Read-only: `select release_epoch, persisted_at from execution_bindings where
task_id = <the new admitted task's id>`.
- CHECK: `release_epoch = 1`.
- Cross-check via `collectBindingProvenance`/the health check (Step 16) rather
  than only a raw row read.

## Step 16 — Rerun health

Run `kerneljson health` again (fresh bundle, same production).
- CHECK: `authority.bindingReleaseConsistent` and
  `releaseParity.recentBindingsConsistent` both HEALTHY (the new binding
  supplies a genuine current-epoch observation; `NO_OBSERVATION` before this
  point was correctly UNKNOWN, not a failure).
- CHECK: `criticalIssues: 0`.

## Step 17 — Prove historical old-release binding no longer false-alarms

The pre-migration bindings (all 23, now `release_epoch=0`) must not
contribute to `mismatchedBindingCount`/`missingProvenanceCount`. This is
already proven in the code-qualification suite (`tests/release-provenance.test.ts`'s
"current release and historical baseline" case,
`tests/release-provenance-postgres.test.ts`'s multi-release test) — Step 16's
HEALTHY result against **real** historical data (23 genuine epoch-0 rows, not
a synthetic fixture) is the live confirmation that the fix this whole KJ-P1.3B→C
arc exists for actually holds in production.

## Step 18 — Prove any wrong post-cutover binding would still be CRITICAL/P1

**Do not induce a real fault to test this in production** — the correctness of
this property is already proven exhaustively by
`tests/release-provenance-postgres.test.ts`'s "overlapping old writer after
activation is stamped into new epoch and CRITICAL" test, against real
Postgres, and by the alert-policy mapping verified in KJ-P1.3C's review
(`authority.bindingReleaseConsistent` CRITICAL → P1). This step is satisfied
by **citing that existing, already-passing proof**, not by manufacturing a
live incident.

---

## Rollback / STOP conditions

STOP immediately, without attempting further steps, if:
- Steps 1–6 (precheck/quiesce/in-flight proof) reveal anything ambiguous —
  wrong target, release mismatch, unhealthy scheduler/Restate/alert-state,
  next wake too close, or any in-flight invocation.
- Step 7's migration apply errors for any reason — the transaction rolls back
  automatically; verify `kernel_private.release_epoch` does **not** exist
  afterward, report exact state, do not retry blindly.
- Step 8's post-apply schema verification finds any divergence from the
  repository file.
- Step 9's deploy fails any health/parity check — roll back to the prior
  images/env (`baseline.env`/prior release tag), exactly as
  `D1_EXECUTION_PATH_DEPLOYMENT_RUNBOOK.md`'s own per-stage rollback commands
  specify. The migration from Step 7 is **not** rolled back merely because the
  deploy failed — epoch 0 with no activation is a safe, valid, permanent state
  to sit in if the deploy needs to be retried later.
- Step 11's `activate_release` call errors, times out, or its result is
  uncertain — do not guess. Re-read state in a fresh transaction before
  deciding whether to retry (same request UUID only).
- Step 12's verification fails — the epoch did not durably commit to `1`, or
  the activation row doesn't match what was requested.
- At any point a P0/P1/P2 alert appears that is **not** the expected,
  documented `legacyAuthority` P3 — stop and investigate before proceeding
  further, regardless of which step is in progress.
- If a genuine rollback of an **already-activated** release is ever needed:
  per `RELEASE_PROVENANCE.md`, this requires the **same** full
  quiesce/parity/new-epoch protocol for the restored release (a **new**
  explicit epoch/request, never rewriting history) — never a raw `UPDATE` on
  `release_epoch`/`release_activations` (both are immutable/trigger-protected
  by design).

## Internal consistency check

No unresolved blocker: target identity, migration content, deploy mechanism,
activation call, and every verification step are each backed by either a
prior, already-proven check this session (production role/privileges,
migration application pattern, deploy mechanism from the D1 runbook) or an
already-passing automated test (transaction ordering, trigger enforcement,
activation idempotency, health semantics). The one operationally-judgement
item (Step 3's "next wake margin") is explicitly left to be verified live,
with a stated conservative threshold, rather than hard-coded — appropriate for
a runbook, not a gap.
