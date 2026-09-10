# SYSTEM HANDOVER FOR EXTERNAL ARCHITECT

**Evidence scope:** read-only synthesis of every evidence file supplied under `/workspace/arch-discovery/`.
**Evidence date:** 7 September 2026. **Language:** UK English.

## Status vocabulary

- **IMPLEMENTED**: present in the supplied code or SQL evidence.
- **DOCUMENTED**: asserted by an evidence document, without the supplied artefact proving live deployment.
- **PLANNED**: design or intended future work.
- **INFERRED**: a reasoned conclusion from the evidence, not a direct runtime proof.
- **UNVERIFIED**: the evidence is absent, contradictory, stale, or explicitly awaiting verification.

# Consolidated handover

## 1. Executive position

**DOCUMENTED / IMPLEMENTED:** There are three materially different bodies of work and they must not be collapsed into one architecture:

1. **LIVE estate:** AgentHub, OpenClaw, the Conductor, jai-os, Orchestra/persona skills, Mission Control, n8n and the Shared Brain. This is the current operating estate on one GCP VM, with laptop/desktop repositories and DSH as development or interactive surfaces.
2. **new-system clean room:** the registry-v2/new-system design and skill/MCP foundation intended to replace jai-os and the Orchestra incrementally. Its 224-skill registry is built, but the full Agent Spawner runtime remains described as a critical gap. A `spawner_run` Conductor tool exists and calls port `8766`, but that does not by itself prove the complete runtime is deployed.
3. **KernelJSON:** a separate project, in Supabase project `banqdzddfganzfhckdps`, using Restate and its own task/evidence model. It is in phase 15 and is **not yet the live estate orchestrator or control plane**.

**DOCUMENTED:** The intended new-system direction is a thin, ephemeral worker model: skills are the primitive; a dispatcher assembles only the skills and tools needed for a task; execution is sandboxed; evidence is verified; a learning is written back; the worker retires. The supplied evidence does not establish that the complete runtime exists in production.

## 2. Current live topology

**DOCUMENTED (NOTES_FROM_INDEX.md, PARTIAL_FROM_EXECUTORS.md):** The live estate is described as one GCP VM:

- Instance: `instance-20260717-082134`
- Public address: `136.112.138.225`
- GCP project: `project-d58d4a53-a63b-45a0-818`

**DOCUMENTED service and port inventory:**

| Service | Port / transport | Public or local surface | Status |
|---|---:|---|---|
| BizOS shell | `:3100` | `bizos.jonnyai.co.uk` | DOCUMENTED live |
| Mission Control | `:3200` | `control.jonnyai.co.uk` | DOCUMENTED live |
| Conductor MCP remote | `:8790` | private behind Caddy | DOCUMENTED live; exact host-side process still needs a runtime check |
| jai-os API | `:8765` | `jaios.jonnyai.co.uk` | DOCUMENTED live |
| n8n | `:5678` | `n8n.jonnyai.co.uk` | DOCUMENTED live, Docker |
| OpenClaw gateway for Marcus | `127.0.0.1:18789` | Telegram bot | DOCUMENTED live |
| DSH web | `127.0.0.1:3080` | loopback only | DOCUMENTED live |
| Caddy | `:80`, `:443` | TLS ingress | DOCUMENTED live |
| Possible Agent Spawner | `:8766` | local URL used by `spawner_run` | UNVERIFIED and conflicted in documentation |

**INFERRED:** Caddy is the external TLS boundary for the VM; internal services should not be treated as independently public merely because they have a port. The supplied files do not include Caddy configuration or a live socket check.

```text
                         Internet / Telegram
                                |
                         Caddy :80/:443
                                |
        +-----------------------+-----------------------+
        |                       |                       |
   BizOS :3100          Mission Control :3200     Conductor :8790
   (public DNS)         (public DNS)               private / OAuth
                                                        |
                 +------------------------------+-------+----------------+
                 |                              |                        |
          OpenClaw :18789                 jai-os :8765             DSH :3080
          loopback, Marcus                public API                loopback
                 |                              |
                 +--------------+---------------+
                                |
                       Shared Brain Supabase
                       ref lkwydqtfbdjhxaarelaz
                                |
                              n8n :5678
```

## 3. Conductor is the present integration boundary

