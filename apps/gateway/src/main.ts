import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { BRIEF_RECIPE, CODE_CHANGE_RECIPE, MISSION_RECIPE, TenantContext } from "../../../packages/contracts/src/index.js";
import {
  createGateway,
  createRestateDispatch,
  bearerAuthenticator,
  type CredentialsFor,
  type Dispatch,
  type ScopedOperation,
} from "./server.js";
import { createRestateControls } from "./index.js";
import { createControlSigner, isKeyId, MIN_SIGNING_KEY_LENGTH, type ControlSigner } from "../../../services/kernel/src/control-signing.js";
import type { ControlPort } from "../../mission-control/src/server.js";

/**
 * KernelJSON admission door — production HTTP bootstrap (repo-only; NOT deployed here).
 *
 * The SMALLEST wrapper that turns the reviewed `createGateway(...)` request-handler factory
 * ([server.ts](./server.ts)) into a runnable service, WITHOUT changing any admission semantics
 * (allow-list, idempotency, task_admissions persistence, canonical task creation all stay in
 * server.ts). It only: builds a pg.Pool from DATABASE_URL, wires a deterministic bearer -> tenant
 * identity resolver from explicit non-secret env, adds a non-admitting `GET /healthz`, and serves.
 *
 * Fail-closed and secret-safe: the bearer and DATABASE_URL are read from the environment only,
 * never logged, never an argument, never persisted; a config failure prints only an error CODE.
 * Identity (tenant/principal ids + kind) is non-secret and comes from explicit env so the
 * bearer -> TenantContext mapping is stable across restarts (the principal drives the admission
 * idempotency scope, so it must not vary between retries).
 *
 * Dispatch/controls reuse the existing production seams when a Restate ingress is configured; with
 * none configured the door runs admission-only and NEVER fakes execution success (dispatch resolves
 * UNRESOLVED, control actions resolve UNSUPPORTED). The admission itself (task_admissions row +
 * canonical child task) is persisted before dispatch, so admission-only is a safe, honest mode.
 */

const RELEASE_ID_RE = /^[A-Za-z0-9._:-]{1,160}$/;

export class DoorConfigError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DoorConfigError";
  }
}

export interface DoorConfig {
  databaseUrl: string; // SENSITIVE — never logged, never returned to a printer
  bearer: string; // SENSITIVE — never logged, never returned to a printer
  context: TenantContext; // non-secret tenant + principal ids/kind
  port: number;
  releaseId: string;
  restateIngressUrl: string | null; // null => admission-only mode (no execution dispatch)
  /**
   * KJ-P4B.1. SENSITIVE (`key`) - never logged, never returned to a printer, and NEVER transmitted:
   * Restate journals every request header for 24 hours, so the door signs each request to the workflow
   * with this key (HMAC assertion in `X-KJ-Control-*` headers) instead of sending a credential.
   * null => nothing is signed, exactly as before. Distinct from `bearer`, which never leaves the door.
   */
  controlSigning: { keyId: string; key: string } | null;
  /**
   * ADR-0025. The operator MCP server's own credential and SERVICE principal, distinct from the worker's.
   * null => no MCP credential is accepted. `bearer` is SENSITIVE, like the main bearer.
   */
  mcp: { bearer: string; context: TenantContext } | null;
}

/** ONLY the non-secret fields — safe to log/return. Never includes bearer or DATABASE_URL. */
export interface DoorConfigSummary {
  port: number;
  releaseId: string;
  tenantId: string;
  principalId: string;
  principalKind: string;
  mcpPrincipalId: string | null;
  mode: "restate-dispatch" | "admission-only";
}

export function summariseDoorConfig(config: DoorConfig): DoorConfigSummary {
  return {
    port: config.port,
    releaseId: config.releaseId,
    tenantId: config.context.tenantId,
    principalId: config.context.principal.id,
    principalKind: config.context.principal.kind,
    mcpPrincipalId: config.mcp?.context.principal.id ?? null,
    mode: config.restateIngressUrl ? "restate-dispatch" : "admission-only",
  };
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value === "")
    throw new DoorConfigError(`${name}_MISSING`, `${name} is required`);
  return value;
}

