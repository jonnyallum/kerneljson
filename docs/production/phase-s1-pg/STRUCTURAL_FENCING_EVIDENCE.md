# S1-F2 Structural Lease Fencing — Evidence

## Question
CAN ORDINARY SCHEDULER RUNTIME CODE PERFORM AN OWNERSHIP-SENSITIVE MUTATION
WITHOUT A CURRENT LEASE FENCE?

## Answer: NO.

## 1. Compile-time (defence in depth)
The runtime interface `ScheduleStore` requires `fence: LeaseFence` on the
ownership-sensitive methods. Removing a fence argument does not compile:

    tests/schedule-fencing-types.test.ts(15,10): error TS2554: Expected 3 arguments, but got 2.

`tests/schedule-fencing-types.test.ts` holds `@ts-expect-error` tripwires so
`pnpm typecheck` FAILS (TS2578 unused directive) if fencing is ever made optional again.

## 2. DB enforcement (authoritative)
Protected mutations UPDATE ... FROM schedule_leases with a `l.owner=$ AND l.epoch=$`
predicate. A stale/wrong fence matches no lease row -> zero rows updated -> fail closed.
Live proof (throwaway local Postgres): a stale-owner fenced write returns `UPDATE 0`
(see FENCING_DB_EVIDENCE.txt). Fencing suite: 8/8.

## 3. Operation classification
OWNERSHIP-SENSITIVE (fence REQUIRED, DB-enforced): bindAdmission, transition, releaseLease.
AUTHORITY-SAFE / NON-LEASED (no fence): createOrGetFire (idempotent unique constraint),
claimLease (acquires ownership), setState (admin), upsertSpecVersion (admin/immutable),
createBackfillRequest (human approval + CHECKs), recordObservation (telemetry).
READS (never fenced): getSchedule, listFires, listObservations.

## 4. Privileged escape hatch (not on the runtime interface)
`PrivilegedScheduleStore` (bindAdmissionPrivileged / transitionPrivileged) exists ONLY on
the concrete stores for bootstrap/migration/reconciliation and lease-independent CONTRACT
tests. Code typed against `ScheduleStore` cannot reach it.
