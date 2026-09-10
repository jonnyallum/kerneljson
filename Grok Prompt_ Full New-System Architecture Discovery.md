You are performing a READ-ONLY technical architecture discovery of my current AI system.

DO NOT modify code.
DO NOT create migrations.
DO NOT change configuration.
DO NOT deploy anything.
DO NOT delete, rename or move files.
DO NOT alter databases.
DO NOT change credentials.
DO NOT make architectural changes.

Your job is purely to inspect, understand and document the system as it ACTUALLY EXISTS.

I am going to give your final report to another AI architect who currently knows almost nothing about this new system.

The report must therefore be extremely detailed, factual, structured and based on evidence from the actual repositories, configuration, infrastructure and running services.

Do not rely solely on README files or architecture documentation.

READ THE CODE.

Where documentation and implementation disagree, report the implementation as reality and explicitly note the disagreement.

Do not hallucinate missing components.

If something cannot be verified, label it:

UNVERIFIED

rather than guessing.

---

# BACKGROUND

This system is being built to replace two previous AI orchestration systems:

- JaiOS
- Antigravity Orchestra

The migration is currently underway.

The new system is a major architectural upgrade.

There is also currently:

- an Agent Hub / MCP system
- a component currently acting as the Conductor
- a separate VM running a DeepSeek harness
- a Shared Brain / shared-memory system
- existing agents, workflows, tools and integrations inherited or migrated from JaiOS and Antigravity Orchestra
- messaging/channel integrations
- potentially LangGraph or similar orchestration components
- external infrastructure and databases

Do NOT assume these descriptions are architecturally accurate.

Verify them.

There is another project called KernelJSON that will eventually be introduced, but for this task YOU DO NOT NEED TO DESIGN OR IMPLEMENT KernelJSON.

Your sole job is to give an external architect a perfect understanding of the CURRENT new system so KernelJSON can later be integrated correctly.

---

# PRIMARY OBJECTIVE

Produce the most complete possible technical map of the current system.

I need to understand:

1. What exists.
2. Where it exists.
3. What each component does.
4. Which component controls which other component.
5. What actually acts as the global orchestrator.
6. How agents receive work.
7. How agents communicate.
8. How tools are exposed.
9. How MCP is being used.
10. How the Agent Hub works.
11. How the Conductor works.
12. How the DeepSeek harness works.
13. How the separate DeepSeek VM connects to the rest of the system.
14. How the Shared Brain works.
15. What data is stored in the Shared Brain.
16. How memory is retrieved and written.
17. What databases exist.
18. What queues/event systems exist.
19. How task state is maintained.
20. How execution state is maintained.
21. How agents are registered.
22. How capabilities are registered.
23. How routing decisions currently work.
24. How models/providers are selected.
25. How failures/retries work.
26. How workflows are represented.
27. How long-running jobs operate.
28. How human approvals work, if present.
29. How credentials/secrets are managed.
30. How observability/logging works.
31. What services run locally.
32. What services run remotely.
33. What services run in Docker/VM/cloud environments.
34. What is already migrated.
35. What still depends on JaiOS.
36. What still depends on Antigravity Orchestra.
37. What is temporary migration scaffolding.
38. What is intended to remain permanently.
39. Where architectural duplication currently exists.
40. Where there are competing sources of authority.

---

# INSPECTION METHOD

Explore all relevant repositories and infrastructure available to you.

Inspect, where accessible:

- source code
- package manifests
- Python dependencies
- TypeScript dependencies
- Dockerfiles
- docker-compose files
- environment templates
- configuration
- YAML
- JSON
- TOML
- databases
- Supabase configuration
- schema/migrations
- MCP servers
- MCP manifests/config
- LangGraph graphs
- workflow definitions
- routers
- schedulers
- agent registries
- model registries
- prompt systems
- memory systems
- vector stores
- queues
- event buses
- API routes
- gateways
- workers
- background processes
- system services
- deployment configuration
- monitoring
- telemetry
- logging
- authentication
- secret-management integration
- messaging integrations
- Telegram
- WhatsApp
- GitHub integration
- external APIs
- model-provider integrations

