# KernelJSON Build Plan

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
Initial capability layer.

## Phase 7
Policy and approvals.

## Phase 8
Evidence and verification.

## Phase 9
Golden end-to-end workflow.

## Phase 10
Memory fabric.

## Phase 11
World model.

## Phase 12
Evaluation framework.

## Phase 13
Mission Control.

## Phase 14
Adaptive execution routing.

## Phase 15
Autonomous workflows.

## Cognitive architecture mapping

The accepted cognitive architecture does not alter the Phase 1-3 implementation slice.

Its implementation maps across later phases rather than becoming a separate agent framework:

- Phases 4-6: provider-neutral cognitive workers and delegation hooks
- Phases 7-9: scoped role authority, verification and first governed cognitive golden paths
- Phase 10: Primary Identity v1 and governed identity memory
- Phase 11: world-model grounding and dynamic specialist context
- Phase 12: worker evaluation, reflection proposals and governed identity growth
- Phase 13: Mission Control views for identity, roles, workers, memory and governance
- Phase 14: adaptive model/worker/swarm routing
- Phase 15: governed long-running workflows coordinated by the Primary Identity when cognition is useful

Canonical design and detailed plan:

- `docs/cognition/COGNITIVE_ARCHITECTURE.md`
- `docs/cognition/IMPLEMENTATION_PLAN.md`
- `docs/adr/0005-persistent-identities-ephemeral-workers.md`
- `docs/adr/0006-core-team-and-dynamic-specialists.md`
