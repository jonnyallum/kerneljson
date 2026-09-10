/**
 * Phase 5.1 — minimal KernelJSON gateway for estate-email admission-only.
 * Env: KERNELJSON_DATABASE_URL, KERNELJSON_GATEWAY_BEARER (required).
 * Optional: KERNELJSON_GATEWAY_HOST (127.0.0.1), KERNELJSON_GATEWAY_PORT (8787),
 * KERNELJSON_RELEASE_ID (email-admission-gateway.v1). Never prints secrets.
 */
import { createServer } from "node:http";
import pg from "pg";
import { createRestateControls } from "../apps/gateway/src/index.js";
import { createGateway, bearerAuthenticator } from "../apps/gateway/src/server.js";
import { ESTATE_EMAIL_PRINCIPAL, ESTATE_TENANT_ID } from "../packages/admission/src/identity.js";

const databaseUrl = process.env.KERNELJSON_DATABASE_URL || process.env.DATABASE_URL;
const bearer = process.env.KERNELJSON_GATEWAY_BEARER;
const host = process.env.KERNELJSON_GATEWAY_HOST || "127.0.0.1";
const port = Number(process.env.KERNELJSON_GATEWAY_PORT || "8787");
const releaseId = process.env.KERNELJSON_RELEASE_ID || "email-admission-gateway.v1";

if (!databaseUrl) { console.error("MISSING KERNELJSON_DATABASE_URL"); process.exit(2); }
if (!bearer || bearer.length < 16) { console.error("MISSING_OR_WEAK KERNELJSON_GATEWAY_BEARER"); process.exit(2); }

const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });

async function seedEstate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("insert into principals(id,kind) values($1,'SERVICE') on conflict(id) do nothing", [ESTATE_EMAIL_PRINCIPAL.id]);
    await client.query("insert into tenants(id,name) values($1,'estate') on conflict(id) do nothing", [ESTATE_TENANT_ID]);
    await client.query(
      `insert into tenant_memberships(tenant_id,principal_id,role,status)
       values($1,$2,'operator','ACTIVE')
       on conflict(tenant_id,principal_id) do update set status='ACTIVE', role='operator'`,
      [ESTATE_TENANT_ID, ESTATE_EMAIL_PRINCIPAL.id],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  await pool.query("select 1");
  await seedEstate();
  const authenticate = bearerAuthenticator(async (token) => {
    if (token !== bearer) return null;
    return { tenantId: ESTATE_TENANT_ID, principal: ESTATE_EMAIL_PRINCIPAL };
  });
  const controls = createRestateControls("http://127.0.0.1:9", async () => ({}), {
    pool,
    fetch: async () => { throw new Error("email-admission-gateway: controls must not be called"); },
  });
  const handler = createGateway({
    pool,
    releaseId,
    authenticate,
    admit: async () => true,
    controls,
    dispatch: async () => { throw new Error("email-admission-gateway: dispatch must not be called"); },
  });
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => resolve());
    server.on("error", reject);
  });
  console.log(JSON.stringify({
    event: "EMAIL_ADMISSION_GATEWAY_LISTENING",
    host, port, releaseId,
    estateTenant: ESTATE_TENANT_ID,
    estatePrincipal: ESTATE_EMAIL_PRINCIPAL.id,
    recipe: "estate-email-triage/v1",
  }));
}

main().catch((error) => {
  console.error("email-admission-gateway failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
