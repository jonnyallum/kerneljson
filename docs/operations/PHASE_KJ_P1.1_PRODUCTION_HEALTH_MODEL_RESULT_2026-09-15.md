# KJ-P1.1 — production health model (PASS)

Date: 2026-09-15. Status: **PASS.** One canonical, read-only, machine-readable
production health check for KernelJSON now exists (`npm run health`,
`services/kernel/src/health/`) and is proven, on canonical main, post-merge,
against real production. This is the first result under the new **KernelJSON
Production Operations Hardening** programme — see `docs/operations/HEALTH_MODEL.md`
for the full design, check catalogue, and aggregation rules. This record covers
KJ-P1.1 only.

---

## 1. Canonicalisation

- PR #26 squash-merged into `main` by the human reviewer.
- Canonical merge SHA: **`24e3d50`** (kerneljson `main`).
- Verified: `git diff a060da9a6b48865e8109e98743eeee6ca3eb553a 24e3d50` (the reviewed
  PR branch head vs. canonical main) is **empty** — the squash-merge introduced
  zero content drift from what was reviewed. Exactly the 13 reviewed files landed
  (`docs/operations/HEALTH_MODEL.md`, `package.json`, the 10
  `services/kernel/src/health/*.ts` files, `tests/health-model.test.ts`) — no more,
  no less.

## 2. Post-merge validation, from canonical main

| Check | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | clean, 0 errors |
| `npx eslint packages services apps runtimes tests evals vitest.config.ts --max-warnings=0` | clean, 0 warnings |
| `npx vitest run tests/health-model.test.ts` | **25/25 passed** |
| `npm run test:unit` | **180/180 passed** |
| Full `vitest run` (all suites) | **561 passed, 48 skipped (all intentional, environment-gated), 0 failed** |
| `node scripts/check-baseline.mjs` | baseline retained: 224/224 passing, recovery 31>=27, 48 intentional env-gated skips |

No regression anywhere. Docker was healthy and already running; its lifecycle was
not managed by this task (per the global Docker Desktop safety rule) — the
existing daemon was used as-is by vitest's own live-integration suites.

## 3. Final live read-only production health check

Run via a standalone compiled bundle of `services/kernel/src/health/` (built from
canonical main, `tsc` against a scoped tsconfig — no dev tooling installed into
the production image), `docker cp`'d into `kerneljson-execution-worker-1` and
executed with `node cli.js --json`, exactly the same read-only pattern used
throughout S1D2. Restart counts supplied via `docker inspect` beforehand
(`WORKER_RESTART_COUNT`/`DOOR_RESTART_COUNT`); `RESTATE_ADMIN_URL` and
`EXPECTED_RELEASE_ID` supplied explicitly; every other value (DATABASE_URL,
SCHED_ARM_NEXT, SCHED_APPROVED_SHA256, SCHED_RECIPE, KERNELJSON_RELEASE_ID,
KJ_ADMISSION_URL) came from the worker's own live production environment.

```
KernelJSON Production

Overall             UNKNOWN
Authority           HEALTHY
Admission           HEALTHY
Scheduler           HEALTHY
Execution           HEALTHY
Restate             HEALTHY
Database            HEALTHY
Evidence            HEALTHY
Release parity      HEALTHY
Production config   HEALTHY
Legacy authority    UNKNOWN

Last fire            15 Sep, 08:00
Next wake            16 Sep, 08:00
Release              5a2335b41d8fe525ff940a3bd86912c98dae68af
Critical issues      0
Degraded issues      0
Unknown checks       1
```

Matches the expected result exactly: **9/10 domains HEALTHY, `legacyAuthority`
UNKNOWN, overall UNKNOWN, 0 critical, 0 degraded.** `lastFireAtUtc`/`nextWakeAtUtc`/
`release`/evidence digest all agree exactly with the S1D2 evidence record
(`docs/production/PHASE_S1D2_PRODUCTION_RECURRING_ENABLEMENT_RESULT_2026-09-15.md`).

No production mutation occurred: `RestartCount=0` on both worker and door before
and after; every collector call is a `SELECT` / Restate `/query` introspection /
`/healthz` GET. Temporary files removed from the VM and the worker container after
the run.

## 4. Known gap — recorded, not fixed here

**`legacyAuthority.b1FreezeObservable` is `UNKNOWN`, and this is why `overall` is
`UNKNOWN` rather than a true `HEALTHY`, even with zero critical or degraded
issues.** The B1 authority freeze (`dsp_scanner`/`boardroom-poller` guard) lives in
a different system — the Shared Brain Supabase project — which this module has no
credentials for. This is a **known observability gap, not an execution
failure**: nothing about the B1 freeze itself is in question (it was proven PASSED
and held throughout S1D2 by independent means — see
`new-system`'s `docs/production/PHASE_B1_AUTHORITY_FREEZE_RESULT_2026-09-13.md`);
this health model simply cannot yet *observe* it. Per the explicit scope of this
task, **no Shared Brain credentials or cross-system wiring were added** — wiring
that in, if wanted, is a decision for a future phase, not a defect to patch here.
Full detail: `docs/operations/HEALTH_MODEL.md` "Known gaps".

## 5. Canonical status after this record

- **KJ-P1.1 = PASS.** The production health model is production-ready: proven by
  25 deterministic unit tests, a clean post-merge full-suite run, and a live
  read-only check against real production that matches every independently-known
  fact about current production state.
- `npm run health` is now the one-command answer to "is KernelJSON production
  healthy right now, and why."
- Not started: KJ-P1.2 or any successor phase. Per the KJ-P1.1 authorisation, no
  alerting, dashboards, auto-remediation, or new capabilities were added.
