# KernelJSON Grok Integration Specification

**Status:** Proposed v1  
**Primary objective:** Integrate Grok Build, Grok Bot, DeepSeek and frontier-model subscriptions into KernelJSON as a cost-aware, evidence-bound multi-model execution system.

---

# 1. Core Principle

KernelJSON should not think in terms of:

> Which AI should answer this prompt?

It should think:

> What kind of work is this, what capabilities are required, what is the cheapest competent worker, what authority does it need, and how will completion be proved?

The abstraction therefore remains:

```text
TASK
  ↓
COMPILE
  ↓
PLAN
  ↓
ROUTE
  ↓
EXECUTE
  ↓
VERIFY
  ↓
EVALUATE
  ↓
COMPLETE / RETRY / ESCALATE
```

Models are workers underneath this architecture.

---

# 2. Target Architecture

```text
                             JONNY
                               │
                        Mission / Request
                               │
                               ▼
                    ┌─────────────────────┐
                    │  KernelJSON Gateway │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │   Task Compiler     │
                    │                     │
                    │ intent              │
                    │ risk                │
                    │ capabilities        │
                    │ expected evidence   │
                    │ budget              │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │      Planner        │
                    │   DeepSeek default  │
                    └──────────┬──────────┘
                               │
                               ▼
                ┌───────────────────────────┐
                │       Model Router        │
                │                           │
                │ cost × capability × risk  │
                │ confidence × availability │
                └─────────────┬─────────────┘
                              │
             ┌────────────────┼─────────────────┐
             │                │                 │
             ▼                ▼                 ▼
      ┌────────────┐    ┌────────────┐    ┌────────────┐
      │ DeepSeek   │    │ Grok Build │    │ Grok Bot   │
      │            │    │            │    │            │
      │ reasoning  │    │ repository │    │ computer   │
      │ planning   │    │ coding     │    │ browser    │
      │ critics    │    │ terminal   │    │ SaaS       │
      │ bulk work  │    │ tests      │    │ persistent │
      └─────┬──────┘    └─────┬──────┘    └─────┬──────┘
            │                 │                 │
            └─────────────────┼─────────────────┘
                              │
                              ▼
                  ┌───────────────────────┐
                  │ Evidence Bus          │
                  │                       │
                  │ diffs                 │
                  │ tests                 │
                  │ screenshots           │
                  │ command results       │
                  │ source links          │
                  │ artefacts             │
                  └───────────┬───────────┘
                              │
                              ▼
                  ┌───────────────────────┐
                  │ Evaluator / Critics   │
                  │                       │
                  │ DeepSeek cheap        │
                  │ GPT difficult         │
                  │ Claude architecture   │
                  │ Gemini alternate      │
                  └───────────┬───────────┘
                              │
                 ┌────────────┼─────────────┐
                 ▼            ▼             ▼
               PASS         REPAIR       ESCALATE
                              │
                              └──────► executor
```

---

# 3. Grok Should Be Two Separate Integrations

Do **not** implement one generic `GrokAdapter`.

Implement:

```text
GrokBuildRuntime
GrokBotBridge
XaiModelProvider
```

They solve three different problems.

## 3.1 GrokBuildRuntime

This is the important one.

Purpose:

- coding
- terminal work
- repository modification
- debugging
- tests
- refactoring
- codebase investigation
- implementation tasks

Grok Build officially supports headless invocation, JSON/streaming JSON output, resumable sessions and ACP over JSON-RPC. citeturn280270search4turn621546view0

KernelJSON should ultimately favour **ACP**, not shell scraping.

---

## 3.2 XaiModelProvider

Direct xAI model API.

Use for:

- reasoning
- structured generation
- specialised Grok calls
- tool calling
- non-repository workloads

Current Grok Build 0.1 has a 256K context window and supports reasoning, structured output and function calling. citeturn280270search6

This is analogous to:

```text
OpenAIProvider
AnthropicProvider
GeminiProvider
DeepSeekProvider
XaiProvider
```

---

## 3.3 GrokBotBridge

Different beast.

Purpose:

- browser interaction
- persistent login sessions
- cross-SaaS workflows
- computer use
- recurring operational procedures
- tasks requiring several applications
- long-lived operational roles

Grok Bot runs on a persistent cloud computer with browser, filesystem and terminal, and Bots can hand work between one another. citeturn341279search2

