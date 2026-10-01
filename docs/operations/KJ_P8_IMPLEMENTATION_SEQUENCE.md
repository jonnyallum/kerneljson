# KJ-P8 implementation sequence (design only)

Status: DESIGN ONLY, revision 2.1. Nothing here is authorised for implementation. Each step needs its own explicit
authorisation, hostile implementation review and, for production, its own change window. Design: ADR-0023 (PROPOSED,
revision 2.1). Revision 1 (`f2b36fa`) was blocked at the hostile design seal; this file follows the remediated ADR.

The order is fixed. A step may not start before the one above it has passed its gate.

| Order | Step | Contents | Production effect | Gate |
|---|---|---|---|---|
| 1 | P8A-0 | contracts and schema; atomic admission reservation and quota (ADR 5.4); pre-admission scanner as one neutral shared module (ADR 5.3); proposal, evaluation, disposition, Class E and support stores; `self_model_current` view; reflection governance mode, default `DISABLED`; replaced version and transition guards that refuse any version for a model candidate (ADR 10); same-tenant composite keys (ADR 23); health rows; topology fences and mutations | none observable: no door recipe, no model call, mode `DISABLED` | hostile review, CI, mutation suite, the P8A-0 proofs of ADR 20, deployment at a new epoch with the mode `DISABLED` |
| 2 | B2 | separate Class B faculty-version review: appended intelligence and verifier versions permitting `identity-reflection/v1`; `REFLECT_PROPOSE` and `REFLECT_EVALUATE` in the static operation table; explicit verifier-isolation allow-list extended to `REFLECT_EVALUATE` (ADR 6.4) | none until P8A-1 | its own Class B review |
| 3 | P8A-1 | HUMAN-owner door route; mode `OBSERVE`; bounded reflector and evaluator with strict structured outputs and enforced independence; no raw model output in evidence (ADR 6 and 15) | proposals and observations only | separate authorisation; live proofs 1 to 8, 12 and 14 to 17 of ADR 20 |
| 4 | P8A-2 | mode `PROPOSE_IDENTITY`: HELD `MODEL_PROPOSAL` candidates only | HELD candidates only; still impossible to approve, version or activate one; Class C/D frozen | separate authorisation; live proofs 9 to 11 and 13 of ADR 20 |
| 5 | B1 | dedicated least-privilege production worker database role; full P1 to P7 privilege requalification | role change only | its own design and review |
| 6 | P8B | ADR addendum; adoption binding table; static candidate state/origin CHECK revision; dynamic approval trigger; append-only growth-window and closure tables; replaced activation guard and retired `set_identity_freeze`; `identity-change/v1` `ADOPT` workflow; `IDENTITY_ADOPT_MODEL_*` gates as `APPROVAL_REQUIRED`; controlled activation (ADR 17 and 18) | human-approved growth inside time-boxed windows | separate hostile review, explicit HUMAN authorisation, P8B proofs of ADR 20 |

**No P8B implementation before B1.** While the worker is the `postgres` owner, P8B may not be implemented or deployed.

**Invariants throughout:**
- no auto-adoption;
- no automatic triggers;
- no Shared Brain;
- no P5 promotion path;
- no adaptive routing;
- Class C/D stays frozen until an effective growth window exists in P8B;
- applied migrations are never edited; every guard change is a new migration that replaces a function;
- every check ships with a negative case that fails on purpose.

The Codex prototype (`codex/kjp8-proposal-design`, PR #49) is reference material only. P8A-0 is written fresh against
ADR-0023.
