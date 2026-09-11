# S1 Canary Gate 3 — admission-door bootstrap (Change Plan A, repo-only)

Date: 2026-09-11 (Europe/London).
Scope: **REPO-ONLY. No secret creation, no jVault mutation, no deploy, no production admission, no
canary enable/fire, no Restate deploy.** This documents the code that turns the reviewed
`createGateway(...)` handler into a runnable production admission door. It changes no admission
semantics; it adds a bootstrap, a deterministic identity resolver, a health probe, tests, and a
deploy artefact.

Closes GAP D's tooling half (the door being runnable). Deploying it, provisioning the bearer, and
the first real admission remain separately gated (see section 7).

---

## 1. Architecture

```
fire-once  -> HttpAdmissionGateway  -> POST {KJ_ADMISSION_URL}/v1/tasks
                                          │  Authorization: Bearer <KJ_ADMISSION_BEARER>
                                          │  Idempotency-Key: fireIdentity
                                          ▼
                       apps/gateway/src/main.ts  (NEW bootstrap)
                         - pg.Pool from DATABASE_URL (production Postgres)
                         - bearer resolver: constant-time match -> fixed TenantContext
                         - GET /healthz (liveness; no auth, no DB, no admission)
                         - createGateway(...)  (UNCHANGED admission semantics)
                                          ▼
                    withTenant (ACTIVE membership + role) -> allow-list enum
                    -> kernel_private.task_admissions (idempotent on tenant/principal/key)
                    -> canonical child task (compileIntent + persistBinding)
                    -> dispatch (Restate if configured, else UNRESOLVED)
```

The bootstrap ([apps/gateway/src/main.ts](../../../apps/gateway/src/main.ts)) is the only new
runtime code. `apps/gateway/src/server.ts` is untouched: allow-list
(`z.enum(['uppercase/v1','uppercase-reverse/v1','claude_md_check/v1'])`, no wildcard),
`Idempotency-Key = fireIdentity`, the 409 payload-conflict guard, `task_admissions` persistence and
canonical task creation all remain exactly as reviewed and merged on `main`.

## 2. Required environment (names only; NO values in this repo)

| Var | Required | Sensitive | Meaning |
|---|---|---|---|
| `DATABASE_URL` | yes | **yes** | production Postgres (canary project). Never logged. |
| `KJ_ADMISSION_BEARER` | yes | **yes** | the bearer the door accepts. Never logged, never argv, never persisted. |
| `KJ_ADMISSION_TENANT_ID` | yes | no | tenant the bearer maps to (`5f97…`). |
| `KJ_ADMISSION_PRINCIPAL_ID` | yes | no | principal the bearer maps to (`da5c…`). |
| `KJ_ADMISSION_PRINCIPAL_KIND` | yes | no | `HUMAN` or `SERVICE`; must match the principal's DB kind (HUMAN for the canary). |
| `PORT` | no (default 8081) | no | listen port (bound to 127.0.0.1 behind Caddy). |
| `KERNELJSON_RELEASE_ID` | no | no | release tag on bindings. |
| `KJ_RESTATE_INGRESS_URL` | no | no | set => real Restate dispatch; unset => admission-only mode. |

Bootstrap fails closed (exit 2, prints only an error CODE) if any required var is missing/invalid.
`KJ_ADMISSION_BEARER` and `DATABASE_URL` never appear in any log line or error message.

## 3. Auth resolver semantics

`createBearerResolver(bearer, context)` returns a resolver used by the reviewed
`bearerAuthenticator`. It SHA-256s the presented token and compares it to the configured bearer with
`crypto.timingSafeEqual` (constant time; no length or short-circuit leak). On an exact match it
returns a single, frozen `TenantContext = { tenantId, principal: { id, kind } }`; any other token
returns `null`, which becomes 401. The mapping is a pure function of env config, so it is identical
across restarts and every request. This stability matters: the door's idempotency scope is
`(tenant, principal, Idempotency-Key)`, so a drifting principal would create a second logical
admission domain and could double-mint. DB-level authority (ACTIVE membership + role permitting
`submit`) is still enforced by `withTenant`; the resolver only asserts which identity.

