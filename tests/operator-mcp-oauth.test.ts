import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { buildHandler, loadConfig } from "../apps/mcp/src/main.js";
import { checkIdToken, type GoogleSignIn } from "../apps/mcp/src/oauth/google.js";
import { ACCESS_TTL_S } from "../apps/mcp/src/oauth/server.js";
import { DEFAULT_RATE_LIMITS } from "../apps/mcp/src/oauth/rate-limit.js";
import { TokenSigner } from "../apps/mcp/src/oauth/tokens.js";

/**
 * ADR-0025 end to end: ChatGPT's connector flow against the real MCP server and OAuth server, with a
 * fake Google and a fake door that has the door's idempotency semantics. Rejected access, token expiry,
 * refresh rotation and duplicate action requests are each exercised. The same tools against the real
 * door and Postgres run in tests/operator-mcp.integration.test.ts (CI).
 */
const JONNY = "104857600000000000001";
const STRANGER = "104857600000000000002";
const CHATGPT = "https://chatgpt.com/connector_platform_oauth_redirect";
const DOOR_BEARER = "door-bearer-for-oauth-tests-0123456789";
const SIGNING_KEY = "k".repeat(48);

let clock = Date.UTC(2026, 9, 21, 12, 0, 0);
const now = () => clock;

// ---- fake door: the real door's idempotency contract, and nothing else -------------------------
const admissions = new Map<string, { taskId: string; body: string }>();
const doorSeen: Array<{ key: string | undefined; channel: string | undefined }> = [];
function fakeDoor(req: IncomingMessage, res: ServerResponse): void {
  const reply = (status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
  if (req.headers.authorization !== `Bearer ${DOOR_BEARER}`) return reply(401, { error: "UNAUTHENTICATED" });
  let raw = "";
  req.on("data", (c: Buffer) => (raw += c.toString()));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://door");
    if (req.method === "POST" && url.pathname === "/v1/tasks") {
      const key = req.headers["idempotency-key"] as string | undefined;
      doorSeen.push({ key, channel: req.headers["x-kj-channel"] as string | undefined });
      if (!key) return reply(400, { error: "INVALID_REQUEST" });
      const prior = admissions.get(key);
      if (prior && prior.body !== raw) return reply(409, { error: "IDEMPOTENCY_CONFLICT" });
      const taskId = prior?.taskId ?? randomUUID();
      admissions.set(key, { taskId, body: raw });
      return reply(202, { taskId, status: "RECEIVED", dispatch: "ACCEPTED" });
    }
    if (req.method === "GET" && url.pathname === "/v1/health") return reply(200, { release: { doorMatchesActive: true } });
    const task = /^\/v1\/tasks\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (req.method === "GET" && task) return reply(200, { taskId: task[1], status: "RECEIVED" });
    reply(404, { error: "NOT_FOUND" });
  });
}

// ---- fake Google: a code names who signed in ------------------------------------------------
const googleCalls: Array<{ nonce: string }> = [];
const google: GoogleSignIn = {
  authorizeUrl: ({ state, nonce }) => `https://accounts.google.test/auth?${new URLSearchParams({ state, nonce })}`,
  exchange: async ({ code, nonce }) => {
    googleCalls.push({ nonce });
    return code === "jonny" ? { sub: JONNY } : code === "stranger" ? { sub: STRANGER } : null;
  },
};

let door: Server;
let mcp: Server;
let base = "";
let publicHost = "";
let handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> = async () => {};
let oauthEnv: Record<string, string> = {};

