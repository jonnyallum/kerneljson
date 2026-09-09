import { SHADOW_CONSUMER } from "./identity.js";
import type { ShadowVerdict } from "./estate-admission-request.js";

export interface ShadowRunRecord {
  id: string;
  consumer: string;
  input_hash: string;
  spawner_output: Record<string, unknown> | null;
  latency_ms: number;
  cost_estimate: number;
  status: string;
  created_at: string;
}

export interface ShadowCompareRecord {
  id: string;
  run_id: string;
  consumer: string;
  verdict: ShadowVerdict;
  diff_jsonb: Record<string, unknown>;
  created_at: string;
}

export interface ShadowPersistInput {
  input_hash: string;
  status: string;
  latency_ms: number;
  output: Record<string, unknown>;
  verdict: ShadowVerdict;
  diff: Record<string, unknown>;
}

export interface ShadowStoreWriter {
  persist(input: ShadowPersistInput): Promise<{
    run: ShadowRunRecord;
    compare: ShadowCompareRecord;
  }>;
  listRuns(consumer?: string): Promise<ShadowRunRecord[]>;
  listCompares(consumer?: string): Promise<ShadowCompareRecord[]>;
}

function newId(): string {
  return crypto.randomUUID();
}

/**
 * In-memory fixture store targeting spawner_shadow_* shapes.
 * Idempotent on (consumer, input_hash): retries reuse the same run row and
 * append an attempt compare (does not invent a new logical comparison identity).
 */
export class InMemoryShadowStore implements ShadowStoreWriter {
  readonly runs: ShadowRunRecord[] = [];
  readonly compares: ShadowCompareRecord[] = [];
  /** Maps `${consumer}:${input_hash}` → run id for logical identity. */
  private readonly runByLogicalKey = new Map<string, string>();

  async persist(input: ShadowPersistInput) {
    const created_at = new Date().toISOString();
    const logicalKey = `${SHADOW_CONSUMER}:${input.input_hash}`;
    const existingRunId = this.runByLogicalKey.get(logicalKey);
    let run: ShadowRunRecord;
    if (existingRunId) {
      const found = this.runs.find((r) => r.id === existingRunId);
      if (found) {
        found.spawner_output = input.output;
        found.latency_ms = input.latency_ms;
        found.status = input.status;
        run = found;
      } else {
        run = {
          id: existingRunId,
          consumer: SHADOW_CONSUMER,
          input_hash: input.input_hash,
          spawner_output: input.output,
          latency_ms: input.latency_ms,
          cost_estimate: 0,
          status: input.status,
          created_at,
        };
        this.runs.push(run);
      }
    } else {
      run = {
        id: newId(),
        consumer: SHADOW_CONSUMER,
        input_hash: input.input_hash,
        spawner_output: input.output,
        latency_ms: input.latency_ms,
        cost_estimate: 0,
        status: input.status,
        created_at,
      };
      this.runs.push(run);
      this.runByLogicalKey.set(logicalKey, run.id);
    }
    const compare: ShadowCompareRecord = {
      id: newId(),
      run_id: run.id,
      consumer: SHADOW_CONSUMER,
      verdict: input.verdict,
      diff_jsonb: {
        ...input.diff,
        attempt: this.compares.filter((c) => c.run_id === run.id).length + 1,
      },
      created_at,
    };
    this.compares.push(compare);
    return { run, compare };
  }

  async listRuns(consumer: string = SHADOW_CONSUMER) {
    return this.runs.filter((r) => r.consumer === consumer);
  }

  async listCompares(consumer: string = SHADOW_CONSUMER) {
    return this.compares.filter((c) => c.consumer === consumer);
  }
}

/**
 * Records intended PostgREST payloads without executing HTTP.
 * Used when live credentials unavailable; fixtures + schema integration tests.
 */
export class StubSqlShadowStore implements ShadowStoreWriter {
  readonly posted: Array<{ table: string; body: Record<string, unknown> }> = [];
  private readonly memory = new InMemoryShadowStore();

  constructor(
    readonly endpointHint = "https://example.invalid/rest/v1/spawner_shadow_runs",
  ) {}

  async persist(input: ShadowPersistInput) {
    const result = await this.memory.persist(input);
    this.posted.push({
      table: "spawner_shadow_runs",
      body: {
        id: result.run.id,
        consumer: result.run.consumer,
        input_hash: result.run.input_hash,
        spawner_output: result.run.spawner_output,
        latency_ms: result.run.latency_ms,
        cost_estimate: result.run.cost_estimate,
        status: result.run.status,
        _endpoint_hint: this.endpointHint,
        _executed: false,
      },
    });
    this.posted.push({
      table: "spawner_shadow_compare",
      body: {
        id: result.compare.id,
        run_id: result.compare.run_id,
        consumer: result.compare.consumer,
        verdict: result.compare.verdict,
        diff_jsonb: result.compare.diff_jsonb,
        _executed: false,
      },
    });
    return result;
  }

  async listRuns(consumer?: string) {
    return this.memory.listRuns(consumer);
  }

  async listCompares(consumer?: string) {
    return this.memory.listCompares(consumer);
  }
}

