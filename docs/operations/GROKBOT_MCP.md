# Grok Bot on the operator MCP server (read-only)

Status: built on `feat/mcp-grokbot-readonly` (stacked on PR #61), not deployed. Enrolment is a short window that
changes only the `kerneljson-mcp` container and one Caddy header; the door, worker, schedules, brief and canary
stay on release `c5de3f5`, epoch 16.

## What Grok Bot actually supports (investigated 23/10/2026)

| Question | Answer | Evidence |
|---|---|---|
| Custom MCP servers | Yes: "Add a custom connector" / "Add a custom MCP server for everyone using this Bot", field "Server URL", "Remote HTTPS" | UI strings in the installed app, `%LOCALAPPDATA%\Programs\Grok Bot\resources\app.asar` |
| Transport | Remote HTTP(S) MCP; it refuses "not an http server" and "invalid mcp server url" | same |
| Authentication | OAuth 2.1 with discovery: it parses RFC 9728 and RFC 8414 metadata, including `registration_endpoint` and `client_id_metadata_document_supported`, and errors on "did not expose an oauth authorization endpoint" | same |
| Client identity | Cursor's public client, `client_id` `https://cursor.com/oauth/mcp-client.json`, `token_endpoint_auth_method: none`, grants `authorization_code` and `refresh_token` | the document itself, fetched 23/10/2026 |
| Callbacks | `https://www.cursor.com/bot/mcp/oauth/callback`, `https://www.cursor.com/agents/mcp/oauth/callback`, `https://grok.com/connectors-oauth-exchange-code/`, `http://localhost:8787/callback`, `http://127.0.0.1:8787/callback` | the document's `redirect_uris` |
| Where OAuth runs | Off the desktop: the app parses metadata, but registration and the token exchange are done by the service (the desktop bundle has no registration request) | inferred from the bundle |
| Official docs | docs.x.ai/grok-bot covers plugins from Connect apps only; nothing about custom servers | fetched 23/10/2026 |

Not established until the live enrolment: which callback it uses, whether it registers dynamically or presents
the metadata-document client id (this server supports only dynamic registration), and whether its calls carry an
`Origin` header. The enrolment log answers all three; see "If it does not connect".

## Design

One KernelJSON, one door, one MCP server. Grok Bot is a second OAuth client of the same MCP server:

- **Profile by redirect URI.** A client's profile comes only from the redirect URIs signed into its client id
  (`apps/mcp/src/oauth/profiles.ts`). ChatGPT's callback is the `chatgpt` profile: operator scope, every tool,
  unchanged, and its existing client id and tokens keep working. The five Cursor callbacks above are the
  `grokbot` profile: scope `kerneljson.read`, the seven read tools only (`kj_list_tasks`, `kj_get_task`,
  `kj_task_evidence`, `kj_task_history`, `kj_memory`, `kj_world`, `kj_health`). A registration that mixes the two,
  or names any other URI, is refused.
- **No escalation.** Whatever scope Grok Bot asks for, it is issued `kerneljson.read`, and a token whose scope is
  not exactly its client's profile scope is refused, even if signed with the real key. Act tools (`kj_run_*`,
  `kj_cancel_task`) answer `NOT_PERMITTED` and never reach the door, so Grok Bot cannot admit, cancel, approve or
  schedule anything. Approve and schedules are not MCP tools at all.
- **Attribution.** Every tool call is logged with `profile` and `client` (and refusals, including an unexpected
  `Origin`). Reads reach the door as the MCP principal, as ChatGPT's do; the MCP log is what tells them apart.
  Admissions would carry the `chatgpt-mcp/v1` channel, but Grok Bot cannot admit.
