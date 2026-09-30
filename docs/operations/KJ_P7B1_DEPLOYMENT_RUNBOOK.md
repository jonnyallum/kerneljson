# KJ-P7B-1 epoch-13 deployment runbook

Status: prepared, not executed. PR #48 contains the implementation. The production
baseline observed on 30 September 2026 is release
`4127361860700085453f86aa09adfa7bf81ef7d3`, epoch 12. Cognition stays **false** throughout
this window. P7B-2 and Class C/D unfreezing are outside this window.

This runbook follows [RELEASE_PROVENANCE.md](RELEASE_PROVENANCE.md) and
[KJ_P7B1_ACTIVATION_PRECONDITIONS.md](KJ_P7B1_ACTIVATION_PRECONDITIONS.md). Production
execution requires Jonny's explicit session change-window authorisation under the
cross-repository `new-system/docs/migration/CHANGE_WINDOWS.md`. Preparation and
read-only preflight do not open that window.

## 1. Pin the release and evidence

- Resolve the reviewed PR head or merged release to a full SHA. Require successful
  qualification for that exact SHA, including both mutation jobs. If merged with a
  new SHA, verify tree identity and qualify the merge SHA before deploying it.
- Record the release SHA, tree, CI URLs, migration blob SHA-256, image IDs, operator,
  activation request UUID and window timestamp. Choose the request UUID once and
  retain the exact activation evidence for uncertain retries.
- Do not use a moving branch name as the release. Do not deploy while CI is pending.

## 2. Fresh read-only preflight

Target only `kerneljson-prod-01`, project `project-c407f628-c71c-45fa-994`, zone
`europe-west2-b`; checkout `/opt/kerneljson/app`. Use the worker's own database
connection, never print it, and use a read-only transaction for database inspection.

Require all of the following; otherwise stop before mutation:

- Worker `current_user=postgres`, worker and door release equal the epoch-12 activation,
  clean production checkout, healthy worker/door/Restate, door localhost-only.
- Cognition unset or false; the two P7B tables and migration-ledger entry absent.
- Exactly the approved current Kernel v1, valid version digests, zero identity pins,
  zero nonterminal tasks and unresolved admissions, no unaccounted pending execution.
- No open P0/P1 alert and no provenance mismatch or poisoned notification delivery.
- Class C/D still default-closed or explicitly frozen; no C/D policy additions.
- Inventory scheduler state and pending Restate wakes. Preserve the recurring
  schedule and its durable state; a deployment must not disable it or bootstrap it.
- Inventory every admission/direct workflow writer, including Telegram, scheduler
  and replay paths. Record how each will be held during the window. A stopped HTTP
  door alone is insufficient if another path can create a binding.

The 21:08 UTC snapshot recorded in the preconditions is only a starting observation;
it did not inspect every item above and is not a full activation preflight.

## 3. Quiesce and apply the migration

Hold all binding ingress using existing maintenance controls and drain initial
ledger/admission transactions. Preserve Restate state and pending wakes. Keep ingress
held until step 6 succeeds. Record binding/admission counts and verify they stop changing.

Read the exact reviewed migration blob:
`supabase/migrations/20260929120000_identity_cognition_binding.sql`. Verify the file
hash against the reviewed blob before sending it to the database.

**The SQL file does not contain BEGIN/COMMIT.** Execute the entire file on one
connection inside an explicit transaction, with `lock_timeout='10s'`. Its DO block
must run before COMMIT. In that same transaction also require production Kernel v1
to exist (the migration permits its absence for empty disposable databases), the
current epoch to remain 12, and the marker to be empty. Record the migration in the
existing migration ledger using its established convention in that transaction.

Any SQL or qualification failure means ROLLBACK and stop. Do not alter the migration
or remove a failed assertion to retry in the window. After COMMIT, use a fresh
connection to verify the objects, digest parity, deferred constraints, exact ACLs,
empty marker, and migration-ledger entry independently.

## 4. Deploy the pinned images with cognition OFF

Build worker and door from the pinned clean checkout using the existing Dockerfiles.
Record immutable image IDs. Preserve the prior images and mode-600 runtime env files
for rollback. Use `scripts/runtime_env_merge.py` to change only the release IDs and
set worker `KJ_IDENTITY_COGNITION_ENABLED=false`; independently verify its file diff.
Preserve every other setting, including signing keys, memory, approvals, Telegram,
alert transport, model routes and scheduler configuration. Never print rendered
Compose config or secret values.

