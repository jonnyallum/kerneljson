# KernelJSON Build Plan

This file is the phase index. The final agreed architecture and roadmap is `FINAL_PLAN.md`.

`STATE.yaml` is the source of truth for verified implementation status.

## Phase 0
Repository and architecture bootstrap.

## Phase 1
Typed contracts.

## Phase 2
Supabase persistence foundation.

## Phase 3
Restate durable task workflow.

## Phase 4
Kernel compiler, planner and executor.

## Phase 5
ModelPort and DeepSeek provider.

## Phase 6
Initial capability layer and first provider-neutral cognitive worker primitive.

## Phase 7
Policy, approvals and role/worker authority ceilings.

## Phase 8
Evidence, verification and independent verifier paths.

## Phase 9
Golden end-to-end workflow, including first governed cognitive task.

## Phase 10
Memory fabric and Primary Identity v1.

## Phase 11
World model, context grounding and dynamic specialist factory.

## Phase 12
Evaluation framework, reflection proposals and governed identity growth.

## Phase 13
Mission Control, including cognition/governance/recovery visibility.

## Phase 14
Adaptive model/worker/swarm routing and provider fallback.

## Phase 15
Governed autonomous workflows.

## Cognitive architecture mapping

The accepted cognitive architecture does not alter the current Phase 1-3 implementation slice.

Its implementation maps across later phases rather than becoming a separate agent framework:

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

This plan is now considered final as of 2026-09-09.

Implementation should proceed phase-by-phase. Material changes to accepted architectural boundaries require an explicit human decision and an ADR where appropriate.