beforeAll(async () => {
  door = createServer(fakeDoor);
  await new Promise<void>((r) => door.listen(0, "127.0.0.1", r));
  const d = door.address();
  if (!d || typeof d === "string") throw new Error("door address");
  mcp = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => mcp.listen(0, "127.0.0.1", r));
  const m = mcp.address();
  if (!m || typeof m === "string") throw new Error("mcp address");
  base = `http://127.0.0.1:${m.port}`;
  publicHost = `127.0.0.1:${m.port}`;
  oauthEnv = {
    MCP_AUTH: "oauth", MCP_PUBLIC_URL: base, MCP_ALLOWED_GOOGLE_SUB: JONNY,
    GOOGLE_CLIENT_ID: "123456789012-test.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "google-secret-for-tests",
    MCP_TOKEN_SIGNING_KEY: SIGNING_KEY, MCP_REGISTRATION: "open", KJ_ADMISSION_URL: `http://127.0.0.1:${d.port}`, KJ_MCP_BEARER: DOOR_BEARER,
    KERNELJSON_RELEASE_ID: "test-release",
  };
  // The flow tests run many sign-ins in one simulated minute from one address, so they get room; the
  // production limits are exercised in their own describe below.
  const roomy = { limit: 100_000, windowMs: 60_000 };
  handler = buildHandler(loadConfig(oauthEnv), { google, now, rateLimits: { perClient: roomy, registerPerClient: roomy, global: roomy } });
});
afterAll(async () => {
  await Promise.all([door, mcp].map((s) => new Promise<void>((r) => s.close(() => r()))));
});
beforeEach(() => {
  clock = Date.UTC(2026, 9, 21, 12, 0, 0);
});

// ---- the connector flow, step by step, as ChatGPT performs it -------------------------------
const form = (values: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(values).toString(),
});

async function registerClient(extra: Record<string, unknown> = {}): Promise<{ client_id: string; client_secret?: string }> {
  const r = await fetch(`${base}/oauth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [CHATGPT], client_name: "ChatGPT", ...extra }),
  });
  expect(r.status).toBe(201);
  return (await r.json()) as { client_id: string; client_secret?: string };
}

async function authorizeToConsent(clientId: string, googleCode = "jonny") {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomUUID();
  const q = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: CHATGPT, code_challenge: challenge, code_challenge_method: "S256",
    state, scope: "kerneljson.operator", resource: `${base}/mcp`,
  });
  const toGoogle = await fetch(`${base}/oauth/authorize?${q}`, { redirect: "manual" });
  expect(toGoogle.status).toBe(302);
  const googleState = new URL(toGoogle.headers.get("location")!).searchParams.get("state")!;
  const back = await fetch(`${base}/oauth/google/callback?${new URLSearchParams({ state: googleState, code: googleCode })}`, { redirect: "manual" });
  return { verifier, state, back };
}

async function consentAndCode(back: Response, decision = "allow") {
  const html = await back.text();
  const ticket = /name="ticket" value="([^"]+)"/.exec(html)![1]!;
  const r = await fetch(`${base}/oauth/consent`, { ...form({ ticket, decision }), headers: { ...form({}).headers, origin: base }, redirect: "manual" });
  expect(r.status).toBe(302);
  return new URL(r.headers.get("location")!);
}

async function exchange(values: Record<string, string>) {
  const r = await fetch(`${base}/oauth/token`, form(values));
  return { status: r.status, body: (await r.json()) as Record<string, string> };
}

async function connect() {
  const { client_id } = await registerClient();
  const { verifier, state, back } = await authorizeToConsent(client_id);
  expect(back.status).toBe(200);
  const redirect = await consentAndCode(back);
  expect(redirect.origin + redirect.pathname).toBe(CHATGPT);
  expect(redirect.searchParams.get("state")).toBe(state);
  expect(redirect.searchParams.get("iss")).toBe(base);
  const tokens = await exchange({ grant_type: "authorization_code", code: redirect.searchParams.get("code")!, redirect_uri: CHATGPT, client_id, code_verifier: verifier, resource: `${base}/mcp` });
  expect(tokens.status).toBe(200);
  return { client_id, ...tokens.body } as { client_id: string; access_token: string; refresh_token: string; expires_in: string };
}

let rpcId = 0;
async function rpc(token: string | null, method: string, params?: unknown) {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json",
      accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", origin: "https://chatgpt.com",
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...(method.startsWith("notifications/") ? {} : { id: ++rpcId }), method, ...(params ? { params } : {}) }),
  });
  return { status: r.status, headers: r.headers, body: r.status === 200 ? ((await r.json()) as { result?: Record<string, unknown>; error?: unknown }) : null };
}
const toolCall = async (token: string, name: string, args: unknown) =>
  (await rpc(token, "tools/call", { name, arguments: args })).body!.result as { isError: boolean; structuredContent: { data?: { taskId?: string }; error?: string } };

/** A raw request, for headers fetch will not let a caller set (Host, forwarding). */
function raw(path: string, headers: Record<string, string>): Promise<number> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path, method: "GET", headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("discovery", () => {
  it("answers an unauthenticated /mcp with 401 pointing at protected-resource metadata, which names this server", async () => {
    const r = await rpc(null, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(r.status).toBe(401);
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(r.headers.get("www-authenticate") ?? "")![1]!;
    const resource = (await (await fetch(metadataUrl)).json()) as { resource: string; authorization_servers: string[] };
    expect(resource.resource).toBe(`${base}/mcp`);
    const as = (await (await fetch(`${resource.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as).toMatchObject({ issuer: base, code_challenge_methods_supported: ["S256"], registration_endpoint: `${base}/oauth/register` });
  });
});

