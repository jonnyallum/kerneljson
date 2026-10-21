# Operator MCP: production deploy checklist

ADR-0025. Background, identity and security review: [OPERATOR_MCP.md](OPERATOR_MCP.md).

**Needs Jonny's explicit approval for one window.**
- Pick a time clear of the 06:00Z brief and 08:00Z canary wakes, for example 10:00Z to 16:00Z. It takes about 45 minutes.
- No step changes a schedule, the canary, Phase 8.1 or release provenance, except the new release in step 3.
- Every step names its expected result. Anything else means stop and roll back from that step.

```
Z="--zone=europe-west2-b --project=project-c407f628-c71c-45fa-994 --account=kerneljson@gmail.com --tunnel-through-iap"
VM=kerneljson-prod-01
SHA=<PR #60 merge commit, 40 hex>     SHORT=${SHA:0:7}
TENANT=<KJ_ADMISSION_TENANT_ID in the door env; public>
MCP_PRINCIPAL=<a new v4 UUID, made once and written here>
W=kerneljson-execution-worker-1   G=kerneljson-admission-door-gateway-1
APP=/opt/kerneljson/app            OPS=/tmp/kjwin/build-$SHORT/infrastructure/ops   # OPS exists from P6 on
SC="python C:\Users\jonny\Desktop\new-system\AgentHub\scripts\secretctl.py"
```

## Before the window (nothing in production changes)

| # | Do | Expect |
|---|---|---|
| P1 | ChatGPT, Settings, Apps: turn on Developer mode, look for **Create** | Both present. If not, stop: the plan cannot use custom servers (see OPERATOR_MCP.md, "Which ChatGPT plans") |
| P2 | One-time setup in OPERATOR_MCP.md (Google client, DNS, secrets) | `$SC check kerneljson/MCP_GOOGLE_CLIENT_SECRET kerneljson/MCP_TOKEN_SIGNING_KEY kerneljson/KJ_MCP_BEARER` reports all three, the last two at length 64. `nslookup kj-mcp.jonnyai.co.uk` gives `34.105.219.103` |
| P3 | Merge PR #60 | `gh run list --commit $SHA` shows `validate` and `identity-cognition-mutations` succeeded |
| P4 | Claude prepares `/tmp/kjwin/mcp-prep.sh`, `mcp-deploy.sh` and `activate60.js` from the 21/10 `07eac9f` scripts, with prior epoch 15 and a new request UUID. Jonny reads them | Scripts on the VM. Diff against the `07eac9f` versions is only the SHA, the epoch, the evidence text and the door env keys below |
| P5 | Secrets to the VM, laptop side: `$SC get kerneljson/KJ_MCP_BEARER --out kjmcp.bearer --expect-len 64`, then `$SC env kerneljson --out mcp.secrets.env --only MCP_GOOGLE_CLIENT_SECRET,MCP_TOKEN_SIGNING_KEY,KJ_MCP_BEARER`, then `gcloud compute scp kjmcp.bearer mcp.secrets.env ${VM}:/tmp/kjwin/ $Z`, then `$SC shred kjmcp.bearer mcp.secrets.env` | Lengths printed, never values. Both files in `/tmp/kjwin`, none left on the laptop |
| P6 | `sudo bash /tmp/kjwin/mcp-prep.sh $SHA`. It builds both images and stages the env files. The door env gains `--set-from KJ_MCP_BEARER=/tmp/kjwin/kjmcp.bearer`, `--set-public KJ_MCP_PRINCIPAL_ID=$MCP_PRINCIPAL` and `--set-public KJ_MCP_PRINCIPAL_KIND=SERVICE` | `verify` passes with door changes exactly `KERNELJSON_RELEASE_ID,KJ_MCP_BEARER,KJ_MCP_PRINCIPAL_ID,KJ_MCP_PRINCIPAL_KIND` and worker changes exactly `KERNELJSON_RELEASE_ID,EXPECTED_RELEASE_ID`. Rollback copies equal live |

## The window

