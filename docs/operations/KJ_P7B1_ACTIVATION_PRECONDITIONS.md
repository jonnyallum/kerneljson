# KJ-P7B-1 activation preconditions and STOP gates

Status: preparation only. Nothing here has been run against production. It applies to a LATER, separately authorised
P7B-1 activation window (epoch 13, feature OFF). It does not authorise that window, and it never authorises P7B-2.

Design: ADR-0022 (sealed `2dd2af5`) and its D1 errata (`a1e8381`, confirmed contract `354a6c3`).

## STOP gate 1: the production worker's database role

The P7B-1 ACL contract (ADR-0022 section 4.2) grants `service_role` SELECT and INSERT on
`kernel_private.identity_cognition_latches` and SELECT on `kernel_private.identity_cognition_contract_v1`, and nothing
else in `kernel_private`. The worker already writes `kernel_private.execution_bindings`, which `service_role` has never
been granted. So the worker probably connects as the owning role. That is INFERRED, not observed.

Before any deployment, measure it read-only, as the worker's own database connection sees it:

    SELECT current_user;

- Record the **role name only**. Never the connection string, a credential, or any other output.
- If it is the owning role (`postgres`), the grants do not bind the worker. Its ceiling is the
  `reject_ledger_mutation` immutability triggers and the latch/pin constraint triggers, which fire for every role.
  Proceed.
- If it is `service_role`, the worker must also be able to read `execution_bindings`, `faculty_pins`,
  `identity_current` and `identity_versions`, and to execute `kernel_private.identity_cognition_source_v1` and
  `kernel_private.identity_core_digest_v1`. None of those is granted to `service_role` by this migration, so the
  latch path would fail closed. **STOP.** Do not deploy, and return the finding for review.
- If it is anything else: **STOP.**

CI runs the latch path as `postgres`, the owner, which is the role the disposable test stack's worker uses.

**Observed 2026-09-30:** `SELECT current_user` executed inside the running
`kerneljson-execution-worker-1`, using its own `DATABASE_URL` in a READ ONLY transaction,
returned **`postgres`**. Only the role name was emitted. This closes the implementation
PR's role-discovery gate; repeat it immediately before the activation window.

The accompanying read-only snapshot at `2026-09-30T21:08:07.736Z` found epoch **12**,
active and worker release `4127361860700085453f86aa09adfa7bf81ef7d3`, cognition unset,
zero nonterminal tasks, zero identity pins, one current identity for the production
tenant, the expected Kernel v1 row with both approved digests, zero unfrozen identities,
and zero open P0/P1 alerts. Neither P7B table existed. These are point-in-time
observations, not a deployment or a substitute for fresh preflight.

The window sequence is in [KJ_P7B1_DEPLOYMENT_RUNBOOK.md](KJ_P7B1_DEPLOYMENT_RUNBOOK.md).

## STOP gate 2: the migration's own pre-COMMIT qualification

`supabase/migrations/20260929120000_identity_cognition_binding.sql` runs in one transaction and raises, rolling back
everything, unless all of these hold:

- the SQL twin reproduces the three Kernel v1 digests: `01998d01...`, `4f6dc581...`, `c1e3d107...`;
- the persisted Kernel v1 row `08be5e20-2606-4809-b81f-11552bb67502` is exactly the approved document with exactly
  those digests;
- every existing identity version has digest parity;
- `identity_pins` is empty, and the contract marker is empty;
- `service_role` gains nothing in `kernel_private` beyond the two allowed grants;
- anon and authenticated hold nothing on any P7B object.

A raise here is a STOP, never a retry with edits in the window.

## The atomic activation transaction (the ONLY place the marker is written)

With ingress quiesced, as the operator role that already runs `activate_release`:

    BEGIN;
      SELECT kernel_private.activate_release('<request uuid>', '<P7B-1 release sha>', 12, '<evidence json>');  -- returns 13
      INSERT INTO kernel_private.identity_cognition_contract_v1(contract, first_release_epoch)
        VALUES ('kerneljson:identity-cognition/v1', 13);
      -- verify: exactly one marker row; first_release_epoch = 13 = release_epoch.epoch;
      --         release_activations(13).release_id = '<P7B-1 release sha>'
    COMMIT;

- The marker guard refuses any epoch other than the one current in this transaction, so it cannot be backdated.
- If either statement or the verification fails, both roll back.
- Retry: `activate_release` returns the existing epoch for the same request id. Insert the marker only if no row
  exists. A row with the same epoch is success; a row with a different epoch means abort.

## Feature state while OFF

`KJ_IDENTITY_COGNITION_ENABLED` stays unset or `false`. With it OFF:
- analyst and reviewer provider requests are byte-identical to release `4127361`;
- NONE latches and `MODEL_CALLED` digest bindings are still written for contract-era tasks, by design;
- `identity.analystRunsBound` reports NO_OBSERVATION at P3 without notifying.

Turning it on is P7B-2 and needs separate authorisation.

## Rollback drain rule (ADR-0022 section 4.8)

Before activating any release that does not implement `kerneljson:identity-cognition/v1` while the marker exists,
require zero non-terminal tasks bound under the contract:

    SELECT count(*) FROM public.tasks t
      JOIN kernel_private.execution_bindings b ON b.task_id = t.id
      JOIN kernel_private.identity_cognition_contract_v1 m ON m.singleton
     WHERE t.status NOT IN ('COMPLETED','FAILED','CANCELLED') AND b.release_epoch >= m.first_release_epoch;
    -- must be 0

Safety is never inferred from the switch being OFF. A REQUIRED task stays REQUIRED.

**Rolling forward again.** Before rolling forward onto a P7B-capable release after such a rollback, require zero
non-terminal tasks bound at the rolled-back epochs. The completion oracle would otherwise fail them closed.

## Class C/D

It remains frozen. Nothing in P7B-1 or P7B-2 unfreezes it (ADR-0021 erratum of 29/09/2026, ADR-0022 section 14).