function normaliseIngress(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new DoorConfigError("RESTATE_INGRESS_INVALID", "KJ_RESTATE_INGRESS_URL must be a URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new DoorConfigError("RESTATE_INGRESS_INVALID", "KJ_RESTATE_INGRESS_URL must be http(s)");
  return raw;
}

/**
 * Load + validate the door config, fail-closed. Every thrown error names only the offending env
 * VARIABLE, never its value — so a bootstrap failure can never echo the bearer or DATABASE_URL.
 */
export function loadDoorConfig(env: Record<string, string | undefined>): DoorConfig {
  const databaseUrl = required(env, "DATABASE_URL");
  const bearer = required(env, "KJ_ADMISSION_BEARER");
  if (bearer.length < 16)
    throw new DoorConfigError("KJ_ADMISSION_BEARER_TOO_SHORT", "KJ_ADMISSION_BEARER is too short");

  const tenantId = required(env, "KJ_ADMISSION_TENANT_ID");
  const principalId = required(env, "KJ_ADMISSION_PRINCIPAL_ID");
  const principalKind = required(env, "KJ_ADMISSION_PRINCIPAL_KIND");
  let context: TenantContext;
  try {
    context = TenantContext.parse({
      tenantId,
      principal: { id: principalId, kind: principalKind },
    });
  } catch {
    throw new DoorConfigError(
      "IDENTITY_CONFIG_INVALID",
      "KJ_ADMISSION_TENANT_ID/_PRINCIPAL_ID must be UUIDs and _PRINCIPAL_KIND must be HUMAN|SERVICE",
    );
  }

  const port = Number(env["PORT"] ?? "8081");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new DoorConfigError("PORT_INVALID", "PORT must be an integer 1..65535");

  const releaseId = env["KERNELJSON_RELEASE_ID"] ?? "unreleased-development";
  if (!RELEASE_ID_RE.test(releaseId))
    throw new DoorConfigError("RELEASE_ID_INVALID", "KERNELJSON_RELEASE_ID has an invalid shape");

  const signingKey = env["KJ_CONTROL_SIGNING_KEY"] === undefined || env["KJ_CONTROL_SIGNING_KEY"] === "" ? null : env["KJ_CONTROL_SIGNING_KEY"];
  if (signingKey !== null && signingKey.length < MIN_SIGNING_KEY_LENGTH)
    throw new DoorConfigError("KJ_CONTROL_SIGNING_KEY_TOO_SHORT", "KJ_CONTROL_SIGNING_KEY is too short");
  const keyId = env["KJ_CONTROL_KEY_ID"] === undefined || env["KJ_CONTROL_KEY_ID"] === "" ? "v1" : env["KJ_CONTROL_KEY_ID"];
  if (!isKeyId(keyId)) throw new DoorConfigError("KJ_CONTROL_KEY_ID_INVALID", "KJ_CONTROL_KEY_ID has an invalid shape");

  return {
    databaseUrl,
    bearer,
    context,
    mcp: loadMcpIdentity(env, bearer, context),
    port,
    releaseId,
    restateIngressUrl: normaliseIngress(env["KJ_RESTATE_INGRESS_URL"]),
    controlSigning: signingKey === null ? null : { keyId, key: signingKey },
  };
}

/** Bearers below this length are refused for the MCP credential (it is newly minted, so no legacy). */
export const MIN_MCP_BEARER_LENGTH = 32;

/**
 * ADR-0025: the MCP credential is all-or-nothing. All three variables set => a second bearer for a
 * SERVICE principal of the same tenant; none set => no MCP credential. A partial set, a HUMAN kind, the
 * worker's principal id or the worker's bearer are refused, so the two identities can never merge.
 */
function loadMcpIdentity(
  env: Record<string, string | undefined>,
  mainBearer: string,
  main: TenantContext,
): { bearer: string; context: TenantContext } | null {
  const names = ["KJ_MCP_BEARER", "KJ_MCP_PRINCIPAL_ID", "KJ_MCP_PRINCIPAL_KIND"] as const;
  const set = names.filter((n) => env[n] !== undefined && env[n] !== "");
  if (set.length === 0) return null;
  if (set.length !== names.length)
    throw new DoorConfigError("KJ_MCP_CONFIG_PARTIAL", "KJ_MCP_BEARER, KJ_MCP_PRINCIPAL_ID and KJ_MCP_PRINCIPAL_KIND must be set together");
  const bearer = env["KJ_MCP_BEARER"]!;
  if (bearer.length < MIN_MCP_BEARER_LENGTH)
    throw new DoorConfigError("KJ_MCP_BEARER_TOO_SHORT", "KJ_MCP_BEARER is too short");
  if (bearer === mainBearer)
    throw new DoorConfigError("KJ_MCP_BEARER_REUSED", "KJ_MCP_BEARER must differ from KJ_ADMISSION_BEARER");
  if (env["KJ_MCP_PRINCIPAL_KIND"] !== "SERVICE")
    throw new DoorConfigError("KJ_MCP_PRINCIPAL_KIND_INVALID", "KJ_MCP_PRINCIPAL_KIND must be SERVICE");
  let context: TenantContext;
  try {
    context = TenantContext.parse({ tenantId: main.tenantId, principal: { id: env["KJ_MCP_PRINCIPAL_ID"], kind: "SERVICE" } });
  } catch {
    throw new DoorConfigError("KJ_MCP_PRINCIPAL_ID_INVALID", "KJ_MCP_PRINCIPAL_ID must be a UUID");
  }
  if (context.principal.id === main.principal.id)
    throw new DoorConfigError("KJ_MCP_PRINCIPAL_REUSED", "KJ_MCP_PRINCIPAL_ID must differ from KJ_ADMISSION_PRINCIPAL_ID");
  return { bearer, context };
}

/** What the MCP principal may start and control at the door. Reads are governed by membership alone. */
export const MCP_RECIPES: readonly string[] = [BRIEF_RECIPE, MISSION_RECIPE, CODE_CHANGE_RECIPE];
export const MCP_CONTROLS: readonly string[] = ["cancel"];

/**
 * The door's per-principal scope: the MCP principal may submit only MCP_RECIPES and use only
 * MCP_CONTROLS. Every other principal is unchanged. Membership (`withTenant`) still applies on top, and
 * as a SERVICE principal the MCP can never approve or schedule there either.
 */
export function doorScope(mcpPrincipalId: string | null): (context: TenantContext, operation: ScopedOperation) => boolean {
  return (context, operation) => {
    if (mcpPrincipalId === null || context.principal.id !== mcpPrincipalId) return true;
    return operation.kind === "submit" ? MCP_RECIPES.includes(operation.recipe) : MCP_CONTROLS.includes(operation.action);
  };
}

/**
 * Several bearers, each mapped to its own fixed identity. Every entry is compared, in constant time
 * over SHA-256 digests, whatever matches first, so timing does not say which credential was close.
 */
export function createBearerTable(
  entries: ReadonlyArray<{ bearer: string; context: TenantContext }>,
): (token: string) => Promise<TenantContext | null> {
  const table = entries.map((e) => ({ digest: createHash("sha256").update(e.bearer, "utf8").digest(), context: TenantContext.parse(e.context) }));
  if (new Set(table.map((t) => t.digest.toString("hex"))).size !== table.length) throw new Error("Duplicate bearer");
  return async (token: string): Promise<TenantContext | null> => {
    if (typeof token !== "string" || token.length === 0) return null;
    const got = createHash("sha256").update(token, "utf8").digest();
    let found: TenantContext | null = null;
    for (const t of table) if (timingSafeEqual(got, t.digest)) found = t.context;
    return found;
  };
}

/**
 * The deployment identity resolver: exactly one bearer maps to exactly one fixed TenantContext.
 * Comparison is constant-time over SHA-256 digests (no length/short-circuit leak). The returned
 * context is a stable constant — the same across restarts and every request — so the admission
 * idempotency scope (tenant, principal) never drifts between retries. Any other token -> null,
 * which `bearerAuthenticator` turns into 401. DB-level authority (ACTIVE membership + role) is
 * still enforced downstream by `withTenant`; this resolver only asserts "which identity".
 */
export function createBearerResolver(
  bearer: string,
  context: TenantContext,
): (token: string) => Promise<TenantContext | null> {
  const expected = createHash("sha256").update(bearer, "utf8").digest();
  const frozen = TenantContext.parse(context); // validate once at construction
  return async (token: string): Promise<TenantContext | null> => {
    if (typeof token !== "string" || token.length === 0) return null;
    const got = createHash("sha256").update(token, "utf8").digest();
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
    return frozen;
  };
}

/** Admission-only dispatch: honest UNRESOLVED, never a fabricated ACCEPTED. */
const admissionOnlyDispatch: Dispatch = async () => ({ status: "UNRESOLVED" });

/** Admission-only controls: no execution surface, so every control action resolves UNSUPPORTED
 *  (createGateway maps a void result to 409). Never reached by fire-once (which only POSTs). */
const admissionOnlyControls: ControlPort = {
  async approve() {
    return undefined;
  },
  async cancel() {
    return undefined;
  },
  async signal() {
    return undefined;
  },
};

/** Build the door request handler: a non-admitting `/healthz` in front of the reviewed gateway. */
export function buildDoorHandler(
  pool: pg.Pool,
  config: DoorConfig,
): (req: IncomingMessage, res: ServerResponse) => void {
  const authenticate = bearerAuthenticator(
    config.mcp === null ? createBearerResolver(config.bearer, config.context) : createBearerTable([{ bearer: config.bearer, context: config.context }, config.mcp]),
  );
  // KJ-P4B.1: the internal hop to the workflow carries a signed assertion for each exact request when a
  // signing key is configured, so the approval workflow can authenticate it without the key ever
  // crossing Restate. Absent, the headers are empty, as before. It never sends `Authorization`.
  const signer: ControlSigner | null = config.controlSigning ? createControlSigner(config.controlSigning) : null;
  const credentialsFor: CredentialsFor = async (context, request) =>
    signer === null ? {} : signer({ ...request, tenantId: context.tenantId, principalId: context.principal.id });
  const dispatch: Dispatch = config.restateIngressUrl
    ? createRestateDispatch(config.restateIngressUrl, credentialsFor)
    : admissionOnlyDispatch;
  const controls: ControlPort = config.restateIngressUrl
    ? createRestateControls(config.restateIngressUrl, credentialsFor, { pool })
    : admissionOnlyControls;
  const gateway = createGateway({
    pool,
    releaseId: config.releaseId,
    authenticate,
    admit: async () => true, // transport auth + ACTIVE-membership authority + allow-list are the gate
    controls,
    dispatch,
    scope: doorScope(config.mcp?.context.principal.id ?? null),
  });
  return (req: IncomingMessage, res: ServerResponse): void => {
    // Liveness only: no auth, no DB, no admission, no secret, no internal detail.
    if (req.method === "GET" && (req.url === "/healthz" || req.url?.startsWith("/healthz?"))) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    void gateway(req, res);
  };
}

/** Start the door: pool + server + listen + graceful shutdown. Logs only non-secret summary. */
export function startDoor(config: DoorConfig): { server: Server; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  const handler = buildDoorHandler(pool, config);
  const server = createServer((req, res) => handler(req, res));
  server.listen(config.port, () => {
    const s = summariseDoorConfig(config);
    console.log(
      `[admission-door] listening on :${s.port} release=${s.releaseId} ` +
        `tenant=${s.tenantId} principal=${s.principalId}(${s.principalKind}) mcp=${s.mcpPrincipalId ?? "none"} mode=${s.mode}`,
    );
  });
  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    console.log(`[admission-door] ${signal} received; draining`);
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  return { server, pool };
}

async function main(): Promise<void> {
  let config: DoorConfig;
  try {
    config = loadDoorConfig(process.env);
  } catch (error) {
    // Print ONLY a code — never a value (no bearer, no DATABASE_URL, no message interpolation).
    const code = error instanceof DoorConfigError ? error.code : "CONFIG_FAILED";
    process.stderr.write(JSON.stringify({ ok: false, error: code }) + "\n");
    process.exitCode = 2;
    return;
  }
  startDoor(config);
}

// Run ONLY when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
