# Canonical release provenance (KJ-P1.3C)

## Authority and ordering

KernelJSON remains the only task authority. This seam records release epochs; it
does not schedule, admit, dispatch, retry or complete work. No runtime startup path
calls activation. `kernel_private.activate_release` is an explicit operator action.

Every binding INSERT fires `stamp_binding_provenance`, which performs a real
`UPDATE release_epoch SET epoch=epoch ... RETURNING epoch`. Activation updates that
same singleton row before advancing it and inserting the activation record. Both
hold the row lock until their outer transaction commits or rolls back.

Therefore a binding that obtains the row first must commit/abort before a different
transaction can activate. A binding that obtains it after activation commits gets
the new epoch, even if its transaction started earlier. An aborted transaction
contributes neither binding nor activation. Within one transaction, statement order
defines the epoch; operators must use a dedicated activation transaction.

Under READ COMMITTED, UPDATE uses the current committed row after a conflicting
updater finishes. Under REPEATABLE READ/SERIALIZABLE a stale updater fails with
SQLSTATE 40001 and must retry its **whole transaction**, not just its last statement.
This is why a real row update is used instead of merely acquiring an advisory lock
and then reading a stale snapshot. See [Postgres isolation semantics](https://www.postgresql.org/docs/17/transaction-iso.html)
and [explicit consistency locks](https://www.postgresql.org/docs/17/applevel-consistency.html).

Neither transaction IDs nor sequence allocation prove commit order. No timestamp
comparison is used. `persisted_at` and `activated_at` are database clock audit times,
not commit times. The ordering token is `release_epoch`.

Tradeoff: binding transactions serialize through one row, held until commit. Keep
admission transactions short and free of network calls (the current gateway already
commits admission before dispatch). This is intentional for the current small
deployment. Deadlocks/serialization failures abort safely; existing caller retry
paths retain task identity. A throughput redesign is outside this phase.

## Schema and trust boundary

- `release_epoch`: singleton, current bigint epoch; initially 0.
- `release_activations`: immutable epoch, unique operator request UUID, release ID,
  previous release ID, database activation time, database actor and evidence object.
- `execution_bindings`: database-assigned release_epoch and persisted_at. The
  existing immutable JSON contract and its intent-derived boundAt are unchanged.

Activation uses expected_epoch compare-and-swap. Reusing an identical request UUID
returns its original epoch, even after a later activation; it never reactivates it.
Different payload/expected epoch under that UUID fails. A new stale request fails.
Rollback to a previous release requires a **new** explicit epoch/request.

Functions are SECURITY INVOKER with fixed empty search_path. Private tables have
RLS and no grants to PUBLIC, anon, authenticated or service_role. Activation EXECUTE
is also revoked from those roles. The existing privileged owner connection is the
deployment authority; this phase does not introduce runtime database roles. Owners
can bypass schema protections by DDL and remain trusted, as with the existing
immutable ledger. Runtime code never invokes activation or directly edits the
singleton/activation tables. Any future role separation must explicitly grant the
binding trigger's singleton UPDATE while reserving activation for the operator.

The trigger stamps even raw SQL inserts and overwrites caller-provided provenance.
An ON CONFLICT replay leaves the original row, epoch and persisted_at unchanged.
A conflicting release request retains its historical release under existing binding
semantics; the ledger's bound-worker rejection guard is unchanged.

## Binding writer inventory

| Path | Binding creation |
|---|---|
| HTTP admission (`apps/gateway/src/server.ts`) | `persistBinding` in admission transaction, before dispatch |
| Direct workflow task creation (`services/kernel/src/ledger.ts`) | `persistBinding` in initial TASK_CREATED transaction |
| TaskWorkflow, KernelWorkflowV1, PolicyCapabilityWorkflowV1, GoldenTaskWorkflowV1, AutonomousChildTaskWorkflowV1, BoundedScheduleWorkflowV1 | ledger's workflow-bound creation path |
| Production scheduler (`scheduler/http-admission.ts`) | HTTP admission door with stable fire identity; no database binding writer |
| Recovery/replay | existing admission reads stored binding; ledger replay preserves existing task/binding; insert conflict preserves provenance |
| Test-only `tests/support/seed-admission.ts` | raw insert, covered by the same database trigger |

No runtime writer refactor is required: persistBinding is already the sole application
INSERT site. Source inventory tests and gateway/ledger integration assertions enforce
that result. Database enforcement additionally covers future direct SQL callers.

## Legacy baseline

Migration takes the normal ALTER TABLE ACCESS EXCLUSIVE lock. Existing immutable
bindings receive epoch 0 and NULL persisted_at without rewriting their contracts or
claiming a historical insertion date. The trigger is installed before migration
commit. New bindings before the first activation also receive epoch 0, with real
database insertion audit time. All epoch-0 bindings are provably before the first
activation because that activation serializes against the trigger. There is no
fictional epoch-0 release activation. Missing activation is UNKNOWN, never HEALTHY.

## Shared health semantics

The collector reads singleton, activation records and all bindings in **one SELECT
snapshot**, including admissions without task projections. There is no 24-hour or
50-row limit. Both `authority.bindingReleaseConsistent` and
`releaseParity.recentBindingsConsistent` use the same verdict:

- Bindings in each nonzero epoch must match that epoch's immutable release ID.
  A mismatch is CRITICAL/P1, even after another activation. Historical valid epochs
  and the explicit legacy baseline do not cause drift merely by differing from today.
- Active release differing from configured expected release is CRITICAL/P1.
- Missing schema/activation/provenance is UNKNOWN and blocks transition qualification.
- No current-epoch bindings is UNKNOWN/NO_OBSERVATION; historical rows cannot manufacture
  a current observation. Multiple valid historical releases plus valid current work
  is HEALTHY; history alone is UNKNOWN.
- `releaseParity.matchesExpected` still compares running versus expected release
  directly. Actual bound-worker rejection remains CRITICAL/P1, without a new time filter.

The authority alert mapping changes from historical-mix DEGRADED/P2 to proven
epoch-mismatch CRITICAL/P1. This strengthens the check; it is not a policy downgrade.

## Canonical activation protocol — preparation only

Execution requires a separately authorized production change window. This PR does
not authorize deployment/migration or resume P1.3A.

1. Record canonical SHA, expected release, current epoch, images/config, existing
   scheduler pending wakes, counters and runtime health. Read-only inventory all
   admission/direct workflow routes and old-release pending bindings. Stop if any
   writer or unresolved old binding cannot be accounted for.
2. Quiesce admission ingress and direct workflow ingress; drain in-flight admission
   and initial ledger transactions. Include scheduler requests through the same door
   and recovery/replay attempts that could first create bindings. Preserve canonical
   scheduler state/configuration and pending Restate wakes. Use deployment maintenance
   controls, not another scheduler or task authority. Prevent new containers accepting
   minting traffic until activation commits. An open transaction barrier alone is not
   a maintenance gate across multiple deployment connections.
3. Apply the reviewed migration in one transaction during that quiescence. On first
   installation, record the epoch-0 baseline count and immutable binding inventory.
   Do not fabricate earlier activations or overwrite existing bindings.
4. Deploy reviewed worker and door using existing conventions; verify actual image/SHA,
   explicit expected release, worker/door parity, registration and health. Keep all
   binding ingress quiesced. Resolve/drain pending historical bindings under their
   proper bound release before resuming; do not rewrite them to the new release.
5. As the deployment database owner, call in a **dedicated transaction**:

   ```sql
   BEGIN;
   SET LOCAL lock_timeout = '10s';
   SELECT kernel_private.activate_release(
     :request_uuid, :verified_release_id, :previous_epoch, :evidence_json);
   COMMIT;
   ```

   These are parameter placeholders, not values inferred at runtime. Evidence must
   reference operator identity/change window, verified parity, quiescence and baseline
   qualification, without secrets. Use one request UUID for every uncertain retry.
   Verify the committed record and current singleton epoch; returning a historical
   retry result alone is not proof that epoch is still active. On timeout/error keep
   ingress quiesced, inspect state and retry safely; never guess commit success.
6. Verify the active record matches the expected release, zero epoch mismatches,
   unchanged business scheduler state, and healthy runtime before reopening ingress.
   At this stage NO_OBSERVATION is expected if no new canonical work has occurred.
   Resume normal admissions; observe natural authorized work, then require both binding
   checks HEALTHY for full release-transition qualification. Never mint synthetic
   production work to turn the gate green. Missing provenance blocks qualification.
7. If an old worker writes after cutover, its binding belongs to the new epoch and
   becomes CRITICAL/P1. Quiesce and investigate; do not hide it by advancing epochs.
   Failed deployment before activation leaves the old epoch intact. A rollback after
   activation requires the same quiesce/parity/new-epoch protocol for the restored
   release, preserving all previous activation/binding evidence.

No monitor bootstrap is part of this protocol. P1.3A remains a separate phase.
