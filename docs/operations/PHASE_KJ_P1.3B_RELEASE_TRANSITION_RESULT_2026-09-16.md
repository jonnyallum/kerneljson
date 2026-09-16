# KJ-P1.3B RELEASE TRANSITION HEALTH SEMANTICS — STOP

Historical reproduction note: `evidence/kj-p1.3b/reproduce.mjs` exercises the pre-seam
health API at commit `700d9e4` (merged PR #30). Run it from that revision. KJ-P1.3C
replaces that API with canonical epoch provenance; its qualification is recorded separately.

## Decision

FACT: No trustworthy release-cutover authority was found in repository configuration,
migrations, deployment conventions, or current production schema/runtime metadata.
The instruction to STOP when that source is absent applies. This PR records the
investigation and repeatable reproduction only; it does not implement a health fix.
No production deployment, configuration/data mutation, restart, monitor seed, merge,
or resumption of P1.3A occurred.

Investigated canonical main: `d5abf22ec176d16932af5cfcd77a8ce3098027bc` (also the proposed target).
Production worker and door: `5a2335b41d8fe525ff940a3bd86912c98dae68af`.

## Root cause and existing semantics

- `services/kernel/src/health/collect.ts`, `fetchRecentBindings`: inner-joins bindings
  to tasks, selects tasks created within 24 hours, caps at 50. Release-parity snapshot
  retains only release IDs, discarding timestamps.
- `evaluate.ts`, `releaseParity.recentBindingsConsistent`: a nonempty set must contain
  exactly one release and, when configured, match EXPECTED_RELEASE_ID; otherwise
  CRITICAL. Alert policy maps this to P1. Historical immutable bindings therefore
  produce a false deployment forecast alarm.
- `authority.bindingReleaseConsistent`: any multiple-release sample is DEGRADED/P2,
  with no transition context. Ordinary mixed historical releases also cause this
  false positive until they leave the sampled window.
- `releaseParity.matchesExpected`: running release unequal to explicit expectation
  is CRITICAL/P1. This remains valid and unchanged.
- `releaseParity.noBoundReleaseRejection`: observed TASK_FAILED event containing the
  bound-worker rejection text is CRITICAL/P1. Collection is not cutover-scoped; this
  protection remains unchanged. The authority incident check mirrors this evidence.
- `ledger.ts` rejects initial task creation when its stored binding release differs
  from the worker release: `Task requires its bound worker release`. Neither this
  enforcement nor the immutable binding is changed.

## Provenance investigation

FACT: `execution-binding.ts` sets `boundAt = task.createdAt`.
`compiler/index.ts` sets task creation time from `intent.receivedAt`. Gateway sets
that receipt time using its application clock before its admission transaction
finishes. Binding and admission commit before dispatch/task projection. Ledger can
also persist a binding during task creation. Consequently neither task.created_at
nor contract.boundAt proves database binding insertion/commit order.

FACT: The production execution_bindings table has task_id, tenant_id, principal_id,
contract only. task_admissions has task_id, tenant_id, principal_id, key_digest,
request_digest, payload only. Neither has a database-assigned insertion timestamp.
Scheduler admitted_at applies to schedule fires, not all binding origins.
Dispatch timestamps record later dispatch events, not release activation.

FACT: Health expectations and Compose expose release IDs but no cutover context.
Both live components expose only KERNELJSON_RELEASE_ID among release/cutover/activation
environment keys. Production schema inspection found no release table or cutover/
activated column in public/kernel_private. Deployment runbooks recreate worker and
door sequentially and verify parity; they do not persist a binding-order boundary.

INFERENCE: Git commit time, Docker StartedAt, Restate registration time, the first
new-release binding, and the current wall clock cannot establish the required
boundary. A restart can move container time; sequential rollout can overlap old
admissions; receipt time can precede binding persistence. The target has not been
activated, so it has no actual production activation time to supply today.

## Smallest explicit seam proposed for review (not implemented)

RECOMMENDATION: Add deployment-owned, immutable release-transition provenance
containing expected release ID plus an authoritative binding cutover boundary.
Use a database-recorded activation timestamp paired with database-recorded binding
insertion provenance, serialized with binding creation under the same transaction
barrier. Preserve original provenance on conflict/replay. Establish the deployment
boundary only after old binding writers are quiesced and worker/door parity is
verified; enumerate gateway and direct ledger writers in that protocol. Legacy
bindings must be explicitly accounted for before the first boundary, not classified
as historical merely because provenance is absent. This is metadata within existing
KernelJSON authority, not another scheduler or task minting path.

A bare EXPECTED_RELEASE_ACTIVE_AT environment variable would be smaller in code,
but is insufficient without that ordering/provenance contract. Do not derive it
from deployment start, process startup, or task receipt time. The exact transaction
barrier and activation procedure require architectural review before implementation.

Proposed new semantics once the seam is approved:

- Both binding checks use the same proven boundary. Proven pre-cutover bindings may
  span historical releases without a drift alarm.
- Every newly persisted binding at/after the boundary must match the expected release.
  Query for violations across the whole relevant epoch, including bindings without
  task projections; a latest-50 sample must not hide violations.
- Post-cutover mismatch remains CRITICAL/P1 in release parity. The authority check
  must also reject mixed post-cutover releases, never report HEALTHY for them.
- Zero post-cutover bindings is explicit UNKNOWN/no observations, not CRITICAL or a
  claim of verified integrity. Missing/invalid provenance is explicit UNKNOWN and
  blocks activation qualification; it is never an exemption for mismatches.
- Running-release mismatch and actual bound-release rejection remain CRITICAL/P1.

These are proposals, not changed runtime behavior. A target-release forecast must
label its proposed activation boundary as hypothetical, distinct from live health.

## Read-only production reproduction

Captured `2026-09-16T20:44:05.628384+00:00` using SELECTs in a REPEATABLE READ READ ONLY
transaction and Docker inspection. Sanitized snapshot: [production.json](evidence/kj-p1.3b/production.json).

Binding task `41f2ce1f-5044-84dc-aa5e-6ce5e5f30103`, release
`5a2335b41d8fe525ff940a3bd86912c98dae68af`, boundAt and task.created_at both
`2026-09-16T08:00:00.645Z`. No bound-release rejection event observed.
Admissions 24, fires 5, tasks 5. Worker and door healthy, restart counts zero.

Local execution of the unchanged production health evaluator against that snapshot:

| Scenario | Binding check | Alert |
|---|---|---|
| Running and expected both old release | HEALTHY | None from binding check |
| Hypothetical running and expected both target d5abf22 | CRITICAL | NEW P1, notify:true |

The hypothetical scenario isolates the historical-binding false positive; it does
not pretend the currently running worker has upgraded. Alert reduction occurred
locally only, without production persistence or notification.

Corrected-model validation: NOT RUN. Without an authoritative boundary, claiming
the historical binding is proven pre-cutover would invent the missing evidence.

## Qualification and scope

Run from repository root:

```powershell
node --import tsx docs/operations/evidence/kj-p1.3b/reproduce.mjs
```

Seven deterministic assertions pass: old-release baseline; target historical-binding
CRITICAL; P1 severity; notify:true; running mismatch still CRITICAL; injected rejection
still CRITICAL; synthetic mixed-release authority DEGRADED. The last two use explicit
local fixture modifications, not claims about observed production events.

The eight requested corrected-semantics acceptance cases are NOT implemented or
qualified because the prerequisite failed. No broad regression suite was rerun for
this evidence-only change. Runtime, alert policy, scheduler and monitor files unchanged.

Files added: this report, sanitized production.json, and reproduce.mjs. The unresolved
architectural concern is authoritative cutover/binding ordering across all writers.
Approval of that seam is required before a subsequent implementation phase.
