import { createServer, type Server } from "node:http";
import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { knowledgeDatabase } from "./support/knowledge-db.js";
import { MissionControlStore } from "../apps/mission-control/src/store.js";
import { createMissionControl } from "../apps/mission-control/src/server.js";
import { renderList } from "../apps/mission-control/src/view.js";
let db: Awaited<ReturnType<typeof knowledgeDatabase>>,
  server: Server,
  url: string;
beforeAll(async () => {
  db = await knowledgeDatabase();
  let handler: ReturnType<typeof createMissionControl>;
  server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No test address");
  url = `http://127.0.0.1:${address.port}`;
  handler = createMissionControl({
    store: new MissionControlStore(db.pool),
    origin: url,
    authenticate: async (headers) => {
      if (headers.authorization !== "Bearer test")
        throw new Error("not signed in");
      return db.context;
    },
  });
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server?.close((error) => (error ? reject(error) : resolve())),
  );
  await db?.close();
});
const headers = { authorization: "Bearer test" };
it("serves a task overview and evidence-backed task detail over HTTP", async () => {
  const overview = await fetch(url, { headers });
  expect(overview.status).toBe(200);
  expect(await overview.text()).toContain(`/tasks/${db.task.id}`);
  const detail = await fetch(`${url}/tasks/${db.task.id}`, { headers });
  const html = await detail.text();
  expect(html).toContain(db.outcome.summary);
  expect(html).toContain(db.evidence.id);
  expect(html).toContain("TASK_COMPLETED");
  expect(html).not.toContain("<form");
});
it("requires authentication and tenant membership", async () => {
  expect((await fetch(url)).status).toBe(401);
  const store = new MissionControlStore(db.pool);
  await expect(
    store.list({
      ...db.context,
      principal: { id: randomUUID(), kind: "HUMAN" },
    }),
  ).rejects.toThrow("Tenant access denied");
  const tenantId = randomUUID();
  await db.pool.query("insert into tenants(id,name) values($1,'other')", [
    tenantId,
  ]);
  await db.pool.query(
    "insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'reader')",
    [tenantId, db.context.principal.id],
  );
  expect(await store.list({ ...db.context, tenantId })).toEqual([]);
  expect(await store.task({ ...db.context, tenantId }, db.task.id)).toBeNull();
});
it("escapes stored content and applies restrictive browser security headers", async () => {
  const html = renderList([
    { ...db.task, objective: '<script>alert("x")</script>' },
  ]);
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
  const response = await fetch(url, { headers });
  expect(response.headers.get("content-security-policy")).toContain(
    "default-src 'none'",
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
});
it("rejects cross-origin mutations and cannot complete a task through the UI", async () => {
  const response = await fetch(`${url}/tasks/${db.task.id}/approve`, {
    method: "POST",
    headers: {
      ...headers,
      origin: "https://untrusted.example",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "decision=GRANTED",
  });
  expect(response.status).toBe(403);
  expect(
    (
      await fetch(`${url}/tasks/${db.task.id}/complete`, {
        method: "POST",
        headers,
      })
    ).status,
  ).toBe(404);
});
it("returns bounded, non-leaking errors for invalid or unknown task identifiers", async () => {
  expect(
    (await fetch(`${url}/tasks/${randomUUID()}`, { headers })).status,
  ).toBe(404);
  const response = await fetch(`${url}/tasks/invalid`, { headers });
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain("postgresql");
});
