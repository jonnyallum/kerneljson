# KernelJSON Identity Backup and Recovery

Status: CANONICAL HARDENING SPEC

Version: 1.0

Date: 2026-09-09

## Purpose

This document defines disaster recovery for the Primary Identity, Core Team configuration, memory state and cognitive governance.

The goal is to make the cognitive layer recoverable from corruption, bad migrations, accidental identity drift, provider failure, poisoned memory and operator error.

## Recovery principle

> The system must be able to restore a known-good cognitive state without depending on any model provider's conversation history.

## Assets requiring recoverability

At minimum:

- Primary Identity profile and versions
- constitution/persona/values refs
- active mantras, vision and aspirations
- Core Team role versions
- memory items and provenance
- memory promotions/supersessions
- self-model observations
- reflection and identity-change proposals
- model affinities/routing preferences
- executive state projections
- task/evidence/audit history required to reconstruct decisions

## Source-of-truth boundaries

### Git
Recoverable through repository history:
- constitutional documents
- ADRs
- default role templates
- policies/eval definitions
- schemas/migrations

### Supabase/PostgreSQL
Requires database backup/point-in-time strategy for:
- identity instances/versions
- role instances/versions
- memory/world state
- change proposals
- worker/evaluation metadata
- task projections and audit data

### Restate
Requires durable runtime recovery procedures for in-flight work, but Restate is not the canonical identity store.

### jVault
Secrets require independent secure backup/recovery procedures appropriate to the vault product. Secrets must not be copied into Git or identity snapshots.

### Object storage
Large artefacts/transcripts/evaluation bundles should use versioning/retention where justified.

## Cognitive snapshot

A future CognitiveSnapshot should reference a coherent known-good set:

- snapshot_id
- created_at
- reason
- primary_identity_id/version
- role versions
- policy version
- memory snapshot/checkpoint ref
- world-model checkpoint ref where relevant
- schema/migration version
- active mission refs
- integrity hashes/digests
- created_by
- verification status

Snapshots should contain references and hashes rather than raw secrets.

## Snapshot triggers

Recommended triggers:

- before constitutional identity change
- before high-impact role restructuring
- before memory schema migration
- before major cognitive migration
- before enabling autonomous identity-growth features
- before production rollout of a new context assembly strategy
- periodic scheduled recovery checkpoint

## Recovery modes

### Provider failover

Use canonical state to rebuild an IdentityProjection for another available provider.

No rollback required unless state itself is bad.

### Identity rollback

Pin/revert current identity pointer to a previous accepted identity version.

Preserve later versions in history.

### Memory quarantine

Disable suspect memories from retrieval without deleting provenance/audit history.

Useful after suspected poisoning or bad promotion.

### Routing rollback

Restore known-good model/provider/delegation preferences after poor adaptive changes.

### Cognitive safe mode

Enter restricted operation:
- known-good identity version pinned
- identity mutations frozen
- memory promotion disabled
- dynamic specialists optionally disabled
- external writes approval-gated
- minimal trusted provider set
- read-only inspection available

### Full cognitive restore

Restore database/object-store state to a known-good checkpoint, reconcile in-flight durable tasks, then verify identity/memory integrity before reopening normal cognition.

## Recovery precedence

When restoring, prefer preserving immutable audit/event history even when current projections are rolled back.

A rollback changes the active current state; it does not rewrite history to pretend the bad state never happened.

## Integrity checks

Recovery verification should eventually check:

- referenced identity versions exist
- active role versions exist
- policy version is valid
- no memory refs cross tenant/principal scope unexpectedly
- supersession chains are valid
- required provenance refs resolve
- active missions reference valid tasks
- identity/context hashes match expected snapshot metadata
- no secret material leaked into snapshots

## Backup testing

A backup is not considered reliable until restore has been tested.

Required drills should eventually include:

1. restore Primary Identity to prior version
2. quarantine poisoned memory and prove it no longer enters context
3. recover from provider outage using fresh provider session
4. restore a database checkpoint in a non-production environment
5. reconcile Restate workflow after cognitive state restore
6. recover after a bad identity migration
7. enter and exit cognitive safe mode

## Data loss priorities

If perfect recovery is impossible, preserve in this order:

1. constitutional/policy boundaries
2. audit/evidence history
3. user-authored identity state
4. current task/mission truth
5. verified/project memory
6. learned routing/self-model state
7. disposable working memory/provider chat state

## Recovery authority

High-impact restore/rollback operations should require explicit human authority in the personal deployment.

A cognitive worker may detect damage and recommend recovery. It should not silently rewrite or erase canonical history.

## Definition of recoverable cognition

The cognitive system is recoverable when a provider session, worker process or bad identity/memory change can be lost without losing the ability to reconstruct a known-good Primary Identity, its governance boundaries, relevant memory and current operational truth from canonical stores.