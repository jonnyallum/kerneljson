# KJ-P2.1A — production outbox activation runbook

Status: **executed 2026-09-17 — PASS, with one real gap found and fixed live.**
See `docs/operations/PHASE_KJ_P2.1A_PRODUCTION_OUTBOX_ACTIVATION_RESULT_2026-09-17.md`
for the full evidence record. **AMENDMENT (post-execution):** this runbook as
originally written omitted `docs/operations/RELEASE_PROVENANCE.md`'s Step 5
`activate_release` call from Step 7's worker/door deploy. That omission
produced two real, correctly-detected P1 alerts the moment the new worker
started reporting `KERNELJSON_RELEASE_ID=1fbe6b2...` while
`kernel_private.release_epoch` still pointed at the prior release — resolved
live by calling `activate_release` (epoch 1→2), per RELEASE_PROVENANCE.md's
now-mandatory rule. Any future re-execution of Step 7 below must include that
call as part of the same step, not as an afterthought. Original text below is
preserved as the reviewed/approved plan; treat Step 7 as amended per this note.

Status (original): **prepared, not executed.** This is the concrete, executable runbook
for applying `supabase/migrations/20260917120000_notification_outbox.sql` to
production and putting the KJ-P2.1 durable notification-delivery path live,
built on KJ-P2.1's already-qualified design
(`docs/operations/NOTIFICATION_OUTBOX.md`) and code qualification
(`docs/operations/PHASE_KJ_P2.1_RELIABLE_NOTIFICATION_DELIVERY_CODE_QUALIFICATION_2026-09-17.md`).
Executing this runbook requires its own separate authorisation.

## Scope discipline

This window authorises **only**: applying the one named migration, deploying
the qualified worker/door release (code already on canonical `main`,
`1fbe6b22ed35394fb3a52c3735b6b4430d8ac9fa` or a later commit that includes it
as an ancestor), and observing the existing, already-enabled alert runner
begin exercising the new outbox path at its **unchanged** 300s cadence. It
does **not** authorise: changing `ALERT_RUNNER_ENABLED`,
`ALERT_RUNNER_CADENCE_MS`, or `ALERT_STATE_STORE`; wiring any real transport
(Telegram/WhatsApp/email — that is P2.2, a separate, later authorisation);
manufacturing a fault to test retry/poison; touching admission, schedule
state, or any business-side table; or any other pending migration.

## Critical ordering constraint (read before executing)

**The migration MUST be applied before the worker/door redeploy — never the
reverse.** This is the opposite order from the D1 execution-path and KJ-P1.3D
runbooks, and deliberately so: unlike those phases, the KJ-P2.1 code has no
feature flag gating the outbox probe. `runner-postgres.ts`'s
`postgresMonitorExclusive` unconditionally probes
`kernel_private.notification_outbox` on every tick once the new worker code is
running — if that code started before the migration existed, the probe would
throw, and the alert runner (currently healthy, PASS per KJ-P1.3A) would
regress to `STATE_FAILED` on every single tick until the migration lands. The
migration itself is inert against the currently-deployed old code (it never
references the new table), so applying it first has zero effect until the new
code is deployed — the safe order.

## Production reality this runbook is built for

Per `docs/operations/PHASE_KJ_P1.3A_ALERT_RUNNER_ACTIVATION_RESULT_2026-09-16.md`,
the production alert runner (`ProductionAlertMonitor/production`) is **already
live**, enabled, at a 300,000ms completion-relative cadence, with a durable
Restate continuation chain already in progress. This runbook does not start
that runner — it changes what the runner's already-running delivery step
does, from front of an already-healthy, already-observed system. The runner's
own durable-recurrence guarantee (proven in
`tests/alert-runner.integration.test.ts` and re-proven in this session's
post-merge qualification) means a worker restart during Step 7 below does
**not** create a second continuation chain or reset the sequence — the
persisted `nextSequence` in Restate state resumes exactly where it left off.

