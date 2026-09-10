# KernelJSON Build Plan

This file is the phase index. The final agreed architecture and roadmap is `FINAL_PLAN.md`. `STATE.yaml` is the source of truth for verified implementation status.

Preservation audit: 2026-09-09. Completion below refers to the bounded implementation in accepted ADRs and phase runbooks, verified by the saved 224-test full suite. It does not mean production deployment. See PHASE_15_HANDOFF.md for fresh checks and readiness gaps.

## Phase 0 — complete (documented scope verified)
Repository and architecture bootstrap.

## Phase 1 — complete (documented scope verified)
Typed contracts.

## Phase 2 — complete (documented scope verified)
Supabase persistence foundation.

## Phase 3 — complete (documented scope verified)
Restate durable task workflow.

## Phase 4 — complete (documented scope verified)
Kernel compiler, planner and executor.

## Phase 5 — complete (documented scope verified)
ModelPort and DeepSeek provider.

## Phase 6 — complete (documented scope verified)
Initial capability layer.

## Phase 7 — complete (documented scope verified)
Policy and approvals.

## Phase 8 — complete (documented scope verified)
Evidence and verification.

## Phase 9 — complete (documented scope verified)
Golden end-to-end workflow.

## Phase 10 — complete (documented scope verified)
Memory fabric.

## Phase 11 — complete (documented scope verified)
World model.

## Phase 12 — complete (documented scope verified)
Evaluation framework.

## Phase 13 — complete (documented scope verified)
Mission Control.

## Phase 14 — complete (documented scope verified)
Adaptive execution routing.

## Phase 15 — complete (documented scope verified)
Autonomous workflows.

## Post-Phase-15 production qualification

Gate 1 is complete within its local qualification scope: A1, F1, G1, A3, A4, D1, E1. Fresh-source validation passed 277 tests, including 31 recovery tests, with all original 224/27 cases retained. Frozen install, typecheck, real lint and build passed. See `docs/production/QUALIFICATION_GATE_1.md` for evidence and remaining deployment prerequisites. The Phase 0-15 history above is preserved; its lint statement describes the checkpoint before Gate 1 introduced ESLint. No Phase 16 or Gate 2 work is authorized here.

## Cognitive architecture mapping

The accepted cognitive architecture does not alter the implemented kernel slice. Its implementation maps across phases rather than becoming a separate agent framework:

- Phases 4-6: provider-neutral cognitive workers and delegation hooks
- Phases 7-9: scoped role authority, verification and first governed cognitive golden paths
- Phase 10: Primary Identity v1 and governed identity memory
- Phase 11: world-model grounding, canonical context assembly and dynamic specialists
- Phase 12: worker evaluation, conflict/adjudication, reflection proposals and governed identity growth
- Phase 13: Mission Control views for identity, roles, workers, memory, security, recovery and governance
- Phase 14: adaptive model/worker/swarm routing
- Phase 15: governed long-running workflows coordinated by the Primary Identity when cognition is useful

## Canonical design and hardening

- `FINAL_PLAN.md`
- `docs/cognition/COGNITIVE_ARCHITECTURE.md`
- `docs/cognition/IMPLEMENTATION_PLAN.md`
- `docs/cognition/COGNITIVE_SECURITY.md`
- `docs/cognition/IDENTITY_GOVERNANCE.md`
- `docs/cognition/CONTEXT_ASSEMBLY.md`
- `docs/cognition/COGNITIVE_CONFLICT_PROTOCOL.md`
- `docs/cognition/IDENTITY_BACKUP_AND_RECOVERY.md`
- `docs/adr/0005-persistent-identities-ephemeral-workers.md`
- `docs/adr/0006-core-team-and-dynamic-specialists.md`
- `docs/adr/0007-canonical-context-and-memory-boundaries.md`

## Architecture freeze

This plan is considered final as of 2026-09-09. Implementation should proceed phase-by-phase. Material changes to accepted architectural boundaries require an explicit human decision and an ADR where appropriate.
