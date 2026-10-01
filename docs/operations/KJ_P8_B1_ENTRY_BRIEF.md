# KJ-P8 B1 entry brief: least-privilege runtime database roles

Status: BRIEF ONLY. B1 is **not authorised and not started**. This file extracts the B1 contract from the sealed
design so the next engineering session starts from one place. It adds nothing to the design and changes nothing in
it. Where this brief and the ADR differ, the ADR wins.

Source: ADR-0023 revision 2.3, section 27, at sealed commit `679e3a3dfc7a33f9106ed77913d49cdac19166d5`
(`docs/adr/0023-reflection-self-model-governed-growth.md`, on branch `design/kjp8-reflection-governed-growth`).
Seal: `docs/reviews/KJ_P8_ADR0023_R23_HOSTILE_SEAL_679e3a3.md`.

## Rule

No runtime process connects to the production database as an owner or a superuser. Production acquires no P8 object
until that is true and qualified. B1 is first in both the implementation order and the production order:
**B1, P8A-0, B2, P8A-1, P8A-2, P8B.**

B1 changes no P1 to P7 behaviour, contract, trigger or applied migration file, and adds no P8 object.

## 1. Runtime roles required

| Role | Used by |
|---|---|
| `kj_worker` | the kernel worker: workflows, ledger, scheduler, channel adapters |
| `kj_door` | the admission door (gateway) |

The deployment owner stays the existing `postgres` role, used only by a human operator in an authorised change
window, never by a running service. A separately connecting read-only reporting process, if there is one, gets a
third SELECT-only role under the same attribute rules.

## 2. Required role attributes

Both roles: `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`, a connection limit, and a
password held only in the vault.

## 3. Forbidden privileges

Neither role may, and each line is a negative test:

- ALTER, DROP or CREATE any table, view, function, trigger, type or schema;
- disable or enable a trigger, or `SET session_replication_role`;
- enable, disable or force row level security, or create, alter or drop a policy;
- TRUNCATE any table;
- GRANT or REVOKE anything;
- apply or record a migration;
- execute `activate_release`, or write `release_epoch` or `release_activations`;
- execute `set_identity_freeze`;
- UPDATE or DELETE on any append-only table;
- assume another role, or bypass row level security.

**No direct approval, adoption, version or activation bypass (ADR 27.3).** `kj_worker` has no way to approve or adopt
directly. Where it may insert an identity version, an activation or, later, an adoption binding, it may insert only
rows that pass the guards and triggers, which it cannot alter or disable. There is no ungoverned write.

From P8A-0 onward the same roles are also denied: `set_reflection_mode`, any insert into `reflection_governance`,
`open_growth_window`, the deployment close, and any insert into either growth-window table. Those objects do not
exist in B1; they are listed so that B1's manifest format can carry them.

## 4. Ownership rules

- The runtime roles own nothing, in any schema.
- They are members of no role, and no role is a member of them. `SET ROLE` and `SET SESSION AUTHORIZATION` to another
  role fail.
- USAGE on `public` and `kernel_private` only. No CREATE on any schema (CREATE on `public` is revoked from `PUBLIC`).
  No TEMPORARY on the database. No privilege on the migration ledger schema, the vault or any other schema.
- No table changes owner in B1.

## 5. Row level security expectations

- Every table already has row level security enabled and no migration creates a policy. A non-owner role therefore
  sees nothing until policies exist.
- The B1 migration adds one explicit policy per table and per verb in the manifest, `to kj_worker` or `to kj_door`.
- It does not grant `BYPASSRLS` and does not disable or relax row level security.
- Tenant isolation stays where it is today: `withTenant` and the composite keys. Views keep `security_invoker`.

## 6. `session_user` owner-refusal invariant

This invariant is implemented in P8A-0, not in B1, because it lives on P8 tables. B1 must leave it possible.

From P8A-0, every trigger on a runtime-written P8 table first checks `session_user`. If it is not `kj_worker` or
`kj_door`, the write is refused `P8_OWNER_ROLE_REFUSED`. `session_user` is used, not `current_user`, so the check holds
inside a `security definer` function. P8 cannot operate under the owner: a return to `postgres` stops P8, it does not
run P8 with wider authority. It is a guard against an operational fallback, not a defence against a hostile owner.

## 7. P1 to P7 grant inventory and freeze procedure

1. A script extracts every SQL statement in `services`, `apps` and `packages`, and every table a trigger function
   reads or writes, and produces the object, verb and column list.
2. That list, reviewed, becomes the **grant manifest**: one file, the single source of the grants. For each role it
   holds each object, the verbs, the columns for column-level UPDATE, the executable functions and the policy.
