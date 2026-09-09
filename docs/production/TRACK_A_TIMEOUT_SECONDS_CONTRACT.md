# Track A — timeout_seconds contract

**Decision:** A — treat `timeout_seconds` as a **legitimate** Spawner structured-output field.

**Recorded (UTC):** 2026-09-09T20:59:00Z — **Local (Europe/London):** 2026-09-09 21:59 BST

**Phase:** 3.3 Track A contract hardening (follows Phase 3.2 production Spawner alignment).

## Context

Phase 3.2 proved production Spawner HEAD `c3472f2` returns `timeout_seconds` inside `repository.read` structured output (echo of the spawn request / input). The KernelJSON adapter used `z.strictObject` for `SpawnerStructuredOutput` / `RepositoryReadOutput` **without** that key, so the raw adapter path fail-closed with `INVALID_SPAWNER_OUTPUT` (Unrecognized key: `timeout_seconds`). A diagnostic strip unlocked PASS but was **not** a production contract.

Selftest on Spawner asserts the echo. The field is intentional Spawner behaviour, not accidental leakage.

## Decision A (chosen)

1. **Require typed `timeout_seconds`** on `SpawnerStructuredOutput` and `RepositoryReadOutput` (`z.number().int().positive().max(3600)`).
2. **Keep `z.strictObject`** — unknown keys still reject. No passthrough / strip / rewrite of Spawner bodies.
3. **No ceremonial Spawner version field** in the contract. Version drift is detected operationally when the live shape no longer validates.
4. **Future break detection:** any new unknown key, missing `timeout_seconds`, or type mismatch → `INVALID_SPAWNER_OUTPUT` (fail-closed).

## Explicit non-choices

- **Not** optional `timeout_seconds` (would hide Spawner/selftest regressions).
- **Not** `passthrough` / strip-unknowns (would hide contract drift).
- **Not** a Spawner "schema version" string (ceremony without stronger guarantees than strict typing).
- **Not** Track B / `public.actions` / EMAIL / consumer changes.

## Phase 3.2 selftest wobble classification

**RESOLVED BENIGN ENVIRONMENT DIFFERENCE**

- First gate used system `python3` importing `spawner.server` (uvicorn missing) which failed the wrapper script.
- Immediate venv selftest (`python -m spawner.engine --selftest`) was **ALL GREEN**.
- **No code defect.**

## Qualification gates (Track A fully qualified when all true)

1. Schemas + fixture + unit tests land `timeout_seconds` (live-shape accept; unknown-key reject; missing-timeout reject).
2. Local commit: `fix(runtimes): accept Spawner timeout_seconds in Track A contract`.
3. Raw KJ-000000 vs production VM Spawner with **ZERO response surgery** — proof artifact asserts `timeout_seconds === 45` and SHA match.
4. Production VM Spawner selftest **ALL GREEN** (venv).

Push to remote is **out of scope** (separate approval).