Recreate the worker and door with the existing Compose projects, with all binding
ingress held. Preserve Restate's container, volume and journal. Register the new
worker and verify its service list and image/release IDs. Verify both containers
report the chosen SHA and the worker reports the switch as `false`. Keep the door
held until activation and verification below. If maintenance cannot prevent another
binding writer from running at this stage, stop and correct the maintenance plan
before beginning the window.

## 5. Activate the release and marker atomically

Use one dedicated owner connection and parameterised values. With the recorded UUID,
release SHA and exact evidence object, execute this sequence in one transaction:

```sql
BEGIN;
SET LOCAL lock_timeout = '10s';
SELECT kernel_private.activate_release($1::uuid, $2::text, 12, $3::jsonb);
-- Application must require the returned epoch to be exactly 13.
INSERT INTO kernel_private.identity_cognition_contract_v1(contract, first_release_epoch)
SELECT 'kerneljson:identity-cognition/v1', 13
WHERE NOT EXISTS (SELECT 1 FROM kernel_private.identity_cognition_contract_v1);
SELECT e.epoch, a.release_id, m.contract, m.first_release_epoch
FROM kernel_private.release_epoch e
JOIN kernel_private.release_activations a USING (epoch)
CROSS JOIN kernel_private.identity_cognition_contract_v1 m
WHERE e.singleton;
-- Application must require exactly one row, epoch=first_release_epoch=13,
-- contract=kerneljson:identity-cognition/v1 and release_id=$2 BEFORE COMMIT.
COMMIT;
```

The comments above are mandatory caller assertions, not SQL checks. A client running
these statements without enforcing them is not an approved executor. Roll back on
any mismatch. On an uncertain response, inspect from a fresh connection and retry
with the same UUID and evidence. An existing different marker or a historical
activation result while another epoch is current is a stop, never success.

## 6. Verify, reopen and prove the OFF contract

From a fresh session require epoch 13, the chosen release, exactly one epoch-13
marker, zero binding/activation mismatches, worker/door parity, cognition false,
healthy services and unchanged scheduler configuration. Then reopen ingress.

Observe naturally authorised work for release provenance. For the ADR-0022 OFF
proof, include one bounded repo-analysis mission in the authorised window scope;
use the canonical admission path and normal approval boundary. Fix its semantic
inputs, repo head and memory snapshot. Compare the outgoing request in memory with
the `4127361` builder for the same inputs and record only equality and digests.
Do not store prompt or memory text to manufacture durable proof. If the in-memory
observation mechanism is unavailable, report this proof incomplete; local golden
fixtures alone are not a live OFF proof.

Require successful canonical completion, an analyst NONE latch, no identity pin,
digest-only MODEL_CALLED evidence and reviewer isolation. Group A identity checks
must be healthy; `identity.analystRunsBound` remains NO_OBSERVATION/P3 without
notification while there is no REQUIRED run. Class C/D remains frozen. Record
the actual observations and any maintenance alert recovery in a dated result file.

## 7. Rollback

Before activation: keep ingress held, restore the prior images and env files,
verify the unchanged epoch-12 release and parity, then reopen. If the migration
committed, leave its additive schema in place and verify the marker is still empty;
do not edit migration history or drop immutable evidence.

After activation: hold ingress again and enforce the zero-nonterminal-contract-task
drain query in the preconditions. OFF does not waive this requirement. Restore
the prior worker/door release in lockstep and activate it with a **new** request UUID
and the actual current expected epoch. Never delete the marker, move it backwards,
rewrite bindings or reuse the epoch-13 request for a rollback. Verify the new
rollback epoch and parity before reopening.

Before a later roll-forward, drain tasks bound at the rollback epochs too. If any
required task cannot be drained under its bound release, remain quiesced and stop.

## Next window: P7B-2

Prepare a separate plan after the OFF window passes: enable cognition for new latches,
one REQUIRED mission, G2 negative proofs, and two fresh G5 missions on DeepSeek then
OpenRouter with the same semantic inputs and unchanged identity/memory. Compare the
ADR-0022 stable equality set and require different actual provider/model/request
digests. G13 closes live qualification only; it never unfreezes Class C/D.
