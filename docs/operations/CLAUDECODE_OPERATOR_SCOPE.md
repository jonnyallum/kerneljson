# Claude Code on the operator MCP: setup, window and rollback

Status: built on `claude/mcp-claudecode-profile` from main `40293dc`. Nothing is deployed. Merging deploys nothing (neither repository has CI deploy coupling). Every production step below needs Jonny's explicit change-window approval.

## What this adds

- A third OAuth client profile, `claudecode`, with the same operator tool set as ChatGPT and Grok Bot: read tasks, evidence, history, memory, world and health; start a brief, a read-only repository analysis or a bounded draft-PR code change; cancel. There is no approve, signal, schedule or identity tool, so human approval stays with Jonny.
- Its own attribution: admissions carry `claudecode-mcp/v1`, recorded by the gateway as `kerneljson:channel/claudecode-mcp/v1`. Idempotency keys begin `claudecode-mcp:`. ChatGPT keeps `chatgpt-mcp/v1` and `mcp:`, Grok Bot keeps `grokbot-mcp/v1` and `grokbot-mcp:`.
- Cancel is scoped for Claude Code: it may cancel only a task whose recorded source is its own channel and which is in the latest 50 tasks. Any other task (ChatGPT's, Grok Bot's, the scheduled brief, Telegram, an unattributed one) is refused with `FORBIDDEN` before the door is asked. ChatGPT and Grok Bot cancel exactly as before.
- Its own credential: Claude Code is issued its own OAuth client id and signed tokens at Jonny's Google sign-in and consent. It never holds or reuses the door bearer, the worker bearer, ChatGPT's or Grok Bot's tokens, or any room bearer.

## Claude Code's OAuth callback (read from the Claude Code documentation, 06/11/2026)

Claude Code runs the OAuth flow with a loopback callback `http://localhost:PORT/callback`. By default it picks a random free port, which could never match this server's exact-match allow-list, so the connection is made with a fixed port: `--callback-port 53682`. Version 2.1.229 sent `127.0.0.1` instead of `localhost` (restored in 2.1.231), so both spellings of that one port are accepted. It registers dynamically, which this server supports. Port 53682 is not used by the Grok Bot profile (8787), so a registration cannot resolve to two profiles.

Connect command, run by Jonny on his machine after the window opens:

```
claude mcp add --transport http --callback-port 53682 kerneljson https://kj-mcp.jonnyai.co.uk/mcp
```

then `/mcp` (or `claude mcp login kerneljson`), choose Google, sign in as Jonny, and approve the consent page that names "Claude Code (loopback callback)".

## Exact production changes needed (NOT done; each needs the change window)

Follow the established pattern in `GROKBOT_MCP.md` and `GROKBOT_OPERATOR_SCOPE.md`.

1. **Release.** Qualify the merge commit. Deploy the gateway, admission door, worker and MCP at one release id by the zero-active-task switch. The gateway must be updated before the first Claude Code admission: it is the component that accepts `claudecode-mcp/v1`.
2. **MCP runtime environment** (`/opt/kerneljson/runtime/mcp/public.env`), changing exactly these keys and keeping a rollback copy first:
   - `KERNELJSON_RELEASE_ID` to the new release.
   - `MCP_ALLOWED_REDIRECT_URIS`: append `http://localhost:53682/callback` and `http://127.0.0.1:53682/callback`, keeping the existing ChatGPT and Grok Bot entries.
   - `MCP_REGISTRATION=open-until=<UTC time, at most 24 hours ahead>` and `MCP_REGISTRATION_PROFILES=claudecode`. This refuses a ChatGPT-lookalike or Grok-lookalike registration while it is open.
3. **Caddy.** The consent page's `form-action` must be able to include `http://localhost:53682`. Check `grep -c "header_down Content-Security-Policy" /opt/n8n/Caddyfile` is 0, as in the Grok Bot window.
4. **Window timing.** Keep clear of the 06:00 and 08:00 Europe/London brief and canary.
5. **Enrol.** Jonny runs the connect command above. Registration then closes itself at the `open-until` time; close it earlier by setting `MCP_REGISTRATION=closed` and recreating the MCP container.

No new infrastructure, no credential rotation, no change to the schedules, the worker bearer, `MCP_TOKEN_SIGNING_KEY` or the VM beyond the container and the one environment file.

## Proof to run in the window (do not infer from a visible tool list)

| # | Check | Pass |
|---|---|---|
| 1 | Claude Code `kj_health` | Epoch and release as expected, `doorMatchesActive: true` |
| 2 | Claude Code `kj_list_tasks` and `kj_task_history` for a recent task | Same tasks and history ChatGPT sees |
| 3 | Claude Code submits one harmless bounded task: `kj_run_analysis` on an allowlisted repository, not the morning brief | The kernel creates the task |
| 4 | The task's source | `kerneljson:channel/claudecode-mcp/v1`, and the MCP log shows `profile":"claudecode"` |
| 5 | `kj_task_evidence` for that task once terminal | Evidence retrievable |
| 6 | `kj_cancel_task` on the task Claude Code started (if still non-terminal) | Accepted |
| 7 | `kj_cancel_task` on the scheduled brief or a ChatGPT task | `FORBIDDEN`, and no cancel reaches the door |
| 8 | A call with no token, and with a token whose client's callbacks were removed | 401 |
| 9 | Morning brief and canary at their next fire | Unchanged and healthy |
| 10 | `docker logs kerneljson-mcp 2>&1 \| grep -c 'kjm1\.'` and a search of the room and Git for the token | `0`, and none |

## Known limits

- The MCP process holds one door credential, so the ledger principal is shared by ChatGPT, Grok Bot and Claude Code. Claude Code's tasks are distinguished by their channel source and the MCP audit log, as Grok Bot's are. A separate Claude Code ledger principal would need an additional door credential, an identity registration and membership: a further production change, not part of this one.
- The room tools on the MCP use a bearer per profile (`ROOM_BEARER_CHATGPT`, `ROOM_BEARER_GROK`). `claudecode` has none, so those four tools answer `FORBIDDEN` for it. Claude Code uses the room directly, with its own participant bearer, through `AgentHub\scripts\room.py`.
- ChatGPT's and Grok Bot's cancel is not narrowed to their own tasks by this change. That is the existing behaviour, left alone on purpose.
- The loopback callback is reachable by any local process on Jonny's machine, but it can obtain nothing without Jonny's own Google sign-in and an explicit consent. Removing the two callbacks from `MCP_ALLOWED_REDIRECT_URIS` revokes Claude Code at once, without rotating the signing key and without touching the other clients.

## Rollback

| Do | Expect |
|---|---|
| Claude Code only: remove the two `53682` callbacks from `MCP_ALLOWED_REDIRECT_URIS` and recreate `kerneljson-mcp`. Its access tokens and refreshes are then refused immediately (tested). Then `claude mcp remove kerneljson` | Claude Code gets 401; ChatGPT and Grok Bot unaffected |
| Everything: restore the previous release and the saved `public.env`, compare to the exact pre-window files first, recreate the MCP container | The pre-window MCP. The old code refuses any `claudecode` token |

Do not restore old runtime env files over a later authorised change; preserve the exact pre-switch files and compare first.
