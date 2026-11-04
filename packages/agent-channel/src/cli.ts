import { pathToFileURL } from "node:url";
import { isRoomBearer } from "./bearer.js";

export interface RoomClient {
  baseUrl: string;
  bearer: string;
  fetchImpl?: typeof fetch;
}

export class RoomClientError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`room ${status}`);
    this.name = "RoomClientError";
  }
}

/** HTTP client for send, read and ack. The bearer stays in the header and is not returned. */
export async function roomCall(client: RoomClient, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  if (!isRoomBearer(client.bearer)) throw new RoomClientError(401, '{"error":"rejected","message":"Sign in required"}');
  const response = await (client.fetchImpl ?? fetch)(new URL(path, client.baseUrl), {
    method,
    headers: {
      authorization: `Bearer ${client.bearer}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new RoomClientError(response.status, text);
  return text ? JSON.parse(text) as unknown : {};
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

export async function runRoomCli(argv: string[], env: Record<string, string | undefined>, clientFetch?: typeof fetch): Promise<number> {
  const baseUrl = env["ROOM_URL"];
  const bearer = env["ROOM_BEARER"];
  if (!baseUrl || !bearer || !isRoomBearer(bearer)) {
    process.stderr.write('{"ok":false,"error":"ROOM_CLIENT_CONFIG"}\n');
    return 2;
  }
  const client: RoomClient = { baseUrl, bearer, ...(clientFetch ? { fetchImpl: clientFetch } : {}) };
  const command = argv[0];
  try {
    if (command === "send") {
      const kind = flag(argv, "--kind");
      const body = flag(argv, "--body");
      const key = flag(argv, "--key");
      if (!kind || !body || !key) {
        process.stderr.write('{"ok":false,"error":"ROOM_CLIENT_USAGE"}\n');
        return 2;
      }
      process.stdout.write(JSON.stringify(await roomCall(client, "POST", "/messages", { kind, body, idempotencyKey: key })) + "\n");
      return 0;
    }
    if (command === "read") {
      const params = new URLSearchParams();
      const after = flag(argv, "--after");
      const since = flag(argv, "--since");
      if (after) params.set("after", after);
      if (since) params.set("since", since);
      const query = params.size ? `?${params.toString()}` : "";
      process.stdout.write(JSON.stringify(await roomCall(client, "GET", `/messages${query}`)) + "\n");
      return 0;
    }
    if (command === "ack") {
      const upTo = flag(argv, "--up-to");
      if (!upTo || !/^[1-9][0-9]*$/.test(upTo)) {
        process.stderr.write('{"ok":false,"error":"ROOM_CLIENT_USAGE"}\n');
        return 2;
      }
      process.stdout.write(JSON.stringify(await roomCall(client, "POST", "/acks", { upToSeq: Number(upTo) })) + "\n");
      return 0;
    }
    if (command === "acks") {
      process.stdout.write(JSON.stringify(await roomCall(client, "GET", "/acks")) + "\n");
      return 0;
    }
    process.stderr.write('{"ok":false,"error":"ROOM_CLIENT_USAGE"}\n');
    return 2;
  } catch (error) {
    if (error instanceof RoomClientError) {
      process.stderr.write(error.body.trim() + "\n");
      return 1;
    }
    process.stderr.write('{"ok":false,"error":"ROOM_CLIENT_FAILED"}\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runRoomCli(process.argv.slice(2), process.env);
}