Where shell access is available, you may use SAFE READ-ONLY commands to understand:

- repository structure
- running processes
- Docker containers
- ports
- services
- environment variable NAMES
- installed packages
- dependency graphs
- Git status/history
- service topology

DO NOT output secret VALUES.

Environment variable names are useful.

Credential contents are not.

---

# PART 1 — EXECUTIVE ARCHITECTURE

Start with a plain-English explanation:

"What is this system?"

Explain it to a senior AI/software architect who has never seen it.

Cover:

- primary purpose
- architectural philosophy
- major subsystems
- execution model
- memory model
- orchestration model
- agent model
- infrastructure model

Then provide:

CURRENT ARCHITECTURE MATURITY: X/10

with reasoning.

---

# PART 2 — MASTER SYSTEM MAP

Create the most accurate ASCII architecture diagram possible.

Show at minimum:

USER / INPUT CHANNELS

↓

ENTRY/GATEWAY LAYER

↓

GLOBAL ORCHESTRATION

↓

LOCAL ORCHESTRATION

↓

AGENTS

↓

TOOLS / MCP / CAPABILITIES

↓

MODELS

↓

SHARED BRAIN / MEMORY

↓

DATABASES

↓

EXTERNAL SERVICES

Also show:

- Agent Hub
- Conductor
- DeepSeek VM
- DeepSeek harness
- Shared Brain
- messaging channels
- MCP servers
- agent runtimes
- worker processes
- databases
- external model providers
- relevant cloud infrastructure

Show arrows indicating actual direction of control/data.

Do not draw conceptual relationships that do not exist in code.

---

# PART 3 — COMPONENT INVENTORY

Create a table:

| Component | Location | Language | Process Type | Responsibility | Called By | Calls | Persistent? | Current Status |

Include EVERY major component.

Location should identify repository/path/service where possible.

Current Status must be one of:

- PRODUCTION
- ACTIVE
- MIGRATING
- LEGACY
- TEMPORARY
- EXPERIMENTAL
- UNUSED
- UNKNOWN

---

# PART 4 — REPOSITORY MAP

For every relevant repository:

Provide:

Repository:
Purpose:
Language:
Framework:
Entry point:
Key directories:
Important configuration:
Runtime:
Deployment:
Database dependencies:
External services:
Relationship to other repos:

Then show a reduced directory tree containing architecturally important files only.

Do not dump thousands of filenames.

---

# PART 5 — AGENT HUB DEEP DIVE

This section is extremely important.

Find the Agent Hub / MCP system.

Explain:

- what Agent Hub actually is
- whether it is an MCP server, client, gateway, runtime or combination
- its main entry point
- what protocols it exposes
- what tools/capabilities it exposes
- how clients connect
- how authentication works
- what state it maintains
- what agents it knows about
- whether it directly executes work
- whether it delegates work
- how results return
- whether it maintains sessions
- whether it can execute asynchronously
- whether it exposes structured schemas
- whether capabilities can be discovered programmatically

List every important Agent Hub tool.

For each:

Tool:
Input:
Output:
Purpose:
Side effects:
Risk:
Implementation location:

Then answer:

COULD AN EXTERNAL ORCHESTRATOR TREAT AGENT HUB AS AN EXECUTION RUNTIME?

Answer:

YES / PARTIALLY / NO

Then explain exactly what interfaces already exist that would support that.

---

# PART 6 — CONDUCTOR DEEP DIVE

Identify the component currently referred to as the Conductor.

Do not assume the name identifies one file.

Determine what ACTUALLY performs orchestration.

Explain:

- entry point
- task intake
- planning
- decomposition
- routing
- agent selection
- tool selection
- context construction
- memory retrieval
- model selection
- retries
- error handling
- completion detection
- execution state
- task state
- human approval
- output assembly

Then answer separately:

WHO CURRENTLY OWNS:

Global task authority:
Agent selection:
Tool selection:
Model selection:
Memory selection:
Execution state:
Completion decision:
Retries:
Escalation:
Permissions:

If multiple systems believe they own one of these, flag:

AUTHORITY CONFLICT

---

# PART 7 — AGENT MODEL