**IMPLEMENTED:** `/workspace/arch-discovery/conductor-server.py` contains the stdio MCP server. Its authoritative `TOOLS` dictionary is at `conductor-server.py:2506`, and JSON-RPC tool enumeration is at `:2914`. It registers **17 tools**, not 16:

1. `boardroom_read_protocol`
2. `boardroom_tail_chatroom`
3. `boardroom_post_dsp`
4. `orchestra_list_handles`
5. `orchestra_load_skill`
6. `orchestra_save_skill`
7. `github_repo_summary`
8. `matrix_route`
9. `route_task`
10. `brain_query_projects`
11. `spawner_run`
12. `jaios_run`
13. `marcus_chat`
14. `marcus_session_chat`
15. `brain_log_learning`
16. `telegram_send`
17. `cloud_escalate`

`tool_cloud_quote` is implemented in `conductor-server.py:1930` but is **not registered** in the stdio `TOOLS` dictionary. That is an important distinction between code presence and callable MCP surface.

**IMPLEMENTED:** The stdio server uses JSON-RPC over stdio, with a worker queue and 2-4 worker threads (`conductor-server.py:2983`). It has no durable task IDs, queue API, cancel API, retry API or completion state machine in the supplied Conductor server. Long-running work is delegated to external services or local subprocess/HTTP calls.

**IMPLEMENTED / DOCUMENTED:** Two HTTP surfaces exist:

- **Local Conductor API:** `/workspace/arch-discovery/api_main.py` defines FastAPI on `127.0.0.1:8787`. It exposes `GET /health`, `/matrix/{domain}`, `/orchestra/handles`, `/orchestra/skill/{handle}`, `/boardroom/protocol`, `/boardroom/chatroom`, `/brain/projects`, and `POST /boardroom/dsp`, `/route`, `/delegate`, `/jaios/run`. It does not define `/tasks`, `/status`, `/approve`, `/retry`, `/complete` or `/escalate`.
- **Remote streamable HTTP MCP:** `/workspace/arch-discovery/server_http.py` defaults to host `0.0.0.0`, port `8790`, and creates a `FastMCP` named `conductor-mcp` with OAuth settings. `MCP_BEARER_TOKEN` and `MCP_PUBLIC_URL` are required. The remote wrapper deliberately omits Hermes-dependent `marcus_chat` and `telegram_send`, while reusing the stdio server's tool logic. It also adds loopback-only Mission Control adapter routes. The VM inventory calls this service `conductor-mcp :8790` behind Caddy.

```text
OpenClaw / Claude Code / local MCP client
                 |
        JSON-RPC stdio server
        conductor-server.py
          17 registered tools
                 |
        +--------+---------+
        |                  |
  FastAPI :8787       streamable HTTP :8790
  local API           OAuth / Caddy surface
        |                  |
        +--------+---------+
                 |
       Shared tool implementation
       Boardroom, Brain, routing,
       jai-os, Spawner, cloud paths
```

**DOCUMENTED / INFERRED:** The Conductor is an external orchestrator only **PARTIALLY**. It can dispatch via `jaios_run`, `spawner_run` and the remote MCP/HTTP surfaces, but the supplied implementation does not provide a durable end-to-end task lifecycle. Completion is an external convention, including DSP `DONE`; execution state is held by OpenClaw, jai-os, Spawner or other external services.

## 4. Shared Brain and Mission Control data boundary

**DOCUMENTED / IMPLEMENTED:** The estate's durable memory source of truth is the Shared Brain Supabase project ref `lkwydqtfbdjhxaarelaz`, also named in `memory-README.md` and `shared-brain-SKILL.md`. The supplied Conductor code explicitly queries or writes these Brain tables:

- `projects`
- `agents`
- `learnings`
- `chatroom`
- `actions_open`

`actions_open` is an explicit-only action ledger view/table in `conductor-server.py:BRAIN_TABLES`; it is excluded from the default all-table query and requested by name. The code uses named columns, caps and pagination rather than `select=*`. Learnings are inserted with `verified=false`; promotion is a separate review operation.

**IMPLEMENTED / DOCUMENTED:** Boardroom DSP posts are intended to dual-write to local `chatroom.md` and Brain `chatroom`. A local-only result is explicitly reported as `[PARTIAL]`. Long-term memory is not the local `memory/` folder, which is only an index/pointer area.

