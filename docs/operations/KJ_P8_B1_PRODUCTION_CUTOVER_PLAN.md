# KJ-P8 B1 production cutover plan: least-privilege runtime database roles

Status: PLAN ONLY. **Nothing in this document has been executed.** No production SQL, role, credential, runtime
configuration or deployment was touched while preparing the B1 candidate. Executing this plan needs its own explicit
authorisation and its own change window (new-system `docs/migration/CHANGE_WINDOWS.md`).

Design: ADR-0023 revision 2.6, section 27 (including 27.9, 27.10 and 27.11), hostile-sealed APPROVE at
`7712702020ef5d3d841f68f4d425d9707fb703eb`.
Candidate: branch `feat/kjp8-b1-runtime-least-privilege` (see `KJ_P8_B1_IMPLEMENTATION_REPORT.md`).

## 1. What changes in production

| Item | Now (recorded, not re-inspected) | After cutover |
|---|---|---|
| Worker database session | `postgres` (the owner) | `kj_worker` |
| Door database session | not observed; assumed `postgres` until inspected | `kj_door` |
| Runtime grants | none needed, the owner bypasses row level security | exactly `infrastructure/database/runtime-role-manifest.json` |
| Row level security policies | none exist | one per table and verb in the manifest, scoped to the role |
| `kernel_private.stamp_binding_provenance()` | `security invoker` | `security definer`, the one ADR 27.9 exception; body, owner, `search_path = ''` and trigger unchanged; EXECUTE for the owner only (report, section 3) |
| `SECURITY DEFINER` inventory | not governed | exactly the frozen platform baseline plus `stamp_binding_provenance()` (ADR 27.10, stage B1) |
| Runtime code | accepts any session | refuses any session that is not its sealed role |

Nothing else changes: no table, column, trigger body, owner or existing migration file. No P8 object is created.

## 2. Preconditions (all must hold before the window opens)

1. The exact candidate SHA has an independent hostile review with verdict APPROVE.
2. CI is green on that SHA, including both mutation jobs.
3. The frozen manifest has been reviewed line by line by a human.
4. The `security definer` change is ruled: ADR-0023 revision 2.5 section 27.9, sealed at `424f85c`. Closed.
4a. **The target platform `SECURITY DEFINER` baseline is frozen** (ADR 27.10.4). Before any B1 migration on the target,
   the deployment owner runs, read-only:
   `pnpm tsx scripts/b1/platform-baseline-snapshot.ts --environment <name> --database-url-file <mode-600 file> --out infrastructure/database/security-definer-platform-baseline.json`.
   The connection string is a file path, never an argument; delete the file afterwards. The tool opens one READ ONLY
   transaction with `search_path = ''`, writes nothing, and refuses if B1 is already applied or an entry is
   ineligible. It also refuses unless the migration ledger records **exactly** the 22 base migration versions of the
   stage manifest (no missing, extra or duplicated row; B1 not recorded) and the stamp function exists. If production's
   ledger has gaps from manually applied migrations, the snapshot refuses and the drift is adjudicated separately; the
   ledger is not caught up ad hoc and the gate is not weakened. The resulting file is reviewed line by line and committed: that is a **new candidate SHA** and needs
   its own review. Until it exists, `database.runtimeRolesLeastPrivilege` reports `TARGET_PLATFORM_BASELINE_PENDING`
   and stays CRITICAL, so the window cannot pass step 11.
5. A change window is authorised and recorded.
6. **Production is re-inventoried.** The qualification database is plain Postgres 17. Production is hosted Postgres
   and was not inspected. Before the window, with read-only catalogue queries as the owner, record:
   - the door's current database role and the worker's (`select current_user` from each running process);
   - whether the owner can create a role with `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`
     and alter it afterwards;
   - how a custom role logs in through the connection pooler in use, and which pooler mode the services use (the
     runner lock uses session-level advisory locks, which need a session-mode connection);
   - the runtime capability facts of both roles under ADR 27.11. A platform object, sequence, function or policy
     granted to `PUBLIC` inside a schema the role cannot USAGE is **not** a runtime fact and needs nothing. Any
     unexpected fact that remains (for example a platform schema that grants USAGE to `PUBLIC`, which is an
     unexpected `schema:<name>:USAGE` fact and exposes the objects inside it) **stops B1**: classify it and report it.
     A platform grant is never revoked without separate authority, and target-specific authority is never added to the
     repository manifest to make health green (ADR 27.7, 27.11.5). A genuinely required new runtime capability needs
     its own reviewed manifest change and design authority, and is a new candidate SHA;
   - whether revoking TEMPORARY on the database from `PUBLIC` affects any platform role. If it does, that revoke is
     replaced by a reviewed alternative before the window;
   - default privileges in `public` and `kernel_private` (`pg_default_acl`): none may grant to the runtime roles;
   - the current connection counts, to confirm the connection limits (worker 40, door 20) leave headroom.
7. A rollback baseline of the current runtime env files exists, taken with the existing env-merge tooling, with every
   secret handled by path and never as an argument.
8. Zero non-terminal tasks, zero open P0/P1, scheduler healthy, recorded immediately before the window.

If item 6 finds a difference that needs a manifest or migration change, stop: that is a new candidate SHA and a new
review, not a window-time edit.

## 3. Order of operations

Each step has a check chosen before acting and a result that means failure.

1. **Hold ingress.** Stop new admissions at the door (existing procedure). Check: no new `task_admissions` row for
   60 seconds.
