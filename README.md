# KernelJSON

KernelJSON is a durable cognitive execution platform.

It is NOT an agent roster.

## Six primitives

1. EVENT
2. TASK
3. CAPABILITY
4. STATE
5. POLICY
6. EVIDENCE

## Core rule

A task is the primitive.

An agent is only one possible execution strategy.

## Canonical responsibilities

- Restate: durable execution
- Supabase/PostgreSQL: persisted world state and provenance
- Git: code, schemas, policies and migrations
- jVault: credentials and secrets
- Object storage: large artefacts
- Mission Control: human visibility and control

## Final canonical plan

The final agreed architecture and roadmap is:

- `FINAL_PLAN.md`

`STATE.yaml` remains the source of truth for what is actually implemented.

Material architectural changes require an explicit human decision and an ADR where accepted boundaries change.

## Cognitive architecture

KernelJSON supports a continuing Primary Identity, a small stable Core Team, and dynamic ephemeral specialists without turning agents into infrastructure primitives.

Canonical cognition documents:

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

The governing distinctions are:

> Identities may persist. Cognitive executions do not.

> Models may reason over canonical state. They do not become canonical state.

See `ARCHITECTURE.md` for the kernel constitution and `FINAL_PLAN.md` for the complete build roadmap.