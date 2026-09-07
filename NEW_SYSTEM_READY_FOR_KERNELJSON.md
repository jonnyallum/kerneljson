# NEW SYSTEM READY FOR KERNELJSON

**Deliverable authority:** Transition Charter §18. **Compiled:** 2026-09-07 (kerneljson-prep, track C).
**Language:** UK English. **Verify tags:** OBSERVED (verified live this session) · DOCUMENTED (asserted by evidence) · INFERRED · UNVERIFIED.

This is the migration-completion deliverable the estate hands to KernelJSON. It assembles the
three track-C artefacts — the expanded capability catalogue, the MCP inventory and the authority
map — with the runtime, spawner, Brain, Agent Hub, DeepSeek, legacy, security, evidence and
gap sections. It reports **reality first**: where this session proved something live it is OBSERVED;
where it rests on the external-architect handover it is DOCUMENTED; open items are UNVERIFIED.

---

## 1. Runtime estate — actual services and ports

One GCP VM `instance-20260717-082134` (`136.112.138.225`, project `project-d58d4a53-a63b-45a0-818`), Caddy the TLS boundary.

| Service | Port | Surface | Status |
|---|---:|---|---|
| BizOS shell | 3100 | bizos.jonnyai.co.uk | DOCUMENTED live |
| Mission Control | 3200 | control.jonnyai.co.uk | DOCUMENTED live |
| Conductor MCP (remote) | 8790 | private behind Caddy, OAuth | DOCUMENTED live |
| jai-os API | 8765 | jaios.jonnyai.co.uk | DOCUMENTED live (pending retirement) |
| n8n | 5678 | n8n.jonnyai.co.uk, Docker | DOCUMENTED live (17 workflows) |
| OpenClaw gateway (Marcus) | 127.0.0.1:18789 | Telegram | DOCUMENTED live |
| **Agent Spawner** | 127.0.0.1:8766 | loopback | **OBSERVED live (this session)** |
| DSH web | 127.0.0.1:3080 / :3000 | loopback | DOCUMENTED live |
| Caddy | 80/443 | TLS ingress | DOCUMENTED live |

**OBSERVED (this session):** VM `ss` shows `127.0.0.1:8766` held by `python -m uvicorn spawner.server:app`; `pm2 pid spawner`=510746; the boardroom-poller cron runs `*/5` on the VM and now carries `--spawner-authoritative`. **UNVERIFIED:** exact Caddy route map, and whether `:8790` serves the supplied `server_http.py` or a variant (handover backlog items 3–4).

## 2. Spawner — live proof and interface

**OBSERVED (this session) — RESOLVES the handover's biggest UNVERIFIED (was "SPEC ONLY / conflicted").**

- **Live on both hosts:** VM `127.0.0.1:8766` and laptop `127.0.0.1:8766` both return `GET /api/v1/health` → `{"status":"healthy","service":"spawner-daemon","active_workers":0}`.
- **Supervised (durable):** VM under **pm2** (`spawner` online, `pm2 save` done, `pm2-jonny` startup enabled → survives crash + reboot); laptop under **`SpawnerWatchdogSupervisor`** scheduled task (restarting action, every 5 min, verified firing).
- **End-to-end proof:** `POST /api/v1/spawn` → `status=completed, exit_code=0`, worker spawned, `dsp_posted=False` (no side effects).
- **Interface (`spawner/server.py`, uvicorn on 127.0.0.1:8766):** `GET /api/v1/health`, `GET /api/v1/workers`, `POST /api/v1/spawn` (SpawnRequest: mission, brief, skills[], model_tier, timeout_seconds, dry_run), `GET /api/v1/tasks/{id}`, `POST /api/v1/tasks/{id}/cancel`.
- **Known code-quality gaps (flagged, non-blocking):** `spawner-watchdog.py --install-task` schedules probe-only `--check` (fixed operationally by scheduling the default restarting action); `run_e2e_proof()` asserts a `repository.read` result `execute_task` may not produce.

## 3. Capability catalogue — all callable capabilities

→ `capabilities/INDEX.yaml` (v1.1.0, **23 capabilities**) + per-capability YAMLs. Expanded from the 14 seeded by 9 (track C): `model.invoke` (enabled), `code.generate` / `code.review` (staged), `cloud.escalate` (legacy), `browser.use` (candidate), `message.email` / `social.publish` (staged, gated), `voice.synthesize` (candidate), `workflow.n8n` (enabled). Each carries id/implementation/runtime/inputs/outputs/side_effects/permissions/evidence_produced/stateful/status per Charter §5. **KernelJSON consumes this catalogue, not raw agents.**