**IMPLEMENTED in supplied SQL, status not proven applied:** Mission Control migrations define `mc_*` tables in the same public database namespace, including:

- `mc_admins`
- `mc_persona_sessions`
- `mc_settings`
- `mc_cost_reservations`
- `mc_cost_events`
- `mc_persona_messages`
- `mc_learning_reviews`
- `mc_audit_log`
- `mc_boards`
- `mc_cards`

`mc_foundation.sql` explicitly says the migration is intentionally unapplied and requires disposable-branch testing first. `mc_kanban.sql` adds DB-backed boards and cards. Both use RLS and narrow admin-checked RPCs such as `mc_read_projects()`, `mc_read_agents()`, `mc_read_boardroom(...)`, `mc_read_pending_learnings(...)`, `mc_review_learning(...)`, `mc_read_boards()`, `mc_read_board_cards(...)`, `mc_create_board(...)`, `mc_create_card(...)`, `mc_update_card(...)` and `mc_move_card(...)`.

```text
                         Shared Brain
              Supabase ref lkwydqtfbdjhxaarelaz
                                |
       +------------------------+------------------------+
       |                        |                        |
  estate tables             MC foundation             MC kanban
 projects                   mc_* tables               mc_boards/cards
 agents                     admin/RLS/RPCs             admin/RLS/RPCs
 learnings
 chatroom
 actions_open
```

**UNVERIFIED:** The files do not prove which `mc_*` migrations have been applied to the live Brain project. Treat the SQL as an implementation proposal/migration artefact, not as a live-schema assertion.

## 5. Authority and operating rules

**DOCUMENTED:** `GROUND_RULES.md` and `routing.json` make the following authority claims:

- Keith is the human front man and day-to-day director.
- Marcus plans, delegates and reports.
- Jonny retains gates for money, production go-lives, client/third-party sends and emergency security/legal/data-loss decisions.
- Escalation is agent -> `@marcus` -> `@keith` -> Jonny.
- Orchestra personas decide, brief and gate; jai-os modules execute.
- Quality gate sign-off is persona-only.
- Long-term memory is Shared Brain.
- `registry/routing.json` is the routing source of truth; `routing_controller.py` classifies free text to a domain by keyword score and then returns Orchestra handles, jai-os modules and model tier.
- Human gates are intended to be graph interrupt nodes, not merely prompt text.

**IMPLEMENTED:** `routing_controller.py:classify_domain()` is deterministic substring keyword scoring with insertion-order tie behaviour. `route()` supports explicit domain matching and classified free text. `api_main.py:/route` uses it directly.

**AUTHORITY CONFLICTS, DOCUMENTED in `CONDUCTOR_DEEP_DIVE.md`:**

1. `/delegate` documentation says it uses `routing_controller`, while the supplied code's endpoint independently scans keywords and builds a multi-domain plan.
2. Keith is the documented front man, while `SOUL` material is described as making Marcus the only conversation partner.
3. README material says OpenClaw is current, while the Conductor still starts or calls Hermes paths.
4. OpenRouter is retired in operating documents, while `cloud_escalate` still calls the OpenRouter path and the Mission Control SQL contains OpenRouter cost controls.
5. Some catalogue documents say 16 Conductor tools; the authoritative supplied `TOOLS` dict has 17.
6. `mcp.yaml` has empty `allow_tools` and `deny_tools` arrays; the deep dive says these scopes are not enforced by the Conductor.
7. Human gates are documented but not enforced centrally in the supplied Conductor.
8. The supplied evidence names both an OpenClaw front and multiple possible control surfaces: Conductor, jai-os, Mission Control, n8n, Brain and the future registry-v2 Spawner.

**ARCHITECT'S INTERPRETATION:** These are not cosmetic documentation differences. They are unresolved authority boundaries. Before migration, define one owner for task admission, routing, capability selection, approvals, execution state, completion evidence, retry/cancellation and external side effects.

## 6. Model and DSH configuration

**IMPLEMENTED / DOCUMENTED:** `/workspace/arch-discovery/dsh-settings.yaml` states:

