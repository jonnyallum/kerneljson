# NEW SYSTEM TRANSITION CHARTER

## Purpose

We are completing the migration away from JaiOS and Antigravity Orchestra.

A new control-plane project called **KernelJSON** will shortly become the global task authority for the ecosystem.

Do NOT stop the current migration.

Do NOT rewrite the new system around KernelJSON yet.

Instead, complete the migration in a way that allows KernelJSON to integrate cleanly without another major architectural rewrite.

---

# 1. Architectural Direction

The intended final architecture is:

```text
Persistent Identity
        │
        ▼
    KernelJSON
        │
        ├── Agent Hub / Conductor Runtime
        ├── New-System Spawner Runtime
        ├── DeepSeek Runtime
        ├── Grok Runtime
        ├── direct model providers
        └── other execution capabilities
                 │
                 ▼
            Shared Brain
```

The roles will be:

## Persistent Identity

Owns:

- personality
- relationship
- mantras
- autobiography
- vision
- strategic continuity

It does NOT own execution authority.

---

## KernelJSON

Will ultimately own:

- task admission
- durable task state
- routing
- capability selection
- approvals
- authority
- budgets
- retries
- cancellation
- evidence
- verification
- completion
- escalation

KernelJSON will use its own fresh Supabase project.

Do not merge KernelJSON operational storage with Shared Brain.

---

## Shared Brain

Owns durable cognitive and organisational knowledge:

- memories
- projects
- learnings
- decisions
- observations
- relationships
- knowledge
- provenance
- world state

Shared Brain is not the task execution database.

---

## Agent Hub / Conductor

Will remain valuable.

It will eventually become a KernelJSON execution runtime / capability gateway.

It should NOT become another competing global task authority.

---

## registry-v2

Treat registry-v2 as the foundation of the future capability system.

Skills should remain portable and independently callable.

Do not make skills dependent on permanent named agents unnecessarily.

---

## Agent Spawner

The intended worker architecture remains:

```text
mission
 ↓
retrieve capabilities / skills
 ↓
assemble ephemeral worker
 ↓
guardian
 ↓
sandbox
 ↓
execute
 ↓
evidence
 ↓
learning
 ↓
retire worker
```

Preserve this architecture.

---

# 2. CURRENT PRIORITY

Finish the JaiOS / Antigravity migration.

However:

DO NOT introduce new global orchestration responsibilities into:

- Conductor
- OpenClaw
- Mission Control
- n8n
- Spawner
- Shared Brain
- registry-v2

Any new functionality should preferably be exposed as:

```text
CAPABILITY
```

rather than:

```text
NEW GLOBAL ORCHESTRATOR
```

---

# 3. VERIFY THE SPAWNER

This is Priority Zero.

Determine conclusively whether the Agent Spawner is live.

Expected surface:

```text
127.0.0.1:8766
POST /api/v1/spawn
```

Verify:

- running process
- service manager
- health
- port
- endpoint
- request schema
- response schema
- skill mounting
- model selection
- memory retrieval
- guardian pre-gate
- sandbox execution
- evidence output
- worker teardown
- failure handling

Perform one harmless end-to-end test.

Example task:

```text
Read a test repository README.
Return its project name.
Make no changes.
```

Capture evidence.

Do not assume the Spawner exists because an adapter exists.

---

# 4. VERIFY CURRENT LIVE ESTATE

Resolve these uncertainties where safely possible:

### Runtime

Identify actual running:

- PM2 processes
- Docker containers
- systemd services
- ports

### Conductor

Verify:

- :8790 runtime
- exact implementation deployed
- OAuth
- Caddy route
- tool availability

### DeepSeek

Verify:

- where DSH runs
- whether there is a genuinely separate DeepSeek VM
- API/interface
- authentication
- task format
- session behaviour
- tool access

### Shared Brain

Verify current:

- schemas
- tables
- RLS
- migration state
- current learnings count

### Mission Control

Determine which `mc_*` migrations are actually live.

Do not apply migrations merely to make documentation match reality.

Report reality first.

---

# 5. CAPABILITY CATALOGUE

Begin representing the new system as capabilities.

Do not organise this primarily around agent names.

Example:

```text
repository.read
repository.write

github.read
github.write

memory.search
memory.write

research.web

database.read
database.write

shell.execute

browser.use

message.telegram
message.whatsapp

code.generate
code.review

workflow.execute
```

For every capability record:

```yaml
id:

implementation:

runtime:

inputs:

outputs:

side_effects:

permissions:

evidence_produced:

stateful:

status:
```

This catalogue will later be consumed by KernelJSON.

---

# 6. MCP INVENTORY

Reconcile the currently drifting MCP catalogues.

Clearly distinguish:

```text
AVAILABLE
ENABLED
STAGED
CANDIDATE
LEGACY
RETIRED
```

Do not claim one canonical total until the actual runtime wiring is verified.

For every active MCP define:

```text
name
transport
capabilities
authentication
consumer
side effects
status
```

---

# 7. ROUTING

Do not expand the existing routing architecture beyond what is necessary to finish migration.

Current routing may continue temporarily.

However, isolate routing decisions behind a clean interface.

Target concept:

```text
route(request)
→ capability requirements
```

rather than permanently encoding:

```text
route(request)
→ Marcus
→ persona
→ JaiOS node
```

KernelJSON will ultimately own global routing.

---

# 8. CONDUCTOR

Keep the Conductor operational.

Do not delete or rewrite it.

Begin treating it conceptually as:

```text
AgentHub Capability Gateway
```

Its existing MCP tools are useful integration surfaces.

Prepare documentation for:

```text
capabilities()
execute()
health()
```

Do not implement these abstractions prematurely unless needed.