describe("the connected session", () => {
  it("runs the full MCP protocol and tools with a ChatGPT-style token", async () => {
    const { access_token } = await connect();
    const init = await rpc(access_token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ChatGPT", version: "1" } });
    expect(init.body!.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "kerneljson-operator", version: "test-release" } });
    expect((await rpc(access_token, "notifications/initialized")).status).toBe(202);
    expect(((await rpc(access_token, "tools/list")).body!.result as { tools: unknown[] }).tools).toHaveLength(10);
    const health = await toolCall(access_token, "kj_health", {});
    expect(health.isError).toBe(false);
    expect(health.structuredContent.data).toEqual({ release: { doorMatchesActive: true } });
    expect(googleCalls.at(-1)!.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("turns a duplicate action request into the same task, and a changed one under the same id into a conflict", async () => {
    const { access_token } = await connect();
    const requestId = `chat-${randomUUID()}`;
    const first = await toolCall(access_token, "kj_run_brief", { request_id: requestId });
    const again = await toolCall(access_token, "kj_run_brief", { request_id: requestId });
    expect(first.isError).toBe(false);
    expect(again.structuredContent.data!.taskId).toBe(first.structuredContent.data!.taskId);
    const fresh = await toolCall(access_token, "kj_run_brief", { request_id: `chat-${randomUUID()}` });
    expect(fresh.structuredContent.data!.taskId).not.toBe(first.structuredContent.data!.taskId);
    const changed = await toolCall(access_token, "kj_run_analysis", { request_id: requestId, repo: "jonnyallum/kerneljson" });
    expect(changed).toMatchObject({ isError: true, structuredContent: { error: "CONFLICT" } });
    expect(doorSeen.at(-1)).toEqual({ key: `mcp:${requestId}`, channel: "chatgpt-mcp/v1" });
  });

  it("expires access tokens, rotates refresh tokens, and ends the family when a refresh token is replayed", async () => {
    const { client_id, access_token, refresh_token } = await connect();
    expect((await rpc(access_token, "ping")).status).toBe(200);
    clock += (ACCESS_TTL_S + 1) * 1000;
    expect((await rpc(access_token, "ping")).status).toBe(401);
    const refreshed = await exchange({ grant_type: "refresh_token", refresh_token, client_id });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body["refresh_token"]).not.toBe(refresh_token);
    expect((await rpc(refreshed.body["access_token"]!, "ping")).status).toBe(200);
    const replay = await exchange({ grant_type: "refresh_token", refresh_token, client_id });
    expect(replay).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    expect((await rpc(refreshed.body["access_token"]!, "ping")).status).toBe(401);
    expect((await exchange({ grant_type: "refresh_token", refresh_token: refreshed.body["refresh_token"]!, client_id })).status).toBe(400);
  });
});

describe("rejected access", () => {
  it("refuses a different Google account before any code exists", async () => {
    const { client_id } = await registerClient();
    const { back } = await authorizeToConsent(client_id, "stranger");
    expect(back.status).toBe(403);
    expect(back.headers.get("location")).toBeNull();
    const html = await back.text();
    expect(html).not.toContain('name="ticket"');
    expect(html).toContain(STRANGER);
    expect(html).not.toContain(JONNY);
  });

  it("refuses an unverifiable Google sign-in and a denied consent with access_denied", async () => {
    const { client_id } = await registerClient();
    const failed = await authorizeToConsent(client_id, "forged");
    expect(new URL(failed.back.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
    const { back } = await authorizeToConsent(client_id);
    expect((await consentAndCode(back, "deny")).searchParams.get("error")).toBe("access_denied");
  });

  it("refuses a cross-site consent post and a replayed consent ticket", async () => {
    const { client_id } = await registerClient();
    const { back } = await authorizeToConsent(client_id);
    const ticket = /name="ticket" value="([^"]+)"/.exec(await back.text())![1]!;
    const cross = await fetch(`${base}/oauth/consent`, { ...form({ ticket, decision: "allow" }), headers: { ...form({}).headers, origin: "https://evil.example" }, redirect: "manual" });
    expect(cross.status).toBe(403);
    const ok = await fetch(`${base}/oauth/consent`, { ...form({ ticket, decision: "allow" }), headers: { ...form({}).headers, origin: base }, redirect: "manual" });
    expect(ok.status).toBe(302);
    const replay = await fetch(`${base}/oauth/consent`, { ...form({ ticket, decision: "allow" }), headers: { ...form({}).headers, origin: base }, redirect: "manual" });
    expect(replay.status).toBe(400);
  });

  // Found live on 22/10/2026: each passed the fetch tests above and failed in Chrome.
  it("serves the consent page with headers a real browser can complete it under", async () => {
    const { client_id } = await registerClient();
    const { back } = await authorizeToConsent(client_id);
    expect(back.status).toBe(200);
    // no-referrer makes a browser send `Origin: null` on the form POST, which the cross-site check refuses.
    expect(back.headers.get("referrer-policy")).toBe("same-origin");
    // Chrome applies form-action to the redirect after the submit: ChatGPT's origin must be allowed, and only it.
    const csp = back.headers.get("content-security-policy")!;
    expect(/form-action ([^;]+)/.exec(csp)![1]).toBe(`'self' ${new URL(CHATGPT).origin}`);
    const ticket = /name="ticket" value="([^"]+)"/.exec(await back.text())![1]!;
    const nullOrigin = await fetch(`${base}/oauth/consent`, { ...form({ ticket, decision: "allow" }), headers: { ...form({}).headers, origin: "null" }, redirect: "manual" });
    expect(nullOrigin.status).toBe(403);
    // Every other page still allows form posts to this origin only.
    const other = await fetch(`${base}/oauth/authorize?client_id=unknown`, { redirect: "manual" });
    expect(other.headers.get("content-security-policy")).toContain("form-action 'self';");
  });

  it("refuses registration for any redirect except ChatGPT's, and never redirects to an unregistered address", async () => {
    const bad = await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"] }) });
    expect(bad.status).toBe(400);
    const { client_id } = await registerClient();
    const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: "https://evil.example/cb", code_challenge: "a".repeat(43), code_challenge_method: "S256" });
    const r = await fetch(`${base}/oauth/authorize?${q}`, { redirect: "manual" });
    expect(r.status).toBe(400);
    expect(r.headers.get("location")).toBeNull();
    const forgedClient = new TokenSigner("z".repeat(48)).sign({ typ: "client", iss: base, name: "x", redirect_uris: [CHATGPT], auth: "none", iat: 0, jti: "x" });
    const r2 = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: forgedClient, redirect_uri: CHATGPT })}`, { redirect: "manual" });
    expect(r2.status).toBe(400);
  });

  it("requires PKCE S256 and refuses a wrong verifier, a reused code and a code for another client", async () => {
    const { client_id } = await registerClient();
    const noPkce = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id, redirect_uri: CHATGPT, state: "s" })}`, { redirect: "manual" });
    expect(new URL(noPkce.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
    const { verifier, back } = await authorizeToConsent(client_id);
    const code = (await consentAndCode(back)).searchParams.get("code")!;
    const other = await registerClient();
    expect((await exchange({ grant_type: "authorization_code", code, redirect_uri: CHATGPT, client_id: other.client_id, code_verifier: verifier })).status).toBe(400);
    const { verifier: v2, back: back2 } = await authorizeToConsent(client_id);
    const code2 = (await consentAndCode(back2)).searchParams.get("code")!;
    expect((await exchange({ grant_type: "authorization_code", code: code2, redirect_uri: CHATGPT, client_id, code_verifier: verifier })).body["error"]).toBe("invalid_grant");
    expect((await exchange({ grant_type: "authorization_code", code: code2, redirect_uri: CHATGPT, client_id, code_verifier: v2 })).status).toBe(400);
  });

  it("expires an unused authorisation code", async () => {
    const { client_id } = await registerClient();
    const { verifier, back } = await authorizeToConsent(client_id);
    const code = (await consentAndCode(back)).searchParams.get("code")!;
    clock += 6 * 60_000;
    expect((await exchange({ grant_type: "authorization_code", code, redirect_uri: CHATGPT, client_id, code_verifier: verifier })).body["error"]).toBe("invalid_grant");
  });

  it("refuses forged, tampered, mis-typed and foreign-key tokens at /mcp", async () => {
    const { access_token, refresh_token } = await connect();
    const [p, payload, mac] = access_token.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    const tampered = `${p}.${Buffer.from(JSON.stringify({ ...claims, sub: STRANGER })).toString("base64url")}.${mac}`;
    const foreign = new TokenSigner("z".repeat(48)).sign(claims);
    for (const token of [tampered, foreign, refresh_token, "kjm1.x.y", "not-a-token"]) expect((await rpc(token, "ping")).status).toBe(401);
  });

  it("locks out every issued token when the permitted Google subject changes", async () => {
    const { access_token, refresh_token, client_id } = await connect();
    const original = handler;
    handler = buildHandler(loadConfig({ ...oauthEnv, MCP_ALLOWED_GOOGLE_SUB: STRANGER }), { google, now });
    try {
      expect((await rpc(access_token, "ping")).status).toBe(401);
      expect((await exchange({ grant_type: "refresh_token", refresh_token, client_id })).status).toBe(400);
    } finally {
      handler = original;
    }
    expect((await rpc(access_token, "ping")).status).toBe(200);
  });

  it("closes registration without disconnecting a client that is already registered", async () => {
    const { access_token, refresh_token, client_id } = await connect();
    const original = handler;
    handler = buildHandler(loadConfig({ ...oauthEnv, MCP_REGISTRATION: "closed" }), { google, now });
    try {
      const r = await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [CHATGPT] }) });
      expect(r.status).toBe(403);
      expect((await rpc(access_token, "ping")).status).toBe(200);
      expect((await exchange({ grant_type: "refresh_token", refresh_token, client_id })).status).toBe(200);
      const { back } = await authorizeToConsent(client_id);
      expect(back.status).toBe(200);
    } finally {
      handler = original;
    }
    expect(() => loadConfig({ ...oauthEnv, MCP_REGISTRATION: undefined })).toThrow(/MCP_REGISTRATION/);
  });

  it("refuses a confidential client with the wrong secret", async () => {
    const { client_id, client_secret } = await registerClient({ token_endpoint_auth_method: "client_secret_post" });
    expect(client_secret).toBeTruthy();
    const r = await exchange({ grant_type: "authorization_code", code: "x", redirect_uri: CHATGPT, client_id, client_secret: "wrong", code_verifier: "v".repeat(43) });
    expect(r).toMatchObject({ status: 401, body: { error: "invalid_client" } });
  });

  it("serves only its own public host name", async () => {
    expect(await raw("/.well-known/oauth-authorization-server", { host: publicHost })).toBe(200);
    expect(await raw("/.well-known/oauth-authorization-server", { host: "n8n.jonnyai.co.uk" })).toBe(421);
    expect(await raw("/healthz", { host: "anything.invalid" })).toBe(200);
  });
});

