import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { knowledgeDatabase } from "./support/knowledge-db.js";
import { buildDoorHandler, loadDoorConfig } from "../apps/gateway/src/main.js";
import { buildHandler, loadConfig } from "../apps/mcp/src/main.js";

/**
 * ADR-0025 against the real door wiring and Postgres. The door runs `buildDoorHandler` with two
 * credentials, as in production: the worker's (the fixture's HUMAN owner) and the MCP server's own
 * SERVICE principal with an `operator` membership. The MCP server's tools reach the ledger only
 * through the door, admissions are attributed to chatgpt-mcp/v1 and to the MCP principal, a duplicate
 * action request converges on one canonical task, and the door holds the MCP principal to its scope.
 * Local mode is used here so the test exercises the door path; OAuth is covered end to end in
 * operator-mcp-oauth.test.ts.
 */
const WORKER_BEARER = `worker-${randomUUID()}`;
const MCP_BEARER = `mcp-${randomUUID()}${randomUUID()}`;
const MCP_PRINCIPAL = randomUUID();
let fixture: Awaited<ReturnType<typeof knowledgeDatabase>>;
let door: Server;
let mcp: Server;
let doorUrl = "";
let mcpUrl = "";

beforeAll(async () => {
  fixture = await knowledgeDatabase();
  await fixture.pool.query("select kernel_private.activate_release($1,'test-release',0,$2)", [randomUUID(), { qualification: "operator mcp integration" }]);
  await fixture.pool.query("insert into principals(id,kind) values($1,'SERVICE')", [MCP_PRINCIPAL]);
  await fixture.pool.query("insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'operator')", [fixture.context.tenantId, MCP_PRINCIPAL]);
  const config = loadDoorConfig({
    DATABASE_URL: "postgresql://unused.invalid/db", // the handler is given the fixture pool directly
    KJ_ADMISSION_BEARER: WORKER_BEARER,
    KJ_ADMISSION_TENANT_ID: fixture.context.tenantId,
    KJ_ADMISSION_PRINCIPAL_ID: fixture.context.principal.id,
    KJ_ADMISSION_PRINCIPAL_KIND: fixture.context.principal.kind,
    KJ_MCP_BEARER: MCP_BEARER,
    KJ_MCP_PRINCIPAL_ID: MCP_PRINCIPAL,
    KJ_MCP_PRINCIPAL_KIND: "SERVICE",
    KERNELJSON_RELEASE_ID: "test-release",
  });
  const doorHandler = buildDoorHandler(fixture.pool, config);
  door = createServer((req, res) => doorHandler(req, res));
  await new Promise<void>((r) => door.listen(0, "127.0.0.1", r));
  doorUrl = `http://127.0.0.1:${(door.address() as { port: number }).port}`;
  const handler = buildHandler(loadConfig({ MCP_AUTH: "local-unauthenticated", KJ_ADMISSION_URL: doorUrl, KJ_MCP_BEARER: MCP_BEARER, KERNELJSON_RELEASE_ID: "test-release" }));
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
const doorPost = (path: string, bearer: string, body: unknown) =>
  fetch(doorUrl + path, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", "idempotency-key": `k-${randomUUID()}` },
    body: JSON.stringify(body),
  });

it("admits a brief through the real door as the MCP principal, attributed to chatgpt-mcp/v1, once per request id", async () => {
  const requestId = `chat-${randomUUID()}`;
  const first = await tool("kj_run_brief", { request_id: requestId });
  const again = await tool("kj_run_brief", { request_id: requestId });
  expect(first.isError).toBe(false);
  const taskId = (first.structuredContent.data as { taskId: string }).taskId;
  expect((again.structuredContent.data as { taskId: string }).taskId).toBe(taskId);
  const rows = await fixture.pool.query(
    "select principal_id, payload->>'recipe' as recipe, payload->'intent'->>'source' as source, payload->'intent'->'principal'->>'kind' as kind from kernel_private.task_admissions where task_id=$1",
    [taskId],
  );
  expect(rows.rows).toEqual([{ principal_id: MCP_PRINCIPAL, recipe: "morning-brief/v1", source: "kerneljson:channel/chatgpt-mcp/v1", kind: "SERVICE" }]);
  const conflict = await tool("kj_run_analysis", { request_id: requestId, repo: "jonnyallum/kerneljson" });
  expect(conflict).toMatchObject({ isError: true, structuredContent: { error: "CONFLICT" } });
});

it("reads tasks, one task and health through the door as a SERVICE operator", async () => {
  const list = await tool("kj_list_tasks", { limit: 5 });
  expect(list.isError).toBe(false);
  expect((list.structuredContent.data as unknown[]).length).toBeGreaterThan(0);
  const one = await tool("kj_get_task", { task_id: fixture.task.id });
  expect(one.structuredContent.data).toMatchObject({ taskId: fixture.task.id });
  const health = await tool("kj_health", {});
  expect(health.isError).toBe(false);
  expect(health.structuredContent.data).toMatchObject({ release: { door: "test-release", doorMatchesActive: true } });
  const missing = await tool("kj_get_task", { task_id: randomUUID() });
  expect(missing).toMatchObject({ isError: true, structuredContent: { error: "NOT_FOUND" } });
});

it("holds the MCP credential to its scope at the door, and leaves the worker credential unchanged", async () => {
  // Recipes outside the MCP scope are refused before any admission row exists.
  const before = (await fixture.pool.query("select count(*)::int n from kernel_private.task_admissions")).rows[0].n;
  for (const recipe of ["claude_md_check/v1", "uppercase/v1"]) {
    const r = await doorPost("/v1/tasks", MCP_BEARER, { recipe, objective: "out of scope" });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: "OUT_OF_SCOPE" });
  }
  expect((await fixture.pool.query("select count(*)::int n from kernel_private.task_admissions")).rows[0].n).toBe(before);
  // Approve and signal are refused for the MCP credential; cancel passes the scope (admission-only
  // controls then answer UNSUPPORTED, which is a different refusal from OUT_OF_SCOPE).
  for (const action of ["approve", "signal"]) {
    const r = await doorPost(`/v1/tasks/${fixture.task.id}/${action}`, MCP_BEARER, {});
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: "OUT_OF_SCOPE" });
  }
  const cancel = await doorPost(`/v1/tasks/${fixture.task.id}/cancel`, MCP_BEARER, {});
  expect(cancel.status).toBe(409);
  // The worker credential still admits a recipe the MCP may not use.
  expect((await doorPost("/v1/tasks", WORKER_BEARER, { recipe: "claude_md_check/v1", objective: "worker path" })).status).toBe(202);
  // A forged bearer is still 401, and the MCP bearer with one character changed is not the MCP.
  expect((await doorPost("/v1/tasks", `${MCP_BEARER}x`, { recipe: "morning-brief/v1", objective: "x" })).status).toBe(401);
});