2. **Apply the B1 migration** as the owner, in one transaction: `20261002090000_runtime_least_privilege_roles.sql`.
   Its own pre-COMMIT check refuses to commit if a role's attributes are not as sealed, or if the stamp function is not
   exactly as ADR 27.9.4 requires (definer, `proconfig`, owner-only ACL, source digest equal to the pin, one function of
   that name, one KernelJSON definer).
   Check: the catalogue equals the manifest for both roles (`compareRoleToManifest`, both directions empty) and the
   `SECURITY DEFINER` inventory equals `EXPECTED(B1)` against the committed platform baseline
   (`definerInventoryProblems` empty, including the committed baseline's `systemIdentifier` and database name equal to
   the live database's). Failure: any missing, extra or mismatched fact.
   **Transaction behaviour (ADR 27.11.6 item 5).** The migration's own assertions run before its COMMIT: if one fails,
   the transaction rolls back and nothing has changed. The catalogue and inventory checks above run after the migration
   has committed and cannot roll it back. If one of them fails, stop the window and invoke the recorded rollback
   procedure of section 6; do not continue to step 3.
3. **Provision credentials out of band.** As the owner, set a generated password on each role. Store each in the
   vault through `secretctl`, value never in an argument, with a length expectation. The migration contains no
   password and never will.
4. **Build the two database URLs into mode-600 files** and merge them into the door's and the worker's runtime env
   with the existing env-merge tool. Check: only `DATABASE_URL` and `KERNELJSON_RELEASE_ID` changed, by fingerprint.
5. **Deploy the door** at the candidate release with its `kj_door` URL. Check: `/healthz` answers, and a read-only
   status request succeeds. Failure: the door refuses with `RUNTIME_DATABASE_ROLE_REFUSED` or any `42501` in its log.
6. **Deploy the worker** at the candidate release with its `kj_worker` URL, in lockstep with the door's release id.
   Check: Restate lists every expected service once.
7. **Verify the effective sessions.** From each running process: `current_user` and `session_user` are the runtime
   role. From the owner: `pg_stat_activity` shows no application session as `postgres`.
8. **Activate the release** through the existing `activate_release` procedure, run by the owner.
9. **Positive smoke.** One harmless admitted task completes; one approval round trip; the scheduler's next wake is
   armed. Check: ledger COMPLETED, evidence present.
10. **Negative smoke**, from a `kj_worker` session and a `kj_door` session: the short list in section 5 must each be
    refused with the pinned SQLSTATE.
11. **Full health check.** Every domain as before the window, and `database.runtimeRolesLeastPrivilege` HEALTHY.
12. **Release ingress.**

## 4. Soak

P8A-0 may not be applied to production until B1 has run through:

- at least one full scheduler cycle (a real scheduled fire admitted, executed and completed under `kj_worker`);
- at least one live mission from admission to completion notice;
- with zero `42501` errors in the database log for the whole period, and `database.runtimeRolesLeastPrivilege`
  HEALTHY throughout.

## 5. Negative smoke list for the window

As each runtime role, each must fail with `42501`:

- `create table public.kj_b1_x (i int)`
- `alter table public.task_events disable trigger all`
- `alter table public.tasks disable row level security`
- `truncate public.task_events`
- `set role postgres`
- `select kernel_private.activate_release(...)`
- `select kernel_private.set_identity_freeze(...)`
- `update kernel_private.release_epoch set epoch = epoch`
- `delete from public.task_events`

The full matrix is `tests/runtime-roles-negative.integration.test.ts`; this list is its window-sized subset.

## 6. Failure and rollback

**Rule: no fallback to `postgres`.** There is no temporary owner mode and no switch that makes the new release accept
an owner session.

| Failure | Response |
|---|---|
| The migration's own pre-COMMIT check fails in step 2 | the migration's transaction rolls back; production is unchanged; close the window |
| A post-COMMIT check of step 2 fails (catalogue, capability facts, definer inventory, baseline binding) | stop the window; invoke the rollback procedure below; the committed migration is not undone by the check |
| An unexpected runtime capability fact on the target | stop; classify and report it; no platform revoke and no target-specific manifest addition (ADR 27.11.5) |
| A service refuses to start, or a legitimate statement gets `42501` | stop that service or path. Do not reconnect it as the owner. Identify the exact missing privilege. |
| A privilege is genuinely missing | fix forward: a reviewed manifest change, a regenerated migration, a new candidate SHA, applied in a window |
| The window cannot complete in time | roll back as below |

**Rollback of B1 before any P8 object exists** is an ordinary P1 to P7 rollback and returns the system to its
recorded pre-B1 state:

1. Hold ingress.
2. Redeploy the previous release (`cebbb0dfe32e913ac3d4cd2860abce6ca9ecf05e` at the time of writing) with the rollback
   baseline env files. That release has no role guard and runs as it did before.
3. Leave the roles, grants and policies in place: they grant nothing to the owner session and change no P1 to P7
   behaviour. Optionally lock the roles (`alter role ... nologin`) so the unused credentials cannot be used.
4. Decide separately whether to return `stamp_binding_provenance()` to `security invoker`. Under the owner session it
   behaves identically either way.
5. Activate the previous release, verify health, release ingress.

After any P8 object exists in production (P8A-0 or later), running a runtime process as the owner is prohibited and
the P8 write guard refuses it; rollback of B1 is then no longer available and the only path is fix-forward.

## 7. What must be recorded for the window

- the reviewed candidate SHA and its review reference;
- the production re-inventory of section 2 item 6;
- the catalogue equality result before and after;
- `current_user` and `session_user` of the running worker and door;
- the positive and negative smoke results with SQLSTATEs;
- the health report;
- the soak record.

P8A-0 remains forbidden until B1 is independently declared qualified in production.