## 4. MCP catalogue — verified runtime wiring

→ `docs/MCP_INVENTORY.md`. Grounded in `.dsh/dshmm/mcp.json` (8 loaded) and `new-system/mcp/mcp.yaml` (~28 servers + ~23 candidates). Reconciled into ENABLED / STAGED / CANDIDATE / LEGACY / RETIRED (Charter §6) with the required fields; **no single canonical total claimed**. Enabled ≈ 10 official/estate + drift flags (github 401, memory/hostinger in mcp.json); 7 `*-mcp-jaios` = LEGACY; supabase/postgres-brain/firecrawl/notion/linear/hostinger-email/google-workspace = STAGED.

## 5. Shared Brain — current schema and interfaces

**DOCUMENTED:** Supabase ref `lkwydqtfbdjhxaarelaz`. Estate tables the Conductor reads/writes: `projects`, `agents`, `learnings`, `chatroom`, `actions_open` (explicit-only ledger view; `state='done'` requires ≥20 chars evidence). Learnings inserted `verified=false`; promotion is a separate review. Mission Control `mc_*` tables (foundation + kanban) are **UNVERIFIED as applied** (`mc_foundation.sql` says intentionally unapplied). **BOUNDARY (Charter §14):** Shared Brain is durable *cognitive* memory, **not** the task-execution DB — KernelJSON uses its **own** Supabase ref `banqdzddfganzfhckdps`; do not merge them.

## 6. Agent Hub — verified Conductor interfaces

