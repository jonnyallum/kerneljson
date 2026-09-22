// Gate 3 execution-topology validator (repo-only; no VM, no deploy).
//
// Proves the deployment infra in infrastructure/docker/{execution,gateway}.compose.yaml
// is safe and correctly shaped, using Docker Compose's own parser (`config --format json`)
// so syntax is validated authoritatively rather than by text matching. Dummy, non-secret
// env is supplied only so the `${VAR:?...}` required-variable checks resolve during config.
//
// Asserts:
//   - both compose files are syntactically valid (config succeeds)
//   - every published port binds 127.0.0.1 (no 0.0.0.0 / no bare public publish)
//   - the worker has NO host-published port
//   - gateway + restate + worker all attach to the shared network `kerneljson-exec`
//   - `kerneljson-exec` is EXTERNAL in BOTH files — neither compose file owns/creates it
//     (regression guard: this is exactly the ownership conflict Gate 3's D1 deploy hit)
//   - the gateway image resolves to a concrete tag (never unresolved/empty — regression
//     guard for the exact defect Gate 3's D1 deploy hit, where `build:` with no `image:`
//     resolved to nothing at all); if EXPECTED_GATEWAY_IMAGE is set, it must match exactly
//   - restate has persistent named-volume storage at /restate-data
//   - the worker's repo mount (/opt/kerneljson/app) is read-only
//   - there is NO Postgres/db container in the execution stack
//   - the gateway keeps a localhost-only publish of :8081
//
// Env overrides (all optional):
//   EXEC_COMPOSE_FILE, GATEWAY_COMPOSE_FILE — point at alternate compose files (used by the
//     negative-test harness in tests/topology-guard.test.ts against deliberately-broken
//     fixture copies; default to the real repo files).
//   KJ_GATEWAY_IMAGE — passed through to `config` like any other deploy-time var.
//   EXPECTED_GATEWAY_IMAGE — if set, the resolved gateway image must equal it exactly.
//
// Exit 0 = all pass; exit 1 = any failure (prints the failing checks).
import { execFileSync } from "node:child_process";

const DUMMY_ENV = {
  // Non-secret placeholders so `${VAR:?...}` resolves during `config`. Never real values.
  DATABASE_URL: "postgresql://placeholder@127.0.0.1:5432/placeholder",
  KERNELJSON_RELEASE_ID: "topology-check",
  KJ_ADMISSION_BEARER: "placeholder-bearer-token-0000",
  KJ_ADMISSION_TENANT_ID: "00000000-0000-4000-8000-000000000000",
  KJ_ADMISSION_PRINCIPAL_ID: "00000000-0000-4000-8000-000000000001",
  KJ_ADMISSION_PRINCIPAL_KIND: "HUMAN",
};

