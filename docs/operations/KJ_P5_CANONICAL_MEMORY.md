# KJ-P5 canonical memory fabric: runbook and live-proof design

Status: BUILT AND TESTED LOCALLY. NOT MERGED. NOT DEPLOYED. The migration has NOT been applied to production.
Date: 21/09/2026. Design authority: ADR-0018 (authority) and ADR-0020 (this fabric).

## What exists

| Piece | Where |
|---|---|
| Contracts (classes, origins, candidate, version, context request and result) | `packages/contracts/src/canonical-memory.ts` |
| Migration (five tables, guard triggers, current view, RLS, inbox constraint widening) | `supabase/migrations/20260921180000_canonical_memory.sql` |
| Deterministic promotion policy | `services/memory/src/canonical/policy.ts` |
| Canonical memory service (submit, promote, correct, supersede, retract, flag conflict, find, list, assemble, settle approval) | `services/memory/src/canonical/service.ts` |
| Approval binding through the existing ApprovalStore | `services/memory/src/canonical/approval-binding.ts` |
| Context assembler (pure ranking, packing, digest, render) | `services/memory/src/canonical/assembler.ts` |
| Shared Brain boundary (read-only port, candidates only) | `services/memory/src/canonical/sharedbrain.ts` |
| `/remember` classification | `services/memory/src/canonical/classify.ts` |
| Configuration (`KJ_MEMORY_ENABLED`) | `services/memory/src/canonical/config.ts` |
| Mission memory port (read-only) | `services/kernel/src/mission/memory-port.ts`, `services/memory/src/canonical/mission-port.ts` |
| Telegram memory commands and port | `services/kernel/src/channel/telegram/{commands,replies,operator,memory-port,production}.ts` |
| Mutation check | `scripts/mutation-check-memory.mjs` |

## Configuration (all off by default)

| Variable | Meaning |
|---|---|
| `KJ_MEMORY_ENABLED` | `true` turns memory on. Unset, empty or `false`: missions run exactly as before and the four Telegram commands answer "not switched on". Any other value stops the worker at startup. |
| `KJ_ADMISSION_TENANT_ID`, `KJ_ADMISSION_PRINCIPAL_ID` | Already set for the door. They are the operator's tenant and principal for memory. Required when memory is on. |
| `KJ_MEMORY_APPROVER_ID` | Optional. The human who may approve protected promotions. Unset: protected candidates stay held. |
| `KJ_MEMORY_APPROVAL_TTL_SECONDS` | Optional, 60 to 604800, default 86400. |

None is a secret. They are declared in `execution.compose.yaml`, in `scripts/check-execution-topology.mjs` and in the
public-key table of `scripts/runtime_env_merge.py`, so the explicit-allowlist gotcha (an undeclared variable is
silently dropped) cannot bite.

## The first live memory proof (design only, not run)

Do not start any of this without Jonny's explicit go. It changes a live database and redeploys the worker.

Pre-flight, per the standing rule:

1. Target: apply migration `20260921180000_canonical_memory.sql` to the production kerneljson database, then deploy the
   worker at the merged release with `KJ_MEMORY_ENABLED=true`. Today the five memory tables and the view do not exist,
   and `telegram_inbox_command_check` allows only STATUS, MISSION, TASK and MALFORMED. Read both before writing.
2. Verification, chosen before acting: `to_regclass` is non-null for the five tables and the view; all five have
   `relrowsecurity = true`; no grant to `anon`, `authenticated` or `public`; the inbox constraint lists REMEMBER,
   MEMORIES, MEMORY and FORGET; the worker reports the merged release id; a fresh `/status` still answers.
   Failure means any of those is different, or the worker crash-loops (check `restart_time` and connect to the port,
   not just pm2 or compose status).
3. Expectation: 5 tables, 1 view, 4 guard functions; `select count(*)` is 0 on all five tables before the proof.

Order: migration first (it is additive, and a worker without the flag ignores it), then the worker. The door is not
touched by this change, so there is no lockstep door and worker deploy as there was for P4B.1.

The proof:

1. Jonny sends `/remember I prefer concise deployment summaries unless I explicitly ask for detail`.
   Expect the reply "Remembered as PREFERENCE: memory <8 hex> v1."
