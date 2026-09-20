import { createHash } from "node:crypto";

/**
 * KJ-P4A - the adapter's only way to ask KernelJSON for anything: the SAME admission door every other
 * client uses (`POST /v1/tasks`, the scheduler's route). The adapter cannot mint a task, complete one,
 * or write ledger state; it can only ask the door, which authenticates the bearer, resolves principal
 * and tenant, applies policy, and builds the IntentEnvelope.
 *
 * What the adapter contributes to that envelope, and nothing more:
 *   idempotency key  `tg:upd:<update_id>`   Telegram retries and replays converge on ONE task
 *   x-kj-channel     `telegram/v1`          becomes `source: kerneljson:channel/telegram/v1` (allow-listed)
 *   x-correlation-id a trace id derived from the update id, so the trace is stable across replays
 *
 * The bearer is passed in by the caller (from jVault via the environment) and appears only in the
 * Authorization header. Errors are classified by status and never carry a body or a header.
 */
export type AdmitResult =
  | { ok: true; taskId: string }
  | { ok: false; reason: "UNAVAILABLE" | "REJECTED" | "CONFLICT" };

export type ReadResult =
  | { found: true; status: unknown; evidence: unknown }
  | { found: false }
  | { found: "ERROR" };

export interface DoorClient {
  admitMission(input: { updateId: number; recipe: string; objective: string }): Promise<AdmitResult>;
  readTask(taskId: string): Promise<ReadResult>;
}

export const idempotencyKeyFor = (updateId: number): string => `tg:upd:${updateId}`;

/** A stable UUID-shaped trace id for one Telegram update. Same update in, same trace out. */
export function traceIdFor(updateId: number): string {
  const h = createHash("sha256").update(`telegram/v1:${updateId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const TIMEOUT_MS = 15_000;

export class HttpDoorClient implements DoorClient {
  readonly #base: string;
  readonly #authorization: string;
  readonly #fetch: typeof fetch;

  constructor(baseUrl: string, authorization: string, fetchImpl: typeof fetch = fetch) {
    this.#base = baseUrl.replace(/\/+$/, "");
    this.#authorization = authorization;
    this.#fetch = fetchImpl;
  }

  async admitMission(input: { updateId: number; recipe: string; objective: string }): Promise<AdmitResult> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#base}/v1/tasks`, {
        method: "POST",
        headers: {
          authorization: this.#authorization,
          "content-type": "application/json",
          "idempotency-key": idempotencyKeyFor(input.updateId),
          "x-kj-channel": "telegram/v1",
          "x-correlation-id": traceIdFor(input.updateId),
        },
        body: JSON.stringify({ recipe: input.recipe, objective: input.objective }),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return { ok: false, reason: "UNAVAILABLE" };
    }
    if (response.status === 202) {
      try {
        const body = (await response.json()) as { taskId?: unknown };
        if (typeof body.taskId === "string" && /^[0-9a-f-]{36}$/.test(body.taskId)) return { ok: true, taskId: body.taskId };
      } catch {
        // fall through: an accepted admission with an unreadable body is treated as unavailable
      }
      return { ok: false, reason: "UNAVAILABLE" };
    }
    await response.body?.cancel().catch(() => {});
    if (response.status === 409) return { ok: false, reason: "CONFLICT" };
    if (response.status === 429 || response.status >= 500) return { ok: false, reason: "UNAVAILABLE" };
    return { ok: false, reason: "REJECTED" };
  }

  async readTask(taskId: string): Promise<ReadResult> {
    const get = async (path: string): Promise<{ status: number; body: unknown }> => {
      const response = await this.#fetch(`${this.#base}${path}`, {
        headers: { authorization: this.#authorization },
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return { status: response.status, body: null };
      }
      return { status: response.status, body: await response.json() };
    };
    try {
      const status = await get(`/v1/tasks/${taskId}`);
      if (status.status === 404 || status.status === 403) return { found: false };
      if (status.status !== 200) return { found: "ERROR" };
      const evidence = await get(`/v1/tasks/${taskId}/evidence`);
      if (evidence.status === 404 || evidence.status === 403) return { found: false };
      if (evidence.status !== 200) return { found: "ERROR" };
      return { found: true, status: status.body, evidence: evidence.body };
    } catch {
      return { found: "ERROR" };
    }
  }
}
