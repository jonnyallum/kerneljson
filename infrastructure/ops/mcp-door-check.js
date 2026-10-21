// ADR-0025: prove at the live door that the MCP credential is accepted and held to its scope. Runs inside
// the door container, which holds KJ_MCP_BEARER; the value never leaves process.env and is never printed.
// It admits nothing: every request it sends is one the door must refuse, or a read.
//
//   docker exec -i kerneljson-admission-door-gateway-1 node - < mcp-door-check.js
//
// Before the release (no MCP credential configured) it prints `MCP_DOOR NOT_CONFIGURED` and exits 1.
// After it, every line must be PASS and the last line `MCP_DOOR OK`.
const base = `http://127.0.0.1:${process.env.PORT || 8081}`;
const bearer = process.env.KJ_MCP_BEARER || "";
const forged = "forged-" + require("node:crypto").randomBytes(24).toString("hex");
const nil = "00000000-0000-4000-8000-000000000000";

async function call(token, method, path, body) {
  const r = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": `mcp-door-check-${Date.now()}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let error = null;
  try {
    error = (await r.json()).error ?? null;
  } catch {}
  return { status: r.status, error };
}

(async () => {
  if (bearer.length < 32) {
    console.log("MCP_DOOR NOT_CONFIGURED");
    process.exit(1);
  }
  const checks = [
    ["health readable", await call(bearer, "GET", "/v1/health"), (r) => r.status === 200],
    ["task list readable", await call(bearer, "GET", "/v1/tasks?limit=1"), (r) => r.status === 200],
    ["canary recipe refused", await call(bearer, "POST", "/v1/tasks", { recipe: "claude_md_check/v1", objective: "scope check" }), (r) => r.status === 403 && r.error === "OUT_OF_SCOPE"],
    ["identity recipe refused", await call(bearer, "POST", "/v1/tasks", { recipe: "identity-change/v1", objective: "scope check" }), (r) => r.status === 403 && r.error === "OUT_OF_SCOPE"],
    ["approve refused", await call(bearer, "POST", `/v1/tasks/${nil}/approve`, {}), (r) => r.status === 403 && r.error === "OUT_OF_SCOPE"],
    ["signal refused", await call(bearer, "POST", `/v1/tasks/${nil}/signal`, {}), (r) => r.status === 403 && r.error === "OUT_OF_SCOPE"],
    ["forged bearer refused", await call(forged, "GET", "/v1/health"), (r) => r.status === 401],
  ];
  let ok = true;
  for (const [name, result, pass] of checks) {
    const good = pass(result);
    ok &&= good;
    console.log(`${good ? "PASS" : "FAIL"} ${name}: ${result.status}${result.error ? " " + result.error : ""}`);
  }
  console.log(ok ? "MCP_DOOR OK" : "MCP_DOOR FAILED");
  process.exit(ok ? 0 : 1);
})().catch(() => {
  console.log("MCP_DOOR ERROR");
  process.exit(1);
});