it("the deploy window's door check passes on the scoped credential and fails on an unscoped one", async () => {
  const port = new URL(doorUrl).port;
  // Asynchronous on purpose: the door under test runs in this process, so a synchronous spawn would
  // block the very server the check is calling.
  const check = (bearer: string) =>
    new Promise<{ code: number; stdout: string }>((resolve) => {
      execFile(process.execPath, ["infrastructure/ops/mcp-door-check.js"], { env: { PATH: process.env["PATH"], PORT: port, KJ_MCP_BEARER: bearer }, timeout: 30_000 }, (error, stdout) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
        resolve({ code, stdout: String(stdout) });
      });
    });
  const good = await check(MCP_BEARER);
  expect(good.code, good.stdout).toBe(0);
  expect(good.stdout.trim().split(/\r?\n/).at(-1)).toBe("MCP_DOOR OK");
  expect(good.stdout).not.toContain(MCP_BEARER);
  // The worker's credential is not scoped, so the same check must fail: the check can fail on purpose.
  const unscoped = await check(WORKER_BEARER);
  expect(unscoped.code).toBe(1);
  expect(unscoped.stdout).toContain("FAIL canary recipe refused");
  expect((await check("")).stdout.trim()).toBe("MCP_DOOR NOT_CONFIGURED");
});
