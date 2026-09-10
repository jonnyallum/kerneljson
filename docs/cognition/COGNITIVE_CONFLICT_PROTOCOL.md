# KernelJSON Cognitive Conflict Protocol

Status: CANONICAL HARDENING SPEC

Version: 1.0

Date: 2026-09-09

## Purpose

This document defines how KernelJSON handles disagreement between workers, Core Team roles, providers, evidence sources and verifiers.

Disagreement is useful signal. The system must not erase it merely to produce a clean answer.

## Core principle

> Preserve material disagreement until it is resolved by evidence, explicit adjudication or human authority.

## Conflict types

### Evidence conflict

Two sources assert incompatible facts.

Response:
- inspect provenance, date, scope and source authority
- determine whether one supersedes the other
- seek additional evidence where cost/risk justifies it
- mark unresolved conflicts explicitly

### Expert disagreement

Two specialists produce different recommendations from compatible facts.

Response:
- preserve both proposals
- compare against explicit decision criteria
- use independent critic/verifier/adjudicator where valuable
- escalate if consequences exceed confidence

### Role conflict

Two Core Team roles prioritise different concerns, e.g. Builder wants speed while Guardian flags risk.

Response:
- role seniority does not resolve deterministic policy
- task acceptance criteria and policy remain binding
- Primary Identity may choose among policy-compliant options
- unresolved high-impact conflict may require human decision

### Producer/verifier conflict

Verifier rejects the producer's claim or artefact.

Response:
- task does not become COMPLETED
- record verification failure
- rework, replan or escalate
- producer cannot overrule verification required by the task contract

### Provider conflict

Different models provide incompatible interpretations.

Response:
- do not treat majority vote as truth by default
- consider provider independence, domain performance and evidence quality
- use a deterministic criterion or separate adjudicator

### User/system conflict

A user request conflicts with deterministic policy or higher-level architecture constraints.

Response:
- deterministic policy wins for execution
- explain the blocking constraint
- surface safe alternatives or approval path where one exists

## Adjudication ladder

Use the cheapest level likely to resolve the conflict safely:

1. deterministic validation
2. evidence freshness/provenance check
3. task acceptance criteria comparison
4. independent Verifier
5. domain-specific adjudicator worker
6. small diverse panel/swarm
7. Primary Identity synthesis within authority
8. explicit human decision

Do not invoke a panel when a unit test or database query can settle the matter.

## Decision record

A material adjudication should eventually retain:

- conflict_id
- task_id
- competing claims/proposals refs
- evidence refs
- decision criteria
- adjudication method
- selected result
- rejected/retained alternatives
- confidence/uncertainty
- adjudicator actor/worker
- human approval ref where applicable
- timestamp

## Confidence and uncertainty

Workers must be allowed to return uncertainty rather than being forced into false precision.

Useful states include:

- HIGH_CONFIDENCE
- MODERATE_CONFIDENCE
- LOW_CONFIDENCE
- INSUFFICIENT_EVIDENCE
- MATERIAL_CONFLICT

These are not substitutes for task-specific calibration metrics but provide explicit routing signals.

## When to say "we do not know yet"

The Primary Identity should explicitly surface unresolved uncertainty when:

- evidence remains materially contradictory
- verification cannot be performed
- the decision depends on unavailable information
- adjudicators remain split and expected harm from guessing is meaningful
- provider/model confidence is unsupported by external evidence

The architecture prefers an inspectable unresolved state to manufactured consensus.

## Swarm diversity

When using multiple workers to resolve conflict:

- vary expertise or reasoning angle where useful
- avoid giving every worker identical summaries that erase source disagreement
- retain independent outputs before synthesis
- require synthesis to cite worker/evidence refs
- measure whether the swarm adds value over a single-worker baseline

## Tie-breaking

No universal voting rule is canonical.

Preferred order:

- deterministic truth where available
- authoritative and temporally valid evidence
- explicit acceptance criteria
- calibrated historical performance for the relevant task class
- independent verification
- human authority for high-impact unresolved choices

Simple majority vote is a last-resort heuristic, not a truth mechanism.

## Conflict with identity aspirations/mantras

Mantras, values, vision and aspirations can guide choices only beneath deterministic policy and explicit task requirements.

If two identity preferences conflict, the Primary Identity should apply their priority/scope/version metadata and record a decision when material.

Identity preferences never resolve authority conflicts in their own favour.

## Acceptance tests

When implemented, test at least:

1. verifier rejection blocks completion
2. contradictory memory is surfaced rather than silently merged
3. three-model majority cannot override deterministic failed test evidence
4. high-impact unresolved conflict escalates to approval/human decision
5. specialist disagreement is retained through synthesis
6. stale authoritative source loses to newer valid superseding source when temporal semantics prove supersession
7. Primary Identity can return INSUFFICIENT_EVIDENCE without being treated as failure of the runtime

## Definition of successful adjudication

A conflict is successfully handled when KernelJSON can explain what disagreed, what evidence and criteria were used, how the resolution was reached, what uncertainty remains and who had authority to make the final decision.