| # | Do (on the VM unless marked) | Expect |
|---|---|---|
| 1 | Baseline, read only: `morning-check.js`, `counts.js`, `docker ps --format '{{.Names}} {{.ID}} {{.Status}}'` | Epoch 15, release `07eac9f`, nonterminal 0, next brief and canary wakes armed. Record container IDs. Then `docker exec -i $G node - < $OPS/mcp-door-check.js` prints `MCP_DOOR NOT_CONFIGURED`: the check fails before the change |
| 2 | `docker exec -i $W node - show $TENANT $MCP_PRINCIPAL < $OPS/mcp-principal.js`, then the same with `create` | `show` prints `MCP_PRINCIPAL NONE`. `create` prints `"kind":"SERVICE","role":"operator","status":"ACTIVE"` |
| 3 | `sudo bash /tmp/kjwin/mcp-deploy.sh $SHA`: stop the door, check 0 nonterminal, recreate the worker, activate, start the door | `ACTIVATED {"epoch":16,...}` and `DEPLOY OK $SHORT`. `docker logs $G` shows `mcp=$MCP_PRINCIPAL` |
| 4 | `docker exec -i $G node - < $OPS/mcp-door-check.js` | Seven `PASS` lines, then `MCP_DOOR OK` |
| 5 | Release checks (`smoke-check.js`) and `morning-check.js` | HEALTHY at epoch 16. Brief and canary wakes still armed. Restate and n8n container IDs unchanged |
| 6 | Network and Caddy. Run `docker network create kj-mcp-edge`. Back up `/opt/n8n/compose.yaml` and `/opt/n8n/Caddyfile` to `*.pre-mcp`. Add `kj-mcp-edge` (external) to the `caddy` service. Run `docker compose -f /opt/n8n/compose.yaml up -d caddy` | Only `n8n-caddy-1` restarts. `curl -s -o /dev/null -w '%{http_code}' https://n8n.jonnyai.co.uk` gives 200 (or the basic-auth 401 it gave before) |
| 7 | MCP env. Create `/opt/kerneljson/runtime/mcp/public.env` (root, mode 600) with `MCP_PUBLIC_URL=https://kj-mcp.jonnyai.co.uk`, `MCP_ALLOWED_GOOGLE_SUB=0`, `GOOGLE_CLIENT_ID=<id>`, `MCP_REGISTRATION=open`, `KERNELJSON_RELEASE_ID=$SHA`. Then `install -m 600 -o root -g root /tmp/kjwin/mcp.secrets.env /opt/kerneljson/runtime/mcp/secrets.env` and `shred -u /tmp/kjwin/mcp.secrets.env /tmp/kjwin/kjmcp.bearer` | `cut -d= -f1 /opt/kerneljson/runtime/mcp/secrets.env` lists exactly `MCP_GOOGLE_CLIENT_SECRET`, `MCP_TOKEN_SIGNING_KEY`, `KJ_MCP_BEARER`. Names only; never `cat` the file |
| 8 | Start. `cd $APP/infrastructure/docker` and run `KJ_MCP_IMAGE=kerneljson-admission-door:$SHORT docker compose --env-file /opt/kerneljson/runtime/mcp/public.env --env-file /opt/kerneljson/runtime/mcp/secrets.env -f mcp.compose.yaml up -d`. Append `$APP/infrastructure/caddy/kj-mcp.Caddyfile` to `/opt/n8n/Caddyfile`. Run `docker exec n8n-caddy-1 caddy validate --config /etc/caddy/Caddyfile`, then `caddy reload` the same way | `kerneljson-mcp` healthy with no published ports. `Valid configuration`. Then from the laptop, the four checks below |
| 9 | Your subject id. Do step 10a once: Google shows "Not permitted" with your id. Put it in `public.env` as `MCP_ALLOWED_GOOGLE_SUB` and re-run the step 8 `up -d` | Container recreated. `docker logs kerneljson-mcp` shows `signin_refused` once, from the placeholder |