Do **not** make KernelJSON depend on an imaginary Grok Bot programmatic API.

Initially:

```text
KernelJSON
     │
     ▼
GrokBotBridge
     │
     ├── routine/event integration where supported
     ├── MCP/connector integration where supported
     └── human dispatch fallback
```

If Cursor/xAI later exposes a stable Bot API, replace the transport without changing KernelJSON's contracts.

---

# 4. New KernelJSON Runtime Contract

Create:

```text
packages/contracts/src/runtime.ts
```

Conceptually:

```ts
export interface ExecutionRuntime {
  id: string;

  capabilities(): Promise<RuntimeCapabilities>;

  health(): Promise<RuntimeHealth>;

  execute(
    mission: CompiledMission,
    context: ExecutionContext
  ): Promise<ExecutionHandle>;

  resume?(
    executionId: string,
    instruction?: string
  ): Promise<ExecutionHandle>;

  cancel?(executionId: string): Promise<void>;
}
```

Capabilities:

```ts
export interface RuntimeCapabilities {
  reasoning: boolean;
  coding: boolean;
  filesystem: boolean;
  terminal: boolean;
  browser: boolean;
  computerUse: boolean;
  persistentSession: boolean;
  structuredOutput: boolean;
  streaming: boolean;
  mcp: boolean;

  maxContextTokens?: number;

  riskClasses: RiskClass[];
}
```

This makes the router ask:

```text
Can this runtime perform the mission?
```

instead of:

```text
Is this a Grok task?
```

---

# 5. Mission Contract

This should become one of KernelJSON's most important contracts.

```text
packages/contracts/src/mission.ts
```

Example:

```ts
export interface CompiledMission {
  id: string;

  objective: string;

  taskType: TaskType;

  context: ContextReference[];

  inputs: MissionInput[];

  constraints: Constraint[];

  requiredCapabilities: Capability[];

  expectedOutputs: ExpectedOutput[];

  verification: VerificationRequirement[];

  authority: AuthorityPolicy;

  budget: BudgetPolicy;

  routing: RoutingPreferences;

  retry: RetryPolicy;

  escalation: EscalationPolicy;

  metadata: MissionMetadata;
}
```

---

# 6. Human Prompt → Mission Compilation

You should be able to say:

```text
Fix the login problem on BizOS.
```

KernelJSON turns that into:

```yaml
mission:
  objective: >
    Identify and resolve the reported BizOS login failure
    and leave a review-ready tested implementation.

  task_type: software_debugging

  capabilities:
    - repository_read
    - repository_write
    - terminal
    - test_execution

  authority:
    repo_write: true
    create_branch: true
    production_write: false
    production_data_write: false
    deploy: false

  verification:
    - reproduce_original_failure
    - automated_regression_test
    - existing_tests_pass
    - diff_review

  deliverables:
    - root_cause
    - patch
    - regression_test
    - execution_evidence

  escalation:
    - destructive_migration
    - production_data_change
    - auth_architecture_change
```

This compiled mission, rather than your casual sentence, goes to Grok.

---

# 7. DeepSeek Becomes the Cheap Intelligence Layer

Your existing DeepSeek harness should be used heavily.

DeepSeek jobs:

```text
intent classification
task decomposition
mission compilation
prompt optimisation
repository summaries
context compression
test generation
criticism
diff analysis
risk classification
candidate routing
result summarisation
bulk transformations
simple research
```

It becomes your **cognitive grunt-work layer**.

Don't ask Grok/GPT/Claude to spend expensive tokens discovering that:

```text
"This is a TypeScript bug involving authentication."
```

DeepSeek can determine that.

---

# 8. Routing Engine

Create:

```text
services/kernel/src/router/
    capability-router.ts
    cost-router.ts
    risk-router.ts
    confidence-router.ts
    escalation-router.ts
```

Final runtime score:

```text
score =
    capability_match
  × reliability
  × task_affinity
  × availability
  × context_fit
  × historical_success
  ÷ estimated_cost
  ÷ latency_penalty
  ÷ risk_penalty
```

Don't hardcode:

```ts
if (coding) useGrok();
```

Instead maintain runtime profiles.

Example:

