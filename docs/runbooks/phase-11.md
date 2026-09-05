# Phase 11: World model

`WorldStore.entity` resolves a stable tenant/identity key and rejects type changes.
`observe` derives a TASK_RESULT observation from verified Outcome evidence with
an explicit validity interval. `view` returns bounded observations known and valid
at the requested time, retaining multiple observations. It also returns a separate
`historicalRelationships` list; these edges record shared provenance, not current
truth or a time-filtered relationship snapshot.

`link` supports the initial SHARES_VERIFIED_RESULT relationship only. Both entities
must already have observations backed by the same task/evidence. Confidence 1
means the deterministic task result was verified; it does not assert external
world certainty. Generic fact extraction and inferred entity resolution are not
implemented.

The authenticated tenant context is checked on every operation. The additive local
migration protects entity/observation/relationship history and requires task and
evidence provenance on new relationships. Historical rows without that provenance
are excluded from reads. No remote migration was applied.

Validation: `pnpm typecheck`, `pnpm build`, then
`pnpm exec vitest run tests/world.test.ts tests/memory.test.ts tests/database.test.ts`.
All 32 selected tests passed; the report is `artifacts/local/phase11-tests.json`.