describe("the public OAuth endpoints are rate limited (production defaults)", () => {
  let limited: Server;
  let port = 0;
  let t = Date.UTC(2026, 9, 21, 15, 0, 0);
  const lines: string[] = [];
  beforeAll(async () => {
    let h: (req: IncomingMessage, res: ServerResponse) => Promise<void> = async () => {};
    limited = createServer((req, res) => void h(req, res));
    await new Promise<void>((r) => limited.listen(0, "127.0.0.1", r));
    port = (limited.address() as { port: number }).port;
    const env = { ...oauthEnv, MCP_PUBLIC_URL: `http://127.0.0.1:${port}` };
    h = buildHandler(loadConfig(env), { google, now: () => t, log: (l) => lines.push(l) });
  });
  afterAll(() => new Promise<void>((r) => limited.close(() => r())));
  const hit = (path: string, from: string, method = "GET") =>
    new Promise<{ status: number; retryAfter: string | undefined }>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, "x-forwarded-for": from, "content-type": "application/json" } },
        (res) => {
          res.resume();
          resolve({ status: res.statusCode ?? 0, retryAfter: res.headers["retry-after"] as string | undefined });
        },
      );
      req.on("error", reject);
      req.end(method === "POST" ? JSON.stringify({ redirect_uris: [CHATGPT], client_name: "ChatGPT" }) : undefined);
    });

  it("refuses one address after its per-minute allowance, with Retry-After, and recovers when the window ends", async () => {
    const { limit } = DEFAULT_RATE_LIMITS.perClient;
    for (let i = 0; i < limit; i++) expect((await hit("/oauth/authorize", "203.0.113.7")).status).not.toBe(429);
    const refused = await hit("/oauth/authorize", "203.0.113.7");
    expect(refused.status).toBe(429);
    expect(Number(refused.retryAfter)).toBeGreaterThan(0);
    expect(Number(refused.retryAfter)).toBeLessThanOrEqual(60);
    // Other paths under /oauth/ share the allowance; discovery and other addresses do not.
    expect((await hit("/oauth/token", "203.0.113.7", "POST")).status).toBe(429);
    expect((await hit("/.well-known/oauth-authorization-server", "203.0.113.7")).status).toBe(200);
    expect((await hit("/oauth/authorize", "203.0.113.8")).status).not.toBe(429);
    // Only the last X-Forwarded-For entry (the one Caddy writes) names the client.
    expect((await hit("/oauth/authorize", "198.51.100.1, 203.0.113.7")).status).toBe(429);
    expect((await hit("/oauth/authorize", "203.0.113.7, 198.51.100.1")).status).not.toBe(429);
    t += DEFAULT_RATE_LIMITS.perClient.windowMs;
    expect((await hit("/oauth/authorize", "203.0.113.7")).status).not.toBe(429);
    const logged = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l["oauth"] === "rate_limited");
    expect(logged.length).toBeGreaterThan(0);
    expect(logged[0]).toMatchObject({ route: "GET /oauth/authorize", rule: "perClient" });
    expect(lines.join(" ")).not.toContain("203.0.113.7");
  });

  it("allows only a few registrations an hour from one address", async () => {
    t += 3_600_000;
    const { limit } = DEFAULT_RATE_LIMITS.registerPerClient;
    for (let i = 0; i < limit; i++) expect((await hit("/oauth/register", "192.0.2.50", "POST")).status).toBe(201);
    expect((await hit("/oauth/register", "192.0.2.50", "POST")).status).toBe(429);
    t += DEFAULT_RATE_LIMITS.perClient.windowMs; // the per-minute window resets, the hourly one does not
    expect((await hit("/oauth/register", "192.0.2.50", "POST")).status).toBe(429);
    expect((await hit("/oauth/authorize", "192.0.2.50")).status).not.toBe(429);
  });

  it("caps everyone together, so many addresses cannot fill the sign-in table", async () => {
    t += 3_600_000;
    const { limit } = DEFAULT_RATE_LIMITS.global;
    for (let i = 0; i < limit; i++) expect((await hit("/oauth/authorize", `10.1.${Math.floor(i / 250)}.${i % 250}`)).status).not.toBe(429);
    expect((await hit("/oauth/authorize", "10.9.9.9")).status).toBe(429);
    t += DEFAULT_RATE_LIMITS.global.windowMs;
    expect((await hit("/oauth/authorize", "10.9.9.9")).status).not.toBe(429);
  });
});