function config(file) {
  const out = execFileSync("docker", ["compose", "-f", file, "config", "--format", "json"], {
    encoding: "utf8",
    env: { ...process.env, ...DUMMY_ENV },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out);
}

const failures = [];
const check = (ok, label) => {
  if (!ok) failures.push(label);
};
const svcNets = (svc) => Object.keys(svc?.networks ?? {});
const EXEC = process.env.EXEC_COMPOSE_FILE || "infrastructure/docker/execution.compose.yaml";
const GW = process.env.GATEWAY_COMPOSE_FILE || "infrastructure/docker/gateway.compose.yaml";

let exec, gw;
try {
  exec = config(EXEC);
} catch (e) {
  console.error(`FATAL: ${EXEC} failed to parse:\n${e.stderr || e.message}`);
  process.exit(1);
}
try {
  gw = config(GW);
} catch (e) {
  console.error(`FATAL: ${GW} failed to parse:\n${e.stderr || e.message}`);
  process.exit(1);
}

// --- Port publishing: every published port in BOTH files must bind 127.0.0.1 ---
for (const [file, cfg] of [[EXEC, exec], [GW, gw]]) {
  for (const [name, svc] of Object.entries(cfg.services ?? {})) {
    for (const p of svc.ports ?? []) {
      check(p.host_ip === "127.0.0.1", `${file}:${name} port ${p.target} binds host_ip='${p.host_ip || "(unset=0.0.0.0)"}' not 127.0.0.1`);
    }
  }
}

// --- Worker must have NO host-published port ---
const worker = exec.services?.worker;
check(!!worker, "execution: worker service missing");
check((worker?.ports ?? []).length === 0, `execution: worker must not publish ports (found ${(worker?.ports ?? []).length})`);

// --- Worker must declare every env var the alert transport reads (key names only) ---
// The environment: block is an explicit allowlist, so an undeclared var in runtime.env is
// silently dropped and the worker falls back to console with no error (the S1D2 gotcha).
for (const key of [
  "ALERT_TRANSPORT",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  // KJ-P3 mission runtimes and read-only GitHub token.
  "MISSION_OPENROUTER_API_KEY",
  "MISSION_DEEPSEEK_API_KEY",
  "MISSION_ANALYST_MODEL",
  "MISSION_REVIEWER_MODEL",
  "GITHUB_READ_TOKEN",
  // KJ-P4A Telegram operator channel.
  "TELEGRAM_INBOUND_ENABLED",
  "TELEGRAM_MISSION_DAILY_CAP",
  // KJ-P4B approval boundary.
  "KJ_APPROVAL_ENABLED",
  "KJ_APPROVAL_TTL_SECONDS",
  "KJ_ADMISSION_TENANT_ID",
  "KJ_ADMISSION_PRINCIPAL_ID",
  // KJ-P4B.1 signed control requests (the key itself is never transmitted).
  "KJ_CONTROL_SIGNING_KEY",
  "KJ_CONTROL_KEY_ID",
  "KJ_CONTROL_SIGNING_KEY_PREVIOUS",
  "KJ_CONTROL_KEY_ID_PREVIOUS",
  "KJ_CONTROL_FRESHNESS_SECONDS",
  // KJ-P5 canonical memory.
  "KJ_MEMORY_ENABLED",
  "KJ_MEMORY_APPROVER_ID",
  "KJ_MEMORY_APPROVAL_TTL_SECONDS",
]) {
  check(key in (worker?.environment ?? {}), `execution: worker environment does not declare ${key} (silently dropped from runtime.env)`);
}

// --- Restate persistent named-volume storage at /restate-data ---
const restate = exec.services?.restate;
check(!!restate, "execution: restate service missing");
const restateDataMount = (restate?.volumes ?? []).find((v) => v.target === "/restate-data");
check(!!restateDataMount, "execution: restate has no mount at /restate-data");
check(restateDataMount?.type === "volume", `execution: /restate-data mount is not a named volume (type=${restateDataMount?.type})`);
check(!!exec.volumes && Object.keys(exec.volumes).length > 0, "execution: no named volume declared");

// --- Worker repo mount is read-only at /opt/kerneljson/app ---
const repoMount = (worker?.volumes ?? []).find((v) => v.target === "/opt/kerneljson/app");
check(!!repoMount, "execution: worker has no mount at /opt/kerneljson/app");
check(repoMount?.read_only === true, "execution: worker /opt/kerneljson/app mount is NOT read-only");

// --- No Postgres/db container in the execution stack ---
for (const [name, svc] of Object.entries(exec.services ?? {})) {
  check(!/postgres/i.test(svc.image ?? ""), `execution: service '${name}' uses a Postgres image (${svc.image})`);
  check(!/^(db|postgres|postgresql)$/i.test(name), `execution: unexpected DB service '${name}' present`);
}
check(Object.keys(exec.services ?? {}).sort().join(",") === "restate,worker", `execution: services must be exactly restate+worker (found ${Object.keys(exec.services ?? {}).join(",")})`);

// --- Shared network kerneljson-exec across gateway + restate + worker ---
check(svcNets(exec.services?.restate).includes("kerneljson-exec"), "execution: restate not on kerneljson-exec");
check(svcNets(exec.services?.worker).includes("kerneljson-exec"), "execution: worker not on kerneljson-exec");
check(exec.networks?.["kerneljson-exec"]?.external === true, "execution: kerneljson-exec must be external in execution.compose.yaml");
check(exec.networks?.["kerneljson-exec"]?.name === "kerneljson-exec", "execution: kerneljson-exec must have fixed name 'kerneljson-exec'");
const gwSvc = gw.services?.gateway;
check(!!gwSvc, "gateway: gateway service missing");
check(svcNets(gwSvc).includes("kerneljson-exec"), "gateway: gateway not on kerneljson-exec");
check(gw.networks?.["kerneljson-exec"]?.name === "kerneljson-exec", "gateway: kerneljson-exec must have fixed name 'kerneljson-exec'");
check(gw.networks?.["kerneljson-exec"]?.external === true, "gateway: kerneljson-exec must be external in gateway.compose.yaml (Compose-owned means it will try to manage a network it did not create)");

// --- Gateway image must resolve to a concrete tag, never unresolved/empty ---
check(typeof gwSvc?.image === "string" && gwSvc.image.length > 0, `gateway: image did not resolve to a concrete tag (resolved: ${JSON.stringify(gwSvc?.image)})`);
if (process.env.EXPECTED_GATEWAY_IMAGE) {
  check(gwSvc?.image === process.env.EXPECTED_GATEWAY_IMAGE, `gateway: image resolved to '${gwSvc?.image}', expected exactly '${process.env.EXPECTED_GATEWAY_IMAGE}'`);
}

// --- Gateway keeps a localhost-only publish of :8081 ---
const gwPorts = gwSvc?.ports ?? [];
const gw8081 = gwPorts.find((p) => Number(p.target) === 8081);
check(!!gw8081, "gateway: no publish targeting :8081");
check(gw8081?.host_ip === "127.0.0.1", `gateway: :8081 publish is not localhost-only (host_ip=${gw8081?.host_ip})`);

if (failures.length) {
  console.error("EXECUTION TOPOLOGY: FAIL");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("EXECUTION TOPOLOGY: PASS — localhost-only, worker unpublished, shared kerneljson-exec network, persistent Restate storage, read-only repo mount, no Postgres container, gateway :8081 localhost-only.");