- provider: `deepseek-official`
- model: `deepseek-v4-pro`
- reasoning effort: `high`
- `permission.defaultPreset: danger-full-access`
- `agent-presets.default: keith`

**DOCUMENTED:** DSH web is loopback `127.0.0.1:3080` on the VM. The separate DeepSeek VM is **UNVERIFIED**. A generic execution provider is **PARTIALLY** evidenced, not proven as a single production abstraction.

**DOCUMENTED:** The live estate model direction is direct DeepSeek, with v4-flash for phone/cron/classification/drafts and v4-pro for architecture/audits/client copy; Ollama is described as a fallback. The DSH settings specifically confirm the default interactive model as DeepSeek v4 Pro.

**RISK:** `danger-full-access` is a DSH default permission preset, not proof of a safe runtime policy. The new-system blueprint separately requires a deterministic guardian pre-gate and sandbox execution.

## 7. new-system clean room

**DOCUMENTED / IMPLEMENTED:** `/workspace/arch-discovery/BLUEPRINT.md` is marked canonical for the new-system design. It says registry-v2 contains **224 skills**, validator-green, with ten DSH-native always-live skills and 214 on-demand. `/workspace/arch-discovery/LIVE_SKILLS.md` names the ten live skills:

`boardroom-dsp`, `shared-brain`, `jvault`, `skill-writer`, `skill-creator`, `skill-supply-chain-vetting`, `mcp-builder`, `mason`, `riskguard`, `syncmaster`.

The live mount is described as Windows junctions from `.dsh/skills/` to `registry-v2/skills/`, preserving one write path. Conductor `orchestra_load_skill` prefers `registry-v2/skills` over the legacy Orchestra path when available.

**DOCUMENTED:** The clean-room objective is to replace jai-os and the Orchestra, not extend their roster. OpenClaw remains the messaging and dispatch front; a dedicated slim worker-runtime service on the VM is the intended Spawner host.

**PLANNED / SPEC ONLY:** The full Agent Spawner is described as the critical gap. The intended flow is brief -> worker assembly -> identity/model/tools/skills/memory retrieval -> guardian pre-gate -> sandboxed execution -> evidence/verification -> one DONE DSP and one learning -> retirement.

**IMPLEMENTED code path, UNVERIFIED deployment:** `conductor-server.py:tool_spawner_run()` posts to `SPAWNER_URL`, default `http://127.0.0.1:8766`, at `/api/v1/spawn`. Its description claims dynamic skill mounting, pre-gates, sandbox and automatic teardown. The function's existence proves only the adapter, not the daemon or the whole runtime.

**DOCUMENTATION CONFLICT:** The supplied steering evidence reports that a `BUILD_PLAN` claims PM2 `:8766` is live, while `BLUEPRINT.md` says “Agent Spawner SPEC ONLY”. `BUILD_PLAN` is not present in the supplied `/workspace/arch-discovery/` directory, and no health or process evidence is present. Therefore the `:8766` daemon is **UNVERIFIED**, and the conflict must be resolved by checking the VM process, route and a real end-to-end spawn.

**MCP catalogue discrepancy:**

- `NOTES_FROM_INDEX.md` and `PARTIAL_FROM_EXECUTORS.md` document approximately 42 MCP IDs for new-system.
- `newsys-mcp.yaml` contains a `servers` section with approximately 28 rows, plus a separate research `candidates` section headed as 20 candidates. Counting both sections gives approximately 48 catalogue rows, but candidates are not necessarily wired servers.
- `mcp.yaml` is runtime wiring and contains a materially smaller enabled/staged set than the whole catalogue.
- Therefore “42”, “42-51”, “28 wired”, and “48 including candidates” refer to different or drifting populations. This is **DOCUMENTED conflict / UNVERIFIED exact inventory**, not a reason to invent a canonical count.

**Additional drift:** the steering evidence reports registry 224 skills versus Brain 169, while other documents record Brain learnings as 181 and 34 ever applied. These are different concepts and must not be conflated. The Brain count is **UNVERIFIED as a current live query** in this evidence set.

```text
                         OpenClaw / Keith
                              |
                         dispatch front
                              |
                   +----------+----------+
                   |                     |
             registry-v2             Shared Brain
             224 skills              retrieval/writeback
                   |                     |
             Agent Spawner ?             |
                   |                     |
          guardian + sandbox + worker + evidence
                   |
              retire worker

          ? = complete runtime not proven live
```

