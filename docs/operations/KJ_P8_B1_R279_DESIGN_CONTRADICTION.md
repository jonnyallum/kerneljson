# B1 R2.7.9 implementation intake: pinned helper failure behaviour

Status: **DESIGN_CONTRADICTION — R279-HELPER-RETHROW**. This branch contains a diagnostic and its evidence, not a completed B1 remediation. No repository or target qualification is claimed.

Date: 09/10/2026. Implementation authority: the owner's B1 full implementation sprint, including its section 51 contradiction stop rule.

| Anchor | Exact commit |
|---|---|
| Frozen B1, unchanged parent | `0ff2919c1bbf722b4842aa56fdc94ef9b74e5a51` |
| Normative sealed R2.7.9 | `af2f7320aae32eaa0ce699b1c09d015371f156d5` |
| Main carrying hostile seal and full review | `e211eb796c51403637bb5f231c7feba2aaf97be2` |
| Prior sealed design | `c7c0fba524655b19e06deb39cec5b6d5426c4ce4` |
| Verified common base | `20e39f797be9c4c982bc32fb40b6aa1427b5c09c` |
| New branch directly from frozen B1 | `feat/kjp8-b1-r279-remediation` |

## Contradictory sealed statements

ADR-0023 section 27.12.3 pins `public.rls_auto_enable()` to a 953-byte body with SHA-256
`2782e98b348aca7d6f6f73c420fd78d2e094957dd7a52b0483d4c34f29d2a7a1`.
Sections 27.8, 27.12.1 and 27.12.5 require preserving this co-resident platform control unchanged.

Section 27.12.4, **Interactions**, states:

> On failure the pinned body re-raises, so the migration aborts: fail closed.

The same paragraph is labelled INFERENCE. The exact pinned source instead contains:

```sql
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
```

There is no `RAISE;` after the log statement. The handler consumes an error raised while enabling RLS. Adding a rethrow would change the sealed source digest and violate the preservation requirement.

Source was obtained from the ADR's exact [Supabase upstream revision](https://github.com/supabase/supabase/blob/54a96831278818ff2fbdd82c51e225cdd0fecab8/apps/studio/components/interfaces/Database/Triggers/EventTriggersList/EventTriggers.constants.ts), not current Studio. The committed fixture preserves the body byte for byte; only the installer references are schema-qualified with `public.`. Its body length and digest are asserted before any container starts and from the live catalogue.

## Observed reproduction

Run from this repository:

```text
node scripts/b1/diagnostics/r279-helper-rethrow.mjs
```

The diagnostic accepts no arguments and cannot select a database target. It uses a new local Docker container, no network, no published port, no host mount, and a tmpfs data directory. It applies no KernelJSON migration and writes no migration ledger. The source installer and diagnostic SQL are not an alternate B1 application path.

Exact image: `postgres@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929`.
Exact server: `PostgreSQL 17.6 (Debian 17.6-2.pgdg13+1) on x86_64-pc-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit`.

1. Install the pinned helper and `ensure_rls`. Assert its sealed attributes, null ACL, source digest and event-trigger topology.
2. Positive control: create a table; its `relrowsecurity` is true.
3. Install a diagnostic SECURITY INVOKER event-trigger function in schema `diagnostic`. Its `ddl_command_start` trigger raises `insufficient_privilege` on `ALTER TABLE`. It does not change the helper or `ensure_rls`. Rule E4 places event triggers bound into other schemas outside the co-resident topology rule; this function is not a definer.
4. `BEGIN; CREATE TABLE public.r279_failure_control(id integer); COMMIT;` succeeds. The helper logs failure and the table persists with `relrowsecurity = false`.
5. A direct `ALTER TABLE public.r279_failure_control ENABLE ROW LEVEL SECURITY` fails with `42501`, proving the injected failure is effective.
6. Re-read every pinned helper attribute and topology: unchanged. Confirm the helper's failure log.
7. Remove the container and verify it is absent. No network was created.

The committed [observations](evidence/kj-p8-r279-contradiction/observed.json) are a compact diagnostic result, not a governed runner run record, target baseline or declaration. The script independently asserts every result; no caller supplies a success flag. The initial ad hoc experiment and the committed diagnostic reproduced the same failure behaviour.

## Scope, stopping decision and smallest proposed correction

**Affected path:** claiming or qualifying the section 27.12.4 helper failure guarantee while preserving its exact sealed pin. Those two requirements cannot both hold. Fail-closed implementation of that guarantee requires a source change which this sprint cannot make.

This does **not** prove that every B1 positive path is impossible. B1 creates no table and does not fire the helper. The diagnostic is a simulated DDL failure, not evidence of a production incident, a runtime-role exploit, or disabled RLS on existing KernelJSON tables. No P8A-0 work was started. The contradiction concerns the stated behaviour of the platform control B1 must preserve and later migrations must coexist with.

No implementation workaround was introduced. The affected path is stopped under sprint section 51. Rather than silently treating the claim as nonblocking editorial debt or changing a pinned platform control, this branch returns the evidence for design adjudication. Unrelated remediation was not represented as a completed implementation; the original implementation objective remains outstanding.

**Smallest proposed design correction, not applied:** correct the section 27.12.4 inference to state that this pinned helper logs and absorbs errors. Preserve its source and ACL. Explicitly state that migrations must not rely on this helper for abort-on-error or as their sole RLS enforcement, and qualify their own explicit RLS statements/checks in the appropriate separately authorised stage. If rethrow is a required platform guarantee instead, a new source pin and separate platform-change authority are necessary. Choosing either is a design ruling, not an implementation exception.