The goal is to make a later `AgentHubRuntime` adapter straightforward.

---

# 9. JAIOS AND ORCHESTRA

Do NOT delete JaiOS or Orchestra yet.

For every remaining consumer create:

```text
legacy component
→ consumer
→ capability supplied
→ replacement
→ replacement verified?
→ retirement safe?
```

Only retire when the replacement has:

- positive test
- negative test
- rollback
- consumer verification

Disable before deletion.

---

# 10. AUTHORITY

During migration, explicitly document who currently owns:

```text
task admission
routing
capability selection
model selection
execution
approvals
retry
cancel
completion
external side effects
```

Where two components believe they own the same responsibility mark:

```text
AUTHORITY CONFLICT
```

Do not hide these conflicts by documentation wording.

KernelJSON will eventually resolve them.

---

# 11. SECURITY

Do not assume documented human gates are actually enforced.

Treat dangerous operations as dangerous regardless of persona instructions.

Flag especially:

- production mutation
- credential changes
- messaging
- publishing
- cloud resources
- database writes
- destructive filesystem operations
- external spend

Document where enforcement occurs in CODE.

Prompt-level instructions do not count as enforcement.

---

# 12. DSH PERMISSIONS

The current:

```text
danger-full-access
```

preset must be treated as development infrastructure, not the future security architecture.

Do not broaden it.

Future execution will receive mission-scoped authority through KernelJSON/policy/jVault.

---

# 13. EVIDENCE

Start making workers return structured evidence.

For work that changes anything, return where applicable:

```text
files changed
git diff
commands executed
exit codes
tests
URLs
database results
artefacts
screenshots
logs
```

Do not rely solely on:

```text
DONE
```

as proof of completion.

---

# 14. SHARED BRAIN

Do not perform a destructive restructure yet.

Prepare for Shared Brain v2.

Future memory classes will include:

```text
knowledge
project memory
self memory
relationship memory
decisions
observations
evidence
beliefs
hypotheses
autobiography
world state
```

Current data must be preserved.

Migration must be additive and reversible.

---

# 15. PERSISTENT IDENTITY

A new primary identity will replace the current Marcus/Keith conversational architecture.

Do NOT build the identity yet unless explicitly instructed.

However, preserve useful material from:

- Marcus
- Keith
- Orchestra personas
- existing memories
- operating principles
- interaction history

Nothing useful should be deleted.

They will later be mined for:

```text
lessons
preferences
mistakes
successful behaviours
relationship history
mantras
persona traits
```

The old personas will become historical source material rather than orchestration authorities.

---

# 16. KERNELJSON

KernelJSON already exists.

It is not to be recreated.

It has its own fresh Supabase project.

It already includes substantial implementation around:

- durable task lifecycle
- Restate execution
- evidence
- approvals
- policy
- memory provenance
- DeepSeek
- scheduling

Current KernelJSON work should be completed separately.

The new system should prepare integration surfaces rather than attempting to duplicate KernelJSON functionality.

---

# 17. DO NOT BUILD

Until instructed, do NOT build new versions of:

- durable task ledger
- global scheduler
- global approval engine
- global retry engine
- global completion engine
- global model router
- global evidence ledger
- second Shared Brain
- second KernelJSON
- second Conductor

These responsibilities are being consolidated.

---

# 18. MIGRATION COMPLETION DELIVERABLE

When the new-system migration reaches a stable point, produce:

# NEW SYSTEM READY FOR KERNELJSON

including:

### Runtime estate

Actual services and ports.

### Spawner

Live proof and interface.

### Capability catalogue

All callable capabilities.

### MCP catalogue

Verified runtime wiring.

### Shared Brain

Current schema and interfaces.

### Agent Hub

Verified Conductor interfaces.

### DeepSeek

Verified execution interface.

### Legacy dependency map

Remaining JaiOS / Orchestra consumers.

### Authority map

Who currently owns each control responsibility.

### Security map

Actual enforcement points.

### Evidence format

What each execution path can return.

### Known gaps

Anything KernelJSON integration must solve.

---

# 19. AFTER MIGRATION

Once the migration is stable:

```text
Step 1
Complete KernelJSON current phase.

Step 2
Build AgentHubRuntime.

Step 3
Connect registry-v2 capability discovery.

Step 4
Connect and verify Spawner runtime.

Step 5
Add direct DeepSeek runtime where appropriate.

Step 6
Introduce Persistent Identity v1.

Step 7
Run KernelJSON in shadow mode.

Step 8
Move read-only missions to KernelJSON.

Step 9
Move normal execution to KernelJSON.

Step 10
Move approval/completion authority to KernelJSON.

Step 11
Retire global routing from Conductor.

Step 12
Retire verified JaiOS / Orchestra consumers.

Step 13
Make KernelJSON the sole global control plane.
```

---

# 20. FIRST KERNELJSON ESTATE TEST

The first estate-level mission will be:

```text
KJ-000000

Dispatch a read-only repository analysis through Agent Hub,
collect structured evidence,
verify it,
and complete the task durably.
```

No production changes.

This proves:

```text
KernelJSON
→ Agent Hub
→ new-system worker
→ evidence
→ KernelJSON verification
```

---

# 21. FIRST MAJOR PROGRAMME

After the control plane is proven:

```text
COLLECTIVE PREDICTION ENGINE
```

will become KernelJSON's first major build programme.

KernelJSON will decompose it into evidence-bound missions and use the combined runtime estate to execute them.

---

# OPERATING RULE

Until KernelJSON assumes control:

> Finish the migration. Strengthen execution capabilities. Verify reality. Preserve evidence. Do not create another control plane.

The objective is not merely to finish the new system.

The objective is to finish it in a form that can become an exceptionally capable execution fabric underneath KernelJSON.