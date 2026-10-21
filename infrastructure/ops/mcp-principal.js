// ADR-0025: show, create or revoke the operator MCP server's SERVICE principal and its `operator`
// membership. Runs inside the worker container, which already holds DATABASE_URL; the URL never leaves
// process.env and nothing secret is printed. Ids are public UUIDs.
//
//   docker exec -i kerneljson-execution-worker-1 node - show   <tenant> <principal> < mcp-principal.js
//   docker exec -i kerneljson-execution-worker-1 node - create <tenant> <principal> < mcp-principal.js
//   docker exec -i kerneljson-execution-worker-1 node - revoke <tenant> <principal> < mcp-principal.js
//
// Prints exactly one line, `MCP_PRINCIPAL <json>` or `MCP_PRINCIPAL NONE`, then exits 0; anything
// unexpected exits 1 and the transaction rolls back. Revocation is a status change (audited by the
// membership trigger), never a delete: admissions made by the principal keep their reference.
const pg = require("pg");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const [MODE, TENANT, PRINCIPAL] = process.argv.slice(2);

async function read(c) {
  const r = await c.query(
    `select p.kind, m.role, m.status from public.principals p
       left join public.tenant_memberships m on m.principal_id = p.id and m.tenant_id = $1
      where p.id = $2`,
    [TENANT, PRINCIPAL],
  );
  return r.rows[0] ?? null;
}

(async () => {
  if (!["show", "create", "revoke"].includes(MODE) || !UUID.test(TENANT || "") || !UUID.test(PRINCIPAL || "")) throw new TypeError("usage: show|create|revoke <tenant uuid> <principal uuid>");
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query("begin");
    await c.query("set local lock_timeout = '10s'");
    if ((await c.query("select 1 from public.tenants where id = $1", [TENANT])).rowCount !== 1) throw new Error("tenant not found");
    if (MODE === "create") {
      await c.query("insert into public.principals(id, kind) values ($1, 'SERVICE') on conflict (id) do nothing", [PRINCIPAL]);
      await c.query(
        `insert into public.tenant_memberships(tenant_id, principal_id, role) values ($1, $2, 'operator')
         on conflict (tenant_id, principal_id) do update set status = 'ACTIVE', role = 'operator'`,
        [TENANT, PRINCIPAL],
      );
    } else if (MODE === "revoke") {
      const r = await c.query("update public.tenant_memberships set status = 'REVOKED' where tenant_id = $1 and principal_id = $2", [TENANT, PRINCIPAL]);
      if (r.rowCount !== 1) throw new Error("no membership to revoke");
    }
    const row = await read(c);
    if (MODE === "create" && !(row && row.kind === "SERVICE" && row.role === "operator" && row.status === "ACTIVE")) throw new Error("create did not produce an ACTIVE SERVICE operator");
    if (MODE === "revoke" && !(row && row.status === "REVOKED")) throw new Error("revoke did not take effect");
    await c.query(MODE === "show" ? "rollback" : "commit");
    console.log(`MCP_PRINCIPAL ${row ? JSON.stringify({ tenant: TENANT, principal: PRINCIPAL, ...row }) : "NONE"}`);
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
})().catch((e) => {
  console.error(`MCP_PRINCIPAL_FAILED ${e instanceof Error ? e.message : "error"}`);
  process.exit(1);
});
