import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { OperatorDoor } from "./door.js";
import { SUPPORTED_PROTOCOL_VERSIONS, handleMessage, type CallLog } from "./protocol.js";

export const MCP_PATH = "/mcp";
export const MAX_BODY_BYTES = 65536;

/**
 * Decides whether a request may use the tools. The OAuth verifier (ADR-0025: one Google identity,
 * short-lived audience-bound tokens) is a separate piece; until it exists the only verifier is the
 * loopback-only local one in main.ts. A verifier must never forward the token anywhere.
 */
export type AccessVerifier = (authorization: string | undefined) => Promise<boolean>;

export interface McpServerOptions {
  door: OperatorDoor;
  release: string;
  verify: AccessVerifier;
  /** Exact Origin values allowed to call (DNS rebinding defence). A request with no Origin is allowed. */
  allowedOrigins: readonly string[];
  /** Sent in WWW-Authenticate on a 401 so an OAuth client can discover the authorisation server. */
  resourceMetadataUrl?: string;
  log?: (entry: CallLog & { correlationId: string }) => void;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new HttpError(415, "JSON_REQUIRED");
  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) {
    req.resume();
    throw new HttpError(413, "PAYLOAD_TOO_LARGE");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const b = Buffer.isBuffer(part) ? part : Buffer.from(String(part));
    size += b.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "PAYLOAD_TOO_LARGE");
    chunks.push(b);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "INVALID_JSON");
  }
}

export function createMcpServer(options: McpServerOptions) {
  if (typeof options.verify !== "function") throw new Error("An access verifier is required");
  const origins = new Set(options.allowedOrigins);
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const correlationId = randomUUID();
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-correlation-id", correlationId);
    const send = (status: number, body?: unknown) => {
      res.statusCode = status;
      if (body === undefined) {
        res.end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? "/", "http://mcp.invalid");
      if (req.method === "GET" && url.pathname === "/healthz") return send(200, { ok: true });
      if (url.pathname !== MCP_PATH) throw new HttpError(404, "NOT_FOUND");
      const origin = req.headers.origin;
      if (origin !== undefined && !origins.has(origin)) throw new HttpError(403, "ORIGIN_NOT_ALLOWED");
      if (!(await options.verify(req.headers.authorization))) {
        if (options.resourceMetadataUrl) res.setHeader("www-authenticate", `Bearer resource_metadata="${options.resourceMetadataUrl}"`);
        throw new HttpError(401, "UNAUTHENTICATED");
      }
      // No server-initiated stream and no sessions: only POST is served.
      if (req.method !== "POST") {
        res.setHeader("allow", "POST");
        throw new HttpError(405, "METHOD_NOT_ALLOWED");
      }
      const version = req.headers["mcp-protocol-version"];
      if (version !== undefined && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(String(version))) throw new HttpError(400, "UNSUPPORTED_PROTOCOL_VERSION");
      const accept = req.headers.accept;
      if (accept !== undefined && !/application\/json|\*\/\*/.test(accept)) throw new HttpError(406, "JSON_RESPONSE_ONLY");
      const message = await readJson(req);
      const answer = await handleMessage(message, options.door, options.release, (entry) => options.log?.({ ...entry, correlationId }));
      if (answer === null) return send(202);
      return send(200, answer);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      send(status, { error: e instanceof HttpError ? e.code : "INTERNAL_ERROR", correlationId });
    }
  };
}
