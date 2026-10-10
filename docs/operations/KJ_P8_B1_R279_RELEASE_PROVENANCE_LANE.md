# DESIGN_CONTRADICTION: R279-RELEASE-PROVENANCE-LANE

Status: **OWNER-AUTHORIZED NARROW CORRECTION; design-review/seal update pending.** In response to the explicit approval request, the owner delegated the decision: “you are in charge … read the conversation back and do your thing”. The implementation decision is to make the minimal lane correction described below and resume this affected path. This does not establish that B1 as a whole is impossible. No full sprint qualification is claimed.

## Conflicting sealed requirements

At sealed design `af2f7320aae32eaa0ce699b1c09d015371f156d5`, `docs/operations/KJ_P8_R276_REGRESSION_INVENTORY_2026-10-09.md` assigns `release-provenance-postgres.test.ts` to lane D as a knowledge-helper database consumer. The inventory requires preservation of the frozen test meaning.

ADR-0023 §27.12.15, “Authority of a regression consumer,” forbids a stage-T consumer from reading or applying any file under `supabase/migrations/`; a consumer is never a migration path. The sprint requires that inventory partition and the consumer prohibitions together.

## Frozen source evidence and minimal reproduction

Read the untouched source at frozen B1 `0ff2919c1bbf722b4842aa56fdc94ef9b74e5a51`:

```text
git show 0ff2919c1bbf722b4842aa56fdc94ef9b74e5a51:tests/release-provenance-postgres.test.ts
```

The test named **“migration baselines preexisting immutable bindings without inventing their insertion time”** (lines 154–187) reconstructs the pre-provenance schema, inserts historical bindings and then executes:

```ts
await db.query(await readFile("supabase/migrations/20260916205049_release_provenance.sql", "utf8"));
```

It subsequently restores selected B1 security/privilege state to support the frozen runtime-role harness. Its assertions check the migration's backfill of historical bindings and the resulting provenance verdict. This is an actual migration behaviour test, not merely a catalogue mutation used to prove health detection. No database execution is needed to demonstrate the prohibited file read/application; both calls are explicit in the frozen test.

The same file creates a fresh knowledge database in `beforeEach`, rather than just once per file. The unaffected lane-D tests therefore need distinct fixed plan databases or another explicitly justified isolation arrangement; a single shared database would change their initial-state assumptions. The runner's general multi-database plan rule permits fixed per-test databases, so that fact alone is not a design contradiction.

## Why the affected classification cannot be implemented as written

Keeping this test in lane D and preserving its migration behaviour violates the explicit consumer prohibition. Deleting the test, skipping it, substituting a hand-written equivalent, or copying the migration into a differently named fixture would not preserve the test's guarantee that the real migration performs the backfill. The test cannot pass honestly as the classified stage-T consumer while exercising that real migration file.

## Authorized narrow correction

Classify this one block as lane A in a new `tests/release-provenance-base.integration.test.ts`. Keep every assertion and the application of the real base migration. Run it with the base harness; omit the four statements that only restore B1-specific runtime-role state, because lane A has no B1/runtime roles. Those statements are setup adaptations, not the test's migration/backfill assertions. Retain the other twelve expanded test cases in lane D (eleven test declarations, including the two isolation-level cases), with fixed plan databases preserving their fresh-database preconditions.

Record the added block mapping in the regression inventory and lane partition; preserve expanded test names in collection/report checks. No migration, grant manifest, helper pin, runner eligibility rule, production authority or qualification threshold changes. The sealed design commit itself remains immutable.

Owner authorization for this separate correction is recorded above. The earlier helper-rethrow ruling remains separate. A subsequent design-review/seal update remains pending; neither owner authorization nor this implementation decision is a hostile-review verdict.

## Implemented mapping and verification

| Frozen block | Current file | Lane | Expanded cases |
|---|---|---|---|
| migration baselines preexisting immutable bindings without inventing their insertion time | `tests/release-provenance-base.integration.test.ts` | A | 1 |
| Every other release-provenance block | `tests/release-provenance-postgres.test.ts` | D | 12 |

The earlier approval question said “ten”; source collection establishes twelve remaining expanded cases. No additional block moved lanes. Fixed databases `kj_release_provenance_01` through `kj_release_provenance_12` preserve their per-test isolation. The real migration/backfill test passed under the base harness. The two release-provenance files plus the converted identity-cognition consumer passed 64 tests in a base-mode adaptation check; this is not stage-T qualification. The first broader run passed 222 assertions but failed overall with an unhandled connection-termination error during teardown. Cleanup now waits for sessions to disappear before dropping a base database, and the affected three-file rerun passed without unhandled errors.

Pinned Node 22.19.0 / Vitest 5.0.0 collection observed 114 files, 2,294 entries, zero placeholder connections and exact equality of the 13 frozen release-provenance expanded names with the union of the split files. Current collection entries SHA-256: `8c58da47fd9f9d6bf3bec2dcce22a52b34fc6e0d1e58afa467a99c68769009c2`. This digest is a source-collection checkpoint, not execution or repository qualification.