export interface PostgrestShadowStoreOptions {
  /** Brain/Supabase REST base, e.g. https://xxx.supabase.co/rest/v1 */
  restBaseUrl: string;
  /** service_role key — NEVER log this value */
  serviceRoleKey: string;
  /** Optional fetch impl for tests */
  fetchImpl?: typeof fetch;
}

/**
 * Real writer for public.spawner_shadow_runs + public.spawner_shadow_compare
 * via Brain PostgREST (service_role). consumer=kj-admission-shadow-email.
 *
 * Idempotent: one logical run per (consumer, input_hash). Retries reuse the
 * existing run id and append a compare attempt row — they do not invent a
 * new logical comparison identity / fake task.
 *
 * Schema: new-system/migrations/2026-09-05_shadow_store_ddl.sql
 */
export class PostgrestShadowStore implements ShadowStoreWriter {
  private readonly fetchFn: typeof fetch;
  private readonly headers: Record<string, string>;
  private readonly runsUrl: string;
  private readonly compareUrl: string;

  constructor(opts: PostgrestShadowStoreOptions) {
    const base = opts.restBaseUrl.replace(/\/$/, "");
    this.runsUrl = `${base}/spawner_shadow_runs`;
    this.compareUrl = `${base}/spawner_shadow_compare`;
    this.fetchFn = opts.fetchImpl ?? fetch;
    this.headers = {
      apikey: opts.serviceRoleKey,
      Authorization: `Bearer ${opts.serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };
  }

  private async rest<T>(
    method: string,
    url: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const init: RequestInit = {
      method,
      headers: { ...this.headers, ...extraHeaders },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const res = await this.fetchFn(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `PostgREST ${method} ${url.split("?")[0]} failed: ${res.status} ${text.slice(0, 200)}`,
      );
    }
    if (res.status === 204) return [] as T;
    return (await res.json()) as T;
  }

  async persist(input: ShadowPersistInput) {
    const existing = await this.rest<ShadowRunRecord[]>(
      "GET",
      `${this.runsUrl}?consumer=eq.${encodeURIComponent(SHADOW_CONSUMER)}&input_hash=eq.${encodeURIComponent(input.input_hash)}&select=*&limit=1&order=created_at.asc`,
    );
    let run: ShadowRunRecord;
    if (existing[0]) {
      const patched = await this.rest<ShadowRunRecord[]>(
        "PATCH",
        `${this.runsUrl}?id=eq.${encodeURIComponent(existing[0].id)}`,
        {
          spawner_output: input.output,
          latency_ms: input.latency_ms,
          status: input.status,
          cost_estimate: 0,
        },
      );
      run = patched[0] ?? {
        ...existing[0],
        spawner_output: input.output,
        latency_ms: input.latency_ms,
        status: input.status,
      };
    } else {
      const inserted = await this.rest<ShadowRunRecord[]>("POST", this.runsUrl, {
        consumer: SHADOW_CONSUMER,
        input_hash: input.input_hash,
        spawner_output: input.output,
        latency_ms: input.latency_ms,
        cost_estimate: 0,
        status: input.status,
      });
      if (!inserted[0]) {
        throw new Error("PostgREST insert spawner_shadow_runs returned empty");
      }
      run = inserted[0];
    }

    const priorAttempts = await this.rest<Array<{ id: string }>>(
      "GET",
      `${this.compareUrl}?run_id=eq.${encodeURIComponent(run.id)}&select=id`,
    );
    const attempt = (priorAttempts?.length ?? 0) + 1;
    const compareInserted = await this.rest<ShadowCompareRecord[]>(
      "POST",
      this.compareUrl,
      {
        run_id: run.id,
        consumer: SHADOW_CONSUMER,
        verdict: input.verdict,
        diff_jsonb: { ...input.diff, attempt },
      },
    );
    if (!compareInserted[0]) {
      throw new Error("PostgREST insert spawner_shadow_compare returned empty");
    }
    return { run, compare: compareInserted[0] };
  }

  async listRuns(consumer: string = SHADOW_CONSUMER) {
    return this.rest<ShadowRunRecord[]>(
      "GET",
      `${this.runsUrl}?consumer=eq.${encodeURIComponent(consumer)}&select=*&order=created_at.desc&limit=200`,
    );
  }

  async listCompares(consumer: string = SHADOW_CONSUMER) {
    return this.rest<ShadowCompareRecord[]>(
      "GET",
      `${this.compareUrl}?consumer=eq.${encodeURIComponent(consumer)}&select=*&order=created_at.desc&limit=500`,
    );
  }
}

/**
 * Build PostgrestShadowStore from env (never logs secrets).
 * Env: ANTIGRAVITY_BRAIN_URL / BRAIN_URL + ANTIGRAVITY_BRAIN_SERVICE_ROLE_KEY / BRAIN_SERVICE_ROLE_KEY
 */
export function createPostgrestShadowStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PostgrestShadowStore | null {
  const url =
    env.ANTIGRAVITY_BRAIN_URL ||
    env.BRAIN_URL ||
    "https://lkwydqtfbdjhxaarelaz.supabase.co";
  const key =
    env.ANTIGRAVITY_BRAIN_SERVICE_ROLE_KEY || env.BRAIN_SERVICE_ROLE_KEY;
  if (!key) return null;
  return new PostgrestShadowStore({
    restBaseUrl: `${url.replace(/\/$/, "")}/rest/v1`,
    serviceRoleKey: key,
  });
}
