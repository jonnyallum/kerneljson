# MCP INVENTORY — New System (KernelJSON prep)

**Authority:** Transition Charter §6. **Compiled:** 2026-09-07 (kerneljson-prep track C).
**Language:** UK English. Every row is tagged; secrets are jvault refs only.

## Method and evidence

Grounded in the actual wiring, not a recited count:

- **OBSERVED** — `C:\Users\jonny\.dsh\dshmm\mcp.json` (DSH single-source runtime; 8 servers loaded), read 2026-09-07.
- **DOCUMENTED** — `new-system/mcp/mcp.yaml` (registry-v2 canonical catalogue v2, seeded 2026-09-04): ~28 server rows + ~23 research candidates.
- **DOCUMENTED** — `reSYSTEM_HANDOVER_FOR_EXTERNAL_ARCHITECT.md` (external-architect synthesis) and `registry/mcp.yaml` (derived wiring).
- **OBSERVED (this session)** — live estate state used elsewhere in the deliverable.

### No single canonical total (Charter §6)

The drift the handover flags ("42" vs "28 wired" vs "48–51 with candidates") is **not** contradictory once the populations are separated:

| Population | Source | Count |
|---|---|---|
| DSH desk actually loads | `.dsh/dshmm/mcp.json` | **8** |
| registry-v2 server rows | `new-system/mcp/mcp.yaml` `servers:` | **~28** (10 official-live + 7 jai-os-internal-live + 3 VM pending + 8 pending-verify) |
| research candidates (not wired) | `mcp.yaml` `candidates:` | **~23** |
| servers + candidates | — | **~51** |

Do not collapse these into one number. "Enabled on the DSH" ≠ "in the catalogue" ≠ "a research candidate".

## Status taxonomy (Charter §6)

- **ENABLED** — wired AND running now in at least one consumer (registry `status: live`, official/estate servers).
- **STAGED** — config + jvault ref present, not yet enabled/smoke-tested (registry `pending-verify`).
- **CANDIDATE** — researched, not wired (registry `candidates:`).
- **LEGACY** — runs today but via a runtime being retired (jai-os internal `*-mcp-jaios`) or a retired provider (OpenRouter).
- **RETIRED** — explicitly disabled (registry `retired`).
- **AVAILABLE** — reachable/exists somewhere; the superset of ENABLED + STAGED + LEGACY.

Fields per row (Charter §6): name · transport · capabilities · authentication · consumer · side_effects · status.

## ENABLED (wired and running)

| name | transport | capabilities | authentication | consumer | side_effects | status |
|---|---|---|---|---|---|---|
| conductor | stdio | boardroom, Shared Brain, orchestra, jai-os, spawner, cloud (17 tools) | jvault + conductor env | DSH, Claude Code, OpenClaw, VM pm2 :8790 | publishes (DSP, learnings) | ENABLED |
| filesystem | stdio | read/write scoped local paths | none (dir allow-list) | DSH, Claude Code | write-filesystem | ENABLED |
| fetch | stdio | HTTP fetch public URLs | none | registry-v2 agents | outbound-http | ENABLED |
| brave-search | stdio | web/news/image search | BRAVE_API_KEY (jvault) | DSH, agents | outbound-http | ENABLED |
| git | stdio | git operations (mcp_server_git) | none | registry-v2 agents | write-filesystem (local) | ENABLED |
| puppeteer | stdio | browser automation | none | DSH, agents | browser-automation, outbound-http | ENABLED |
| browser-tools | stdio | browser inspection/audits (AgentDesk) | none | DSH, agents | browser-automation | ENABLED |
| github | stdio | repo/issue/PR read+write | fine-grained PAT (jvault) | DSH, agents | github-write (publishes) | ENABLED* |
| sequential-thinking | stdio | structured reasoning aid | none | agents | none | ENABLED |
| time | stdio | time/timezone utilities | none | agents | none | ENABLED |

