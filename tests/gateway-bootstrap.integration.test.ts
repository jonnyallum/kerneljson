import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "./support/local.js";
import { buildDoorHandler, loadDoorConfig } from "../apps/gateway/src/main.js";

/**
 * Admission door bootstrap — Postgres admission qualification (integration).
 *
 * Serves the real `buildDoorHandler` (bearer resolver + createGateway) against a REAL local
 * throwaway Postgres and proves the door authenticates, rejects, allow-lists, and drives the
 * existing admission path (task_admissions + idempotency + 409) end to end. Admission-only mode
 * (no Restate ingress): dispatch resolves UNRESOLVED, but the admission itself persists.
 *
 * Gated on KJ_TEST_PG_URL; skips cleanly when unset; a production-looking target aborts.
 */
const TEST_URL = process.env["KJ_TEST_PG_URL"];
const PROD_MARKERS = [
  "supabase.co", "supabase.com", "pooler.supabase", "supabase.in",
  "banqdzddfganzfhckdps", "lkwydqtfbdjhxaarelaz",
  "136.112.138.225", "35.242.183.206", "34.105.139.159",
];
const URL_ = globalThis.URL;
function assertLocalTestTarget(url: string): void {
  const lower = url.toLowerCase();
  for (const m of PROD_MARKERS)
    if (lower.includes(m)) throw new Error(`PRODUCTION TRIPWIRE: refusing target containing '${m}'`);
  let host: string;
  try { host = new URL_(url).hostname; } catch { throw new Error("unparseable KJ_TEST_PG_URL"); }
  const localOk = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!localOk && process.env["KJ_TEST_PG_ALLOW_NONLOCAL"] !== "1")
    throw new Error(`PRODUCTION TRIPWIRE: non-local host '${host}' not explicitly test-authorised`);
}

const run = TEST_URL ? describe : describe.skip;
if (!TEST_URL) console.warn("[gateway-bootstrap] SKIPPED: set KJ_TEST_PG_URL to a LOCAL throwaway Postgres to run.");

run("admission door — Postgres admission qualification", () => {
  let pool: pg.Pool;
  let server: Server;
  let base: string;
  const tenantId = randomUUID();
  const principalId = randomUUID();
  const BEARER = `gw-boot-${randomUUID()}${randomUUID()}`; // test-only, long

  const submit = (
    body: unknown,
    key: string,
    token: string = BEARER,
    auth = true,
  ): Promise<Response> =>
    fetch(`${base}/v1/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": key,
        ...(auth ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    assertLocalTestTarget(TEST_URL!);
    pool = new pg.Pool({ connectionString: TEST_URL });
    const migrated = await pool.query("select to_regclass('kernel_private.task_admissions') as t");
    if (!migrated.rows[0].t) await migrate(pool);
    // Identity: a HUMAN principal with an ACTIVE operator membership of the tenant.
    await pool.query("insert into principals(id,kind) values($1,'HUMAN')", [principalId]);
    await pool.query("insert into tenants(id,name) values($1,'gw-boot')", [tenantId]);
    await pool.query(
      "insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'operator')",
      [tenantId, principalId],
    );
    const config = loadDoorConfig({
      DATABASE_URL: TEST_URL,
      KJ_ADMISSION_BEARER: BEARER,
      KJ_ADMISSION_TENANT_ID: tenantId,
      KJ_ADMISSION_PRINCIPAL_ID: principalId,
      KJ_ADMISSION_PRINCIPAL_KIND: "HUMAN",
      // no KJ_RESTATE_INGRESS_URL -> admission-only
    });
    const handler = buildDoorHandler(pool, config);
    server = createServer((req, res) => handler(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
    await pool?.end();
  });

  it("GET /healthz is 200 and creates no admission", async () => {
    const before = await pool.query("select count(*)::int n from kernel_private.task_admissions");
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    const after = await pool.query("select count(*)::int n from kernel_private.task_admissions");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("rejects a missing bearer and a wrong bearer with 401", async () => {
    expect((await submit({ recipe: "claude_md_check/v1", objective: "x" }, randomUUID(), BEARER, false)).status).toBe(401);
    expect((await submit({ recipe: "claude_md_check/v1", objective: "x" }, randomUUID(), `nope-${randomUUID()}`)).status).toBe(401);
  });

  it("rejects a recipe outside the allow-list with 400 (under a valid bearer)", async () => {
    expect((await submit({ recipe: "not-a-real-recipe/v1", objective: "x" }, randomUUID())).status).toBe(400);
  });

  it("admits a valid claude_md_check/v1 request: 202 and exactly one task_admissions row", async () => {
    const res = await submit({ recipe: "claude_md_check/v1", objective: "canary admission qualification" }, randomUUID());
    expect(res.status).toBe(202);
    const b = (await res.json()) as { taskId: string; dispatch: string };
    expect(b.taskId).toBeTruthy();
    expect(b.dispatch).toBe("UNRESOLVED"); // admission-only: honest, admission still persisted
    const adm = await pool.query("select count(*)::int n from kernel_private.task_admissions where task_id=$1", [b.taskId]);
    expect(adm.rows[0].n).toBe(1);
    const st = await fetch(`${base}/v1/tasks/${b.taskId}`, { headers: { authorization: `Bearer ${BEARER}` } });
    expect(st.status).toBe(200);
  });

  it("same idempotency key + same payload returns the same task; no duplicate admission row", async () => {
    const key = randomUUID();
    const body = { recipe: "claude_md_check/v1", objective: "idempotent same payload" };
    const first = (await (await submit(body, key)).json()) as { taskId: string };
    const second = (await (await submit(body, key)).json()) as { taskId: string };
    expect(second.taskId).toBe(first.taskId);
    const adm = await pool.query("select count(*)::int n from kernel_private.task_admissions where task_id=$1", [first.taskId]);
    expect(adm.rows[0].n).toBe(1);
  });

  it("same idempotency key + changed payload is 409 (fail closed)", async () => {
    const key = randomUUID();
    expect((await submit({ recipe: "claude_md_check/v1", objective: "original" }, key)).status).toBe(202);
    expect((await submit({ recipe: "claude_md_check/v1", objective: "CHANGED" }, key)).status).toBe(409);
  });
});
