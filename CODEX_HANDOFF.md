# KernelJSON Codex Handoff

**Current entrypoint:** [PHASE_15_HANDOFF.md](PHASE_15_HANDOFF.md) and `STATE.yaml` are the current source of truth for what is implemented. The historical checkpoints at the end of this file are retained for provenance, not as current state.

## FINAL CANONICAL INSTRUCTION

KernelJSON has a final agreed architecture and roadmap.

Before implementation, read and obey in this order:

1. `ARCHITECTURE.md`
2. `FINAL_PLAN.md`
3. `STATE.yaml`
4. `BUILD_PLAN.md`
5. this `CODEX_HANDOFF.md`
6. accepted ADRs under `docs/adr/`
7. `docs/cognition/COGNITIVE_ARCHITECTURE.md`
8. `docs/cognition/IMPLEMENTATION_PLAN.md`
9. the cognitive hardening specs listed below

Cognitive hardening specs are binding for the phases in which they become relevant:

- `docs/cognition/COGNITIVE_SECURITY.md`
- `docs/cognition/IDENTITY_GOVERNANCE.md`
- `docs/cognition/CONTEXT_ASSEMBLY.md`
- `docs/cognition/COGNITIVE_CONFLICT_PROTOCOL.md`
- `docs/cognition/IDENTITY_BACKUP_AND_RECOVERY.md`

Accepted cognitive ADRs include:

- `docs/adr/0005-persistent-identities-ephemeral-workers.md`
- `docs/adr/0006-core-team-and-dynamic-specialists.md`
- `docs/adr/0007-canonical-context-and-memory-boundaries.md`

The architecture is considered frozen as of 2026-09-09. Do not continue speculative redesign while implementing. If a material conflict or missing architectural prerequisite is discovered, document it and stop that architectural branch. A material change requires an explicit human decision and an ADR where accepted boundaries would change. `STATE.yaml` remains the source of truth for verified implementation; design documents do not mean a feature exists.

## Implemented scope (per STATE.yaml, verified 2026-09-09)

Phases 1-15 are complete within their documented, bounded scope (saved 224-test full suite; zero failed/skipped), plus post-Phase-15 **Gate 1** qualification (277 tests including 31 recovery, fresh-source frozen install/typecheck/lint/build). This supersedes the earlier "Phases 1-3 only" handoff note reproduced in the historical section below, which is no longer the current scope. No Phase 16 or Gate 2 work is authorized here. No production deployment, remote migration, or scheduler enablement is implied by "complete".

## Mission

Build KernelJSON as a durable cognitive execution platform, not an agent roster.

The architectural constitution in `ARCHITECTURE.md` is binding unless a new ADR explicitly supersedes it.

The six primitives are:

1. EVENT
2. TASK
3. CAPABILITY
4. STATE
5. POLICY
6. EVIDENCE

The core rule is: **a Task is the primitive; an agent is only one possible execution strategy.**

---

## Historical checkpoints (provenance only — NOT current state)

**Superseded current-state handoff:** [PHASE_15_HANDOFF.md](PHASE_15_HANDOFF.md), audited 2026-09-09. The checkpoint and original instructions below are historical.

### Saved checkpoint — 2026-09-05

Current branch: `codex/phase-15`. Phases 1–14 are implemented with the executed evidence recorded in `STATE.yaml` and the phase runbooks. Phase 15 is in progress: typecheck, build, four unit tests and four targeted recovery tests passed. It is not complete. See `docs/runbooks/phase-15.md` for remaining verification work. The last full combined suite was Phase 9; later phases have focused validation only. The user requested saving and pushing this checkpoint before further implementation. No remote migrations were pushed.

The original bootstrap status below is historical, not the current state. This is the historical Phase 1–3 handoff. The user subsequently authorized Phases 4 onward; see `STATE.yaml`, the accepted ADRs and the phase runbooks for those bounded follow-on implementations. The exclusions described the historical Phase 1–3 scope, not a ban on the subsequently authorized phases. Local tests and live provider validation passed; see STATE.yaml for evidence.