Also per that same freeze doc, the last **known** deployed release is
`49a93bb9a0a3b2c3f77a4ed778229704e3e038e7` (KJ-P1.3C's qualified SHA) — an
ancestor of this phase's canonical merge
(`git merge-base --is-ancestor 49a93bb... 1fbe6b2...` confirmed true in this
session). **This is a "last known" fact, not a live one** — time has passed;
re-verify the actual running release live in Step 2, the same way every prior
production runbook in this repo has, rather than trusting this document.

## Target identity (fixed for this runbook — verify, do not trust)

- Production Supabase project: `banqdzddfganzfhckdps` ("kerneljson") — never
  `lkwydqtfbdjhxaarelaz` (the Shared Brain, a different product).
- VM: `kerneljson-prod-01`, zone `europe-west2-b`, project
  `project-c407f628-c71c-45fa-994`, account `kerneljson@gmail.com`,
  `--tunnel-through-iap`. **This is KernelJSON's own dedicated production VM
  — distinct from, and unrelated to, the separate "estate" VM
  (`instance-20260717-082134`) referenced in this operator's global tooling
  notes, which hosts unrelated services (biz-os, mission-control,
  conductor-mcp, jai-os, n8n) and has never run any part of KernelJSON.**
- Repo checkout on VM: `/opt/kerneljson/app`.
- Canonical schedule (unaffected by this window, cited only for the
  business-isolation proof): `acab9ebc-dc92-5c3a-90d6-4d6f9ddb0a1b`.
- Approved release: canonical `main` `1fbe6b22ed35394fb3a52c3735b6b4430d8ac9fa`
  (KJ-P2.1's squash-merge) or a later commit with it as an ancestor — verified
  present and CI-green before this runbook runs (this session's own
  post-merge qualification, `dfa66c9` on top, is docs-only and does not change
  the deployed image's behaviour either way).
- Migration: `supabase/migrations/20260917120000_notification_outbox.sql`,
  exactly this file, no other pending migration.
- Deployment mechanism: reuse `docs/production/D1_EXECUTION_PATH_DEPLOYMENT_RUNBOOK.md`
  Stages 2/4/5/8–12 verbatim (checkout, build images, worker secret file,
  start/verify worker, register with Restate, switch door), substituting the
  target SHA and images throughout. Do not reinvent the deployment mechanism.

All secret handling in this runbook follows the same discipline used
throughout this programme: `DATABASE_URL` and the admission bearer are read
from already-provisioned, mode-600 runtime env files or derived
container-to-container (never typed, echoed, or passed as a literal
argument); no value is ever printed. Prefer `AgentHub\scripts\secretctl.py`
over hand-rolling any of this.

---

## Step 1 — Identify canonical production target

```
gcloud compute ssh kerneljson-prod-01 --zone=europe-west2-b \
  --project=project-c407f628-c71c-45fa-994 --account=kerneljson@gmail.com \
  --tunnel-through-iap --command="cd /opt/kerneljson/app && git remote -v && git rev-parse HEAD && git status --porcelain"
```
- CHECK: remote is `https://github.com/jonnyallum/kerneljson.git`.
- CHECK: working tree clean (empty porcelain).
- RECORD current `HEAD` as `PRIOR_SHA` (used for the ancestor check, rollback,
  and Step 2).
- STOP if the target does not match exactly, or the tree is dirty.

## Step 2 — Verify current release, worker/door parity, and whether a redeploy is needed

```
sudo docker exec kerneljson-execution-worker-1 printenv KERNELJSON_RELEASE_ID
sudo docker exec kerneljson-admission-door-gateway-1 printenv KERNELJSON_RELEASE_ID
```
- CHECK: both values identical (parity) — RECORD as the live `PRIOR_RELEASE`.
- On the workstation (not the VM):
  `git merge-base --is-ancestor <PRIOR_RELEASE> 1fbe6b22ed35394fb3a52c3735b6b4430d8ac9fa`
  — CHECK: true (the running code is an ancestor of the qualified merge, so a
  redeploy is a forward move, not a downgrade or a divergent branch).
  - If `PRIOR_RELEASE` is **already** `1fbe6b2` or a later commit that
    contains it, **no redeploy is needed** — skip to Step 5 after applying
    the migration (mirrors KJ-P1.3A's own "no redeploy required" finding).
  - If the ancestor check is **false** (the running release has diverged onto
    an unexpected branch), STOP and investigate before proceeding — do not
    assume a fast-forward is safe.

## Step 3 — Verify current alert-runner health (read-only, before any change)

Run `kerneljson alerts` (`ALERT_STATE_STORE=postgres`, the default) and
`kerneljson health` against production, using the currently-running release's
own compiled bundle (not a new one yet).
- CHECK: `kerneljson alerts` exit code `0`.
- CHECK: no P0/P1/P2 decision — the only expected decision is the known,
  already-documented `legacyAuthority.b1FreezeObservable` at P3/`notify:false`.
- CHECK (via the running Restate admin, `127.0.0.1:9070`):
  `POST /ProductionAlertMonitor/production/status` returns
  `{"enabled":true,"cadenceMs":300000,"nextSequence":N}` for some `N` — RECORD
  `N` as the pre-window sequence. This is the durable continuation this
  window must not reset or duplicate.
- STOP if anything else appears — an unrelated alert firing right before a
  production change is a reason to investigate first, not proceed.

## Step 4 — Confirm no risk to in-flight work (lighter than a full quiesce)

This migration adds two new tables under `kernel_private`; it does not touch
`task_admissions`, `schedule_fires`, `schedule_state`, or any admission-path
table. There is no business-admission quiescing requirement equivalent to
KJ-P1.3D's (that migration touched binding provenance on the hot admission
path; this one does not). Still, apply the same discipline for the deploy
half of this window (Steps 7–9 restart the worker container, which — per
"Production reality" above — is safe for the monitor's own continuation, but
any **business** admission mid-restart deserves the same caution as every
prior worker restart in this programme):
- CHECK Step 3's recorded next wake margin (via `kerneljson health`,
  `scheduler.nextWakeArmedAndFuture`) is not imminent — same conservative
  ~2-hour threshold as KJ-P1.3D's Step 3. If closer, reschedule this window.
- Do not manually trigger any admission or alert-runner tick during this
  window.

## Step 5 — Apply only the reviewed migration

Read the exact file content from the canonical checkout
(`/opt/kerneljson/app/supabase/migrations/20260917120000_notification_outbox.sql`,
after Step 6's checkout if a redeploy is happening, or from the current
checkout if Step 2 found no redeploy needed) inside **one transaction**,
mirroring KJ-P1.2A's and KJ-P1.3C's exact pattern:
- Pre-flight guard (fail closed, do not assume): refuse if
  `kernel_private.notification_outbox` or
  `kernel_private.notification_delivery_events` already exists, or if
  `supabase_migrations.schema_migrations` already has a row for version
  `20260917120000`.
- Apply inside `BEGIN`/`COMMIT`; on any error, `ROLLBACK` and report exact
  state — do not retry blindly.
- Insert the `schema_migrations` tracking row (`version`, `name`,
  `statements`) in the **same transaction**.
- Do not touch any other migration file.

**This step alone is the safe, permanent stopping point if the redeploy
(Steps 6–9) needs to be deferred** — an applied-but-unused migration is inert
against the currently-running old code, exactly like every prior migration in
this programme before its activation window.

## Step 6 — Verify schema

Read-only, immediately after commit:
- `select column_name, data_type from information_schema.columns where
  table_schema='kernel_private' and table_name='notification_outbox' order
  by ordinal_position` — CHECK: matches the migration file's 18 columns
  exactly (`notification_id` through `last_error`).
- CHECK: `unique (fingerprint, first_seen_at, kind, occurrence_count)`
  present; both partial/covering indexes present
  (`notification_outbox_due`, `notification_outbox_sending`).
- CHECK: `notification_delivery_events` present, FK to `notification_outbox`,
  `attempt_number`/`outcome`/`transport` columns present.
- CHECK: RLS enabled on both tables; `anon`/`authenticated`/`public` revoked
  (same query pattern already used and reported for KJ-P1.2A/KJ-P1.3C).
- CHECK: both tables currently **empty** (`select count(*) from
  kernel_private.notification_outbox` = 0, same for
  `notification_delivery_events`) — the correct pre-activation baseline.

## Step 7 — Deploy the qualified release (only if Step 2 found a redeploy needed)

Follow `docs/production/D1_EXECUTION_PATH_DEPLOYMENT_RUNBOOK.md` Stages 2, 4,
5, 8–12 **verbatim**, substituting:
- `SHA` = `1fbe6b22ed35394fb3a52c3735b6b4430d8ac9fa` (or the actual later
  commit checked in Step 1, if canonical main has moved since — re-verify CI
  green on whatever exact SHA is used).
- `WORKER_IMAGE` / `DOOR_IMAGE` tags derived from that SHA, per that runbook's
  own convention.
- **Do not** change `ALERT_RUNNER_ENABLED`, `ALERT_RUNNER_CADENCE_MS`, or
  `ALERT_STATE_STORE` in `runtime.env` — they must carry over unchanged from
  the currently-running configuration (`true` / `300000` / unset-defaulting-
  to-`postgres` respectively, per KJ-P1.3A). This is a code-only redeploy,
  not a configuration change.
- After the worker restarts: CHECK Step 3's recorded Restate sequence `N` —
  `POST /ProductionAlertMonitor/production/status` must show `nextSequence
  >= N` (never less; a reset to 0 would indicate a NEW, wrong object key or
  lost state — STOP immediately if seen). The pending delayed self-send from
  before the restart is expected to still be scheduled and to fire normally
  once due — do not manually re-send it.
- Door redeploy (D1 Stage 11) is only needed if the door image itself changed
  in this PR — **it did not** (KJ-P2.1's diff touches only
  `services/kernel/src/alerting/**`, consumed by the worker, not
  `apps/gateway/**`). Skip the door half of D1's Stages 11–12 unless the door
  image tag must also move for unrelated reasons; if skipped, still re-run
  D1's Stage 12 health/auth checks against the **existing** door to confirm
  it was undisturbed.

## Step 8 — Verify worker parity and Restate registration post-deploy

```
sudo docker exec kerneljson-execution-worker-1 printenv KERNELJSON_RELEASE_ID
```
- CHECK: equals the deployed SHA exactly; container healthy, `restarts=0`.
- CHECK: `POST /deployments {"uri":"http://worker:9080","force":true}` was
  sent (required for Restate to see any registration change — D1 Stage 9);
  `GET /services` still lists all 5 expected services, now including
  `ProductionAlertMonitor` alongside the 4 execution services (it was already
  registered before this window per KJ-P1.3A; confirm it is still present,
  not re-add it as new).

## Step 9 — Re-verify alert-runner health post-deploy

Re-run Step 3's checks.
- CHECK: still exit `0`, still zero P0/P1/P2 beyond the known B1 P3.
- CHECK: `ALERT_RUNNER_ENABLED`/`ALERT_RUNNER_CADENCE_MS` unchanged (`true` /
  `300000`) — confirm by reading the worker's own env, not by assumption.
- CHECK: `kernel_private.alert_state` row count and content unchanged from
  Step 3's baseline (the redeploy itself must not have caused a spurious
  re-evaluation or decision).

## Step 10 — Wait for the first natural post-cutover outbox row

Do **not** manually trigger a tick. Per "Production reality" above, the
existing durable chain continues on its own schedule. Given the ~300s
cadence, this requires only a short wait (unlike KJ-P1.3D's ~daily canary
cadence) — a single `ScheduleWakeup` at a few minutes is sufficient, checked
against the production server's own clock.
- CHECK: `POST /ProductionAlertMonitor/production/status`'s `nextSequence`
  has advanced by at least 1 since Step 9.
- Read-only: `select count(*) from kernel_private.notification_outbox` — if
  the health model produced any notify-worthy decision during this natural
  run (most likely: none, since production is currently healthy beyond the
  known B1 P3, which is `notify:false` and so never reaches the outbox at
  all), this is expected to still be `0`. **A `0` count here is success, not
  a gap** — it proves the new code path runs without error on a healthy
  system, exactly as KJ-P1.3A's own three observed runs did for the
  underlying alert engine. Do not manufacture a decision to force a non-zero
  count (see "Scope discipline").

## Step 11 — If a real outbox row DOES appear (opportunistic, not required)

Should production genuinely alert during the observation window (any
decision, including a recurrence of the known B1 gap surfacing differently,
or a real transient condition), this is the opportunity to observe the real
path end to end — passively, never induced:
- CHECK: the row's `status` transitions `PENDING` → `SENDING` → `DELIVERED`
  within one monitor cycle (or is still correctly `PENDING`/`SENDING` if
  observed mid-flight — re-check after the next cycle).
- CHECK: exactly one `kernel_private.notification_delivery_events` row with
  `outcome='DELIVERED'` for it once delivered.
- CHECK: the console output (worker logs) shows the corresponding safe,
  synthetic notification line (`ConsoleNotifier`'s `formatPayloadHuman`
  output) — never the raw check message.
- Record this as **live confirmation** of successful delivery + acknowledgement
  if it happens; its absence is not a failure (see Step 10).

## Step 12 — Retry-state and poison-semantics validation (cited proof, not induced)

**Do not induce a real transient or permanent failure in production to
exercise retry/backoff/poison** — this is explicit in scope discipline above,
mirroring KJ-P1.3D's Step 18 precedent ("do not induce a real fault ... this
step is satisfied by citing existing, already-passing proof"). This step is
satisfied by:
- Citing `tests/outbox-postgres.integration.test.ts` tests 7 (transient
  retry with backoff), 8 (poison after exhausting attempts), and 9
  (crash-after-delivery-before-acknowledgement, proven to deliver the same
  `notificationId` twice) — all passed against real disposable Postgres in
  this session's final qualification and again in post-merge qualification
  (`docs/operations/PHASE_KJ_P2.1_RELIABLE_NOTIFICATION_DELIVERY_CODE_QUALIFICATION_2026-09-17.md`).
- Confirming (read-only) that `kernel_private.notification_outbox`'s CHECK
  constraints are present and match the migration file exactly (Step 6) —
  the DB-level enforcement these tests depend on is schema-verified live, not
  assumed.
- If a genuine transient failure is passively OBSERVED during this window
  (e.g. a real, unrelated momentary Postgres blip), document it as live
  confirmation rather than discard it — but do not wait for or wish for one.

## Step 13 — Prove zero business-side effect

Read-only, compare to Step 1/3's baseline (reusing the exact `kj_dbcheck.mjs`
pattern from `D1_EXECUTION_PATH_DEPLOYMENT_RUNBOOK.md` Appendix A, or a
narrower equivalent scoped to just the counts below):
- CHECK: `task_admissions_total` unchanged.
- CHECK: `schedule_fires_total` unchanged.
- CHECK: `schedule_specs_enable` / `schedule_state` for the canonical
  schedule unchanged (still exactly as before this window — this migration
  and deploy never touch schedule state).