```yaml
deepseek:
  planning: 0.93
  bulk_reasoning: 0.95
  coding: 0.78
  computer_use: 0
  cost: 0.98

grok_build:
  planning: 0.88
  coding: 0.96
  repository_execution: 0.98
  terminal: 0.98
  computer_use: 0.2

grok_bot:
  browser: 0.98
  computer_use: 0.98
  saas_workflow: 0.98
  coding: 0.70

gpt:
  architecture: 0.98
  difficult_reasoning: 0.98
  review: 0.97

claude:
  architecture: 0.98
  large_codebase_review: 0.98
  adversarial_review: 0.96

gemini:
  huge_context: 0.98
  multimodal_analysis: 0.97
  independent_review: 0.93
```

Those numbers should eventually be learned from evaluations rather than manually maintained.

---

# 9. Route by Work Type

Initial routing policy:

| Work | Primary | Secondary |
|---|---|---|
| Classification | DeepSeek | Gemini |
| Mission compilation | DeepSeek | GPT |
| Cheap reasoning | DeepSeek | Grok API |
| Bulk work | DeepSeek | local |
| Repository exploration | Grok Build | Claude |
| Coding | Grok Build | Codex/Claude |
| Debugging | Grok Build | Codex |
| Testing | Grok Build | local runner |
| Browser SaaS | Grok Bot | computer-use agent |
| Persistent operations | Grok Bot | dedicated worker |
| Architecture | GPT/Claude | Gemini |
| Critical review | different provider | GPT/Claude |
| Huge context | Gemini | Claude |
| Final cheap critic | DeepSeek | Grok |
| High-risk verification | GPT + Claude | human |

The key rule:

> **Generator and judge should preferably be different model families.**

If Grok writes the implementation, don't let Grok be the sole authority deciding Grok did a brilliant job.

---

# 10. Grok Build ACP Runtime

This is the crown jewel.

Run:

```powershell
grok agent stdio
```

Grok exposes ACP over stdin/stdout using JSON-RPC. The documented sequence includes `initialize`, `authenticate`, `session/new`, `session/prompt`, while streamed assistant content arrives through `session/update`. citeturn621546view0

KernelJSON:

```text
Worker Runtime
      │
      ▼
spawn(grok agent stdio)
      │
      ▼
ACPClient
      │
      ├── initialize
      ├── authenticate
      ├── session/new
      ├── session/prompt
      │
      ◄── session/update
      │
      ▼
Evidence Adapter
```

Create:

```text
runtimes/grok-build/
├── src/
│   ├── index.ts
│   ├── runtime.ts
│   ├── acp-client.ts
│   ├── session-manager.ts
│   ├── event-parser.ts
│   ├── permission-adapter.ts
│   ├── evidence-adapter.ts
│   └── errors.ts
├── tests/
└── README.md
```

---

# 11. ACP Session Manager

Never treat every turn as stateless.

Map:

```text
KernelJSON task
     ↓
execution
     ↓
ACP session
```

Store:

```ts
interface AgentSession {
  executionId: string;
  runtime: "grok-build";
  providerSessionId: string;
  cwd: string;

  createdAt: string;
  updatedAt: string;

  status:
    | "initialising"
    | "working"
    | "waiting_approval"
    | "completed"
    | "failed"
    | "cancelled";
}
```

That allows:

```text
execute
pause
review
critic finds issue
resume Grok session
repair
verify again
```

rather than restarting from zero.

---

# 12. Mission Packet Generator

DeepSeek should convert the compiled mission into an executor-specific prompt.

Create:

```text
services/kernel/src/compiler/adapters/
    grok-build-compiler.ts
    grok-bot-compiler.ts
    deepseek-compiler.ts
    openai-compiler.ts
```

Grok Build receives something like:

```text
MISSION ID
KJ-2026-000482

OUTCOME
Implement the requested authentication fix.

WORKSPACE
C:\repos\biz-os

AUTHORITATIVE SOURCES
- repository
- current tests
- architecture documentation

PERMITTED
- inspect files
- modify repository
- install non-destructive development dependencies
- execute tests
- create regression tests

PROHIBITED
- production deployment
- production database writes
- deleting production resources
- changing credentials

WORKFLOW
1. reproduce
2. identify root cause
3. implement minimal robust repair
4. add regression coverage
5. execute relevant tests
6. inspect resulting diff
7. report evidence

COMPLETION REQUIRES
- root cause identified
- defect no longer reproducible
- regression test
- existing tests passing
- changed files listed

IF BLOCKED
Return BLOCKED plus:
- blocker
- evidence
- required authority

DO NOT CLAIM SUCCESS WITHOUT EVIDENCE.
```

