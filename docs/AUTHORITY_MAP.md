# AUTHORITY MAP — New System (KernelJSON prep)

**Authority:** Transition Charter §10. **Compiled:** 2026-09-07 (kerneljson-prep track C).
Documents **who currently owns each control responsibility**, marks every **AUTHORITY CONFLICT**
without hiding it (Charter §10), and records the KernelJSON target owner. Verify-tagged.

## Method and evidence

- **DOCUMENTED** — `GROUND_RULES.md` / `routing.json` authority claims (via the external-architect handover §5).
- **DOCUMENTED** — the 8 authority conflicts and §10 decision set from `reSYSTEM_HANDOVER_FOR_EXTERNAL_ARCHITECT.md`.
- **OBSERVED (this session, 2026-09-07)** — spawner liveness on both hosts, the boardroom-poller production cutover, VM process/pm2 state.
- **DOCUMENTED** — the KernelJSON target ownership from Transition Charter §1 (KernelJSON "will ultimately own" task admission, durable state, routing, capability selection, approvals, authority, budgets, retries, cancellation, evidence, verification, completion, escalation).

## Human authority chain (DOCUMENTED)

- **Jonny (principal):** retains gates for **money, production go-lives, client/third-party sends, and emergency security/legal/data-loss**. Ultimate and non-delegable authority. Instructions to an agent are valid only from Jonny directly.
- **Keith:** human-facing front / day-to-day dispatcher (single voice, incl. Telegram).
- **Marcus:** plans, delegates, reports; a VM agent under Keith.
- **Escalation:** agent → `@marcus` → `@keith` → **Jonny**.
- **Forward note (Charter §15):** a new **Persistent Identity** will replace the Marcus/Keith conversational architecture. Personas become historical source material, **not** orchestration authorities. Persistent Identity owns personality/relationship/vision — **not execution authority**.

## Control-responsibility ownership (Charter §10)

| Responsibility | Current owner (grounded) | Conflict | KernelJSON target |
|---|---|---|---|
| **task admission** | No single owner — OpenClaw, Conductor, jai-os :8765, n8n and Mission Control all admit work | **CONFLICT #8** | KernelJSON (`task.submit`) |
| **routing** | `registry/routing.json` + `routing_controller.py` (declared source of truth) | **CONFLICT #1** (`/delegate` runs its own keyword scan) | KernelJSON global routing |
| **capability selection** | new-system: registry-v2 + MCP catalogue; legacy: Conductor + jai-os MCPs (generations unreconciled) | **CONFLICT** (§10 decision 3) | KernelJSON policy + capability registry (`capabilities/INDEX.yaml`) |
| **model selection** | Direct DeepSeek (v4-flash phone/cron/drafts, v4-pro architecture/audits); DSH default v4-pro | **CONFLICT #4** (OpenRouter path still live in code/SQL) | KernelJSON ModelPort (Phase 5) |
| **execution** | Distributed — OpenClaw, jai-os :8765, **Spawner :8766 (OBSERVED live this session)**, gVisor sandbox, n8n | **CONFLICT #8** | KernelJSON → runtimes (AgentHub/Spawner/DeepSeek) |
| **approvals** | Intended: human-approval-gate (DSP TYPE=GATE / Jonny). **Not centrally enforced**; DSH runs `danger-full-access` | **CONFLICT #7** | KernelJSON default-deny policy + scoped approvals (Phase 7) |
| **retry** | No durable owner — Conductor has no retry API; external services retry ad-hoc | — (gap) | Restate (durable) |
| **cancel** | No durable owner — Conductor has no cancel API | — (gap) | Restate (`task.cancel`) |
| **completion** | DSP `DONE` (coordination convention) + action-ledger evidence constraint (≥20 chars) | **CONFLICT #7** (DONE ≠ durable proof) | Evidence-bound Outcome (Phase 8/9) |
| **external side effects** | Uneven — `orchestra_save_skill`, `telegram_send`, `cloud_escalate`, social publish are side-effecting; scopes declared but not enforced | **CONFLICT #6, #7** | Policy-gated capabilities + idempotency |

## The 8 documented AUTHORITY CONFLICTS (handover §5)

