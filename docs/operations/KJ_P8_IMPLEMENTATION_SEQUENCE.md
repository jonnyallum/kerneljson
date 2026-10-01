# KJ-P8 implementation sequence (design only)

Status: DESIGN ONLY. Nothing here is authorised for implementation. Each step needs its own explicit authorisation,
hostile implementation review and, for production, its own change window. Design: ADR-0023 (PROPOSED).

| Step | Contents | Production effect | Gate |
|---|---|---|---|
| P8A-0 | one new migration; contracts; deterministic `REFLECT_QUALIFY` packet builder; Class E store; dispositions and support; caps; mode table (default `DISABLED`); health rows; fences; mutation harness | none observable; the door does not yet accept the recipe | hostile review, CI, mutation suite, deployment at a new epoch with the mode `DISABLED` |
| B2 | reviewed faculty-version appends permitting `identity-reflection/v1` with `REFLECT_PROPOSE` and `REFLECT_EVALUATE`; static `routeFaculty` extension | none until P8A-1 | its own Class B review |
| P8A-1 | the door accepts the recipe for HUMAN principals; reflecting and evaluating cognition; mode `OBSERVE` | proposals and observations only | separate authorisation; live proofs 1 to 7, 13, 14, 15 and 16 |
| P8A-2 | mode `PROPOSE_IDENTITY`: HELD `MODEL_PROPOSAL` candidates | HELD candidates only; Class C/D frozen; model candidates not approvable | separate authorisation; the remaining P8A proofs |
| B1 | worker moved to a least-privilege database role; grants re-qualified across P1 to P7 | role change only | its own design and review |
| P8B | ADR addendum; `identity-change/v1` `ADOPT`; new migration (model approval binding, adoption-bound version creation, growth windows); `IDENTITY_ADOPT_MODEL_*` gates as `APPROVAL_REQUIRED` | human-approved growth inside time-boxed windows | separate hostile review, explicit HUMAN authorisation, P8B proofs |

**Invariants throughout:**
- no auto-adoption;
- no automatic triggers;
- no Shared Brain;
- no P5 promotion path;
- no adaptive routing;
- the applied P7 migrations are never edited.

The Codex prototype (`codex/kjp8-proposal-design`, PR #49) is reference material only. P8A-0 is written fresh against
ADR-0023.