## Other verified intake facts

- Remote main, frozen B1 and sealed design match the supplied anchors after fetch.
- The new branch was created directly from frozen B1, in an isolated worktree. The original checkout and historical B1 branch were not modified.
- Frozen dependencies install with `pnpm install --frozen-lockfile --ignore-scripts`.
- Supabase CLI Windows archive SHA-256 is `53920013d24bc9e66180f35ceeea9ddc20e65a7afa883421e9c0ba60ad7457ee`.
- Its two executable hashes match section 27.12.13.7: launcher `1cbedd6e494581a1c1d90113660113a06798d9967d19c857127b66b8a428e836`; Go executable `fa2ba7fb02b01d98fa5a3c6d92632239b10c6974dbc42c65b698b6a479847343`.
- Copies in a fresh directory print exactly `2.120.0` with the seven Windows H1 environment names only: `PATH`, `HOME`, `USERPROFILE`, `TMPDIR`, `TEMP`, `TMP`, `SystemRoot`. This is an engine-startup check only, not a migration or ledger qualification.

## Implementation status and requested final-report fields

`FAIL (NOT RUN)` below means a required qualification gate is not established; it is not a claim that its test was executed and failed. No gate is silently waived.

| Field | Result |
|---|---|
| IMPLEMENTATION_BRANCH | `feat/kjp8-b1-r279-remediation` |
| FINAL_IMPLEMENTATION_SHA | No completed implementation; this report's containing branch commit is diagnostic only. Exact pushed SHA is in the delivery message. |
| COMMITS | One coherent diagnostic/evidence/report commit atop frozen B1; no rebase, rewrite or squash. |
| FILES_CHANGED | This report, a notice in the historical implementation report, the diagnostic script, pinned helper fixture and compact observations. |
| B1_MIGRATION_REMEDIATED | NO |
| SCHEMA_WIDE_FUNCTION_ACL_REMOVED | NO — frozen migration unchanged |
| CO_RESIDENT_EXCEPTION_IMPLEMENTED | NO — diagnostic only |
| STANDARD_MIGRATION_ENGINE | NO — no B1 application |
| CLI_PIN | Windows 2.120.0 startup and both hashes verified; no runner pin file implemented |
| PRE_LEDGER_GATE / POST_LEDGER_GATE | FAIL (NOT RUN) |
| RUNNER_IMPLEMENTED | NO |
| EPHEMERAL_MODE | FAIL (NOT RUN); diagnostic is not runner qualification |
| HOSTED_MODE_IMPLEMENTED_NOT_PRODUCTION_EXECUTED | NO |
| P1 / P2 / P3 | FAIL (NOT RUN) |
| LANES_JSON / B1_REQUIRED_JSON / HOOK_REGISTRY | Not implemented |
| PLATFORM_DEFINER_FIXTURE | Not implemented |
| PINNED_COLLECTION / COLLECTION_107_FILES | FAIL (NOT RUN) |
| PROTECTED_224 / INTENTIONAL_SKIPS_62 / RECOVERY_GE_27 | FAIL (NOT RUN) |
| G1_G9 | G1–G9 not qualified; no changed gate or threshold |
| TRACE_ACCOUNTING / WORKER_TRACE / REFUSAL_MULTISET | FAIL (NOT RUN) |
| LOG_EXTRACTION / LOG_FINGERPRINT / CON47 / CON48 | FAIL (NOT RUN) |
| LEDGER_HOOKS_6 / CON43_ACL_PRECONDITION | FAIL (NOT RUN) |
| MUTATION_FACULTIES_5 / MUTATION_IDENTITY_57 / MUTATION_IDENTITY_COGNITION_62 | FAIL (NOT RUN) |
| NEGATIVE_CASES | Cases 1–41, ACL-A–C, LEDGER-A–F, EPH-1–27, CON-1–48: NOT RUN, none claimed passed. Diagnostic R279-HELPER-RETHROW reproduced. |
| CI | Existing workflow unmodified; this diagnostic commit uses `[skip ci]` so pushing it does not launch the inherited ungoverned B1 application paths. No green CI or skipped qualification is claimed as a pass. The replacement governed workflow remains outstanding. |
| EVIDENCE | `docs/operations/evidence/kj-p8-r279-contradiction/observed.json`; reproducible diagnostic above |
| DEFERRED_NONBLOCKING | None adjudicated; outstanding sealed implementation requirements are not relabelled nonblocking |
| SELF_REVIEW_FINDINGS | Exact pinned helper contradicts its described rethrow behaviour; all helper pins rechecked unchanged; diagnostic does not apply B1 or mint qualification |
| DESIGN_CONTRADICTION | R279-HELPER-RETHROW |
| PRODUCTION_CONNECTED / PRODUCTION_MUTATED | NO / NO |
| PRODUCTION_LEDGER_REPAIRED / PRODUCTION_BASELINE_CAPTURED | NO / NO |
| B1_MERGED / P8A0_STARTED | NO / NO |
| READY_FOR_CLAUDE_RECONCILIATION | NO for implementation reconciliation; evidence ready for design adjudication |

No PR was opened. No merge, deployment, target cutover, hosted connection, production ledger action or production baseline capture is authorised by this result.
