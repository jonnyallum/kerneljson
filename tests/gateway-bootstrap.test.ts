import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import pg from "pg";
import {
  loadDoorConfig,
  createBearerResolver,
  buildDoorHandler,
  summariseDoorConfig,
  DoorConfigError,
} from "../apps/gateway/src/main.js";
import { TenantContext } from "../packages/contracts/src/index.js";

// Test-only literals. NOT real secrets; used to prove they never leak.
const TENANT = "5f970749-7507-894b-a2e4-872ce20a94b7";
const PRINCIPAL = "da5c6dfc-38c5-4773-bd47-5c80ed908d75";
const BEARER = "test-bearer-supersecret-value-0123456789";
const DB_PASSWORD = "PW-should-never-print";
const DATABASE_URL = `postgresql://postgres:${DB_PASSWORD}@db.example.invalid:5432/postgres`;

const baseEnv = (): Record<string, string | undefined> => ({
  DATABASE_URL,
  KJ_ADMISSION_BEARER: BEARER,
  KJ_ADMISSION_TENANT_ID: TENANT,
  KJ_ADMISSION_PRINCIPAL_ID: PRINCIPAL,
  KJ_ADMISSION_PRINCIPAL_KIND: "HUMAN",
});

function configCode(env: Record<string, string | undefined>): string {
  try {
    loadDoorConfig(env);
    return "NO_THROW";
  } catch (e) {
    return e instanceof DoorConfigError ? e.code : (e as Error).name;
  }
}

describe("admission door — loadDoorConfig (fail closed, never echoes a secret)", () => {
  it("loads a complete admission-only config", () => {
    const c = loadDoorConfig(baseEnv());
    expect(c.context.tenantId).toBe(TENANT);
    expect(c.context.principal).toEqual({ id: PRINCIPAL, kind: "HUMAN" });
    expect(c.port).toBe(8081);
    expect(c.restateIngressUrl).toBeNull();
    expect(summariseDoorConfig(c).mode).toBe("admission-only");
  });

  it("fails closed on each missing required var", () => {
    for (const key of [
      "DATABASE_URL",
      "KJ_ADMISSION_BEARER",
      "KJ_ADMISSION_TENANT_ID",
      "KJ_ADMISSION_PRINCIPAL_ID",
      "KJ_ADMISSION_PRINCIPAL_KIND",
    ]) {
      const env = baseEnv();
      delete env[key];
      // tenant/principal/kind missing surface as the generic identity error via zod;
      // DATABASE_URL/BEARER missing surface as their own <NAME>_MISSING code.
      const expected =
        key === "DATABASE_URL" || key === "KJ_ADMISSION_BEARER"
          ? `${key}_MISSING`
          : `${key}_MISSING`;
      expect(configCode(env)).toBe(expected);
    }
  });

  it("fails closed on a too-short bearer", () => {
    expect(configCode({ ...baseEnv(), KJ_ADMISSION_BEARER: "short" })).toBe(
      "KJ_ADMISSION_BEARER_TOO_SHORT",
    );
  });

  it("fails closed on malformed identity (bad uuid or bad kind)", () => {
    expect(configCode({ ...baseEnv(), KJ_ADMISSION_TENANT_ID: "not-a-uuid" })).toBe(
      "IDENTITY_CONFIG_INVALID",
    );
    expect(configCode({ ...baseEnv(), KJ_ADMISSION_PRINCIPAL_ID: "nope" })).toBe(
      "IDENTITY_CONFIG_INVALID",
    );
    expect(configCode({ ...baseEnv(), KJ_ADMISSION_PRINCIPAL_KIND: "ROBOT" })).toBe(
      "IDENTITY_CONFIG_INVALID",
    );
  });

  it("fails closed on invalid PORT and invalid Restate ingress", () => {
    expect(configCode({ ...baseEnv(), PORT: "0" })).toBe("PORT_INVALID");
    expect(configCode({ ...baseEnv(), PORT: "70000" })).toBe("PORT_INVALID");
    expect(configCode({ ...baseEnv(), KJ_RESTATE_INGRESS_URL: "ftp://x" })).toBe(
      "RESTATE_INGRESS_INVALID",
    );
  });

  it("enables restate-dispatch mode with a valid ingress", () => {
    const c = loadDoorConfig({ ...baseEnv(), KJ_RESTATE_INGRESS_URL: "http://127.0.0.1:18080" });
    expect(c.restateIngressUrl).toBe("http://127.0.0.1:18080");
    expect(summariseDoorConfig(c).mode).toBe("restate-dispatch");
  });

  it("never echoes the bearer or DATABASE_URL in a config error", () => {
    let text = "";
    try {
      loadDoorConfig({ ...baseEnv(), KJ_ADMISSION_TENANT_ID: "bad" });
    } catch (e) {
      const err = e as DoorConfigError;
      text = `${err.name}|${err.code}|${err.message}`;
    }
    expect(text).toContain("IDENTITY_CONFIG_INVALID");
    expect(text).not.toContain(BEARER);
    expect(text).not.toContain(DB_PASSWORD);
    expect(text).not.toContain(DATABASE_URL);
  });

  it("summary carries only non-secret fields", () => {
    const s = JSON.stringify(summariseDoorConfig(loadDoorConfig(baseEnv())));
    expect(s).not.toContain(BEARER);
    expect(s).not.toContain(DB_PASSWORD);
  });
});

describe("admission door — bearer resolver (constant-time, deterministic, stable)", () => {
  const ctx = TenantContext.parse({ tenantId: TENANT, principal: { id: PRINCIPAL, kind: "HUMAN" } });

  it("resolves the exact bearer to the fixed context", async () => {
    expect(await createBearerResolver(BEARER, ctx)(BEARER)).toEqual(ctx);
  });

  it("rejects a wrong, longer, shorter or empty token", async () => {
    const r = createBearerResolver(BEARER, ctx);
    expect(await r("wrong-token-value-000000000000")).toBeNull();
    expect(await r(BEARER + "x")).toBeNull();
    expect(await r(BEARER.slice(0, -1))).toBeNull();
    expect(await r("")).toBeNull();
  });

  it("is stable across repeated calls", async () => {
    const r = createBearerResolver(BEARER, ctx);
    expect(await r(BEARER)).toEqual(await r(BEARER));
    expect(await r(BEARER)).toEqual(ctx);
  });
});

describe("admission door — HTTP surface without a DB (healthz + auth rejection)", () => {
  let server: Server;
  let pool: pg.Pool;
  let base: string;

  beforeAll(async () => {
    // A pool whose target is never reached: healthz and 401 never touch the DB.
    pool = new pg.Pool({ connectionString: "postgresql://unused@127.0.0.1:1/unused" });
    const handler = buildDoorHandler(pool, loadDoorConfig(baseEnv()));
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

  const submit = (headers: Record<string, string>) =>
    fetch(`${base}/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "kkkkkkkkkkkk", ...headers },
      body: JSON.stringify({ recipe: "claude_md_check/v1", objective: "x" }),
    });

  it("GET /healthz returns 200 {status:ok} with no auth and no admission", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("POST /v1/tasks with no bearer is 401 (before any DB access)", async () => {
    expect((await submit({})).status).toBe(401);
  });

  it("POST /v1/tasks with a wrong bearer is 401 (before any DB access)", async () => {
    expect((await submit({ authorization: "Bearer wrong-token-1234567890" })).status).toBe(401);
  });
});
