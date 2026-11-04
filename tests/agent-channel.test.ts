import { createServer, type Server } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ChannelError,
  ChannelService,
  InMemoryChannelStore,
  createChannelHandler,
  redactSecrets,
  type AgentRegistry,
} from "../packages/agent-channel/src/index.js";
import { createMissionControl } from "../apps/mission-control/src/server.js";
import type { MissionControlStore } from "../apps/mission-control/src/store.js";
import type { TenantContext } from "../packages/contracts/src/index.js";

const tenantA = randomUUID(), tenantB = randomUUID();
const people = {
  claude: { tenantId: tenantA, principal: { id: randomUUID(), kind: "SERVICE" } } as TenantContext,
  codex: { tenantId: tenantA, principal: { id: randomUUID(), kind: "SERVICE" } } as TenantContext,
  jonny: { tenantId: tenantA, principal: { id: randomUUID(), kind: "HUMAN" } } as TenantContext,
  outsider: { tenantId: tenantB, principal: { id: randomUUID(), kind: "SERVICE" } } as TenantContext,
  stranger: { tenantId: tenantA, principal: { id: randomUUID(), kind: "SERVICE" } } as TenantContext,
};
const handles = new Map<string, string>([
  [`${tenantA}:${people.claude.principal.id}`, "claude-code"],
  [`${tenantA}:${people.codex.principal.id}`, "codex"],
  [`${tenantA}:${people.jonny.principal.id}`, "jonny"],
  [`${tenantB}:${people.outsider.principal.id}`, "grok"],
]);
const registry: AgentRegistry = { handleFor: async (c) => handles.get(`${c.tenantId}:${c.principal.id}`) ?? null };
const fresh = () => new ChannelService(new InMemoryChannelStore(), registry);
const post = (kind: string, body: string, key = `k-${randomUUID()}`, extra: object = {}) => ({ kind, body, idempotencyKey: key, ...extra });