describe("local unauthenticated mode cannot be reached through a proxy", () => {
  let local: Server;
  let port = 0;
  beforeAll(async () => {
    const handler = buildHandler(loadConfig({ MCP_AUTH: "local-unauthenticated", KJ_ADMISSION_URL: "http://127.0.0.1:9", KJ_MCP_BEARER: DOOR_BEARER }));
    local = createServer((req, res) => void handler(req, res));
    await new Promise<void>((r) => local.listen(0, "127.0.0.1", r));
    port = (local.address() as { port: number }).port;
  });
  afterAll(() => new Promise<void>((r) => local.close(() => r())));
  const post = (headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { "content-type": "application/json", ...headers } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
    });

  it("answers a direct loopback call and refuses every proxied shape", async () => {
    expect(await post({ host: `127.0.0.1:${port}` })).toBe(200);
    expect(await post({ host: "kj-mcp.jonnyai.co.uk" })).toBe(421);
    for (const h of ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "via", "x-real-ip"])
      expect(await post({ host: `127.0.0.1:${port}`, [h]: "1.2.3.4" })).toBe(421);
  });

  it("refuses to start on a non-loopback address", () => {
    expect(() => loadConfig({ MCP_AUTH: "local-unauthenticated", MCP_HOST: "0.0.0.0", KJ_ADMISSION_URL: "http://x", KJ_MCP_BEARER: DOOR_BEARER })).toThrow(/loopback/);
  });
});

describe("Google ID token checks", () => {
  const idToken = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
  const good = { iss: "https://accounts.google.com", aud: "cid.apps.googleusercontent.com", sub: JONNY, exp: 2_000_000_000, nonce: "n" };
  const expect_ = { clientId: "cid.apps.googleusercontent.com", nonce: "n", nowSeconds: 1_900_000_000 };
  it("accepts only Google's issuer, this client, an unexpired token and the request's nonce", () => {
    expect(checkIdToken(idToken(good), expect_)).toEqual({ sub: JONNY });
    for (const bad of [
      { ...good, iss: "https://evil.example" }, { ...good, aud: "other.apps.googleusercontent.com" }, { ...good, aud: [good.aud, "other"] },
      { ...good, exp: 1_800_000_000 }, { ...good, nonce: "other" }, { ...good, nonce: undefined }, { ...good, sub: "not-digits" },
    ])
      expect(checkIdToken(idToken(bad), expect_)).toBeNull();
    expect(checkIdToken("not.a-token", expect_)).toBeNull();
  });
});