## 8. KernelJSON, deliberately separate

**IMPLEMENTED / DOCUMENTED in `kernel-STATE.yaml`:** KernelJSON is repository `jonnyallum/kerneljson`, branch `codex/phase-15`, version `0.0.1`, state `phase_15_in_progress`, and Supabase ref `banqdzddfganzfhckdps`. Its durable execution provider is Restate. It has a DeepSeek adapter marked live-verified, deterministic capability registry and durable receipts, and a list of implemented phases covering task lifecycle, model receipts, capability invocation, default-deny policy, human approvals, evidence verification, memory provenance, Mission Control controls and bounded scheduling.

**IMPLEMENTED in supplied KernelJSON SQL/design:**

- `public.task_status` enum: `RECEIVED`, `COMPILED`, `READY`, `RUNNING`, `WAITING`, `APPROVAL_REQUIRED`, `VERIFYING`, `COMPLETED`, `FAILED`, `CANCELLED`.
- `tasks`, `task_steps`, `task_events`, `evidence`, `approvals`, `artifacts` tables.
- Immutable ledger/evidence triggers and idempotency constraints.
- Evidence requirement before completion and RLS/revocation controls.
- `memory_items` immutability in `kj_memory_provenance.sql`.

**DOCUMENTED:** KernelJSON phase 15 is incomplete. The state file says phase 15 unit tests, recovery tests, typecheck and build passed, but `phase_complete: false`; remaining work includes stronger child-evidence verification, a negative database test and the full regression/review. Remote migrations were not pushed, remote dry run was not executed and the full Supabase local stack was not tested.

**BOUNDARY:** KernelJSON is an architectural candidate/separate project, not the live AgentHub/OpenClaw/Conductor orchestrator. Do not use its task enum or Restate workflow as evidence that the live estate has durable task state.

```text
 LIVE estate                         KernelJSON project
 ----------------                    ------------------
 OpenClaw + Conductor                Restate workflow
 jai-os + Orchestra                  Supabase banqdzddfganzfhckdps
 Brain lkwydqtfbdjhxaarelaz           tasks/events/evidence/approvals
 no central durable task API proven   phase 15, incomplete
              X  not the same control plane  X
```

## 9. Migration position

**DOCUMENTED:** Hermes -> OpenClaw migration for Marcus occurred on 1 September 2026. OpenClaw is the intended single messaging gateway; laptop Hermes was disabled, not deleted. The no-second-poller rule remains to be enforced.

**DOCUMENTED:** OpenRouter is retired in the estate documentation and should not be used as the normal model route. **IMPLEMENTED but conflicting:** `cloud_escalate` still supports OpenRouter aliases and requires `OPENROUTER_API_KEY` plus a separate spend approval path. The Mission Control SQL also contains OpenRouter-specific cost reservation functions. Treat those paths as legacy/high-risk until explicitly retired or re-authorised.

**DOCUMENTED:** jai-os and Orchestra personas are still live pending retirement. Migration is draft and gated on a replacement runtime, consumer map, negative-cased cutover with rollback and Jonny approval. Disable rather than delete.

## 10. External architect's recommended control-plane decision

This is a handover of evidence, not a new implementation decision. The minimum decision set is:

1. **Choose one task authority.** If KernelJSON is selected, explicitly integrate it; otherwise do not imply that Conductor has its lifecycle.
2. **Choose one routing authority.** Continue with `registry/routing.json` plus `routing_controller.py`, and remove or reconcile the duplicate `/delegate` classifier.
3. **Choose one capability authority.** For new-system, that is registry-v2 plus the MCP catalogue. Define whether the legacy Conductor, jai-os MCPs and new-system catalogue are separate generations or one promoted catalogue.
4. **Prove Spawner status.** Inspect PM2/process health for `:8766`, exercise `/api/v1/spawn`, and capture evidence for a real skill-loaded, verified, retired worker.
5. **Define approval enforcement.** DSH `danger-full-access`, Conductor's weak central gates, Mission Control RLS/RPCs and any KernelJSON policy must not be treated as interchangeable.
6. **Reconcile model spend.** Decide whether OpenRouter is retired in code as well as documents; remove stale aliases, SQL and tool paths or record an explicit legacy exception.
7. **Make completion evidence durable.** DSP `DONE` is a coordination convention, not sufficient proof of an external side effect.

