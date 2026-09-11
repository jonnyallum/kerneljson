# S1 Canary Gate 1.6 — HUMAN identity provisioning path (repo-only)

Date: 2026-09-11. Author: Claude A (takeover; builder/verifier).
Branch: `feat/s1-canary-gate1_6-human-identity` (base: Gate 1.5 HEAD `8855620`).
Scope: **Gate 1.6 — repository-only HUMAN identity provisioning tooling. NO production
mutation; no production identity created.** Gate 2 remains NOT authorised.

## Why
The Gate 1.5 preflight found the production KernelJSON DB has **0 HUMAN principals** (sole
principal is SERVICE `72db0114-839e-8ca9-a2fa-462b561a936b`), and there is **no canonical,
tested path** to create one — only raw SQL in test fixtures. The scheduler requires a HUMAN
owner. This builds the missing typed, tested, atomic, idempotent, fail-closed provisioner.

## Architectural decision
The first canary's HUMAN authority = an explicit **HUMAN** principal + **ACTIVE** membership,
role **`operator`** (least privilege: `operator` already satisfies the scheduler
`schedule`/`approve` authorisation in `packages/identity`, so `owner` is unnecessary). The
existing SERVICE principal is never changed or reused.

## Provisioning API
`provisionHumanPrincipal(store, { principalId, tenantId, role })`
(`services/kernel/src/identity/provisioning.ts`). Narrow and explicit — it accepts only
caller-supplied ids (never invents a production principal), `role` is restricted to `operator`,
and it has ZERO dependency on scheduler/task/Restate/gateway/runtime. Result:
`{ provisioned | alreadyProvisioned, principalId, tenantId }`.

## Persistence / store boundary
`IdentityProvisioningStore` interface (`snapshot` + `provisionAtomic`), mirroring Gate 1.5.
- `InMemoryIdentityStore` — reference impl for tests; reproduces PK/unique + transaction
  atomicity, with an injectable membership-insert failure to exercise rollback.
- `PgIdentityProvisioningStore` (`provisioning-pg.ts`) — production impl over the kernel's
  PRIVILEGED pool (service-role/superuser; never anon/authenticated). Touches only
  `public.principals` and `public.tenant_memberships`.

## Transaction implementation (atomic)
`provisionAtomic` runs `begin` → `insert principals(id, 'HUMAN')` → `insert
tenant_memberships(tenant_id, principal_id, 'operator', 'ACTIVE')` → `commit`; any failure
`rollback`s both. Invariant: **either both the HUMAN principal and the ACTIVE membership exist,
or neither new record is committed** — no orphan principal.

## Idempotency semantics
Exact already-provisioned state (principal exists + HUMAN + tenant exists + membership exists +
role `operator` + status `ACTIVE`) → `alreadyProvisioned: true`, **no write** (proven with a
store spy that throws if `provisionAtomic` is called). Fresh valid state → `provisioned: true`
after the transaction commits.

## Conflict semantics (fail closed; never mutates existing identity)
Distinct error codes for: `UNKNOWN_TENANT`, `MALFORMED_PRINCIPAL_UUID`, `MALFORMED_TENANT_UUID`,
`UNSUPPORTED_ROLE`, `PRINCIPAL_NOT_HUMAN` (id exists as SERVICE / non-HUMAN),
`MEMBERSHIP_ROLE_CONFLICT`, `MEMBERSHIP_REVOKED`, `MEMBERSHIP_REMOVED`,
`MEMBERSHIP_STATUS_UNEXPECTED`, `PARTIAL_STATE_UNSAFE` (HUMAN principal exists but requested
membership absent), `ORPHAN_MEMBERSHIP`. No silent update / reactivate / re-role / repair —
those are separate, unauthorised operations.

## Test evidence (`tests/identity-provisioning.test.ts`, 14, Docker-free)
- Success: HUMAN + ACTIVE operator membership created for the tenant; the pre-existing SERVICE
  principal and its membership unchanged.
- Idempotency: exact repeat → `alreadyProvisioned` with NO write (spy proves `provisionAtomic`
  not called).
- Conflicts/negatives: unknown tenant; malformed principal/tenant UUID; unsupported role
  (`owner`); id already SERVICE; membership different role; REVOKED; REMOVED; partial state; and
  "never mutates existing records on conflict" (SERVICE stays SERVICE).
- Transactionality: injected membership-insert failure → throws AND leaves no orphan HUMAN
  principal (rollback proven).
- Side-effect boundary: after provisioning, an independent scheduler store has zero
  schedules/fires/observations (provisioning is structurally independent of the scheduler).

## Production-use contract (prepared, NOT executed)
`runHumanProvision({ pool, principalId, tenantId })` (`provisioning-pg.ts`) — Gate 2 supplies the
pool + the **explicit, change-window-approved HUMAN principal UUID** + the existing production
tenant id; role fixed to `operator`. **It never generates a UUID**, so the exact principal being
created is visible in the authorisation before any write (auditable). Existing tenant
`5f970749-7507-894b-a2e4-872ce20a94b7` ("estate") is valid as the membership tenant.

## Qualification (local)
typecheck 0; lint 0 (`--max-warnings=0`); full suite **412 passed / 32 skipped (444)**; baseline
gate green (224/224, recovery 31, 32 intentional skips); build 0. No `baseline.json` change (new
tests are additive passes).

## Production mutation = NONE
No principal/membership/tenant row created or modified; no migration; no schedule; no enable; no
deploy; no merge. HUMAN identity provisioning is an explicit PRODUCTION MUTATION and will appear
in the Gate 2 change-window evidence when executed.