`*` **DRIFT:** the GitHub PAT was reported **expired / 401** as of 2026-09-03 (registry vetting note, mission `github-token`). Enabled-but-unauthenticated — rotation owed.

## LEGACY (runs, but on a retiring runtime / retired provider)

These are `status: live` in the catalogue but exposed **only** through jai-os internal `*-mcp-jaios` packages, and jai-os is being retired (Charter §9). They must be re-homed as capabilities/MCP under the new-system runtime before jai-os retirement, or they retire with it.

| name | transport | capabilities | authentication | consumer | side_effects | status |
|---|---|---|---|---|---|---|
| jonnyai-mcp-jaios | stdio | Brain interface (Supabase pgvector memory) | jvault Supabase keys | jai-os | write-db (publishes) | LEGACY |
| telegram-mcp-jaios | stdio | Telegram bot alerts/messages | jvault bot token | jai-os | outbound-notification (sends) | LEGACY |
| resend-mcp-jaios | stdio | Resend transactional email | jvault Resend key | jai-os | outbound-email (sends) | LEGACY |
| social-mcp-jaios | stdio | Meta Facebook/Instagram publishing | jvault Meta token | jai-os | public-content-publish | LEGACY |
| gcp-mcp-jaios | stdio | GCP Storage file ops | jvault GCP creds | jai-os | write-cloud-storage (publishes) | LEGACY |
| elevenlabs-mcp-jaios | stdio | ElevenLabs TTS/voice | jvault ElevenLabs key | jai-os | outbound-http, audio-artefact | LEGACY |
| brave-search-mcp-jaios | stdio | Brave web/news/image (jai-os wrapper) | jvault Brave key | jai-os | outbound-http | LEGACY (duplicate of enabled `brave-search`) |
| cloud_escalate → OpenRouter | (conductor tool) | escalate to a cloud model | OPENROUTER_API_KEY + spend-approval | conductor | external-spend, outbound-http | LEGACY (retired provider, code + MC SQL still present — authority conflict #4) |

## STAGED (config + vault ref present, not yet enabled/smoke-tested)

| name | transport | capabilities | authentication | consumer | side_effects | status |
|---|---|---|---|---|---|---|
| supabase | stdio | Shared Brain read-only (query/list/advisors), pinned to ref lkwydqtfbdjhxaarelaz | Supabase PAT (jvault) | agents | none (read-only) | STAGED |
| postgres-brain | stdio | direct read-only SQL to the Brain (pgvector) | conn URL, read-only role (jvault) | agents | none (read-only) | STAGED |
| firecrawl | stdio | crawl/scrape sites to markdown | Firecrawl API key (jvault) | agents | outbound-http | STAGED |
| notion | stdio | Notion workspace read/write | integration token (jvault) | agents | notion-write (gated) | STAGED |
| linear | stdio | Linear issues/projects | Linear API key (jvault) | agents | linear-write | STAGED |
| hostinger-email | stdio | mailbox read/search/send/manage | bearer token (jvault) | DSH (in mcp.json), agents | outbound-email (sends) | STAGED** |
| google-workspace | stdio | Gmail/Calendar/Drive/Sheets | OAuth2 (refresh token owed) | agents | outbound-email (sends) | STAGED (BLOCKED on OAuth refresh — mission oauth-registration) |
| conductor-mcp-vm | http/SSE | conductor tools on the VM (:8790, pm2) | OAuth (MCP_BEARER_TOKEN) | remote agents behind Caddy | publishes | STAGED (pending @marcus VM verify) |
| mcp-marcus | stdio/http | Marcus MCP surface on the VM | env | VM | varies | STAGED (pending verify) |
| sandbox-mcp | stdio | sandbox_exec registering into OpenClaw | env | OpenClaw | isolated-compute | STAGED (N5 build) |

`**` **DRIFT:** `hostinger-email` is `pending-verify` in the catalogue **but present in the DSH `mcp.json`** (i.e. loaded by the desk). Its endpoint moved to OAuth (`mcp.mail.hostinger.com/mcp`); the static-token path is contested (see the capability `message.email`). Treat as STAGED-yet-loaded — a real drift to resolve.

## RETIRED (explicitly disabled)

| name | transport | capabilities | authentication | consumer | side_effects | status |
|---|---|---|---|---|---|---|
| memory | stdio | in-process knowledge-graph memory | none | (was DSH/agents) | none | RETIRED*** |

`***` **DRIFT:** `memory` is `retired` in the catalogue (Shared Brain is the standing memory store) **but still present in the DSH `mcp.json`**. Remove from `mcp.json` to make the retirement real, or the desk keeps loading a retired server.

## CANDIDATE (researched, not wired)

From `mcp.yaml` `candidates:` (~23). Not wired; kept for provenance (schema rule 5). Notable, by intent:

- **Top-5 adopt (flagged):** `n8n-mcp` (trigger the 17 live workflows — pairs with the `workflow.n8n` capability), `supabase-mcp`/`postgres-mcp` (promoted → the STAGED `supabase`/`postgres-brain`), `google-workspace-mcp` (→ STAGED, OAuth-blocked).
- **Browser tier:** `playwright-mcp` (Apache-2.0, SEO/scrape), `browserbase-mcp` (cloud), `puppeteer-mcp-community`.
- **Vector tier (only if pgvector insufficient):** `qdrant-mcp`, `pinecone-mcp`, `chroma-mcp`.
- **Messaging (no-auto-send rule applies):** `slack-mcp`, `telegram-mcp-community` (avoid duplicating OpenClaw), `whatsapp-mcp` (Baileys, unofficial), `meta-mcp`.
- **Media:** `elevenlabs-mcp-official` (metered — cost before mass use).
- **Provenance rows** (already live under a bare id): `filesystem-mcp-ref`, `github-mcp-official`, `memory-mcp-ref`, `fetch-mcp-ref`, `firecrawl-mcp`, `notion-mcp`, `linear-mcp`, `hostinger-email-mcp`.

## Reconciliation and drift flags (for KernelJSON integration)

1. **DSH `mcp.json` (8) vs catalogue.** The desk loads a small, partly-stale subset. `memory` (RETIRED) and `hostinger-email` (STAGED) are loaded there; the catalogue's ENABLED set (fetch, git, sequential-thinking, time, brave-search) is broader. **The DSH is not the estate's MCP source of truth — the registry-v2 catalogue is.**
2. **conductor tool count: 16 vs 17.** Catalogue says "16 tools"; the handover's authoritative `TOOLS` dict has **17** (`tool_cloud_quote` implemented but unregistered is a further code-vs-surface gap). Authority conflict #5.
3. **jai-os `*-mcp-jaios` LEGACY set.** Seven capabilities (Brain, telegram, resend, social, gcp, elevenlabs, brave) currently exist **only** via jai-os. They must be re-homed under the new-system runtime (or the conductor gateway) before jai-os retirement, else those capabilities retire with it.
4. **Scopes are not enforced.** `allow_tools: []` / `deny_tools: []` are declarations only; the deep dive states the Conductor does not enforce them. Do not infer least-privilege from empty arrays (Charter §11).
5. **github ENABLED-but-401, google-workspace STAGED-but-OAuth-blocked, cloud_escalate LEGACY-but-live-code.** Three "present but not truly usable/allowed" cases KernelJSON's capability selection must not treat as green.

## KernelJSON integration note

KernelJSON consumes the **capability catalogue** (`capabilities/INDEX.yaml`), not raw MCP servers. This inventory maps each capability's `runtime` to its backing MCP/consumer, so KernelJSON's policy layer can gate on the real side-effect surface (sends, publishes, spend, write-db) rather than on server names. Enabled ≠ allowed: default-deny policy + human-approval-gate still governs the LEGACY/send/publish/spend rows.