# Expanded technical detail

## A. Live estate components and responsibilities

| Component | Evidence | State | Responsibility / boundary |
|---|---|---|---|
| AgentHub | `NOTES_FROM_INDEX.md`, `PARTIAL_FROM_EXECUTORS.md` | DOCUMENTED | Desktop home for repos, registry, docs and Conductor source |
| OpenClaw | `BLUEPRINT.md`, `NOTES_FROM_INDEX.md` | DOCUMENTED live | Messaging gateway and Marcus front |
| Conductor stdio | `conductor-server.py` | IMPLEMENTED | MCP adapter for boardroom, Brain, routing, jai-os, Spawner and cloud paths |
| Conductor HTTP | `api_main.py`, `server_http.py` | IMPLEMENTED; deployment partly documented | Local FastAPI :8787 and remote OAuth streamable HTTP :8790 |
| Orchestra | `routing.json`, Conductor skill functions | DOCUMENTED live pending retirement | Persona handles and CARD/SKILL loading |
| jai-os | `jaios_run`, index notes | DOCUMENTED live pending retirement | Runtime role nodes/API at :8765 |
| Shared Brain | `memory-README.md`, Conductor code, SQL references | DOCUMENTED live | Durable estate memory and coordination data |
| Mission Control | VM notes, `mc_*.sql` | UI documented; migrations UNVERIFIED | Product/control surface, admin RPCs and proposed kanban/cost tables |
| n8n | VM notes | DOCUMENTED live | Workflow automation at :5678 |
| DSH | `dsh-settings.yaml`, `LIVE_SKILLS.md` | DOCUMENTED live | Interactive desk, DeepSeek configuration and ten mounted skills |
| Hermes | migration notes and Conductor subprocess paths | RETIRED as front, residual code live | Legacy Marcus subprocess dependency; must be removed or quarantined |

## B. Conductor call paths

**IMPLEMENTED:**

- `boardroom_post_dsp()` validates DSP type, summary, handle, mission and layer; GATE posts from jai-os are rejected.
- `tool_brain_query_projects()` uses `BRAIN_TABLES`, named columns, per-table caps and a total payload cap.
- `tool_brain_log_learning()` writes unverified learnings and may retry without FK source references.
- `tool_jaios_run()` posts to `${JAIOS_URL}/run`; the supplied `GROUND_RULES.md` notes that jai-os silently drops the `role` parameter and routes internally.
- `tool_spawner_run()` posts to `${SPAWNER_URL}/api/v1/spawn`.
- `tool_orchestra_save_skill()` can edit, commit and push an existing persona file. This is a high-impact write path, despite the handover itself being read-only.
- `tool_cloud_escalate()` has OpenRouter and Ollama Cloud branches, a local SQLite usage ledger and spend approval checks.

**INFERRED:** The Conductor is an adapter and policy-fragment collection, not a complete workflow engine. Its thread pool provides concurrency but does not create durable task identity or recovery semantics.

## C. MCP registry and wiring

**DOCUMENTED:** `newsys-mcp.yaml` is the canonical new-system catalogue according to its header. `mcp.yaml` is derived runtime wiring. Secrets are represented only as jvault references and are not reproduced here.

**DOCUMENTED / IMPLEMENTED examples of runtime wiring:** filesystem, fetch, Brave Search, git, Puppeteer, browser-tools, GitHub, conductor, session-local memory, sequential-thinking and time are listed as live/enabled in the wiring file. Supabase, Firecrawl, Notion, Linear, postgres-brain, Hostinger Email and Google Workspace are staged or pending verification. The catalogue also lists jai-os internal MCP servers such as `jonnyai-mcp-jaios`, `telegram-mcp-jaios`, `resend-mcp-jaios`, `social-mcp-jaios`, `gcp-mcp-jaios` and `elevenlabs-mcp-jaios`.

**IMPORTANT:** The wiring file's `allow_tools: []` and `deny_tools: []` values are configuration declarations. `CONDUCTOR_DEEP_DIVE.md` says scopes are not enforced in the Conductor itself. The external architect must not infer least privilege from empty arrays.