That last sentence is important.

---

# 13. Evidence-Bound Completion

This aligns perfectly with KernelJSON.

No runtime may simply return:

```text
Done!
```

Completion requires evidence objects.

```ts
interface Evidence {
  id: string;

  type:
    | "command"
    | "test"
    | "diff"
    | "file"
    | "screenshot"
    | "url"
    | "log"
    | "artifact"
    | "human_confirmation";

  source: string;

  timestamp: string;

  contentHash?: string;

  payload: unknown;
}
```

Example:

```json
{
  "type": "test",
  "source": "grok-build",
  "payload": {
    "command": "pnpm test auth",
    "exitCode": 0,
    "passed": 18,
    "failed": 0
  }
}
```

---

# 14. Outcome Contract

Executors don't determine ultimate success.

They submit an outcome candidate:

```ts
interface OutcomeCandidate {
  executionId: string;

  claimedStatus:
    | "completed"
    | "partial"
    | "blocked"
    | "failed";

  summary: string;

  evidenceIds: string[];

  changedResources: ResourceMutation[];

  unresolvedRisks: Risk[];

  recommendedNextAction?: string;
}
```

The evaluator decides whether KernelJSON accepts it.

---

# 15. Evaluator

Flow:

```text
Grok Build
   │
   ▼
Outcome Candidate
   │
   ▼
Deterministic Verification
   │
   ├── tests?
   ├── exit codes?
   ├── files exist?
   ├── git diff?
   ├── schema validation?
   │
   ▼
DeepSeek Critic
   │
   ▼
Risk?
 ┌─┴────────────┐
 │              │
low            high
 │              │
PASS       Frontier Critic
                │
           GPT / Claude
```

This means the expensive reviewer is used only when necessary.

---

# 16. Repair Loop

The system should support:

```text
PLAN
  ↓
EXECUTE
  ↓
VERIFY
  ↓
FAIL
  ↓
DIAGNOSE
  ↓
REPAIR
  ↓
VERIFY
```

Example:

```text
Grok modifies 7 files.

DeepSeek critic detects missing null handling.

KernelJSON produces:

REPAIR REQUEST:
Verification V-293 failed.

Finding:
auth callback assumes account.user exists.

Evidence:
src/auth/callback.ts lines ...

Required:
handle missing user safely and add regression test.

Constraints:
do not rewrite existing authentication architecture.
```

Then resume the same Grok ACP session.

That will be dramatically cheaper than re-prompting an entire coding agent from scratch.

---

# 17. Budget Contracts

Every mission gets a compute budget.

```ts
interface BudgetPolicy {
  maxUsd?: number;

  maxTokens?: number;

  maxExecutions?: number;

  maxRepairLoops?: number;

  allowFrontierEscalation: boolean;

  preferredTier:
    | "local"
    | "cheap"
    | "standard"
    | "frontier";
}
```

Example:

```yaml
budget:
  max_usd: 1.50
  repair_loops: 3
  preferred_tier: cheap
  frontier_escalation: true
```

KernelJSON may decide:

```text
DeepSeek planner        $0.01
Grok implementation     $0.21
DeepSeek critic         $0.01
Grok repair             $0.08

TOTAL                    $0.31
```

Only then, if unresolved:

```text
Claude architecture review
```

---

# 18. Cost Ledger

Add:

```text
services/evaluator/src/cost/
packages/telemetry/src/cost/
```

Track:

```text
provider
model
mission
execution
input tokens
cached tokens
output tokens
estimated cost
wall-clock time
success/failure
repair count
```

Eventually calculate:

```text
£ per successful task
£ per accepted code change
tokens per verified outcome
repair loops per provider
failure rate
hallucinated completion rate
```

That's much more useful than just looking at API bills.

---

# 19. Learned Routing

At first routing is configured.

Eventually KernelJSON learns:

```text
Grok solves TypeScript auth bugs:
91% first-pass acceptance

DeepSeek:
67%

Claude:
94%

Cost:
Grok £0.19
DeepSeek £0.04
Claude £1.31
```

Router conclusion:

```text
Use Grok first.
Escalate to Claude after Grok fails twice.
```

That's the system beginning to optimise its own intelligence procurement.

---

# 20. Risk Levels