1. **/delegate vs routing_controller** — docs say `/delegate` uses `routing_controller`; the code independently scans keywords and builds its own multi-domain plan. Two routing brains.
2. **Keith vs Marcus as conversational front** — GROUND_RULES makes Keith the front man; `SOUL` material makes Marcus the only conversation partner. (Estate has since ruled Keith is the single dispatcher — worth re-baselining the SOUL material.)
3. **OpenClaw vs Hermes** — README says OpenClaw is current; the Conductor still contains/calls Hermes paths. Disabled-not-deleted, but the code path remains.
4. **OpenRouter retired vs live in code** — retired in operating docs; `cloud_escalate` still calls OpenRouter and Mission Control SQL still holds OpenRouter cost controls. (Also: the account is out of credit as of 2026-08-31.) → capability `cloud.escalate` tagged **LEGACY**.
5. **16 vs 17 Conductor tools** — catalogue says 16; the authoritative `TOOLS` dict has **17** (`tool_cloud_quote` implemented but unregistered — a code-vs-surface gap).
6. **Empty allow/deny scopes** — `mcp.yaml` `allow_tools: []` / `deny_tools: []` are declarations; the deep dive says the Conductor does **not** enforce them. No least-privilege can be inferred.
7. **Human gates documented but not enforced** — gates are described as graph-interrupt nodes but are not centrally enforced in the supplied Conductor; DSH `danger-full-access` is a dev preset, not a security architecture (Charter §11/§12).
8. **Multiple candidate control surfaces** — Conductor, jai-os, Mission Control, n8n, Brain and the registry-v2 Spawner are all named as possible control points. No single task authority.

## Verification updates this session (OBSERVED, 2026-09-07)

These change the handover's UNVERIFIED picture and should be folded into the migration decision set:

- **Spawner liveness — RESOLVED (was §10 decision 4 / part of conflict #8).** The Agent Spawner is **live on both hosts**: VM `127.0.0.1:8766` (pm2-managed, `pm2 pid spawner`=510746, saved + `pm2-jonny` startup enabled) and laptop `127.0.0.1:8766` (under `SpawnerWatchdogSupervisor`, restarting action, verified firing). A harmless end-to-end `POST /api/v1/spawn` returned `status=completed, exit_code=0`. So "Spawner UNVERIFIED / SPEC ONLY" no longer holds — the execution runtime KernelJSON will dispatch to is proven present.
- **boardroom-poller cutover — LANDED.** Production now runs the poller `--spawner-authoritative` (crontab flag present; live cycles show `MODE: spawner-authoritative`, `auth_source=spawner`, `verdict=match`, holding across ≥3 cycles). **Production-go-live authority is Jonny's** (per the human chain); this cutover was executed on Keith's GO asserting Jonny's authorisation — a live instance of the **conflict #7 human-gate-enforcement** question (the authorisation reached the executor via Keith, not directly), noted here for the record rather than hidden.

## Migration decision set — must be settled before KernelJSON assumes control (handover §10)

1. **One task authority.** If KernelJSON, integrate it explicitly; do not imply Conductor owns a lifecycle it does not have.
2. **One routing authority.** Keep `routing.json` + `routing_controller.py`; remove/reconcile the `/delegate` duplicate.
3. **One capability authority.** For new-system = registry-v2 + the capability catalogue (`capabilities/INDEX.yaml`). Decide whether Conductor, jai-os MCPs and the new catalogue are separate generations or one promoted catalogue.
4. **Prove Spawner status.** — **DONE this session** (see above).
5. **Define approval enforcement.** DSH `danger-full-access`, Conductor weak gates, MC RLS/RPCs and KernelJSON policy are **not** interchangeable. Enforcement must be in code (Charter §11).
6. **Reconcile model spend.** Decide whether OpenRouter is retired in code as well as docs; remove stale aliases/SQL/tool paths or record an explicit legacy exception (currently `cloud.escalate` = LEGACY).
7. **Make completion evidence durable.** DSP `DONE` is coordination, not proof of an external side effect.

## Operating rule (Charter §2 / §17)

Until KernelJSON assumes control: **finish the migration, verify reality, preserve evidence, and do not create another control plane.** Any new function is exposed as a **CAPABILITY**, never as a new global orchestrator. These conflicts are surfaced, not resolved here — KernelJSON is the intended resolver.
