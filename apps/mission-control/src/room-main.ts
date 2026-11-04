import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { z } from "zod";
import { TenantContext, type Task } from "../../../packages/contracts/src/index.js";
import { Id } from "../../../packages/contracts/src/common.js";
import {
  PostgresAgentRegistry,
  PostgresChannelStore,
  type AgentRegistry,
  type ChannelStore,
} from "../../../packages/agent-channel/src/index.js";
import { createChannelHandler } from "../../../packages/agent-channel/src/http.js";
import { ChannelService } from "../../../packages/agent-channel/src/service.js";
import { isRoomBearer } from "../../../packages/agent-channel/src/bearer.js";
import { createMissionControl } from "./server.js";
import { MissionControlStore } from "./store.js";

/**
 * Shared room process (ADR-0026 Amendment A). PREPARED, NOT STARTED by this repository.
 * It serves the channel and the Mission Control page. It does not construct a control port,
 * so approve, cancel and signal are not wired. The task store below refuses ledger access.
 */

const RELEASE_ID_RE = /^[A-Za-z0-9._:-]{1,160}$/;
export const MIN_ROOM_BEARER_LENGTH = 32;
/** The only database role this process may use. The admission door's role is refused. */
export const ROOM_DATABASE_ROLE = "agent_room_app";

export function assertRoomDatabaseRole(currentUser: string): void {
  if (currentUser !== ROOM_DATABASE_ROLE) throw new RoomConfigError("DATABASE_ROLE_INVALID");
}

export class RoomConfigError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RoomConfigError";
  }
}

const MemberSpec = z.strictObject({
  bearerEnv: z.string().regex(/^ROOM_BEARER_[A-Z0-9_]+$/),
  tenantId: Id,
  principalId: Id,
  kind: z.enum(["HUMAN", "SERVICE"]),
});

export interface RoomMemberConfig {
  bearer: string;
  context: TenantContext;
}

export interface RoomConfig {
  databaseUrl: string;
  origin: string;
  port: number;
  releaseId: string;
  members: RoomMemberConfig[];
}

export interface RoomConfigSummary {
  port: number;
  origin: string;
  releaseId: string;
  members: number;
}

export function summariseRoomConfig(config: RoomConfig): RoomConfigSummary {
  return { port: config.port, origin: config.origin, releaseId: config.releaseId, members: config.members.length };
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new RoomConfigError(`${name}_MISSING`);
  return value;
}

/** Fail closed. Error text is a code, never an env value. */
export function loadRoomConfig(env: Record<string, string | undefined>): RoomConfig {
  const databaseUrl = required(env, "DATABASE_URL");
  let origin: string;
  try {
    origin = new URL(required(env, "ROOM_ORIGIN")).origin;
  } catch (error) {
    if (error instanceof RoomConfigError) throw error;
    throw new RoomConfigError("ROOM_ORIGIN_INVALID");
  }
  const port = Number(env["PORT"] ?? "8092");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RoomConfigError("PORT_INVALID");
  const releaseId = env["KERNELJSON_RELEASE_ID"] ?? "unreleased-development";
  if (!RELEASE_ID_RE.test(releaseId)) throw new RoomConfigError("RELEASE_ID_INVALID");
  let parsed: unknown;
  try {
    parsed = JSON.parse(required(env, "ROOM_MEMBERS"));
  } catch (error) {
    if (error instanceof RoomConfigError) throw error;
    throw new RoomConfigError("ROOM_MEMBERS_INVALID");
  }
  const specs = z.array(MemberSpec).min(1).safeParse(parsed);
  if (!specs.success) throw new RoomConfigError("ROOM_MEMBERS_INVALID");
  const seen = new Set<string>();
  const members: RoomMemberConfig[] = [];
  const digests = new Set<string>();
  for (const spec of specs.data) {
    const key = `${spec.tenantId}:${spec.principalId}`;
    if (seen.has(key)) throw new RoomConfigError("ROOM_MEMBER_DUPLICATE");
    seen.add(key);
    const bearer = env[spec.bearerEnv];
    if (bearer === undefined || bearer === "") throw new RoomConfigError(`${spec.bearerEnv}_MISSING`);
    if (bearer.length < MIN_ROOM_BEARER_LENGTH) throw new RoomConfigError(`${spec.bearerEnv}_TOO_SHORT`);
    if (!isRoomBearer(bearer)) throw new RoomConfigError(`${spec.bearerEnv}_FORMAT`);
    const digest = createHash("sha256").update(bearer, "utf8").digest("hex");
    if (digests.has(digest)) throw new RoomConfigError("ROOM_BEARER_DUPLICATE");
    digests.add(digest);
    members.push({
      bearer,
      context: TenantContext.parse({ tenantId: spec.tenantId, principal: { id: spec.principalId, kind: spec.kind } }),
    });
  }
  return { databaseUrl, origin, port, releaseId, members };
}