Define:

```text
R0 = read-only
R1 = reversible local mutation
R2 = repository mutation
R3 = external system write
R4 = production modification
R5 = financial/legal/security-critical
```

Example authority:

```text
DeepSeek:
R0

Grok Build:
R0-R2

Grok Bot:
R0-R2 automatically
R3 with policy
R4 approval
R5 explicit human approval

Frontier reasoning:
any analysis
no direct execution authority
```

Model intelligence and execution authority should remain separate concepts.

---

# 21. Approval Gateway

Create:

```text
services/policy/src/approval-gateway.ts
```

Actions requiring approval initially:

```text
production deployment
production DB migration
production data mutation
secret modification
permission changes
sending email
sending messages
publishing
purchasing
financial transactions
deletion of cloud resources
domain/DNS changes
legal acceptance
```

Grok Bot's own documentation recommends explicit approval boundaries for actions such as messages, purchases, deletion, permission changes and production changes. citeturn341279search0

KernelJSON should enforce its **own policy layer as well**.

Never rely solely on provider safety controls.

---

# 22. Secrets

Critical rule:

```text
AGENT ≠ SECRET OWNER
```

Agents request capabilities.

jVault issues scoped credentials.

Example:

```text
Grok requests:

capability:
  supabase.schema.read

Kernel policy checks mission.

jVault issues:
  temporary scoped credential

Worker executes.

Credential expires.
```

Not:

```text
Here's my entire .env file, mate.
```

This becomes particularly important for Grok Bot because all Bots on one account share the same persistent cloud computer, including files/browser sessions/logins. citeturn280270search0

---

# 23. Grok Bot Architecture

Treat Bot as an **external persistent worker**.

```text
KernelJSON
     │
     ▼
Bot Dispatch Queue
     │
     ▼
GrokBotBridge
     │
     ▼
Persistent Grok Bot
     │
     ├── browser
     ├── terminal
     ├── SaaS
     ├── connectors
     └── other Bots
```

Possible worker identities:

```text
release-operator
qa-operator
research-operator
product-operator
devops-operator
business-operator
```

Do not create 95 Grok Bots.

Start with five or six broad operational ownership domains.

---

# 24. Grok Bot Skills

Use KernelJSON tasks to discover useful repeatable skills.

Pattern:

```text
Mission
   ↓
successful Bot execution
   ↓
review
   ↓
stable procedure?
   ↓ yes
Bot Skill
   ↓
tested again
   ↓
Routine
```

This is also the workflow Grok Bot's documentation recommends: perform the task, save the working method as a skill, test it, then turn it into a routine. citeturn341279search1

---

# 25. Example Grok Bot: Release Operator

Bot definition:

```text
ROLE
Release Operator

OWNS
Post-build release verification.

RESPONSIBILITIES
- inspect GitHub
- inspect CI
- inspect hosting
- inspect Supabase migration state
- inspect application health
- perform smoke tests
- gather evidence

MAY
- read production configuration
- execute non-destructive tests
- create reports
- open GitHub issues

MUST APPROVE
- deployments
- migration execution
- production writes
- secrets
- DNS
- deleting resources

OUTPUT
Structured release evidence package.
```

---

# 26. DeepSeek → Grok Prompting

Your DeepSeek agents should have a specialised role:

```text
Executor Prompt Engineer
```

Its job:

```text
INPUT:
KernelJSON CompiledMission

OUTPUT:
Executor-specific mission packet
```

It must:

```text
remove irrelevant context
preserve constraints
translate abstractions into concrete actions
specify verification
define completion
define escalation
avoid prescribing unnecessary implementation
```

This is where your original idea becomes powerful:

> agents prompting agents to prompt Grok to do what Grok does best.

Exactly.

---

# 27. Context Optimisation

Do not dump repositories into Grok.

Use:

```text
Context Selector
```

Pipeline:

```text
mission
 ↓
DeepSeek repo mapper
 ↓
likely relevant modules
 ↓
RAG/search
 ↓
minimal context package
 ↓
Grok
```

Then Grok has filesystem access anyway and can inspect further.

The mission packet should tell it **where to start**, not attempt to teach it the entire repository.

---

# 28. Model Council

For difficult work:

```text
Planner       DeepSeek
Architect     GPT
Executor      Grok Build
Critic A      DeepSeek
Critic B      Claude
Tie-breaker   Gemini
```

