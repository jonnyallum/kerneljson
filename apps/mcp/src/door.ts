/**
 * ADR-0025: the operator MCP server's only way to reach KernelJSON - the admission door, with one
 * bearer for Jonny's principal, exactly as the Telegram channel does. Nothing here holds a database
 * credential, Restate access or a runtime secret other than that bearer, which appears only in the
 * Authorization header and is never echoed: errors are classified by status and carry no body.
 */
export type DoorFailure = "NOT_FOUND" | "REJECTED" | "CONFLICT" | "FORBIDDEN" | "RATE_LIMITED" | "UNAVAILABLE";

export type DoorResult = { ok: true; status: number; body: unknown } | { ok: false; failure: DoorFailure; status: number | null };

export const MCP_CHANNEL = "chatgpt-mcp/v1";

const TIMEOUT_MS = 15_000;
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function classify(status: number): DoorFailure {
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 401 || status === 403) return "FORBIDDEN";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "UNAVAILABLE";
  return "REJECTED";
}

export interface OperatorDoor {
  listTasks(limit: number): Promise<DoorResult>;
  task(taskId: string, view?: "history" | "evidence" | "outcome"): Promise<DoorResult>;
  memory(query: Record<string, string>): Promise<DoorResult>;
  world(query: Record<string, string>): Promise<DoorResult>;
  health(): Promise<DoorResult>;
  admit(input: { recipe: string; objective: string; idempotencyKey: string }): Promise<DoorResult>;
  cancel(taskId: string): Promise<DoorResult>;
}

export class HttpOperatorDoor implements OperatorDoor {
  readonly #base: string;
  readonly #authorization: string;
  readonly #fetch: typeof fetch;

  constructor(baseUrl: string, bearer: string, fetchImpl: typeof fetch = fetch) {
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Invalid admission door URL");
    if (!/^[^\s]{16,4096}$/.test(bearer)) throw new Error("Admission bearer missing or malformed");
    this.#base = baseUrl.replace(/\/+$/, "");
    this.#authorization = `Bearer ${bearer}`;
    this.#fetch = fetchImpl;
  }

  async #call(method: "GET" | "POST", path: string, extra: { headers?: Record<string, string>; body?: unknown } = {}): Promise<DoorResult> {
    let response: Response;
    try {
      response = await this.#fetch(this.#base + path, {
        method,
        headers: {
          authorization: this.#authorization,
          ...(extra.body === undefined ? {} : { "content-type": "application/json" }),
          ...extra.headers,
        },
        ...(extra.body === undefined ? {} : { body: JSON.stringify(extra.body) }),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return { ok: false, failure: "UNAVAILABLE", status: null };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, failure: classify(response.status), status: response.status };
    }
    try {
      return { ok: true, status: response.status, body: await response.json() };
    } catch {
      return { ok: false, failure: "UNAVAILABLE", status: response.status };
    }
  }

  listTasks(limit: number): Promise<DoorResult> {
    return this.#call("GET", `/v1/tasks?limit=${encodeURIComponent(String(limit))}`);
  }

  async task(taskId: string, view?: "history" | "evidence" | "outcome"): Promise<DoorResult> {
    // The id goes into a path: refuse anything that is not exactly a uuid rather than encode it.
    if (!TASK_ID.test(taskId)) return { ok: false, failure: "REJECTED", status: null };
    return this.#call("GET", `/v1/tasks/${taskId}${view ? `/${view}` : ""}`);
  }

  memory(query: Record<string, string>): Promise<DoorResult> {
    return this.#call("GET", `/v1/memory?${new URLSearchParams(query)}`);
  }

  world(query: Record<string, string>): Promise<DoorResult> {
    return this.#call("GET", `/v1/world?${new URLSearchParams(query)}`);
  }

  health(): Promise<DoorResult> {
    return this.#call("GET", "/v1/health");
  }

  admit(input: { recipe: string; objective: string; idempotencyKey: string }): Promise<DoorResult> {
    return this.#call("POST", "/v1/tasks", {
      headers: { "idempotency-key": input.idempotencyKey, "x-kj-channel": MCP_CHANNEL },
      body: { recipe: input.recipe, objective: input.objective },
    });
  }

  async cancel(taskId: string): Promise<DoorResult> {
    if (!TASK_ID.test(taskId)) return { ok: false, failure: "REJECTED", status: null };
    return this.#call("POST", `/v1/tasks/${taskId}/cancel`, { body: {} });
  }
}