## D. Security, memory and side effects

**DOCUMENTED:** Ground rules prohibit secret material in source, require Brain grounding before asserting estate facts, prohibit automatic social publishing, require named owners, and require verification before promoting a learning.

**IMPLEMENTED in supplied code:**

- Conductor service-role credentials are loaded from environment/jvault runtime names, never printed.
- Brain query avoids embeddings and large unbounded responses.
- Remote MCP requires OAuth configuration and DNS rebinding protection.
- Mission Control private routes require loopback peer/host checks and a separate internal token.
- Cloud calls require a distinct spend-approval token for metered OpenRouter calls and use a budget ledger.

**CONFLICT:** Code-level protections are uneven. `orchestra_save_skill`, `telegram_send`, DSP posting and cloud escalation are side-effecting paths. The deep dive explicitly says ordinary MCP is unauthenticated and human gates are not centrally enforced by Conductor.

## E. Planned new-system operating model

**PLANNED:** The blueprint's intended sequence is:

```text
Brief: outcome + acceptance + deadline + constraints
                         |
              dispatch-time retrieval
              skills + relevant learnings
                         |
                    worker assembly
           identity + model + tools + tenant
                         |
                  guardian pre-gate
                         |
                 sandboxed execution
                         |
                evidence + verification
                         |
             DONE DSP + learning proposal
                         |
                       retire
```

**PLANNED:** Other new-system lanes include nightly consolidation, boardroom polling, email triage, research, dreamer, tenant cells and repo-intelligence agents. The blueprint records some later progress claims, but the supplied evidence does not provide the implementations or live probes for most of those lanes. Keep their status as specified/documented rather than assuming production readiness.

## F. KernelJSON detailed contract

**IMPLEMENTED in supplied SQL/design, separate project:** KernelJSON models task-scoped execution with `trace_id`, contracts, task steps, immutable `task_events`, evidence rows, approvals and artifacts. The `task_status` enum is the authoritative status list for that project. It requires evidence references for completed external effects and uses idempotency/request digests.

**UNVERIFIED:** No supplied file shows an adapter from the live Conductor or OpenClaw into KernelJSON. No supplied file proves the KernelJSON Supabase migrations were applied remotely. No supplied file proves Restate is running on the live estate VM.

# Explicit unknowns and verification backlog

