import type {
  AdmissionGateway,
  AdmissionRequestInput,
  AdmissionResult,
} from "./durable-timer.js";

/**
 * Phase S1-R — the REAL seam to the KernelJSON admission door.
 *
 * The scheduler's `AdmissionGateway` implemented against the production admission
 * endpoint (`POST /v1/tasks`, `apps/gateway/src/server.ts`). It is the SOLE way the
 * scheduler obtains a canonical child task id: the driver has no minting capability,
 * so Restate/the scheduler structurally cannot create canonical work.
 *
 * Idempotency identity == `fireIdentity`. The deterministic fire identity is passed
 * straight through as the `Idempotency-Key`; there is NO second, random idempotency
 * identity. KernelJSON Admission dedupes on it: concurrent duplicates and post-crash
 * replays converge to ONE canonical task id, and the same key with a different
 * payload fails closed (409). This is the load-bearing exactly-once assumption from
 * the boundary design (S1R_RESTATE_BOUNDARY_DESIGN §4/§13), here bound to the wire.
 *
 * No `@restatedev/restate-sdk` import: the admission seam is Restate-independent.
 */
export interface HttpAdmissionOptions {
  /** Authorization header value for the admission door (e.g. `Bearer <token>`). A
   *  descriptor/token supplied by the caller — never a secret embedded here. */
  authorization: string;
  /** The recipe the scheduled admission requests (e.g. `claude_md_check/v1`). */
  recipe: string;
  /** Stable objective per logical fire. MUST be a pure function of the fire so the
   *  same `(scheduleId, fireWindowKey)` always yields the same payload under one
   *  Idempotency-Key; a varying objective would trip the 409 payload-conflict guard. */
  objectiveFor?: (req: AdmissionRequestInput) => string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Raised when the door rejects a repeat of the same Idempotency-Key with a changed
 *  payload. A bug tripwire, not an expected path: the objective must be fire-stable. */
export class AdmissionIdempotencyConflict extends Error {
  constructor(public readonly admissionIdentity: string) {
    super(`admission idempotency conflict for identity ${admissionIdentity}`);
    this.name = "AdmissionIdempotencyConflict";
  }
}

export class HttpAdmissionGateway implements AdmissionGateway {
  private readonly fetchImpl: typeof fetch;
  constructor(
    private readonly baseUrl: string,
    private readonly opts: HttpAdmissionOptions,
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async admit(req: AdmissionRequestInput): Promise<AdmissionResult> {
    const objective =
      this.opts.objectiveFor?.(req) ??
      `schedule ${req.scheduleId} ${req.fireWindowKey}`;
    const res = await this.fetchImpl(`${this.baseUrl}/v1/tasks`, {
      method: "POST",
      headers: {
        authorization: this.opts.authorization,
        "content-type": "application/json",
        // fireIdentity, verbatim. No secondary idempotency identity.
        "idempotency-key": req.admissionIdentity,
      },
      body: JSON.stringify({ recipe: this.opts.recipe, objective }),
    });
    if (res.status === 409) throw new AdmissionIdempotencyConflict(req.admissionIdentity);
    if (res.status !== 202) throw new Error(`admission door returned HTTP ${res.status}`);
    const body = (await res.json()) as { taskId: string };
    // The HTTP door returns 202 for both first-admit and replay; whether this call
    // deduped is authoritatively decided downstream by the fire row's state, so we
    // do not infer it here. The canonical id is what matters.
    return { childTaskId: body.taskId, deduped: false };
  }
}