Determine exactly what an "agent" means in this architecture.

Are agents:

- LangGraph nodes?
- persistent services?
- prompts?
- classes?
- workflows?
- remote processes?
- model configurations?
- MCP tools?
- combinations?

Find the agent registry if one exists.

Report:

Total agents discovered:
Active:
Migrated:
Legacy:
Deprecated:
Dynamic:

Show representative agent definition(s).

Explain the lifecycle:

CREATE / REGISTER
↓
SELECT
↓
CONTEXT
↓
EXECUTE
↓
TOOLS
↓
RESULT
↓
MEMORY
↓
COMPLETE

If actual lifecycle differs, show reality.

---

# PART 8 — DEEPSEEK HARNESS

This section is extremely important.

Find everything related to the DeepSeek harness.

Explain:

- where it runs
- how it is launched
- whether it runs continuously
- API/interface exposed
- ports/protocol
- authentication
- task input format
- response format
- model(s)
- local/remote inference
- context limits
- session handling
- parallelism
- queueing
- tool access
- file access
- code execution
- internet access
- MCP access
- memory access
- retries
- observability
- cost model if apparent

Explain exactly how:

NEW SYSTEM
→ DEEPSEEK VM
→ DEEPSEEK HARNESS

works.

Include the exact logical call path through code where possible.

Then answer:

COULD THE DEEPSEEK HARNESS BE EXPOSED AS A GENERIC EXECUTION PROVIDER?

YES / PARTIALLY / NO

Explain what would be required.

---

# PART 9 — SHARED BRAIN

This section is CRITICAL.

Find the Shared Brain implementation.

Explain what "Shared Brain" actually means technically.

Identify:

- service
- database
- schemas
- tables
- vector stores
- embeddings
- graph storage
- APIs
- memory classes
- retrieval mechanisms

Classify stored information into:

SEMANTIC MEMORY
EPISODIC MEMORY
WORKING MEMORY
PROJECT KNOWLEDGE
WORLD STATE
DECISIONS
OBSERVATIONS
EXECUTION HISTORY
USER MEMORY
AGENT MEMORY
EVIDENCE

Mark which categories genuinely exist.

Explain the write path:

EVENT
↓
???
↓
SHARED BRAIN

Explain retrieval:

TASK
↓
???
↓
SEARCH
↓
RANK
↓
CONTEXT

Determine:

- provenance support
- confidence scores
- timestamps
- ownership
- project scoping
- agent scoping
- deduplication
- retention
- decay
- summarisation
- embeddings
- graph relationships
- source references

Flag any "memory soup" problems where unrelated facts could contaminate context.

---

# PART 10 — DATABASES

List every database/storage system discovered.

Create:

| Storage | Purpose | Technology | Schema/Collections | Writers | Readers | Source of Truth? |

Include:

- Supabase
- Postgres
- Redis
- vector DB
- filesystem state
- SQLite
- JSON stores
- caches
- external memory services

if present.

Explicitly identify sources of truth.

---

# PART 11 — TASK & EXECUTION STATE

This is extremely important.

Find how a piece of work is represented.

Is there:

- task ID
- run ID
- execution ID
- conversation ID
- workflow ID
- parent/child relationship
- status
- retry count
- timestamps
- owner
- output
- errors

Show the exact current state machine if possible.

Example:

QUEUED
↓
RUNNING
↓
COMPLETE

or whatever reality is.

Explain whether execution survives:

- process restart
- VM restart
- network failure
- model timeout
- human interruption

---

# PART 12 — ROUTING

Find every routing mechanism.

Identify how the system chooses:

- agent
- tool
- workflow
- model
- provider
- runtime

Determine whether routing is:

- hardcoded
- LLM-driven
- rules-based
- semantic
- weighted
- learned
- cost-aware
- capability-based
- fallback-based

Show relevant implementation paths.

---

# PART 13 — MODEL PROVIDERS

List every model/provider integration.

Table:

| Provider | Models | Used For | Called From | API/Local | Cost Awareness | Fallback |

Include:

- DeepSeek
- OpenAI
- Anthropic
- Gemini
- Grok/xAI
- OpenRouter
- local models

