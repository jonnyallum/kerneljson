# KJ-P2.1 / KJ-P2.1A — FINAL CLOSURE

**Status: FULLY CLOSED**
**Verification window: 2026-09-18T09:07Z – 09:10Z (read-only only, no production mutation)**
**Precondition verified: verified after the natural 08:00 UTC / 09:00 UK canonical
schedule fire, per `docs/operations/PHASE_KJ_P2.1A_PRODUCTION_OUTBOX_ACTIVATION_RESULT_2026-09-17.md`'s
own stated remaining risk.**

## Summary

The first genuine execution binding under release epoch 2 landed via the
natural, unmodified canonical scheduler path — no manual fire, no synthetic
task, no test admission. Both release-provenance health checks that were
`UNKNOWN: NO_OBSERVATION` at KJ-P2.1A's close are now independently confirmed
`HEALTHY`. This was the one remaining open item from KJ-P2.1A; it is now
closed. **The entire KJ-P2.1 / KJ-P2.1A programme (durable notification
outbox: design, code qualification, merge, production migration, production
deployment, release-provenance activation, and this final natural-execution
proof) is complete.**

## Verified facts (fresh read, 2026-09-18T09:07–09:10Z)

| Check | Result |
|---|---|
| New execution binding exists | `task_id=d81a6582-9c39-84d7-a0dc-744bd0f4a0f8`, `release_epoch=2`, `persisted_at=2026-09-18T08:00:00.378Z` |
| Binding release ID | `1fbe6b22ed35394fb3a52c3735b6b4430d8ac9fa` — exact match |
| Natural-fire provenance | `schedule_fires` row `fire_window_key=dailyAt/09:00\|Europe/London\|2026-09-18`, `state=ADMITTED`, `admitted_child_task_id` matches the binding's `task_id` exactly — the canonical scheduler path, not a manual/synthetic admission |
| `authority.bindingReleaseConsistent` | **HEALTHY** — `activeEpoch:2, activeReleaseId:1fbe6b2..., mismatchedBindingCount:0, missingProvenanceCount:0` |
| `releaseParity.recentBindingsConsistent` | **HEALTHY** — same observed data |
| `releaseParity.matchesExpected` | HEALTHY (bonus confirmation) |
| Overall health | `criticalIssues:0, degradedIssues:0`; `overall:UNKNOWN` solely from the two pre-existing, unrelated, permanently-documented gaps (`execution.noWorkerRestartLoop`, `legacyAuthority.b1FreezeObservable`) — not new, not part of this programme |
| New P0/P1/P2 alerts | None. `alert_state` shows exactly one non-P3 row, `releaseParity.recentBindingsConsistent`, `current_state=RECOVERED` (closed, not open) |
| Duplicate outbox delivery | None — `notification_delivery_events` grouped by `notification_id` having count > 1 returns zero rows |
| Outbox status distribution | `{"DELIVERED": 5}` — zero `PENDING`, zero `SENDING`, zero `POISON`. The 5th row (beyond KJ-P2.1A's original 4) is `authority.bindingReleaseConsistent`'s own final `RECOVERED` notification, triggered by this natural fire, delivered with `attempt_count=1` |
| `ProductionAlertMonitor` continuation chain | Exactly one `scheduled` invocation (plus exactly one, unrelated, `ScheduleDriver` continuation for the canonical schedule itself) — no second chain |
| Worker/door/Restate health | All `running`/`healthy`, `restarts=0` on all three, unchanged since KJ-P2.1A's close |
| Restate admin / door auth | admin `/health` 200; door `healthz` 200; `noauth` 401 |
| Monitor cadence | Unchanged, `300000`ms; sequence progressed naturally and monotonically (162 at KJ-P2.1A close → 295 now, ≈11h at 300s cadence — consistent) |

## Business counters — expected natural increment, not an anomaly

| Counter | KJ-P2.1A close (2026-09-17) | Now (2026-09-18) | Delta |
|---|---|---|---|
| `task_admissions_total` | 25 | 26 | +1 |
| `schedule_fires_total` | 6 | 7 | +1 |
| `execution_bindings_total` | 26 | 27 | +1 |

Exactly +1 across all three, matching exactly one natural daily fire — the
same increment pattern the fire history shows for every preceding day
(`2026-09-16`, `2026-09-17`, `2026-09-18` each show exactly one `ADMITTED`
fire). This is the expected, healthy operation of the canonical scheduler,
not an anomaly introduced by this programme.

## Occurrence-count note (investigated, not a concern)

`authority.bindingReleaseConsistent`'s `occurrence_count` read `123` at
closure, higher than might look expected at a glance. This is fully
explained and correct: that check's policy maps `UNKNOWN` to `P3` (not
"no alert"), so the entire ~10.25-hour gap between KJ-P2.1A's close
(21:56:36Z) and this fire (08:00:00Z) — during which `NO_OBSERVATION` was the
genuinely correct state, since no binding had occurred yet — was tracked as
one continuously-open P3 episode, incrementing once per 300s tick
(≈123 × 300s ≈ 10.25h, matches). `releaseParity.recentBindingsConsistent`,
by contrast, had already fully `RECOVERED` before the gap began and correctly
produced no further decisions while healthy (`occurrence_count` stayed at 2,
unchanged) — "repeated healthy state does not spam recovery," exactly as
designed. Both are correct, expected behaviour for two checks with
deliberately different UNKNOWN-severity policy mappings, not a defect.

## Verification method

All checks performed read-only, against the live production database
(`banqdzddfganzfhckdps`) and the running worker/door/Restate containers on
`kerneljson-prod-01`, using the same disciplined pattern established
throughout this session (single-purpose Node scripts executed inside the
worker container via `docker exec`, reading `DATABASE_URL` only from the
container's own environment, never as an argument; scripts copied in and
removed immediately after use; no value handled outside the container).
**No production mutation, deployment, restart, repair, retry, manual fire,
task admission, alert-state edit, or configuration change was performed or
needed** — every item on the closure checklist passed on the first read.

## Conclusion

**KJ-P2.1 / KJ-P2.1A — FULLY CLOSED.** The durable notification outbox is
live in production, proven end-to-end against two real incidents (the
deploy-triggered provenance mismatch on 2026-09-17, and this natural
recovery on 2026-09-18), with zero duplicate delivery, zero stuck state, and
zero business-side effect throughout. The two permanent operating rules this
programme surfaced (`docs/operations/RELEASE_PROVENANCE.md`'s mandatory
`activate_release` requirement; the global secret-handling allow-list rule)
remain in force for all future work.

**Next programme: KJ-P2.2 — Real Notification Transports, Telegram first**
(not started; a separate, future authorisation).