But only invoke the council when required.

Most tasks should remain:

```text
DeepSeek
   ↓
Grok
   ↓
DeepSeek
```

Cheap.

Fast.

Verified.

---

# 29. Confidence-Based Escalation

Every evaluation outputs:

```json
{
  "accept": false,
  "confidence": 0.74,
  "severity": "medium",
  "reason": "Implementation works but migration safety is uncertain."
}
```

Policy:

```text
confidence >= .90
AND low risk
→ complete

.70-.90
→ alternate cheap critic

< .70
→ frontier review

high risk
→ frontier review regardless

critical
→ human
```

---

# 30. Provider Failure Handling

Example:

```text
Grok unavailable
      ↓
router checks compatible runtime
      ↓
Codex
      ↓
Claude Code
      ↓
DeepSeek coding
```

KernelJSON task execution shouldn't care which provider won.

The contract remains identical.

---

# 31. Runtime Registry

Create:

```yaml
runtimes:

  deepseek:
    enabled: true
    type: model
    tier: cheap

  grok-build:
    enabled: true
    type: acp
    executable: grok
    tier: standard

  grok-bot:
    enabled: true
    type: external_worker
    tier: standard

  openai:
    enabled: true
    type: api
    tier: frontier

  anthropic:
    enabled: true
    type: api
    tier: frontier

  gemini:
    enabled: true
    type: api
    tier: frontier
```

---

# 32. Suggested KernelJSON Additions

Your current architecture already has the right places for most of this.

Add roughly:

```text
packages/
└── contracts/
    └── src/
        ├── mission.ts
        ├── runtime.ts
        ├── execution.ts
        ├── evidence.ts
        ├── approval.ts
        └── budget.ts

services/
├── kernel/
│   └── src/
│       ├── compiler/
│       │   ├── mission-compiler.ts
│       │   └── adapters/
│       ├── router/
│       │   ├── capability-router.ts
│       │   ├── cost-router.ts
│       │   ├── risk-router.ts
│       │   └── router.ts
│       └── execution/
│           ├── dispatcher.ts
│           └── repair-loop.ts
│
├── policy/
│   └── src/
│       ├── authority.ts
│       ├── approval-gateway.ts
│       └── secret-policy.ts
│
└── evaluator/
    └── src/
        ├── verifier.ts
        ├── critic.ts
        ├── outcome-evaluator.ts
        └── cost-evaluator.ts

runtimes/
├── worker/
├── sandbox/
│
├── grok-build/
│   └── src/
│       ├── runtime.ts
│       ├── acp-client.ts
│       ├── session-manager.ts
│       ├── event-parser.ts
│       └── evidence-adapter.ts
│
└── grok-bot/
    └── src/
        ├── bridge.ts
        ├── dispatcher.ts
        └── status-adapter.ts

packages/
└── models/
    └── src/providers/
        ├── deepseek.ts
        ├── xai.ts
        ├── openai.ts
        ├── anthropic.ts
        └── gemini.ts
```

---

# 33. Database

Suggested tables:

```text
missions
executions
execution_events
runtime_sessions
runtime_profiles
runtime_scores
evidence
verification_results
approval_requests
approval_decisions
provider_usage
provider_costs
routing_decisions
repair_cycles
outcomes
```

Potential learning tables:

```text
runtime_task_performance
runtime_failure_patterns
runtime_cost_statistics
runtime_latency_statistics
critic_accuracy
routing_experiments
```

---

# 34. Execution State Machine

```text
CREATED
   ↓
COMPILED
   ↓
PLANNED
   ↓
ROUTED
   ↓
DISPATCHED
   ↓
RUNNING
   │
   ├────► AWAITING_APPROVAL
   │            │
   │            ▼
   │          RUNNING
   │
   ▼
VERIFYING
   │
   ├────► REPAIR_REQUIRED
   │            │
   │            ▼
   │          RUNNING
   │
   ├────► ESCALATED
   │
   └────► COMPLETED

or

BLOCKED
FAILED
CANCELLED
```

Every transition should be durable.

---

# 35. First Vertical Slice

Do **not** initially build the whole cathedral.

Prove:

```text
User
 ↓
Kernel task
 ↓
DeepSeek compiler
 ↓
Grok ACP
 ↓
repo modification
 ↓
test
 ↓
DeepSeek critic
 ↓
accepted outcome
```