if they exist.

Do not infer integrations that aren't present.

---

# PART 14 — MCP

Map the complete MCP topology.

Show:

CLIENTS
↓
MCP SERVERS
↓
TOOLS
↓
BACKEND SYSTEMS

For every MCP server:

Name:
Location:
Transport:
Tools:
Resources:
Authentication:
Consumers:
State:
External dependencies:

Explicitly state whether Agent Hub itself is an MCP server.

---

# PART 15 — WORKFLOW ENGINE

Identify any:

- LangGraph
- Temporal
- Restate
- n8n
- Celery
- queues
- custom state machine
- cron
- worker architecture

Explain how workflows operate.

Show examples of important graphs/workflows.

Identify whether workflow state is durable.

---

# PART 16 — INFRASTRUCTURE MAP

Show all known runtime environments.

For example:

LOCAL LAPTOP

VM A

DEEPSEEK VM

CLOUD

SUPABASE

RENDER

GCP

DOCKER

HOSTINGER

etc.

Only include verified environments.

For each:

Purpose:
Services:
Network relationships:
Persistent storage:
Deployment method:

Then provide an infrastructure diagram.

---

# PART 17 — NETWORK/API MAP

List important internal interfaces.

| Source | Destination | Protocol | Endpoint/Port | Purpose | Auth |

Do not expose credentials.

Ports and endpoint names are fine.

---

# PART 18 — CHANNELS

Find Telegram/WhatsApp/other messaging channels.

Explain:

USER
↓
CHANNEL
↓
BOT/GATEWAY
↓
???
↓
CONDUCTOR
↓
AGENT
↓
RESPONSE

for every important channel.

---

# PART 19 — SECURITY & AUTHORITY

Document:

- secrets
- API keys
- environment variables
- service credentials
- authentication
- authorisation
- execution permissions
- sandboxing
- shell access
- filesystem access
- database access
- production access

DO NOT PRINT SECRETS.

Instead report:

SECRET: DEEPSEEK_API_KEY
Location: environment
Consumed by: ...
Scope: ...

Identify any component with excessive authority.

Flag:

SECURITY CONCERN

where relevant.

---

# PART 20 — OBSERVABILITY

Find:

- logs
- traces
- metrics
- OpenTelemetry
- dashboards
- task history
- LLM usage
- token usage
- cost tracking
- errors
- audit trail

State exactly what can and cannot currently be reconstructed after an agent runs.

---

# PART 21 — MIGRATION STATUS

Determine what has moved from:

JaiOS
Antigravity Orchestra

into the new system.

Create:

| Capability | JaiOS | Antigravity | New System | Migration Status |

Statuses:

- MIGRATED
- REBUILT
- PARTIAL
- NOT STARTED
- RETIRED
- UNKNOWN

Identify remaining hard dependencies on the old systems.

---

# PART 22 — LEGACY DEBT

List components which appear to exist solely because of the migration.

Classify:

SAFE TO RETIRE LATER

MUST RETAIN

UNKNOWN

DO NOT actually remove anything.

---

# PART 23 — DUPLICATED RESPONSIBILITIES

Look specifically for duplicated:

- orchestrators
- routers
- memory systems
- schedulers
- agent registries
- task databases
- model wrappers
- tool registries
- MCP gateways
- state machines

For each duplication explain which component currently has actual authority.

---

# PART 24 — CAPABILITY MAP

Ignore agent names temporarily.

Describe the system as CAPABILITIES.

Example:

research.web
repository.read
repository.write
database.read
database.write
browser.use
shell.execute
message.telegram
message.whatsapp
memory.search
memory.write
code.generate
code.review
workflow.execute

Produce a complete capability catalogue.

For each:

Capability:
Implemented by:
Interface:
Side effects:
Required permissions:
Reliability:
Stateful/stateless:

This section is VERY important for the external architect.

---

# PART 25 — CONTROL PLANE VS EXECUTION PLANE

Based solely on the existing system, identify which components currently behave as:

CONTROL PLANE

EXECUTION PLANE

KNOWLEDGE PLANE

DATA PLANE

