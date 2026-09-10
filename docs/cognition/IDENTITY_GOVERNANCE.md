# KernelJSON Identity Governance

Status: CANONICAL HARDENING SPEC

Version: 1.0

Date: 2026-09-09

## Purpose

This document defines how the Primary Identity and durable Core Team roles may change over time without uncontrolled drift.

Identity is allowed to evolve. Authority is not allowed to grow merely because the system wants it to.

## Identity domains and governance classes

### Class A: Constitutional

Examples:
- relationship to the human principal
- authority boundaries
- policy-obedience requirements
- truthfulness/evidence principles
- privacy principles
- self-modification rules

Rules:
- explicit human approval required
- full version created
- change reason and provenance retained
- regression review required
- rollback path required

### Class B: Structural role

Examples:
- Core Team responsibilities
- exclusions
- escalation rules
- risk ceilings
- default verification requirements

Rules:
- change proposal required
- impact review required
- human approval for authority-adjacent changes
- role versioning required

### Class C: Persona and interaction

Examples:
- tone
- humour
- communication style
- level of initiative
- presentation preferences

Rules:
- versioned
- may be changed by explicit user instruction
- low-risk model proposals may be suggested but not silently adopted

### Class D: Mantras and vision

Rules:
- user-authored items may be activated directly when policy-safe
- model-proposed items remain proposals until approved unless a future explicit policy allows low-risk auto-adoption
- every item retains author, scope, priority, version and provenance

### Class E: Self-model and learned preferences

Examples:
- provider affinities
- observed strengths/weaknesses
- delegation heuristics
- communication preferences inferred from repeated feedback

Rules:
- evidence/evaluation linkage required for material claims
- may be superseded when later evidence contradicts them
- confidence must be represented where relevant

## Change object

Every identity mutation should eventually be represented by a versioned change object containing at least:

- change_id
- identity_id or role_id
- target_domain
- previous_version
- proposed_value/ref
- proposer
- reason
- evidence_refs[]
- risk_class
- approval_requirement
- status
- approved_by optional
- created_at
- resolved_at optional

## Change lifecycle

`PROPOSED -> CLASSIFIED -> EVALUATED -> APPROVAL_REQUIRED/APPROVED/REJECTED -> APPLIED -> OBSERVED -> SUPERSEDED/ROLLED_BACK`

No model-generated text directly mutates canonical identity state.

## Approval hierarchy

The human principal is the final authority for the personal deployment.

Recommended defaults:

- constitutional changes: human approval always
- authority changes: human approval always
- Core Team role-boundary changes: human approval unless clearly narrowing authority
- persona changes: explicit user instruction or low-risk approved workflow
- routing preferences: may become automatically adaptive only after Phase 14 policy/evaluation gates exist
- self-model observations: may be recorded automatically when evidence-backed, but material behavioural changes remain governed

## Version pinning

A task or mission may pin an identity/role version when reproducibility matters.

Examples:
- evaluation suites
- regulated workflows
- long-running tasks
- incident replay

A new identity version must not silently change the semantics of an already-running pinned mission.

## Rollback

Rollback must support:

- reverting current identity version to a previously accepted version
- disabling a mantra/vision item without deleting history
- superseding an incorrect self-model observation
- reverting a role version
- quarantining model-derived changes pending review

Rollback is a new auditable event, not deletion of history.

## Emergency safe mode

Mission Control should eventually provide a safe mode that can:

- freeze identity self-change workflows
- disable dynamic specialists if necessary
- pin a known-good Primary Identity version
- restrict cognition to a minimal approved provider/model set
- require approval for all external writes
- disable memory promotion while preserving read-only retrieval

## User correction rule

For facts/preferences owned by the user, explicit user correction outranks conflicting model-derived memory.

The prior item should normally be superseded rather than erased so provenance and learning remain inspectable.

## Audit requirements

Mission Control should expose:

- current identity version
- current role versions
- active mantras/vision/aspirations
- pending proposals
- who/what proposed each change
- evidence and evaluations supporting it
- who approved it
- rollback/supersession history

## Definition of governed identity growth

Identity growth is considered governed only when:

1. every durable change has provenance
2. high-risk changes cannot bypass human approval
3. authority cannot grow through reflection
4. old versions remain recoverable
5. changes can be evaluated against regressions
6. provider sessions cannot become the hidden canonical identity
7. the human principal can inspect and reverse material evolution.