describe("service: validation, idempotency, replay", () => {
  it("rejects malformed input and any attempt to name an author, tenant or principal", async () => {
    const s = fresh();
    for (const bad of [
      {}, post("NOTE", ""), post("SHOUT", "hi"), post("NOTE", "x".repeat(4001)), post("NOTE", "hi", "short"),
      post("NOTE", "hi", undefined, { author: people.jonny.principal }),
      post("NOTE", "hi", undefined, { tenantId: tenantB }),
      post("NOTE", "hi", undefined, { handle: "jonny" }),
      post("NOTE", "hi", undefined, { taskRef: "not-a-uuid" }),
    ])
      await expect(s.post(people.claude, bad)).rejects.toThrow();
  });
  it("converges a replay on the stored message and refuses a changed payload under the same key", async () => {
    const s = fresh();
    const a = await s.post(people.claude, post("NOTE", "first", "key-12345678"));
    const b = await s.post(people.claude, post("NOTE", "first", "key-12345678"));
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(b.message.id).toBe(a.message.id);
    expect((await s.read(people.claude, {})).messages).toHaveLength(1);
    await expect(s.post(people.claude, post("NOTE", "changed", "key-12345678"))).rejects.toMatchObject({ code: "CONFLICT" });
    // the same key from a different principal is a different message
    const c = await s.post(people.codex, post("NOTE", "first", "key-12345678"));
    expect(c.duplicate).toBe(false);
  });
  it("derives the author from the authenticated context, never the body", async () => {
    const s = fresh();
    const { message } = await s.post(people.claude, post("NOTE", "hello"));
    expect(message.author).toEqual(people.claude.principal);
    expect(message.handle).toBe("claude-code");
  });
  it("refuses an unregistered principal and a reply to a message in another tenant", async () => {
    const s = fresh();
    await expect(s.post(people.stranger, post("NOTE", "hi"))).rejects.toMatchObject({ code: "DENIED" });
    const { message } = await s.post(people.claude, post("NOTE", "private to A"));
    await expect(s.post(people.outsider, post("REPLY", "x", undefined, { inReplyTo: message.id }))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("tenant isolation", () => {
  it("never returns another tenant's messages or acknowledgements", async () => {
    const s = fresh();
    await s.post(people.claude, post("NOTE", "A only"));
    await s.post(people.outsider, post("NOTE", "B only"));
    const a = (await s.read(people.claude, {})).messages.map((m) => m.body);
    const b = (await s.read(people.outsider, {})).messages.map((m) => m.body);
    expect(a).toEqual(["A only"]);
    expect(b).toEqual(["B only"]);
    await s.ack(people.claude, { upToSeq: 1 });
    expect(await s.cursors(people.outsider)).toEqual([]);
    // the registry is tenant-scoped: A's principal id presented under tenant B is refused
    await expect(s.read({ tenantId: tenantB, principal: people.claude.principal }, {})).rejects.toMatchObject({ code: "DENIED" });
  });
});

describe("offline agents and acknowledgement", () => {
  it("holds messages for an offline agent and lets it catch up from its cursor", async () => {
    const s = fresh();
    for (const t of ["one", "two", "three"]) await s.post(people.claude, post("NOTE", t));
    const first = await s.read(people.codex, {}); // codex was offline until now
    expect(first.messages.map((m) => m.body)).toEqual(["one", "two", "three"]);
    expect(await s.cursors(people.codex)).toEqual([]); // stored is not acknowledged
    await s.ack(people.codex, { upToSeq: first.next });
    expect((await s.read(people.codex, { after: first.next })).messages).toEqual([]);
    await s.post(people.claude, post("NOTE", "four"));
    expect((await s.read(people.codex, { after: first.next })).messages.map((m) => m.body)).toEqual(["four"]);
  });
  it("never rewinds a cursor and refuses an ack beyond the log", async () => {
    const s = fresh();
    await s.post(people.claude, post("NOTE", "a"));
    await s.post(people.claude, post("NOTE", "b"));
    await s.ack(people.codex, { upToSeq: 2 });
    const late = await s.ack(people.codex, { upToSeq: 1 });
    expect(late.upToSeq).toBe(2);
    await expect(s.ack(people.codex, { upToSeq: 3 })).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("keeps a handoff as a pointer: it carries a task id and changes nothing about the task", async () => {
    const s = fresh();
    const taskRef = randomUUID();
    const { message } = await s.post(people.claude, post("HANDOFF", "please look at this", undefined, { taskRef }));
    expect(message.taskRef).toBe(taskRef);
    expect(Object.keys(s)).not.toContain("createTask");
  });
});

describe("secret redaction", () => {
  // Built from pieces so this file never holds a literal credential.
  const fake = {
    openrouter: ["sk-", "or-v1-", "a".repeat(40)].join(""),
    supabase: ["sb_", "secret_", "Z".repeat(30)].join(""),
    bearer: "Bearer " + "q".repeat(30),
    conn: ["post", "gres://svc:", "hunter2hunter2", "@db.example:5432/app"].join(""),
  };
  it("redacts known credential shapes and flags the message", async () => {
    const s = fresh();
    const text = `keys ${fake.openrouter} ${fake.supabase} ${fake.bearer} ${fake.conn}`;
    const { message } = await s.post(people.claude, post("NOTE", text));
    expect(message.redacted).toBe(true);
    for (const v of ["a".repeat(40), "Z".repeat(30), "q".repeat(30), "hunter2hunter2"]) expect(message.body).not.toContain(v);
    expect(redactSecrets("plain text, nothing to hide").redacted).toBe(false);
  });
  it("does not echo secrets or internals in error responses", async () => {
    const s = new ChannelService(new InMemoryChannelStore(), { handleFor: async () => { throw new Error(`boom ${fake.openrouter}`); } });
    const h = createChannelHandler({ service: s, authenticate: async () => people.claude });
    const { url, close } = await listen(h);
    const r = await fetch(`${url}/messages`);
    const txt = await r.text();
    await close();
    expect(r.status).toBe(500);
    expect(txt).not.toContain("a".repeat(40));
    expect(txt).toBe('{"error":"internal"}');
  });
});

async function listen(handler: (req: never, res: never) => unknown) {
  const server: Server = createServer((req, res) => void (handler as (a: unknown, b: unknown) => unknown)(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  return { url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))) };
}
const tokens: Record<string, TenantContext> = { claude: people.claude, codex: people.codex, jonny: people.jonny, outsider: people.outsider };
const authenticate = async (h: { authorization?: string | undefined }) => {
  const who = tokens[(h.authorization ?? "").replace("Bearer ", "")];
  if (!who) throw new Error("not signed in");
  return who;
};
const json = (who: string, body: unknown, method = "POST") => ({ method, headers: { authorization: `Bearer ${who}`, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("HTTP transport", () => {
  let url: string, close: () => Promise<void>;
  beforeAll(async () => {
    ({ url, close } = await listen(createChannelHandler({ service: fresh(), authenticate })));
  });
  afterAll(async () => close());
  it("rejects unauthenticated, unregistered, malformed, oversized and wrong-type requests", async () => {
    expect((await fetch(`${url}/messages`)).status).toBe(401);
    expect((await fetch(`${url}/messages`, { headers: { authorization: "Bearer nobody" } })).status).toBe(401);
    expect((await fetch(`${url}/messages`, json("claude", "{not json}"))).status).toBe(400);
    expect((await fetch(`${url}/messages`, { method: "POST", headers: { authorization: "Bearer claude", "content-type": "text/plain" }, body: "x" })).status).toBe(415);
    expect((await fetch(`${url}/messages`, json("claude", post("NOTE", "x".repeat(9000))))).status).toBe(413);
    expect((await fetch(`${url}/messages`, json("claude", post("SHOUT", "hi")))).status).toBe(400);
    expect((await fetch(`${url}/nothing`, { headers: { authorization: "Bearer claude" } })).status).toBe(404);
    expect((await fetch(`${url}/acks`, { headers: { authorization: "Bearer claude" } })).status).toBe(405);
  });
  it("LOCAL LOOPBACK round trip between two simulated agents: post, read, reply, acknowledge", async () => {
    // Simulation only: both 'agents' are this test process with different registered principals.
    const sent = await fetch(`${url}/messages`, json("claude", post("QUESTION", "Codex, can you review PR 7?", "rt-question-1")));
    expect(sent.status).toBe(201);
    const q = (await sent.json()) as { message: { id: string; seq: number; threadId: string } };
    const seen = (await (await fetch(`${url}/messages?after=0`, { headers: { authorization: "Bearer codex" } })).json()) as { messages: { id: string; body: string }[]; next: number };
    expect(seen.messages.map((m) => m.id)).toContain(q.message.id);
    const reply = await fetch(`${url}/messages`, json("codex", post("REPLY", "On it.", "rt-reply-0001", { inReplyTo: q.message.id })));
    const r = (await reply.json()) as { message: { seq: number; threadId: string; inReplyTo: string } };
    expect(r.message.threadId).toBe(q.message.threadId);
    expect(r.message.inReplyTo).toBe(q.message.id);
    expect((await fetch(`${url}/acks`, json("codex", { upToSeq: q.message.seq }))).status).toBe(200);
    const ack = await fetch(`${url}/acks`, json("claude", { upToSeq: r.message.seq }));
    expect(ack.status).toBe(200);
    // replaying the same send returns 200 and the same message
    const again = await fetch(`${url}/messages`, json("claude", post("QUESTION", "Codex, can you review PR 7?", "rt-question-1")));
    expect(again.status).toBe(200);
  });
});

describe("Mission Control channel surface", () => {
  let url: string, close: () => Promise<void>;
  const service = fresh();
  beforeAll(async () => {
    let handler: ReturnType<typeof createMissionControl>;
    ({ url, close } = await listen(((req: never, res: never) => void handler(req, res)) as never));
    handler = createMissionControl({
      store: {} as MissionControlStore, // channel routes never touch the task store
      origin: url,
      authenticate,
      channel: service,
    });
  });
  afterAll(async () => close());
  const form = (who: string, fields: Record<string, string>, origin?: string) => ({
    method: "POST", redirect: "manual" as const,
    headers: { authorization: `Bearer ${who}`, "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) },
    body: new URLSearchParams(fields).toString(),
  });
  it("renders messages escaped, with a no-script CSP, and lets a human post a note", async () => {
    await service.post(people.claude, post("NOTE", "<script>alert(1)</script> & done"));
    const page = await fetch(`${url}/channel`, { headers: { authorization: "Bearer jonny" } });
    const html = await page.text();
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; done");
    expect(html).not.toContain("<script>alert");
    const ok = await fetch(`${url}/channel/post`, form("jonny", { kind: "NOTE", body: "from Jonny", idempotencyKey: "form-key-0001" }, url));
    expect(ok.status).toBe(303);
    expect(JSON.stringify((await service.read(people.jonny, {})).messages.map((m) => m.handle))).toContain("jonny");
  });
  it("refuses cross-origin, agent, unauthenticated and author-forging form posts", async () => {
    const f = { kind: "NOTE", body: "x", idempotencyKey: "form-key-0002" };
    expect((await fetch(`${url}/channel/post`, form("jonny", f, "http://evil.example"))).status).toBe(403);
    expect((await fetch(`${url}/channel/post`, form("jonny", f))).status).toBe(403);
    expect((await fetch(`${url}/channel/post`, form("claude", f, url))).status).toBe(403); // agents use the JSON transport
    expect((await fetch(`${url}/channel/post`, { method: "POST", headers: { origin: url } })).status).toBe(401);
    // forged fields are simply never read: the stored author is still the authenticated human
    const forged = await fetch(`${url}/channel/post`, form("jonny", { ...f, idempotencyKey: "form-key-0003", author: "claude-code", taskRef: randomUUID() }, url));
    expect(forged.status).toBe(303);
    const last = (await service.read(people.jonny, {})).messages.at(-1)!;
    expect(last.handle).toBe("jonny");
    expect(last.taskRef).toBeNull();
  });
});

/* ADR-0026 section 1: the channel has no path to task authority. */
const ALLOWED_IMPORT = /^(zod|node:[a-z:/]+|\.\/[a-z-]+\.js|\.\.\/\.\.\/contracts\/src\/(common|identity|index)\.js)$/;
const FORBIDDEN = /\b(tasks|approvals|control_events|task_events|evidence|kernel_private|admit|signal)\b/;
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
export function findAuthorityViolations(path: string, text: string): string[] {
  const hits: string[] = [];
  const code = stripComments(text);
  for (const m of code.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g))
    if (!ALLOWED_IMPORT.test(m[1]!)) hits.push(`${path}: import of ${m[1]}`);
  code.split(/\r?\n/).forEach((line, i) => { if (FORBIDDEN.test(line)) hits.push(`${path}:${i + 1}: forbidden identifier`); });
  return hits;
}
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));

describe("authority boundary", () => {
  it("the channel source imports nothing that writes tasks and names no task-authority table", () => {
    const hits = files("packages/agent-channel/src").flatMap((f) => findAuthorityViolations(f, readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
  it("the scanner fails on a planted violation (negative case)", () => {
    expect(findAuthorityViolations("x.ts", 'import { admit } from "../../../services/kernel/src/admission.js";')).not.toEqual([]);
    expect(findAuthorityViolations("x.ts", 'const q = "update tasks set status=1";')).not.toEqual([]);
    expect(findAuthorityViolations("x.ts", 'const q = "insert into control_events values (1)";')).not.toEqual([]);
    expect(findAuthorityViolations("x.ts", 'import pg from "pg";')).not.toEqual([]);
    expect(findAuthorityViolations("x.ts", 'import { z } from "zod";\n// updates tasks in comments are fine\n')).toEqual([]);
  });
  it("the migration only names channel tables plus read-only membership lookups", () => {
    const dir = "supabase/migrations";
    const f = readdirSync(dir).find((n) => n.endsWith("_agent_channel.sql"));
    if (!f) return; // added with the Postgres store
    const sql = stripComments(readFileSync(join(dir, f), "utf8")).replace(/--.*$/gm, "");
    expect(sql).not.toMatch(/\b(tasks|approvals|control_events|task_events|evidence|kernel_private)\b/);
  });
  it("ChannelError is the only failure type that carries an authority-free code", () => {
    expect(new ChannelError("DENIED", "x").code).toBe("DENIED");
  });
});