3. The B1 migration is generated from the manifest or checked against it.
4. A test compares the live catalogue with the manifest in both directions.

The ADR's starting baseline (section 27.4) is a static survey of the code at `750d5b7` and is inference until this
inventory completes and freezes it:

- `kj_worker` SELECT: every table and view in `public` and `kernel_private` (triggers are `security invoker` and read
  widely).
- `kj_worker` INSERT: the tables it writes today (the task ledger tables, evaluations, world-model tables, capability
  tables, memory tables, schedule tables, `faculty_pins`, identity tables, `principals`, `tenant_memberships`, and in
  `kernel_private` the binding, admission, dispatch, effect, control, latch, alert, terminal-result, notification and
  Telegram tables).
- `kj_worker` UPDATE: only `tasks`, `approvals`, `schedule_fires`, `identity_candidates` (columns `state`,
  `resolved_at`), `memory_candidates`, `kernel_private.telegram_approval_cards`, and the upsert targets of the alert
  state store, the ledger and the scheduler store.
- `kj_worker` DELETE: `kernel_private.control_assertions` and `schedule_leases`.
- `kj_worker` EXECUTE: the non-trigger private functions the code calls today.
- `kj_door`: SELECT on what admission, status and the read views need; INSERT on `kernel_private.execution_bindings`,
  `task_admissions` and `dispatch_events`; no UPDATE and no DELETE.

Nothing is revoked from a path production needs.

**The category wording above is not a shippable manifest.** The sealing review states that the finished, exhaustive
P1 to P7 grant list is a B1 engineering deliverable and that B1's own review must reject any attempt to ship the
category prose ("the capability tables", "those the inventory finds", the door's SELECT list). Only the frozen
manifest file, with catalogue equality in both directions, counts. B1 must discover it, freeze it, have it reviewed
and equality-test it. It is not written here.

## 8. Required negative privilege probes

Connected as each runtime role, every operation in section 3 of this brief is attempted and must fail, with
SQLSTATE `42501` or the named refusal. A check that has not been seen to fail is not accepted.

## 9. Full P1 to P7 requalification

The complete existing suite, the faculty, identity and cognition mutation suites and the real-Restate tests run with
the worker connected as `kj_worker` and the door as `kj_door`, against a database migrated by the owner. Required:

- the same pass and skip counts as the baseline run at the same commit;
- zero `42501` errors in the database log for the whole run;
- catalogue equality with the manifest: no privilege more, none fewer.

## 10. Cutover requirements

In its own change window:

- credentials provisioned through the vault tooling, with the value never in an argument;
- worker and door restarted on the runtime roles;
- `current_user` read from each running process and equal to its runtime role;
- a P1 to P7 live proof: a mission, a scheduled fire, an approval and a Telegram round trip;
- health green, including `database.runtimeRolesLeastPrivilege` (P0).

## 11. Soak requirements

P8A-0 is not applied to production until B1 has run through at least one full scheduler cycle and one live mission
with zero insufficient-privilege errors.

## 12. Rollback and fail-closed behaviour

- If B1 cannot be established or does not qualify, P8 stays unavailable. Nothing in P8 is deployed.
- A missing grant found after cutover is fixed forward: a reviewed manifest change and a migration in a change
  window. It is never fixed by connecting a service as the owner.
- Before any P8 object exists in production, reverting the role change is an ordinary P1 to P7 rollback and returns
  the system to its recorded pre-B1 state, with P8 still absent.
- Once a P8 object exists in production, running a runtime process as the owner is prohibited. If it happens, the
  runtime-role guard refuses every P8 write and the health check raises P0.

## 13. No fallback to postgres

There is no fallback to `postgres`, no temporary owner mode, no break-glass switch for P8 and no degraded mode that
widens authority.

## 14. Artefacts B1 must produce before P8A-0 can begin

1. The reviewed grant manifest, frozen, in the repository.
2. The inventory script and its output.
3. The B1 migration (a new file; no applied migration edited), creating the two roles, the grants and the policies.
4. The catalogue-equality test, passing in both directions.
5. The positive requalification record: suite counts equal to baseline, zero `42501`.
6. The negative probe record: every denied operation seen to fail, for both roles.
7. The health check `database.runtimeRolesLeastPrivilege`, with a selftest fixture that makes it fail on purpose.
8. The production cutover record: `current_user` of the running worker and door, the live proof, health.
9. The soak record.
10. B1's own review, as the sequence document requires.

## Facts to establish at the start of B1

These were not observed during design and are not assumed:

- the door's current database role in production;
- whether the hosting platform lets the owner create roles with exactly these attributes;
- the complete list of upsert targets and private functions, which the inventory fixes.
