# KJ-P8 implementation sequence (design only)

Status: DESIGN ONLY, revision 2.6. Nothing here is authorised for implementation. Each step needs its own explicit
authorisation, hostile implementation review and, for production, its own change window. Design: ADR-0023 (PROPOSED,
revision 2.6). Revision 1 (`f2b36fa`) was blocked at the hostile design seal; this file follows the remediated ADR.

The order is fixed. A step may not start before the one above it has passed its gate.

| Order | Step | Contents | Production effect | Gate |
|---|---|---|---|---|
| 1 | B1 | dedicated runtime database roles `kj_worker` and `kj_door` (ADR 27): reviewed grant manifest, explicit row level security policies, no ownership, no role membership; full P1 to P7 requalification under those roles; negative qualification of every denied operation; the one enumerated `SECURITY DEFINER` exception, `kernel_private.stamp_binding_provenance()`, with its pinned source digest, catalogue assertions and negative probes (ADR 27.9); the frozen platform `SECURITY DEFINER` baseline, snapshotted read-only before B1, and the stage-aware definer inventory at its B1 set (ADR 27.10); runtime capability facts under the schema-USAGE rule of ADR 27.11, with an unexpected fact in target qualification stopping B1; production cutover and soak | role change only; no behaviour change; no P8 object | its own hostile review, which must itself verify the ADR 27.9 exception and may not pass B1 on a green suite alone; ADR 20 B1 proofs; its own change window |
| 2 | P8A-0 | contracts and schema, including the dedupe key normalisation contract with its Unicode 15.1.0 pin and golden vectors (ADR 11.1) and the candidate construction contract with its golden vectors (ADR 10.1); atomic admission reservation and quota (ADR 5.4); pre-admission scanner as one neutral shared module (ADR 5.3); proposal, evaluation, disposition, Class E and support stores; `self_model_current` view; reflection governance mode, default `DISABLED`, with its two functions (ADR 17.1); replaced version and transition guards that refuse any version for a model candidate (ADR 10); same-tenant composite keys (ADR 23); runtime-role guard and exact P8 grants (ADR 27.5); health rows; topology fences and mutations | none observable: no door recipe, no model call, mode `DISABLED` | hostile review, CI, mutation suite, the P8A-0 proofs of ADR 20 under the runtime roles, deployment at a new epoch with the mode `DISABLED` |
| 3 | B2 | separate Class B faculty-version review: appended intelligence and verifier versions permitting `identity-reflection/v1`; `REFLECT_PROPOSE` and `REFLECT_EVALUATE` in the static operation table; explicit verifier-isolation allow-list extended to `REFLECT_EVALUATE` (ADR 6.4) | none until P8A-1 | its own Class B review |
| 4 | P8A-1 | HUMAN-owner door route; mode `OBSERVE`; bounded reflector and evaluator with strict structured outputs and enforced independence; no raw model output in evidence (ADR 6 and 15) | proposals and observations only | separate authorisation; live proofs 1 to 8, 12 and 14 to 17 of ADR 20 |
| 5 | P8A-2 | mode `PROPOSE_IDENTITY`: HELD `MODEL_PROPOSAL` candidates only | HELD candidates only; still impossible to approve, version or activate one; Class C/D frozen | separate authorisation; live proofs 9 to 11 and 13 of ADR 20 |
| 6 | P8B | ADR addendum; adoption binding table; static candidate state/origin CHECK revision; dynamic approval trigger; append-only growth-window and closure tables with their functions; replaced activation guard and retired `set_identity_freeze`; `identity-change/v1` `ADOPT` workflow; `IDENTITY_ADOPT_MODEL_*` gates as `APPROVAL_REQUIRED`; controlled activation (ADR 17 and 18) | human-approved growth inside time-boxed windows | separate hostile review, explicit HUMAN authorisation, P8B proofs of ADR 20 |

**No P8 object reaches production before B1 is qualified.** While any runtime process connects as the database
owner, no P8A-0, P8A-1, P8A-2 or P8B deployment is permitted. There is no fallback to `postgres` and no temporary
owner mode: if B1 cannot be established and qualified, P8 stays unavailable.

Repository preparation and qualification in an isolated non-production environment, under the runtime roles, may run
ahead of production. Production order may not.

**Invariants throughout:**
- no auto-adoption;
- no automatic triggers;
- no Shared Brain;
- no P5 promotion path;
- no adaptive routing;
- no runtime process connects as the database owner once B1 is live, and P8 writes refuse under the owner;
- no existing P1 to P7 function changes its security attribute except the one enumerated in ADR 27.9; no runtime role
  is ever granted a direct write on `release_epoch` or `release_activations`;
- at every step the `SECURITY DEFINER` inventory equals ADR 27.10's expected set for the steps applied so far: the
  frozen platform baseline, the target's declared co-resident platform exceptions of ADR 27.12 (on production exactly
  `public.rls_auto_enable()` with its event trigger `ensure_rls`, preserved unchanged), plus
  `stamp_binding_provenance()` from B1, `freeze_reflection(uuid)` from P8A-0 and
  `close_growth_window_by_owner(uuid, uuid)` from P8B; nothing else;
- Class C/D stays frozen until an effective growth window exists in P8B;
- applied migrations are never edited; every guard change is a new migration that replaces a function;
- every check ships with a negative case that fails on purpose.

The Codex prototype (`codex/kjp8-proposal-design`, PR #49) is reference material only. P8A-0 is written fresh against
ADR-0023.