Use one harmless test repository.

Example mission:

```text
Add a /health endpoint returning:
status
version
timestamp

Add tests.
Do not deploy.
```

Success criteria:

```text
mission compiles
Grok starts through ACP
files change
tests execute
events stream into KernelJSON
evidence recorded
DeepSeek evaluates result
task reaches COMPLETE
```

If this works, you've proven the architecture.

---

# 36. Phase Plan

## Phase 1: Contracts

Build:

```text
Mission
Runtime
Execution
Evidence
Outcome
Approval
Budget
```

No AI.

Unit tests only.

---

## Phase 2: Grok ACP Spike

Implement:

```text
spawn grok agent stdio
initialize
authenticate
session/new
session/prompt
capture session/update
shutdown
```

Do nothing sophisticated.

Just prove:

```text
KernelJSON → Grok → response
```

---

## Phase 3: GrokBuildRuntime

Add:

```text
workspace handling
session persistence
timeouts
cancel
structured events
errors
evidence collection
```

---

## Phase 4: Mission Compiler

DeepSeek converts user tasks into `CompiledMission`.

Validate using JSON schema/Zod.

AI output never enters execution unvalidated.

---

## Phase 5: Router v1

Rules only:

```text
reasoning → DeepSeek

coding → Grok Build

browser/computer → Grok Bot

architecture → GPT/Claude
```

No machine learning yet.

---

## Phase 6: Verification

Implement deterministic checks:

```text
commands
tests
files
git status
git diff
schema validation
```

---

## Phase 7: DeepSeek Critic

DeepSeek reviews:

```text
mission
plan
changes
evidence
```

Returns strict JSON.

---

## Phase 8: Repair Loop

Critic failure resumes Grok session.

Cap at:

```text
3 attempts
```

then escalate.

---

## Phase 9: Frontier Escalation

Add:

```text
OpenAI
Anthropic
Gemini
```

as reviewer/router targets.

---

## Phase 10: Cost Telemetry

Track everything.

Begin comparing:

```text
cost
success
latency
repairs
```

---

## Phase 11: Grok Bot Bridge

Only now integrate persistent computer workers.

Start with:

```text
QA Operator
```

because QA is valuable but relatively safe.

---

## Phase 12: Learned Routing

Use your own execution history to dynamically select providers.

KernelJSON starts learning:

> Which AI should do which task for Jonny's actual systems?

Not benchmark leaderboards.

Your workload.

---

# 37. Critical Design Decision

I would **not build "agents" into the centre of KernelJSON**.

Keep your ADR:

```text
Tasks, not agents.
```

Correct.

A Grok Bot may look like an agent.

DeepSeek may run an agent.

Claude may run an agent.

KernelJSON shouldn't care.

KernelJSON owns:

```text
task
authority
state
routing
evidence
outcome
```

Providers own:

```text
execution intelligence
```

That distinction prevents you rebuilding another Antigravity Orchestra with increasingly elaborate agent personalities.

---

# 38. Final System

Eventually:

```text
                         KERNELJSON

             ┌────────────────────────────┐
             │     Durable Task Kernel    │
             └──────────────┬─────────────┘
                            │
           ┌────────────────┼──────────────────┐
           │                │                  │
           ▼                ▼                  ▼
      INTELLIGENCE      EXECUTION          COMPUTER
           │                │                  │
      DeepSeek          Grok Build          Grok Bot
      GPT               Codex               Browser agents
      Claude            Claude Code         Human
      Gemini            Local runtime
      Grok API
           │                │                  │
           └────────────────┼──────────────────┘
                            │
                            ▼
                     Evidence System
                            │
                            ▼
                     Policy / jVault
                            │
                            ▼
                       Evaluator
                            │
                            ▼
                       World Model
                            │
                            ▼
                     VERIFIED OUTCOME
```

KernelJSON becomes the **kernel**.

DeepSeek is cheap cognitive compute.

Grok Build is an execution engine.

Grok Bot is a persistent digital operator.

Codex/Claude Code are interchangeable execution engines.

GPT/Claude/Gemini are escalation intelligence.

jVault controls authority.

The evaluator decides truth.

The world model remembers what actually happened.

That is significantly more interesting than another multi-agent orchestration framework.

It is closer to an **AI operating layer that purchases intelligence and execution dynamically according to capability, cost, risk and historical performance.**