1. **UNVERIFIED:** Is there a live Spawner daemon on `127.0.0.1:8766` or VM port `8766`? Resolve the BLUEPRINT “SPEC ONLY” statement against the absent `BUILD_PLAN` claim of PM2 live.
2. **UNVERIFIED:** Which exact PM2, Docker and systemd processes are running on the GCP VM now?
3. **UNVERIFIED:** Is `:8790` currently serving the supplied `server_http.py`, another build, or a reverse-proxied variant?
4. **UNVERIFIED:** Which Caddy routes, hostnames and TLS policies map to `:8790`, `:8765`, `:3200`, `:3100` and `:5678`?
5. **UNVERIFIED:** Are the `mc_foundation.sql` and `mc_kanban.sql` migrations applied to Brain ref `lkwydqtfbdjhxaarelaz`? The foundation file says intentionally unapplied.
6. **UNVERIFIED:** Are the Brain tables `projects`, `agents`, `learnings`, `chatroom` and `actions_open` current, views or tables, and what are their exact RLS policies?
7. **UNVERIFIED:** Is the Brain learning count 169, 181 or another current number? The evidence mixes registry/Brain counts and historical snapshots.
8. **UNVERIFIED:** What is the exact canonical MCP count? The documents say approximately 42 or 42-51; `newsys-mcp.yaml` separates roughly 28 server rows from 20 candidates, while `mcp.yaml` is runtime wiring.
9. **UNVERIFIED:** Which MCP catalogue entries are actually enabled on the VM versus only laptop-wired or staged?
10. **UNVERIFIED:** Are `allow_tools`, `deny_tools` and scope fields enforced anywhere outside configuration parsing?
11. **UNVERIFIED:** Is the direct DeepSeek provider path the same for DSH, OpenClaw, jai-os and any Spawner workers? The separate DeepSeek VM is explicitly unverified.
12. **UNVERIFIED:** Is OpenRouter technically disabled, or merely retired by policy/documentation while `cloud_escalate` and Mission Control SQL still retain it?
13. **UNVERIFIED:** Does OpenClaw still invoke any Hermes polling or subprocess path in production? The migration says Hermes is disabled but Conductor code still contains Hermes functions.
14. **UNVERIFIED:** What is the exact single source of truth for task admission and lifecycle across OpenClaw, Conductor, jai-os, n8n, Mission Control, Spawner and KernelJSON?
15. **UNVERIFIED:** Who owns retries, cancellation, timeout recovery and completion evidence in the live estate?
16. **UNVERIFIED:** Which consumers still call Orchestra personas and jai-os, and what tested replacement exists for each before retirement?
17. **UNVERIFIED:** Is the DSH `danger-full-access` preset constrained by deployment policy, project scope or user identity on the VM?
18. **UNVERIFIED:** Are all ten live DSH skill junctions present and resolving to the canonical registry on the current machine?
19. **UNVERIFIED:** Is the new-system nightly consolidation deployed, and does it scrub secrets before Brain writes?
20. **UNVERIFIED:** Is sandbox tier-1 gVisor installed on the production VM? The blueprint contains conflicting historical status statements, including blocked and later local/live claims.
21. **UNVERIFIED:** Is tier-2 sandbox intentionally parked on a separate KVM-capable host, as documented?
22. **UNVERIFIED:** Are Mission Control structured state and the proposed `system_state`/`repo_intel` surfaces live, and does the UI read them?
23. **UNVERIFIED:** Are the three cited tenant cells operational in the current estate, or only historical proofs?
24. **UNVERIFIED:** Is the external OAuth issuer/resource URL for `server_http.py` aligned with Caddy and the VM deployment?
25. **UNVERIFIED:** Are OpenClaw, DSH, jai-os, Conductor and Mission Control all using the same timezone and clock source for DSPs, cron and task deadlines?

# Evidence index

| Evidence file | Main contribution |
|---|---|
| `NOTES_FROM_INDEX.md` | VM identity, service/port inventory, migration and estate map |
| `PARTIAL_FROM_EXECUTORS.md` | topology, routing, registries, channels and migration caveats |
| `CONDUCTOR_DEEP_DIVE.md` | 17-tool count, API surface, authority conflicts and partial orchestrator assessment |
| `CONDUCTOR_TOOLS.md` | tool names, environment variable names, API and registry-v2 skill preference |
| `conductor-server.py` | implemented stdio Conductor, `TOOLS`, Brain tables, routing, jai-os/Spawner and cloud paths |
| `api_main.py` | FastAPI :8787 endpoints and routing/delegation behaviour |
| `server_http.py` | streamable HTTP :8790 OAuth wrapper and Mission Control adapter |
| `routing.json` | documented routing source of truth and ownership rules |
| `routing_controller.py` | deterministic free-text domain classifier and route decision function |
| `GROUND_RULES.md` | estate-wide authority, gates, memory and DSP policy |
| `BLUEPRINT.md` | canonical new-system design, 224 skills, Spawner gap and migration intent |
| `LIVE_SKILLS.md` | ten always-live DSH skills and 224 total registry skills |
| `newsys-mcp.yaml` | new-system MCP catalogue, servers and research candidates |
| `mcp.yaml` | derived runtime MCP wiring, enabled/staged flags and jvault references |
| `dsh-settings.yaml` | DeepSeek v4 Pro, high reasoning, permission preset and Keith default |
| `memory-README.md` | Shared Brain source-of-truth statement and project ref |
| `shared-brain-SKILL.md` | Brain grounding/write policy and tool names |
| `mc_foundation.sql` | proposed Mission Control foundation tables, RLS and RPCs; explicitly unapplied |
| `mc_kanban.sql` | proposed Brain-backed Mission Control boards/cards |
| `kernel-ARCHITECTURE.md` | KernelJSON invariants and execution primitives |
| `kernel-STATE.yaml` | KernelJSON separate project, ref, Restate, phase 15 and validation state |
| `kj_task_ledger.sql` | KernelJSON task status enum, immutable events, evidence, approvals and artifacts |
| `kj_memory_provenance.sql` | immutable KernelJSON memory trigger/index |