- **Same human.** Sign-in is still Google with `MCP_ALLOWED_GOOGLE_SUB`, then the consent page, which now names
  the profile ("Grok Bot (Cursor MCP client)", read-only) and lists Cursor's callback origin in `form-action` so
  the browser can follow the Allow redirect (PR #61's fix, needed here).
- **Bounded enrolment.** `MCP_REGISTRATION=open-until=<UTC time>` closes by itself (at most 24 hours ahead, or the
  server refuses to start), and `MCP_REGISTRATION_PROFILES=grokbot` refuses a ChatGPT-lookalike registration
  while it is open. No credential is shared: Grok Bot gets its own client id and tokens from this server.

## Production state found (23/10/2026, read-only probe)

`POST /oauth/register` with an unknown callback answered 400 `invalid_redirect_uri`: registration is still
**open** (`mcp-close.sh` was never run). It is contained (ChatGPT's callback only, one Google subject, consent),
but it is not bounded. This window closes it either way.

## The window

Needs Jonny's approval, and PR #61 and this PR merged (merging deploys nothing). Clear of the 06:00Z brief and
08:00Z canary. About 20 minutes, most of it the Grok Bot sign-in.

| # | Who | Do | Expect |
|---|---|---|---|
| 1 | Claude | Bundle the merge commit as `gb.bundle` (`kj-release-$SHORT`), scp it with `gb-prep.sh`, `gb-enrol.sh` and `gb-close.sh` to `/tmp/kjwin/` | Files on the VM |
| 2 | Jonny (VM) | `sudo bash /tmp/kjwin/gb-prep.sh $SHA` | Image `kerneljson-admission-door:$SHORT` built. public.env keys changed exactly `KERNELJSON_RELEASE_ID MCP_ALLOWED_REDIRECT_URIS MCP_REGISTRATION MCP_REGISTRATION_PROFILES`. Rollback copies equal live. `caddy CSP override lines now: 1`. `PREP OK` |
| 3 | Jonny (VM) | `sudo bash /tmp/kjwin/gb-enrol.sh $SHA` | `kerneljson-mcp healthy`, registration `open-until=<+60 min>`, profiles `grokbot`. Caddy `removed 1 line`, reloaded. n8n 200 (or its 401). Scopes list both. Unauthenticated /mcp 401. Unknown callback 400. ChatGPT-profile registration 403. `ENROLMENT OPEN UNTIL ...` |
| 4 | Jonny | ChatGPT, new chat: "Check KernelJSON's health" | Works as before: epoch 16, `doorMatchesActive: true` (ChatGPT untouched) |
| 5 | Jonny | Grok Bot: Connect apps, Add a custom connector (or a Bot's settings, Add a custom MCP). Server URL `https://kj-mcp.jonnyai.co.uk/mcp`. Sign in when the browser opens | Google chooser, then "Allow access to KernelJSON?" naming **Grok Bot (Cursor MCP client)** and saying it cannot start, cancel or approve anything, with access going to a Cursor or Grok origin. Allow. Seven tools listed |
| 6 | Jonny | Grok Bot: "Check KernelJSON's health" | `kj_health` answers: epoch 16, release `c5de3f5`, `doorMatchesActive: true` |
| 7 | Jonny (VM) | `sudo bash /tmp/kjwin/gb-close.sh $SHA` | `MCP_REGISTRATION=closed`, register now 403. The log summary shows `client_registered` with profile `grokbot`, `consent_allowed`, and Grok Bot's `kj_health` call with `profile: grokbot`. `CLOSE OK` |

If the enrolment times out before step 7, registration has already closed itself; step 7 still records the log.

## Cross-client checks (after step 7)

| Check | How | Pass |
|---|---|---|
| Health from both | Grok Bot and ChatGPT: "Check KernelJSON's health" | Same release `c5de3f5`, epoch 16, both `doorMatchesActive: true` |
| Same ledger | Both: "List the last 5 KernelJSON tasks" | Same task ids, statuses and times |
| Evidence | Grok Bot: "Show the evidence for task <the most recent COMPLETED morning brief>" | The same evidence ids and digests ChatGPT shows for that task |
| Distinguishable | VM: `docker logs kerneljson-mcp 2>&1 \| grep '"tool"'` | Grok Bot's calls have `"profile":"grokbot"`, ChatGPT's `"profile":"chatgpt"` |
| Grok Bot cannot act | Grok Bot: "Run a morning brief" | It has no such tool. Asked to call `kj_run_brief` anyway, the result is `NOT_PERMITTED`; no new task appears in `kj_list_tasks`, and the log shows `kj_run_brief NOT_PERMITTED profile grokbot` |
| ChatGPT unchanged | ChatGPT's tool list | The same ten tools as before |
| No token in logs | VM: `docker logs kerneljson-mcp 2>&1 \| grep -c 'kjm1\.'` | `0` |

No new task is started by any of these.

## If it does not connect

Every refusal is logged by name; `gb-close.sh` prints them.

| Log line | Meaning | Fix (each is a small change to this procedure, not to the design) |
|---|---|---|
| `registration_refused` with `redirectUris` | Grok Bot registered a callback outside the five | Confirm the URI belongs to Cursor or xAI, add it to the `grokbot` profile in code, repeat |
| no registration at all, and Grok Bot reports no client | It wants a client id metadata document, not dynamic registration | Supporting `client_id_metadata_document_supported` for Cursor's document only is the follow-up change |
| `refused: ORIGIN_NOT_ALLOWED` with `origin` | Its calls carry a browser Origin | Add that origin to `MCP_ALLOWED_ORIGINS` (keeping ChatGPT's two) and repeat |
| consent page never redirects | `form-action` still blocked: the Caddy override is back | Check `grep -c "header_down Content-Security-Policy" /opt/n8n/Caddyfile` is 0 |

## Rollback

| Do | Expect |
|---|---|
| Grok Bot only: remove the five Cursor callbacks from `MCP_ALLOWED_REDIRECT_URIS` and recreate `kerneljson-mcp`. A client whose callbacks are no longer allowed has its access tokens and refreshes refused at once (tested), so this ends Grok Bot's access without rotating `MCP_TOKEN_SIGNING_KEY` | Grok Bot gets 401; ChatGPT unaffected |
| Everything: `install -m 600 $RB/mcp.public.before.env /opt/kerneljson/runtime/mcp/public.env`, `cat $RB/Caddyfile.before > /opt/n8n/Caddyfile`, Caddy reload, recreate `kerneljson-mcp` on `kerneljson-admission-door:c5de3f5` | The pre-window MCP exactly. The old code refuses any Grok Bot token (its scope is not the operator scope) |

`$RB` is `/opt/kerneljson/runtime/gb-$SHORT`.