**DOCUMENTED / IMPLEMENTED:** stdio Conductor registers **17 tools** (authoritative `TOOLS` dict; catalogue's "16" is CONFLICT #5). HTTP surfaces: local FastAPI `:8787` (health, matrix, orchestra, boardroom, brain, route, delegate, jaios/run) and remote streamable-HTTP MCP `:8790` (OAuth, omits Hermes-dependent tools). **Charter §8 target:** treat the Conductor as the **AgentHub Capability Gateway** (document `capabilities()`/`execute()`/`health()`; do not build them prematurely) so a later `AgentHubRuntime` adapter into KernelJSON is straightforward. It is an adapter, **not** a durable task engine (no durable task IDs / retry / cancel / completion state).

## 7. DeepSeek — verified execution interface

**DOCUMENTED / OBSERVED:** direct DeepSeek is the live model path (OpenRouter is retired/out-of-credit — LEGACY). Endpoints: `https://api.deepseek.com/v1` (OpenAI-compatible) and `https://api.deepseek.com/anthropic` (Anthropic-compatible, auto-maps Claude ids). Models: **`deepseek-v4-flash`** (phone/cron/classification/drafts) and **`deepseek-v4-pro`** (architecture/audits/client copy); Ollama fallback. jai-os's 109 agents reach it with zero code change via two env vars. Prepaid (structural spend cap). → exposed as capability `model.invoke` (enabled) + `code.generate`/`code.review` (staged; KernelJSON `production_model_recipes: not_enabled`). KernelJSON already has a live-verified DeepSeek adapter (Phase 5, ModelPort).

## 8. Legacy dependency map — remaining jai-os / Orchestra consumers

Retire only with positive test + negative test + rollback + consumer verification; disable before delete (Charter §9).

| Legacy component | Capability supplied | Replacement | Status |
|---|---|---|---|
| jai-os :8765 (109 agents) | role-node execution | new-system Spawner (:8766) | Spawner OBSERVED live; per-consumer cutover UNVERIFIED |
| `*-mcp-jaios` (brain, telegram, resend, social, gcp, elevenlabs) | those 6 capability surfaces | re-home under new-system runtime / conductor gateway | LEGACY — must be re-homed before jai-os retirement |
| Orchestra personas | decide/brief/gate handles | Persistent Identity v1 (Charter §15) + capability catalogue | DOCUMENTED live pending retirement; personas → historical source material |
| Hermes | Marcus messaging front | OpenClaw gateway | RETIRED as front; residual code present (conflict #3) |

## 9. Authority map — who owns each control responsibility

→ `docs/AUTHORITY_MAP.md`. Charter §10 ownership table (task admission / routing / capability selection / model selection / execution / approvals / retry / cancel / completion / external side effects) with current owner, KernelJSON target, and all **8 AUTHORITY CONFLICTS** surfaced. Human chain: Jonny (money / production go-live / client sends / security-legal-data-loss gates) → Keith (dispatcher) → Marcus (plan/delegate) → agents.

## 10. Security map — actual enforcement points (in CODE, Charter §11)

| Control | Enforcement point (CODE) | Strength |
|---|---|---|
| Sandbox isolation | `spawner/sandbox.py` gVisor `runsc` (Tier-1); fail-closed to `denied` when runsc absent | REAL (OBSERVED: fail-closed on non-runsc hosts) |
| Guardian pre-gate | `spawner/engine.py evaluate_pre_gate()` (manifest/brief/secret-scan/gated-action) | REAL but denial reason not persisted |
| Secret handling | jvault refs only; `scrub_secrets()`; `secretctl` file→stdin discipline | REAL |
| DB least-privilege | Supabase RLS; `system_state` anon REVOKE (this-session migration); read-only MCP roles | REAL where applied |
| External spend | `cloud_escalate` spend-approval token + SQLite ledger | REAL but tied to LEGACY OpenRouter |
| Human gates | DSP TYPE=GATE / action-ledger evidence constraint | **WEAK — not centrally enforced (conflict #7)** |
| DSH permission | `danger-full-access` preset | **DEV ONLY — not a security architecture (Charter §12)** |
| MCP scopes | `allow_tools`/`deny_tools` | **NOT ENFORCED (conflict #6) — declarations only** |

**Prompt-level instructions do not count as enforcement.** Treat production mutation, credential changes, messaging, publishing, cloud resources, DB writes, destructive FS ops and external spend as dangerous regardless of persona text.

## 11. Evidence format — what each execution path can return

Per capability `evidence_produced` (deterministic, not free prose — ARCHITECTURE invariant #3/#4):

- **shell.execute / spawner:** `structured_execution_receipt` — exit_code, duration_ms, runtime, sha256_output_hash.
- **repository.write:** `git_commit_sha` — files_modified, diff_stat, commit_hash.
- **database.read/write:** `structured_json` — count, duration_ms.
- **model.invoke / code.*:** `model_receipt` — model, total_tokens, finish_reason, sanitized digest.
- **message.telegram/email, social.publish:** delivery/publish receipt — message_id/post_id, sent_at.
- **human.approval_gate:** `signed_dsp_receipt` — decision, approved_by, signed_at.

For work that changes anything, return where applicable (Charter §13): files changed, git diff, commands + exit codes, tests, URLs, DB results, artefacts, logs. **DSP `DONE` alone is not proof.**

## 12. Known gaps — what KernelJSON integration must solve

1. **No single task authority** (conflict #8) — KernelJSON must own admission/lifecycle explicitly; no Conductor durable task API exists.
2. **No durable retry / cancel / completion** in the live estate — Restate provides these; the estate currently uses DSP `DONE` conventions.
3. **Human-gate enforcement is not central** (conflict #7) — must move to KernelJSON default-deny policy + scoped approvals; DSH `danger-full-access` is dev-only.
4. **Model spend** (conflict #4) — decide OpenRouter's code-level retirement; `cloud.escalate` is LEGACY.
5. **jai-os LEGACY MCP re-homing** — 6+ capabilities exist only via retiring jai-os; re-home before retirement.
6. **No live adapter** from Conductor/OpenClaw into KernelJSON, and KernelJSON remote migrations not pushed (STATE.yaml) — the integration surface itself is the work.
7. **MC `mc_*` migrations** and exact Caddy/`:8790` deployment remain UNVERIFIED (handover backlog).
8. **KernelJSON phase 15 incomplete** — stronger child-evidence verification, a negative DB test and the full regression/review remain.

---

## First KernelJSON estate test (Charter §20)

`KJ-000000`: dispatch a **read-only** repository analysis through Agent Hub → new-system worker (the now-proven Spawner) → structured evidence → KernelJSON verification → durable completion. No production changes. This deliverable makes that test executable: the runtime is mapped, the Spawner is proven, the capability (`repository.read`) and its evidence format are catalogued, and the authority/security boundaries are explicit.

**Operating rule (Charter):** finish the migration, strengthen execution capabilities, verify reality, preserve evidence — do **not** create another control plane. New function = CAPABILITY, never a new global orchestrator.