INTERFACE PLANE

Some components may span several.

Explain overlaps.

---

# PART 26 — WHAT HAPPENS FOR ONE REAL TASK?

Choose one representative request.

For example:

"Inspect repository X, identify a bug, fix it, test it and report."

Trace EVERY major hop:

USER
↓
...
↓
RESULT

Include:

- functions/classes
- services
- agents
- APIs
- memory
- models
- tools
- databases

where identifiable.

This is one of the most valuable parts of the report.

---

# PART 27 — FAILURE TRACE

Repeat the exercise when:

- selected model fails
- agent throws
- tool fails
- network fails
- DeepSeek VM unavailable
- database unavailable

Explain actual fallback behaviour.

Do not describe intended behaviour unless clearly labelled INTENDED ONLY.

---

# PART 28 — STRENGTHS

Identify the ten strongest architectural decisions in the new system.

These must be based on actual implementation.

---

# PART 29 — WEAKNESSES

Identify the ten biggest architectural weaknesses or risks.

Focus particularly on:

- competing orchestration
- state
- memory
- reliability
- coupling
- authority
- security
- observability
- complexity
- migration debt

---

# PART 30 — EXTERNAL ORCHESTRATOR READINESS

Without designing the external orchestrator, assess whether the existing system could be controlled by one.

Score 0-10 for:

Capability discovery
Task dispatch
Structured results
Execution IDs
Persistent sessions
Cancellation
Resume
Evidence
Health checks
Authentication
Permissions
Cost telemetry
Agent abstraction
Model abstraction

Then identify the interfaces which already make this possible.

---

# PART 31 — RECOMMENDED INTEGRATION SURFACES

Do not build anything.

Simply identify where an external orchestration kernel could connect with minimal disruption.

Potential surfaces might include:

Agent Hub MCP
DeepSeek harness API
Shared Brain API
workflow engine
task queue
model provider layer

For each potential integration point:

Existing interface:
Pros:
Cons:
Coupling risk:
Changes required:
Migration risk:

---

# PART 32 — FILES AN EXTERNAL ARCHITECT MUST SEE

Give me a list of the 20-50 most architecturally important files.

Format:

PATH
WHY IT MATTERS

Prioritise:

- entry points
- conductor
- Agent Hub
- MCP
- Shared Brain
- DeepSeek
- routing
- workflows
- agents
- schemas
- state
- providers
- infrastructure

---

# PART 33 — INFORMATION YOU COULD NOT VERIFY

Explicitly list all unanswered questions.

Do not hide uncertainty.

---

# FINAL OUTPUT

Finish with a single consolidated section:

# SYSTEM HANDOVER FOR EXTERNAL ARCHITECT

It should contain:

1. One-paragraph system description.
2. Master architecture diagram.
3. Infrastructure diagram.
4. Component inventory.
5. Control hierarchy.
6. Agent Hub summary.
7. Conductor summary.
8. DeepSeek harness summary.
9. Shared Brain summary.
10. Current task lifecycle.
11. Current capability catalogue.
12. Current model/provider map.
13. MCP topology.
14. Migration status.
15. Sources of truth.
16. Authority conflicts.
17. Integration-ready interfaces.
18. Major risks.
19. Unknowns.
20. Most important source files.

The handover should be detailed enough that another senior architect could design a new orchestration/control layer for this system WITHOUT needing you present to explain how the existing system works.

---

# OUTPUT QUALITY RULES

Be exhaustive.

Prefer evidence to interpretation.

Use exact paths, service names, class names and function names.

Quote short relevant code fragments where useful.

Do not dump entire files.

Distinguish clearly between:

IMPLEMENTED
DOCUMENTED
PLANNED
INFERRED
UNVERIFIED

If architecture docs disagree with code, explicitly say so.

Do not modify anything.

Do not implement anything.

Do not optimise anything.

Your only job is:

DISCOVER → VERIFY → MAP → EXPLAIN.

Return the entire report in one response if possible.

If the report is too large for one response, prioritise the complete "SYSTEM HANDOVER FOR EXTERNAL ARCHITECT" section and then provide additional detail afterwards.