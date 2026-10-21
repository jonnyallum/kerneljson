import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { HttpOperatorDoor } from "./door.js";
import { createMcpServer, type AccessVerifier } from "./server.js";

/**
 * ADR-0025 operator MCP server, LOCAL MODE ONLY. The OAuth verifier is not built yet, so this refuses
 * to start unless it is explicitly told it is local and is bound to a loopback address: there is no
 * configuration in which it serves the tools to the network without authentication.
 *
 *   KJ_ADMISSION_URL     the admission door, e.g. http://127.0.0.1:8081
 *   KJ_ADMISSION_BEARER  the door bearer for Jonny's principal (from jVault via an env file; never argv)
 *   MCP_AUTH=local-unauthenticated   required until OAuth exists
 *   MCP_HOST (default 127.0.0.1), MCP_PORT (default 8090), KERNELJSON_RELEASE_ID (reported as the version)
 */
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function loadConfig(env: NodeJS.ProcessEnv) {
  const host = env["MCP_HOST"] || "127.0.0.1";
  const port = Number(env["MCP_PORT"] || 8090);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MCP_PORT must be a port number");
  if (env["MCP_AUTH"] !== "local-unauthenticated") throw new Error("Only MCP_AUTH=local-unauthenticated is available until the OAuth verifier is built");
  if (!LOOPBACK.has(host)) throw new Error("Local unauthenticated mode binds only to a loopback address");
  const doorUrl = env["KJ_ADMISSION_URL"];
  const bearer = env["KJ_ADMISSION_BEARER"];
  if (!doorUrl || !bearer) throw new Error("KJ_ADMISSION_URL and KJ_ADMISSION_BEARER are required");
  return { host, port, doorUrl, bearer, release: env["KERNELJSON_RELEASE_ID"] || "unreleased-development" };
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const localOnly: AccessVerifier = async () => true;
  const handler = createMcpServer({
    door: new HttpOperatorDoor(config.doorUrl, config.bearer),
    release: config.release,
    verify: localOnly,
    allowedOrigins: [],
    log: (entry) => process.stderr.write(JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n"),
  });
  const server = createServer((req, res) => void handler(req, res));
  server.listen(config.port, config.host, () => process.stderr.write(`kerneljson-operator MCP (local) on http://${config.host}:${config.port}/mcp\n`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`kerneljson-operator MCP failed to start: ${err instanceof Error ? err.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