export function createRoomAuthenticator(members: readonly RoomMemberConfig[]) {
  const table = members.map((member) => ({
    digest: createHash("sha256").update(member.bearer, "utf8").digest(),
    context: TenantContext.parse(member.context),
  }));
  return async (headers: IncomingHttpHeaders): Promise<TenantContext> => {
    const header = headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!token) throw new Error("not signed in");
    const got = createHash("sha256").update(token, "utf8").digest();
    let found: TenantContext | null = null;
    for (const entry of table) {
      if (got.length === entry.digest.length && timingSafeEqual(got, entry.digest)) found = entry.context;
    }
    if (!found) throw new Error("not signed in");
    return found;
  };
}

/** A pool that cannot open a connection. Passed to the task view so a regression fails before SQL. */
export function ledgerDeniedPool(): pg.Pool {
  const fail = () => Promise.reject(new Error("room process has no ledger access"));
  return { connect: fail, query: fail, end: async () => undefined } as unknown as pg.Pool;
}

export class ClosedTaskStore extends MissionControlStore {
  override async list(_context: TenantContext): Promise<Task[]> {
    return [];
  }
  override async task(_context: TenantContext, _taskId: string) {
    return null;
  }
}

export function buildRoomHandler(options: {
  store: ChannelStore;
  registry: AgentRegistry;
  origin: string;
  authenticate: (headers: IncomingHttpHeaders) => Promise<TenantContext>;
  taskStore?: MissionControlStore;
}) {
  const service = new ChannelService(options.store, options.registry);
  const channel = createChannelHandler({ service, authenticate: options.authenticate });
  const pages = createMissionControl({
    store: options.taskStore ?? new ClosedTaskStore(ledgerDeniedPool()),
    origin: options.origin,
    authenticate: options.authenticate,
    channel: service,
  });
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", options.origin);
      if (req.method === "GET" && url.pathname === "/healthz") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.setHeader("cache-control", "no-store");
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (url.pathname === "/messages" || url.pathname === "/acks") {
        await channel(req, res);
        return;
      }
      await pages(req, res);
    } catch {
      if (res.headersSent) return;
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "internal" }));
    }
  };
}

export async function startRoom(config: RoomConfig): Promise<{ server: Server; pool: pg.Pool }> {
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  try {
    const client = await pool.connect();
    try {
      const who = await client.query<{ current_user: string }>("select current_user");
      assertRoomDatabaseRole(who.rows[0]?.current_user ?? "");
    } finally {
      client.release();
    }
  } catch (error) {
    await pool.end();
    if (error instanceof RoomConfigError) throw error;
    throw new RoomConfigError("DATABASE_UNREACHABLE");
  }
  const handler = buildRoomHandler({
    store: new PostgresChannelStore(pool),
    registry: new PostgresAgentRegistry(pool),
    origin: config.origin,
    authenticate: createRoomAuthenticator(config.members),
    taskStore: new ClosedTaskStore(ledgerDeniedPool()),
  });
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  server.listen(config.port, () => {
    const summary = summariseRoomConfig(config);
    console.log(`[agent-room] listening on :${summary.port} release=${summary.releaseId} members=${summary.members}`);
  });
  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    console.log(`[agent-room] ${signal} received; draining`);
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  return { server, pool };
}

async function main(): Promise<void> {
  let config: RoomConfig;
  try {
    config = loadRoomConfig(process.env);
  } catch (error) {
    const code = error instanceof RoomConfigError ? error.code : "CONFIG_FAILED";
    process.stderr.write(JSON.stringify({ ok: false, error: code }) + "\n");
    process.exitCode = 2;
    return;
  }
  try {
    await startRoom(config);
  } catch (error) {
    const code = error instanceof RoomConfigError ? error.code : "START_FAILED";
    process.stderr.write(JSON.stringify({ ok: false, error: code }) + "\n");
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
