import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { TenantContext } from "../../contracts/src/index.js";
import { ChannelError } from "./contract.js";
import type { ChannelService } from "./service.js";

const MAX_REQUEST = 8192;
class HttpError extends Error {
  constructor(readonly status: number) {
    super("rejected");
  }
}

/** JSON transport for agents. Authentication is injected, as in Mission Control (ADR-0014). */
export function createChannelHandler(options: {
  service: ChannelService;
  authenticate: (headers: IncomingHttpHeaders) => Promise<TenantContext>;
}) {
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.end(JSON.stringify(body));
  };
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      let context: TenantContext;
      try {
        context = TenantContext.parse(await options.authenticate(req.headers));
      } catch {
        throw new HttpError(401);
      }
      const url = new URL(req.url ?? "/", "http://channel.invalid");
      if (url.pathname === "/messages" && req.method === "GET") {
        return send(res, 200, await options.service.read(context, Object.fromEntries(url.searchParams)));
      }
      const known = url.pathname === "/messages" || url.pathname === "/acks";
      if (!known) throw new HttpError(404);
      if (req.method !== "POST") throw new HttpError(405);
      if (!req.headers["content-type"]?.startsWith("application/json")) throw new HttpError(415);
      if (Number(req.headers["content-length"] ?? 0) > MAX_REQUEST) {
        req.resume();
        throw new HttpError(413);
      }
      let raw = "";
      for await (const chunk of req) {
        raw += String(chunk);
        if (Buffer.byteLength(raw) > MAX_REQUEST) throw new HttpError(413);
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        throw new HttpError(400);
      }
      if (url.pathname === "/acks") return send(res, 200, await options.service.ack(context, body));
      const out = await options.service.post(context, body);
      return send(res, out.duplicate ? 200 : 201, out);
    } catch (error) {
      if (error instanceof HttpError) return send(res, error.status, { error: "rejected" });
      if (error instanceof z.ZodError) return send(res, 400, { error: "invalid request" });
      if (error instanceof ChannelError)
        return send(res, { DENIED: 403, CONFLICT: 409, NOT_FOUND: 404 }[error.code], {
          error: error.code,
        });
      return send(res, 500, { error: "internal" }); // never echo internals
    }
  };
}
