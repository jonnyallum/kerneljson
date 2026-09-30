# KJ-P8-A K1 qualification

Repository-only checkpoint, 30 September 2026. Contract: ADR-0023.
Branch: `codex/kjp8-proposal-design`; draft PR #49. The exact pushed commit is
recorded in new-system's `docs/migration/KJ_P8_RESTART_CHECKPOINT.md`.

## Implemented scope

- Strict request, disposition, source manifest and proposal contracts. Flat
  string-object JSON scanner refuses decoded duplicate keys, malformed/nested input,
  unknown fields and over-limit UTF-8 input before any normalization.
- Pure source qualification reuses mission, faculty and cognition predicates,
  checks tenant/task/step/release activation references and completed source state,
  and verifies pinned identity document/projection parity and call-time continuity.
- Deterministic digest-only proposal projection with fixed observations and an
  evaluation-request enum. Both cognition modes are covered. Digest contracts bind
  immutable source metadata, producing IDs/time and contract domain; input object
  order and database row order do not change the projection.
- Stable refusal errors discard underlying source diagnostics. Strict output schemas
  and the existing secret-shaped-content scan protect the return/journal boundary.
- The three D1 integration decisions are resolved in ADR-0023: caller-owned kernel
  completion transaction following identity completion, default-OFF admission/direct
  execution gates with committed replay first, and bounded flat-object parsing.

## Qualification record

Focused suite and guard-removal mutation runner: `tests/reflection.test.ts` and
`node scripts/mutation-check-reflection.mjs`. The runner restores exact source bytes
after every mutation and retains a crash-recovery backup before mutation. It requires
actual failed assertions with the full test count; collection/runtime errors do not
count as kills. Local reports are in ignored/untracked
`artifacts/local/reflection-mutations/`, not production evidence.

Final local results:

| Check | Result |
|---|---|
| `pnpm exec vitest run tests/reflection.test.ts tests/contracts.test.ts tests/mission-core.test.ts tests/faculty.test.ts tests/identity-cognition.test.ts tests/identity-topology.test.ts` | 263 passed, six files; includes 65 reflection cases |
| `node scripts/mutation-check-reflection.mjs` | 72-test baseline passed; M01–M14 all detected by failed assertions; no survivors/inconclusive results |
| `pnpm typecheck`, `pnpm lint`, `pnpm build` | PASS |
| `pnpm check:topology` | PASS |
| `git diff --check` | PASS |

The 14 mutations cover duplicate-key detection, input/output byte caps, strict
output fields, completed status, the three reused predicates, pinned projection
parity, continuity, secret scanning, proposal digest integrity, forbidden imports
and persisted step-definition parity. CI now runs this same mutation runner.
The full database/recovery/image suite is delegated to ordinary PR CI; no fresh
full-suite result is claimed by this local checkpoint.

The initial mutation run found one surviving projection-parity mutation: continuity
also rejected the incoherent fixture. The fixture now updates downstream continuity
consistently, so only the pinned-version comparison can reject the forged projection.
The initial typecheck also caught an ES2024 string API against the ES2022 target;
the parser now uses the repository's existing lone-surrogate regex approach.
The combined regression initially refused the new verifier importer under the
identity fence. Its explicit caller allowlist now includes reflection, and a new
transitive reflection fence is itself mutation-tested. Persisted step definitions
are also compared with the compiled recipe, including dependency references.

## Limits and next checkpoint

These tests use fixture persisted facts, not a database adapter. K1 is not end-to-end
P8 acceptance. No HUMAN authentication/membership, transaction isolation, DB ACL/FK,
deferred constraint, concurrency, cancellation or crash/replay claim is made here.
The proposal integrity helper checks shape/digests only; it does not establish source
authority. The builder performs source qualification; future adapters must supply
canonical rows read together on the authorized tenant's transaction.

K2 must implement and test immutable proposal/decision persistence on real disposable
Postgres, including Supabase-style default ACLs, composite references and an independent
deferred completion invariant. K3 owns authenticated admission and workflow wiring;
K4 owns full recovery and isolation qualification. The 16-row ADR refusal matrix is
not wholly satisfied by K1's pure tests or its 14 guard-removal mutations.

No recipe is registered and no workflow, migration, deployment, provider call or
production configuration changed. Class C/D remains frozen. At the checkpoint no
local mutation/test process is left running; ordinary GitHub PR CI may still run.
