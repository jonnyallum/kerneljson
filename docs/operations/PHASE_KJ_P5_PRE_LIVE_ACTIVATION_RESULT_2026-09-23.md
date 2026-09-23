# KJ-P5 pre-live activation — PASS / STOP

Observed on 2026-09-23. This closes activation only. **Canonical memory live proof remains pending Jonny's first Telegram memory write.** No `/remember`, memory candidate, promotion, version, or synthetic task was submitted in this window.

## Release and authorization

- Original P5 merge: `27571c8a95982e90174015513b473754272b57a6` (PR #42).
- Preflight found a real packaging defect: the production entrypoint imported `services/memory`, but the worker Dockerfile omitted it. Existing CI booted a different test entrypoint.
- Jonny authorized the correction and continuation with “go for it” after the STOP report.
- Focused correction: [PR #43](https://github.com/jonnyallum/kerneljson/pull/43), reviewed head `eb560b2dbe0a6769de7e921e9d219f2c217b0b44`.
- **Canonical corrected merge and deployed release: `a577e7439f830a1fbc795a0dddd331d7d7edca78`.** Its tree equals the tested PR head. Neither the original P5 PR head nor an uncommitted patched image was deployed.
- Previous release: `a4078cf96b063db4d8885cf9b2a2f2fedebdd60f`.
- **Epoch: 8 → 9**, activated at `2026-09-23T10:44:43.787Z`.
- Activation request: `3ce703dc-520a-433c-9d6c-c77eaf318609`. The existing `kernel_private.activate_release` protocol was used in a dedicated transaction; a fresh connection (backend PID 1949523) independently read epoch 9, the exact release, previous release, and request ID.

Target: `kerneljson-prod-01`, GCP project `project-c407f628-c71c-45fa-994`, zone `europe-west2-b`; database endpoint verified as KernelJSON Supabase project `banqdzddfganzfhckdps`. No access to the old estate VM or Shared Brain was used.

## Qualification and review

[Canonical-release CI](https://github.com/jonnyallum/kerneljson/actions/runs/35849982618) passed: typecheck, lint, build, **1,470 passed / 62 intentional skips**, 80 test files passed / 10 skipped. Baseline 224/224 retained; recovery 31 passing. The full suite includes disposable PostgreSQL integration tests.

New CI checks boot the image's actual production CMD with memory disabled and enabled, without network access, credentials, host mounts, or published ports. A negative control removes the memory directory only inside a disposable container and requires `ERR_MODULE_NOT_FOUND`. Both positive checks and the negative control also passed against the corrected image built on the production host, before replacing either live container.

The builder's adversarial review checked import coverage, production/test entrypoint divergence, disabled-memory startup, isolated negative-control cleanup, and unchanged authority/policy code. This was not a new independent model review; PR #42's reported Grok review was not rerun for the packaging-only correction.

One branch CI attempt failed when the deliberate Restate SIGKILL/restart recovery test failed readiness, cascading into five failures. The parallel PR run passed. One clean rerun of the failed job passed, and the later canonical-merge CI passed. The failure is retained in [run attempt 1](https://github.com/jonnyallum/kerneljson/actions/runs/35848562462/attempts/1); no recovery test was weakened or skipped.

## Migration proof

Applied only `20260921180000_canonical_memory.sql`, in one transaction with a 10-second lock timeout. Exact committed LF-file SHA-256:

`15f6ca5660692a47f0ecb35bcad336ea7573a89b04507fa2829734cfc54b4c75`

Immediately before migration, tasks in flight = 0, pending approvals = 0, POISON = 0, epoch = 8. The transaction checked schema and data invariants before commit.

| Object | Type | RLS / protection | Rows after activation |
|---|---|---|---:|
| `memory_candidates` | table | RLS enabled | 0 |
| `memory_promotions` | table | RLS enabled | 0 |
| `memory_versions` | table | RLS enabled | 0 |
| `memory_relations` | table | RLS enabled | 0 |
| `memory_context_assemblies` | table | RLS enabled | 0 |
| `memory_current` | view | `security_invoker=true` | 0 |

No grants to PUBLIC, `anon`, or `authenticated` on any of the six objects, checked in the migration transaction and again afterward. Exactly five new tables and one view appeared. Existing public/kernel_private table/view columns, constraints, indexes, non-internal triggers, policies, RLS and ACL metadata were unchanged except the intended widening of `telegram_inbox_command_check` to allow REMEMBER, MEMORIES, MEMORY and FORGET. The migration also defines the four intended memory guard functions; the schema comparison was scoped to existing tables/views, not a whole-database dump.

Legacy `memory_items` remained present and unchanged: 0 rows before and after; the ordered-row SHA-256 stayed `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`. No legacy retrieval blending was introduced by this deployment.

## Configuration and deployment proof

- Worker env changed only `KERNELJSON_RELEASE_ID` and added `KJ_MEMORY_ENABLED=true`.
- Door env changed only `KERNELJSON_RELEASE_ID`.
- `runtime_env_merge.py verify` independently confirmed all other env-file values identical, both before installation and at close. Files remained root-owned mode 600.
- Container environment fingerprints independently checked all 36 prior worker keys and 13 prior door keys. Only release-related values and the declared P5 defaults differed.
- `KJ_MEMORY_APPROVER_ID` remains absent from the runtime file. Compose supplies an empty default in the worker, which is effectively unconfigured; protected promotions remain held. No approver was added.
- `KJ_CONTROL_TOKEN` absent from both runtime files and containers. Signing keys preserved; `KJ_CONTROL_KEY_ID=v1` directly verified in both containers.
- Worker image: `kerneljson-worker:a577e74`; started `2026-09-23T10:44:30.133314153Z`.
- Door image: `kerneljson-admission-door:a577e74`; started `2026-09-23T10:44:31.941313493Z`.
- Restate stayed on 1.7.9, untouched; its container start remains `2026-09-12T18:10:24.870538339Z`.
- Worker and door release IDs match the exact canonical merge. Hashes of running worker entrypoint, memory config/service, and gateway entrypoint match files at that commit; see the evidence JSON.
- Temporary P5 env candidates, rollback copies and fingerprint staging file were removed after final verification. Active runtime env files were retained.

**This record supersedes the worker-only deployment sentence in `KJ_P5_CANONICAL_MEMORY.md`. Worker/door release parity is mandatory; both were deployed together in this activation window.**

## Runtime observations

| Check | Observed result |
|---|---|
| Worker / door / Restate health | all healthy |
| Restart counts | 0 / 0 / 0 |
| Tasks in flight / pending approvals / POISON | 0 / 0 / 0, checked repeatedly including close |
| Outbox | 20 DELIVERED; none pending, sending or poisoned at observation |
| Open alerts | two P3; one historical P1 RECOVERED; no open P0/P1 |
| Scheduler | enabled v2; today's natural 08:00 UTC canary completed on the previous release |
| Next scheduler wake | one, `2026-09-24T08:00:00.012Z`, unchanged |
| Telegram | one continuing poll chain; completion observed at `10:45:19.998Z` after activation |
| Alert monitor | natural completion at `10:44:49.226Z` after activation; next wake `10:49:49.220Z` |
| Known literal credentials in worker/door/Restate logs since deployment | 0 / 0 / 0; values never emitted |

Each service appeared once in the service listing: `ProductionAlertMonitor` revision 8, `GoldenTaskWorkflowV1` 2, `KernelWorkflowV1` 19, `TelegramOperator` 4, `ScheduleDriver` 16, `TaskWorkflow` 19, `CapabilityServiceV1` 19. Revision numbers represent successive registrations, not duplicate service names.

The health report is **UNKNOWN, not globally green**: 0 critical, 0 degraded, 3 unknown checks. Two are expected `NO_OBSERVATION` because epoch 9 has no task binding yet; both show zero mismatched bindings and zero missing provenance. The third is the pre-existing unwired Shared Brain legacy-authority check. No synthetic task was minted to conceal these unknowns. Full release-transition observation remains pending real work.

Two operator-script prechecks stopped before mutation: first for an omitted JSON Accept header, then for Restate's documented omission of `scheduled_start_at` in narrow queries. The script was aligned with the repository's existing `select *` introspection pattern and rerun. No runtime code was changed for these tooling issues.

## Stop boundary and limitations

All results above are directly observed unless identified as inherited/reported review or architectural interpretation. Startup checks do not prove live promotion, retrieval, replay or context assembly. No new journal-wide secret scan or human Telegram command proof was performed in this window; the log scan covers literal configured credential values only.

**KJ-P5 PRE-LIVE ACTIVATION — PASS / STOP.** Waiting for Jonny. The first canonical-memory write must come from Jonny through Telegram. The final `PHASE_KJ_P5_CANONICAL_MEMORY_LIVE_RESULT_2026-09-23.md` must not be marked PASS until the requested live chain, replay and mission-context evidence are proven. P6 remains downstream of that proof.

Machine-readable post-activation observations: [evidence](evidence/kj-p5-prelive/post-activation-2026-09-23.json).