2. Read the rows, by name, no secrets involved:
   - one `kernel_private.telegram_inbox` row, DONE, command REMEMBER;
   - one `memory_candidates` row: origin OPERATOR_INSTRUCTION, idempotency key `telegram:upd:<update id>`, state PROMOTED;
   - one `memory_promotions` row: decision ALLOW, rule `operator-instruction`, promoted by POLICY_ENGINE;
   - one `memory_versions` row: version 1, PREFERENCE, USER_AUTHORED, and `evidence` equal to the candidate's, naming
     `update:<update id>` with the sha256 of the text.
3. No duplicate on replay. The controlled way: with Jonny's go, set `next_offset` in `kernel_private.telegram_operator_state`
   back to that update id and let one poll run. Expect no new candidate, promotion or version, and no second reply
   (the inbox row is DONE). Note the idempotency is per Telegram update, not per sentence: sending the same sentence
   as a new message is a new instruction and creates a new memory.
4. Send `/memories` and `/memory <8 hex>`: the memory is listed and the provenance line names the Telegram update.
5. A harmless mission, for example `/brief jonnyallum/kerneljson`. Expect the analyst evidence to carry `memory_context`
   with status ASSEMBLED, the memory id at version 1, and a context digest; a `memory_context_assemblies` row with that
   digest, the task id and the analyst call id; and the same digest when the assembler is asked the same question again.
   Whether the answer is more concise is not the test: the record of what the model was given is.
6. Optional: `/forget <8 hex>`, then a second mission. Expect the version count for that memory to be 2 (history kept),
   `/memories` to be empty, and the second mission's evidence to list no such memory.

Signals that something is wrong: the reply "I could not reach memory" (database or migration); `memory_context.status`
UNAVAILABLE (the mission still runs, and says so); any reply that echoes text the operator did not write.

## Rollback

Set `KJ_MEMORY_ENABLED` to `false` (or unset it) and restart the worker. Missions and Telegram behave exactly as before
P5. The migration is additive and append-only, so it is left in place: the tables simply stop being written. Rows are
never deleted by design; if a row must be removed for a legal reason, that is a separate, explicitly authorised
operation and not part of this change.

## What was verified locally (OBSERVED, on a disposable Postgres)

See the pull request for the test list and the mutation run. Real Postgres integration covers: candidate to canonical
promotion with provenance; refusal of a model or Shared Brain candidate at the service AND in the database (forged
promotion, forged promoted candidate, orphan version, wrong trust class); explicit-operator promotion; replay
idempotency including six concurrent submissions; correction, supersession, retraction and conflict flag; immutability
of every append-only table; tenant isolation and subject scoping; verified-outcome evidence checked against the ledger;
protected promotion through a real `ApprovalStore` (granted, denied, expired, not bound to another candidate, wrong
resolver, no approver configured); bounded and deterministic context assembly; the assembly record; the Telegram
commands against real inbox and outbox; and a mission run with and without memory.

## What was NOT verified, and what remains before the first live `/remember`

- Nothing has run against production, Supabase or the live VM. The migration has only been applied to disposable
  Postgres databases.
- The Restate journalling of the memory-context step was exercised with the same `ctx.run` pass-through the existing
  mission tests use, not in a live Restate replay. The step returns plain JSON so it journals cleanly, but that is
  reasoning, not an observation.
- Protected promotion is approval-capable, not complete: the durable workflow that waits for the approval and the
  Telegram card for a memory promotion are not built, and nothing yet calls `settleApproval` on a schedule. Until that
  is built, a protected candidate is created with a real approval and can be decided through the ApprovalStore, but is
  only promoted when `settleApproval` is called. Leave `KJ_MEMORY_APPROVER_ID` unset for the first live proof.
- Shared Brain: only the boundary exists. No adapter to the real Shared Brain, and no live read of it.
- Explicit authorisation from Jonny to apply the migration and deploy is still needed. So is a fresh look at the
  release id that will be running at the time.

## Flagged for distillation

The origin-by-entry-point rule (the origin is the door the candidate came in through, never a field it carries), enforced
by database triggers as well as code, and the mutation-check pattern that proves each authority rule fails when broken,
are reusable for P6 to P8.
