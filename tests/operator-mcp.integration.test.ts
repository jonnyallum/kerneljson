import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { knowledgeDatabase } from "./support/knowledge-db.js";
import { createGateway, bearerAuthenticator } from "../apps/gateway/src/server.js";
import { createRestateControls } from "../apps/gateway/src/index.js";
import { buildHandler, loadConfig } from "../apps/mcp/src/main.js";

/**
 * ADR-0025 against the real door and Postgres: the MCP server's tools reach the ledger only through
 * the door, admissions are attributed to chatgpt-mcp/v1, and a duplicate action request converges on
 * one canonical task. Local mode is used here so the test exercises the door path; OAuth is covered
 * end to end in operator-mcp-oauth.test.ts.
 */
const BEARER = "mcp-integration-bearer-0123456789";
let fixture: Awaited<ReturnType<typeof knowledgeDatabase>>;
let door: Server;
let mcp: Server;
let mcpUrl = "";
let dispatches = 0;

beforeAll(async () => {
  fixture = await knowledgeDatabase();
  await fixture.pool.query("select kernel_private.activate_release($1,'test-release',0,$2)", [randomUUID(), { qualification: "operator mcp integration" }]);
  const authenticate = bearerAuthenticator(async (token) => (token === BEARER ? fixture.context : null));
  const controls = createRestateControls("http://not-called.invalid", async () => ({}), { pool: fixture.pool, fetch: async () => { throw new Error("unexpected transport"); } });
  const gateway = createGateway({ pool: fixture.pool, releaseId: "test-release", authenticate, admit: async () => true, controls, dispatch: async () => { dispatches++; return { status: "ACCEPTED" }; } });
  door = createServer((req, res) => void gateway(req, res));
  await new Promise<void>((r) => door.listen(0, "127.0.0.1", r));
  const d = door.address() as { port: number };
  const handler = buildHandler(loadConfig({ MCP_AUTH: "local-unauthenticated", KJ_ADMISSION_URL: `http://127.0.0.1:${d.port}`, KJ_ADMISSION_BEARER: BEARER, KERNELJSON_RELEASE_ID: "test-release" }));
  mcp = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => mcp.listen(0, "127.0.0.1", r));
  mcpUrl = `http://127.0.0.1:${(mcp.address() as { port: number }).port}/mcp`;
});
afterAll(async () => {
  await Promise.all([door, mcp].filter(Boolean).map((s) => new Promise<void>((r) => s.close(() => r()))));
  await fixture?.close();
});

let id = 0;
async function tool(name: string, args: unknown) {
  const r = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(r.status).toBe(200);
  return ((await r.json()) as { result: { isError: boolean; structuredContent: { data?: unknown; error?: string } } }).result;
}

it("admits a brief through the real door, attributed to chatgpt-mcp/v1, once per request id", async () => {
  const requestId = `chat-${randomUUID()}`;
  const before = dispatches;
  const first = await tool("kj_run_brief", { request_id: requestId });
  const again = await tool("kj_run_brief", { request_id: requestId });
  expect(first.isError).toBe(false);
  const taskId = (first.structuredContent.data as { taskId: string }).taskId;
  expect((again.structuredContent.data as { taskId: string }).taskId).toBe(taskId);
  const rows = await fixture.pool.query(
    "select payload->>'recipe' as recipe, payload->'intent'->>'source' as source from kernel_private.task_admissions where task_id=$1",
    [taskId],
  );
  expect(rows.rows).toEqual([{ recipe: "morning-brief/v1", source: "kerneljson:channel/chatgpt-mcp/v1" }]);
  expect(dispatches - before).toBeGreaterThanOrEqual(1);
  const conflict = await tool("kj_run_analysis", { request_id: requestId, repo: "jonnyallum/kerneljson" });
  expect(conflict).toMatchObject({ isError: true, structuredContent: { error: "CONFLICT" } });
});

it("reads tasks, one task and health through the door", async () => {
  const list = await tool("kj_list_tasks", { limit: 5 });
  expect(list.isError).toBe(false);
  expect((list.structuredContent.data as unknown[]).length).toBeGreaterThan(0);
  const one = await tool("kj_get_task", { task_id: fixture.task.id });
  expect(one.structuredContent.data).toMatchObject({ taskId: fixture.task.id });
  const health = await tool("kj_health", {});
  expect(health.structuredContent.data).toMatchObject({ release: { door: "test-release", doorMatchesActive: true } });
  const missing = await tool("kj_get_task", { task_id: randomUUID() });
  expect(missing).toMatchObject({ isError: true, structuredContent: { error: "NOT_FOUND" } });
});
