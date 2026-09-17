# KJ-P1.3A — Production Alert Runner Activation — RESULT

**Status: PASS**
**Window: 2026-09-17T08:3X – 08:46Z**
**Prerequisite: KJ-P1.3D PASS** (`docs/operations/PHASE_KJ_P1.3D_RELEASE_PROVENANCE_PRODUCTION_ACTIVATION_RESULT_2026-09-16.md`)
**Design: `docs/operations/ALERT_RUNNER.md`, code qualification: `docs/operations/PHASE_KJ_P1.3_ALERT_RUNNER_RESULT_2026-09-16.md` (PR #29, merged, already present in deployed release `49a93bb`)**

## Summary

`ProductionAlertMonitor/production` — the durable, Restate-driven observational
alert runner prepared in KJ-P1.3 — is now live in production at a five-minute
completion-relative cadence. No redeploy was required: PR #29's code is already
an ancestor of the currently-deployed `49a93bb` release, so activation was
purely a configuration change (`ALERT_RUNNER_ENABLED=true`) plus one Restate
deployment re-registration and a single bootstrap invocation. Three runs were
observed (one bootstrap + two natural recurrences), all clean: zero P0/P1/P2,
zero overlaps, zero errors, monotonic sequence, no business-side task, fire,
or binding was minted by the monitor at any point.

## Pre-flight (read-only, before any change)

- `kernel_private.alert_state` table present (migration `20260915220000`), 2
  pre-existing rows, `current_user=postgres`.
- Database connection confirmed session-pooled (port `5432` on the Supabase
  pooler host, not the `6543` transaction-pooling port) — required for the
  runner's session-advisory-lock contract.
- Advisory lock `(1263153235, 13)` confirmed free (`pg_try_advisory_lock`
  returned `true`, then released) — no stray/unlocked alert CLI writer to
  quiesce.
- Baseline `alert_state`: zero P0/P1/P2. Two pre-existing P3 rows:
  `legacyAuthority.b1FreezeObservable` (permanent, by design, `notify:false`)
  and `authority.bindingReleaseConsistent` (a transient artifact of the
  KJ-P1.3D pre-activation UNKNOWN window, expected to self-recover).
- Worker/door both healthy, `restarts=0`.

## Activation steps

1. Appended `ALERT_RUNNER_ENABLED=true`, `ALERT_RUNNER_CADENCE_MS=300000`,
   `ALERT_STATE_STORE=postgres` to `/opt/kerneljson/runtime/worker/runtime.env`
   (mode 600; two of the three already matched compose defaults, set
   explicitly anyway for auditability).
2. Recreated `kerneljson-execution-worker-1` from the existing
   `kerneljson-worker:49a93bb` image (no rebuild — same release, config-only
   change). Healthy immediately, `restarts=0`, `KERNELJSON_RELEASE_ID`
   unchanged.
3. Re-registered the worker's deployment with Restate
   (`POST /deployments {"uri":"http://worker:9080","force":true}`) — required
   for Restate to pick up the newly-enabled `ProductionAlertMonitor` service;
   the container recreation alone did not trigger discovery. Registration
   response confirmed `ProductionAlertMonitor` (`VirtualObject`, handlers
   `status` [Shared] and `tick` [Exclusive]) alongside the 4 pre-existing
   services, all under one deployment revision.
4. Checked `POST /ProductionAlertMonitor/production/status` before bootstrap:
   `{"enabled":true,"cadenceMs":300000,"nextSequence":0}` — confirmed fresh,
   no prior chain.
5. Sent exactly one `POST /ProductionAlertMonitor/production/tick/send`
   `{"sequence":0}` → `202 Accepted`, `invocationId=inv_18BewE5hSqPf2414qX830Q0saVbod1fufx`.

## Observed runs

| Sequence | Started | Completed | Duration | overall | P0/P1/P2/P3 | notifications | result |
|---|---|---|---|---|---|---|---|
| 0 (bootstrap) | 08:35:42.396Z | 08:35:42.825Z | 428ms | UNKNOWN | 0/0/0/1 | 1 attempted, 0 failed | OK |
| 1 (natural) | 08:40:42.864Z | 08:40:43.100Z | 236ms | UNKNOWN | 0/0/0/0 | 0 | OK |
| 2 (natural) | 08:45:43.118Z | 08:45:43.315Z | 197ms | UNKNOWN | 0/0/0/0 | 0 | OK |

Gaps between runs: run 0→1 = 300,039ms; run 1→2 = 300,018ms — both match the
documented ~300,000ms completion-relative delay exactly (not fixed
wall-clock). `overall: UNKNOWN` at each run reflects genuinely unresolved
UNKNOWN checks elsewhere in the health model (execution restart-count
evidence not wired to this environment, and the explicitly out-of-scope
`legacyAuthority.b1FreezeObservable`) — not a runner defect.

`POST /ProductionAlertMonitor/production/status` after run 2:
`{"enabled":true,"cadenceMs":300000,"nextSequence":3}` — sequence strictly
monotonic (0→1→2→3), exactly one pending continuation at every check point,
no duplicate chain.

## Overlap, errors, business-side isolation

- `docker logs` across the full window: no `OVERLAP_SKIPPED`, no
  `DUPLICATE_OR_OUT_OF_ORDER`, no error events besides the expected
  `alert_monitor_started`/`alert_monitor_run` pairs.
- `schedule_fires` total for the canonical schedule: **6 before and after** —
  unchanged across all 3 monitor runs. The monitor minted zero fires.
- `kernel_private.execution_bindings` total: **26 before and after** —
  unchanged. The monitor minted zero tasks/bindings.
- `kerneljson-execution-worker-1`: `restarts=0, health=healthy` throughout.

## B1 / durable state correctness

```json
[
  {
    "check_id": "legacyAuthority.b1FreezeObservable",
    "severity": "P3", "current_state": "OPEN",
    "occurrence_count": 6, "last_notified_at": null, "recovered_at": null
  },
  {
    "check_id": "authority.bindingReleaseConsistent",
    "severity": "P3", "current_state": "RECOVERED",
    "occurrence_count": 1,
    "last_notified_at": "2026-09-17T08:35:42.790Z",
    "recovered_at": "2026-09-17T08:35:42.790Z"
  }
]
```

- `legacyAuthority.b1FreezeObservable` stayed `OPEN`, `severity=P3`,
  **`last_notified_at: null` throughout** — B1 remains P3/notify:false exactly
  as designed; `occurrence_count` correctly incremented once per run
  (4→5→6) without ever notifying.
- `authority.bindingReleaseConsistent` transitioned `OPEN → RECOVERED` on run
  0 (the first run after KJ-P1.3D's activation made the underlying check
  HEALTHY) and correctly stayed `RECOVERED` on runs 1 and 2 — no repeated
  recovery-notification storm. This closes the entire KJ-P1.3B → KJ-P1.3C →
  KJ-P1.3D → KJ-P1.3A arc: the original false-alarm check is now durably
  healthy and the alert engine watching it is itself durably running in
  production.
- Durable state persisted correctly across all 3 runs, confirmed by direct
  Postgres reads independent of the runner's own session.

## Deviations from the runbook

1. `ProductionAlertMonitor` did not appear in Restate's `/deployments` listing
   immediately after the worker container was recreated with
   `ALERT_RUNNER_ENABLED=true` — recreating the container is not sufficient by
   itself; Restate's control plane needed the same explicit
   `POST /deployments {force:true}` re-registration call used for every prior
   worker redeploy in this programme. Not anticipated verbatim in the runbook
   text but consistent with the established deployment mechanism documented
   in `docs/production/D1_EXECUTION_PATH_DEPLOYMENT_RUNBOOK.md`.
2. No rollback was required at any point.

## Conclusion

**KJ-P1.3A PRODUCTION ALERT RUNNER ACTIVATION — PASS.**