## 4. Health endpoint

`GET /healthz` -> `200 {"status":"ok"}`. Liveness only: intercepted before the gateway, so it needs
no bearer, touches no DB, admits nothing, and leaks no internal detail. (A DB-readiness probe is a
possible later addition; kept out here to hold scope.)

## 5. Dispatch behaviour (what happens after canonical admission today)

Admission (the `task_admissions` row + canonical child task) is persisted BEFORE dispatch. Then:
- **`KJ_RESTATE_INGRESS_URL` set:** the existing `createRestateDispatch` posts to Restate; a running
  Restate returns ACCEPTED, a down one is caught and recorded UNRESOLVED. No fake success.
- **unset (admission-only, the first-fire posture):** dispatch resolves **UNRESOLVED** explicitly.
  The task is admitted and bound; execution to completion is GAP E/F (executor/verifier + Restate),
  still gated. This is why admission-only is safe and honest: the canonical id exists for the
  scheduler fire to bind, and nothing pretends the work ran.

Control actions (`/v1/tasks/{id}/{cancel,signal,approve}`) resolve UNSUPPORTED (409) in
admission-only mode; fire-once never calls them.

## 6. Deployment topology (artefact only; NOT deployed)

- Image: [infrastructure/docker/gateway.Dockerfile](../../../infrastructure/docker/gateway.Dockerfile)
  (mirrors `worker.Dockerfile`; `CMD node --import tsx apps/gateway/src/main.ts`).
- Compose: [infrastructure/docker/gateway.compose.yaml](../../../infrastructure/docker/gateway.compose.yaml)
  — env-reference only, no values; publishes `127.0.0.1:${PORT}`; healthcheck hits `/healthz`;
  `restart: unless-stopped`; graceful SIGTERM/SIGINT drain.
- Intended runtime: estate VM localhost, Caddy `reverse_proxy` the door's public host to
  `http://127.0.0.1:${PORT}`, TLS terminated at Caddy. `DATABASE_URL` and `KJ_ADMISSION_BEARER`
  injected at deploy time from jVault (e.g. `jvault run --project kerneljson-canary-admit -- …`),
  never committed.
- `KJ_ADMISSION_URL` for fire-once is the door's reachable origin; fire-once runs on the VM
  (localhost) or the laptop (via Caddy HTTPS / IAP). Both the door and fire-once use the same
  production Postgres, so the fire binds to the canonical id the door mints.

## 7. Remaining production prerequisites (still gated)

1. **Deploy the door** (Change Plan C): build/run the image on the VM, Caddy route, reachability.
2. **Provision `KJ_ADMISSION_BEARER`** (Change Plan B): generate with a CSPRNG (>= 32 bytes), store
   in a narrow jVault `kerneljson` project, inject at run time. Not created.
3. **`resolve` identity** must map to the canary tenant `5f97…` + principal `da5c…` (HUMAN,
   ACTIVE operator membership) — set via the `KJ_ADMISSION_*` env above.
4. **Executor/verifier + digest** (GAP E) and **Restate** (GAP F) for execution to completion —
   only needed beyond admission; the first fire is admission-bind only.

## 8. Exact later approval required

- **B (secret creation):** explicit authorisation to generate + store `KJ_ADMISSION_BEARER`.
- **C (deploy):** explicit authorisation + change window to run the door on the VM and add the Caddy
  route (a production change).
- **E (first admission):** the first valid `claude_md_check/v1` admission is the Gate 3 fire; it
  needs explicit Gate 3 execution approval. Nothing in this PR admits, deploys, or fires.

## 9. Status

Production mutation = NONE. Production deployment = NONE. Qualified in-repo: typecheck 0, lint 0,
build 0; bootstrap unit tests green; door Postgres admission integration green on a disposable local
Postgres 17.6 (healthz-no-admission, 401 missing/wrong bearer, 400 off-allow-list, valid
`claude_md_check/v1` -> 202 + one `task_admissions` row, same-key/same-payload -> same task,
same-key/changed-payload -> 409).
