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

## Cognitive architecture

KernelJSON supports a continuing Primary Identity, a small stable Core Team, and dynamic ephemeral specialists without turning agents into infrastructure primitives.

Canonical cognition documents:

- `docs/cognition/COGNITIVE_ARCHITECTURE.md`
- `docs/cognition/IMPLEMENTATION_PLAN.md`
- `docs/adr/0005-persistent-identities-ephemeral-workers.md`
- `docs/adr/0006-core-team-and-dynamic-specialists.md`

The governing distinction is:

> Identities may persist. Cognitive executions do not.

See `ARCHITECTURE.md` for the kernel constitution.