- CHECK: `kernel_private.execution_bindings` count unchanged.
- CHECK: the delivery-worker phase wrote **only** to
  `kernel_private.notification_outbox` /
  `kernel_private.notification_delivery_events` — never to
  `kernel_private.alert_state` (structurally guaranteed by the code, per
  `docs/operations/NOTIFICATION_OUTBOX.md`'s "Crash semantics" table; this
  step is the live, empirical confirmation of that structural guarantee).

---

## Rollback / STOP conditions

STOP immediately, without attempting further steps, if:
- Steps 1–4 (target/parity/health/margin checks) reveal anything ambiguous —
  wrong target, dirty tree, non-ancestor release divergence, unhealthy
  alert-runner, or the next wake margin too close.
- Step 5's migration apply errors for any reason — the transaction rolls back
  automatically; verify neither new table exists afterward, report exact
  state, do not retry blindly. **This alone is a safe, permanent state to
  stop in** — defer Steps 6–13 to a later window.
- Step 6's schema verification finds any divergence from the repository file.
- Step 7's deploy fails any health/parity check — roll back to the prior
  image/release exactly as `D1_EXECUTION_PATH_DEPLOYMENT_RUNBOOK.md`'s own
  Stage 14 specifies, substituting `PRIOR_RELEASE` from this runbook's Step
  2. **The migration from Step 5 is NOT rolled back merely because the
  deploy failed** — an applied-but-inactive migration is a safe, valid state
  (see Step 5's note).
- Step 8's Restate re-registration does not show `ProductionAlertMonitor`
  still present, or shows `nextSequence` having reset/gone backward.
- Step 9's post-deploy health check finds any P0/P1/P2, or finds
  `ALERT_RUNNER_ENABLED`/`ALERT_RUNNER_CADENCE_MS` changed from their prior
  values.
- Step 13's business-isolation check finds ANY unexpected change to
  admission/schedule/binding counts.
- At any point a P0/P1/P2 alert appears that is **not** the expected,
  documented `legacyAuthority` P3 — stop and investigate before proceeding
  further, regardless of which step is in progress.

## Final go / no-go checklist (all must be YES to declare KJ-P2.1A done)

- [ ] Migration `20260917120000_notification_outbox.sql` applied; schema
      verified column-by-column; both tables RLS-enabled, public/anon/
      authenticated revoked; both tables started empty.
- [ ] Worker (and door, if its image changed) running the qualified release
      (`1fbe6b2` or a later ancestor-including commit); parity confirmed.
- [ ] `ALERT_RUNNER_ENABLED=true`, `ALERT_RUNNER_CADENCE_MS=300000`,
      `ALERT_STATE_STORE=postgres` — all unchanged from pre-window values.
- [ ] Restate `ProductionAlertMonitor` registration intact; `nextSequence`
      strictly non-decreasing across the whole window; no second chain.
- [ ] At least one natural post-deploy monitor tick observed, `OK` or
      documented otherwise; zero P0/P1/P2 beyond the known B1 P3 throughout.
- [ ] `task_admissions_total`, `schedule_fires_total`, `schedule_state`,
      `execution_bindings` count — ALL unchanged vs the Step 1/3 baseline.
- [ ] Retry/poison/crash-recovery semantics cited from already-passing
      disposable-Postgres proof, not induced live.
- [ ] Rollback path (prior release/image) confirmed available and untested-
      but-ready throughout.

## Internal consistency check

No unresolved blocker: target identity, migration content, deploy mechanism
(reused verbatim from the already-proven D1 runbook), and every verification
step are each backed by either a prior, already-proven check in this
programme (production role/privileges, migration application pattern,
deploy mechanism, Restate registration/continuation durability) or an
already-passing automated test (atomic commit, dedup, retry/backoff, poison,
crash-after-ack duplicate behaviour — all reproven against real disposable
Postgres in this session, twice). The one genuinely new operational
constraint this phase introduces — **migration-before-deploy, reversed from
every prior runbook's order** — is derived directly from reading the actual
code (`runner-postgres.ts`'s unconditional outbox probe), not asserted.
