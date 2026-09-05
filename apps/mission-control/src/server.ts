import type {
  IncomingMessage,
  ServerResponse,
  IncomingHttpHeaders,
} from "node:http";
import { z } from "zod";
import {
  ApprovalAnswer,
  Id,
  TenantContext,
} from "../../../packages/contracts/src/index.js";
import { MissionControlStore } from "./store.js";
import { layout, renderList, renderTask } from "./view.js";
export interface ControlPort {
  approve(
    context: TenantContext,
    taskId: string,
    answer: ApprovalAnswer,
  ): Promise<void>;
  cancel(context: TenantContext, taskId: string): Promise<void>;
}
class HttpError extends Error {
  constructor(readonly status: number) {
    super("Request rejected");
  }
}
export function createMissionControl(options: {
  store: MissionControlStore;
  origin: string;
  authenticate: (headers: IncomingHttpHeaders) => Promise<TenantContext>;
  controls?: ControlPort;
}) {
  const origin = new URL(options.origin).origin;
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader(
      "content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    try {
      let context: TenantContext;
      try {
        context = TenantContext.parse(await options.authenticate(req.headers));
      } catch {
        throw new HttpError(401);
      }
      const url = new URL(req.url ?? "/", origin);
      if (req.method === "GET" && url.pathname === "/") {
        res.end(renderList(await options.store.list(context)));
        return;
      }
      const match = /^\/tasks\/([^/]+)(?:\/(approve|cancel))?$/.exec(
        url.pathname,
      );
      if (!match) throw new HttpError(404);
      const taskId = Id.parse(match[1]);
      const view = await options.store.task(context, taskId);
      if (!view) throw new HttpError(404);
      if (req.method === "GET" && !match[2]) {
        res.end(renderTask(view, context, Boolean(options.controls)));
        return;
      }
      if (req.method !== "POST" || !match[2]) throw new HttpError(405);
      if (req.headers.origin !== origin) throw new HttpError(403);
      if (!options.controls || !view.pending) throw new HttpError(409);
      if (
        !req.headers["content-type"]?.startsWith(
          "application/x-www-form-urlencoded",
        )
      )
        throw new HttpError(415);
      if (Number(req.headers["content-length"] ?? 0) > 4096) {
        req.resume();
        throw new HttpError(413);
      }
      let body = "";
      for await (const chunk of req) {
        body += String(chunk);
        if (Buffer.byteLength(body) > 4096) throw new HttpError(413);
      }
      const form = new URLSearchParams(body);
      if (new Set(form.keys()).size !== Array.from(form.keys()).length)
        throw new HttpError(400);
      if (match[2] === "approve") {
        if (
          context.principal.kind !== "HUMAN" ||
          view.pending.requestedFrom !== context.principal.id
        )
          throw new HttpError(403);
        const answer = ApprovalAnswer.parse(Object.fromEntries(form));
        if (answer.scopeDigest !== view.pending.evaluation.scopeDigest)
          throw new HttpError(403);
        await options.controls.approve(context, taskId, answer);
      } else {
        if (form.size || context.principal.id !== view.task.principal.id)
          throw new HttpError(403);
        await options.controls.cancel(context, taskId);
      }
      res.writeHead(303, { location: `/tasks/${taskId}` });
      res.end();
    } catch (error) {
      const status =
        error instanceof HttpError
          ? error.status
          : error instanceof z.ZodError
            ? 400
            : error instanceof Error && error.message === "Tenant access denied"
              ? 403
              : 500;
      res.statusCode = status;
      res.end(
        layout(
          String(status),
          `<h1>${status === 401 ? "Sign in required" : status === 404 ? "Task not found" : "Request could not be completed"}</h1><p>Request status: ${status}</p>`,
        ),
      );
    }
  };
}