**Step 8, laptop checks:**
- `curl -s https://kj-mcp.jonnyai.co.uk/.well-known/oauth-protected-resource/mcp` names `https://kj-mcp.jonnyai.co.uk/mcp`.
- `curl -si -X POST https://kj-mcp.jonnyai.co.uk/mcp` gives `401` with `www-authenticate: Bearer resource_metadata=...`.
- `curl -s -o /dev/null -w '%{http_code}' https://kj-mcp.jonnyai.co.uk/anything` gives `404`.
- The rate limit is live: `for i in $(seq 31); do curl -s -o /dev/null -w '%{http_code} ' "https://kj-mcp.jonnyai.co.uk/oauth/authorize"; done` ends in `429`. It resets after a minute; wait that minute before step 9.

## Step 10: the real ChatGPT connection test

Run it in ChatGPT on the web. Every line must hold.

| # | Do | Pass |
|---|---|---|
| 10a | Settings, Apps, Create: URL `https://kj-mcp.jonnyai.co.uk/mcp`, OAuth (OPERATOR_MCP.md, "Connecting ChatGPT") | Google chooser, then "Allow access to KernelJSON?" naming ChatGPT and `https://chatgpt.com`. After Allow, ten `kj_*` tools listed |
| 10b | New chat, **+**, enable KernelJSON. "Check KernelJSON's health" | A read call, no confirmation asked. Answer shows epoch 16 and `doorMatchesActive: true` |
| 10c | "What tasks ran today?" | Lists today's tasks, including the 06:00Z brief |
| 10d | "Run a morning brief" | ChatGPT asks to confirm, you confirm, it returns a task id. The brief reaches Telegram within about 5 minutes. On the VM the admission row for that task has `principal_id = $MCP_PRINCIPAL` and source `kerneljson:channel/chatgpt-mcp/v1` |
| 10e | "Follow that task until it finishes" | `kj_get_task` shows COMPLETED. Evidence is listed |
| 10f | On the VM: `docker logs kerneljson-mcp 2>&1 \| grep -c 'kjm1\.'` | `0`: no token text in the log |

Record the plan used and the result of 10d, which is the write call. If 10d is "blocked by OpenAI's safety checks", record it, retry once in a new chat, and leave the deploy in place: reads still work and the block happens inside ChatGPT.

| # | Then | Expect |
|---|---|---|
| 11 | Set `MCP_REGISTRATION=closed` in `public.env` and re-run the step 8 `up -d` | 10b still works in a new chat. `POST /oauth/register` from the laptop gives 403 |
| 12 | Next morning, the usual 07:15 check and the canary after 09:00 | Brief and canary as normal on epoch 16 |

## Rollback

Use the smallest one that covers the fault. R1 and R2 remove the MCP completely and leave the release in place.

| # | Do | Expect |
|---|---|---|
| R1 | Surface. Run `docker compose -f $APP/infrastructure/docker/mcp.compose.yaml down`. Restore `/opt/n8n/Caddyfile.pre-mcp` and `caddy reload`. Restore `/opt/n8n/compose.yaml.pre-mcp` and `up -d caddy`. Optionally `vercel dns rm` the `kj-mcp` record | `kj-mcp.jonnyai.co.uk` no longer answers. n8n 200 as before |
| R2 | Credential. `docker exec -i $W node - revoke $TENANT $MCP_PRINCIPAL < $OPS/mcp-principal.js` | `"status":"REVOKED"`. `mcp-door-check.js` now fails `health readable` with 403 |
| R3 | Release, only if the door or worker misbehave. Back to `07eac9f` under `RELEASE_PROVENANCE.md`: stop the door, install `worker.before.env`, recreate the worker on `kerneljson-worker:07eac9f`, activate `07eac9f` as epoch 17 (new request UUID), install `door.before.env` (no MCP keys), recreate the door on `kerneljson-admission-door:07eac9f`. The rollback copies are in the directory `mcp-prep.sh` printed | Release checks HEALTHY on `07eac9f`, epoch 17. `mcp-door-check.js` prints `MCP_DOOR NOT_CONFIGURED` |
