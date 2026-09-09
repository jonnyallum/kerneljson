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

/** In-memory fixture store targeting spawner_shadow_* shapes. */
export class InMemoryShadowStore implements ShadowStoreWriter {
  readonly runs: ShadowRunRecord[] = [];
  readonly compares: ShadowCompareRecord[] = [];

  async persist(input: ShadowPersistInput) {
    const created_at = new Date().toISOString();
    const run: ShadowRunRecord = {
      id: newId(),
      consumer: SHADOW_CONSUMER,
      input_hash: input.input_hash,
      spawner_output: input.output,
      latency_ms: input.latency_ms,
      cost_estimate: 0,
      status: input.status,
      created_at,
    };
    const compare: ShadowCompareRecord = {
      id: newId(),
      run_id: run.id,
      consumer: SHADOW_CONSUMER,
      verdict: input.verdict,
      diff_jsonb: input.diff,
      created_at,
    };
    this.runs.push(run);
    this.compares.push(compare);
    return { run, compare };
  }

  async listRuns(consumer = SHADOW_CONSUMER) {
    return this.runs.filter((r) => r.consumer === consumer);
  }

  async listCompares(consumer = SHADOW_CONSUMER) {
    return this.compares.filter((c) => c.consumer === consumer);
  }
}

/**
 * Optional SQL/HTTP stub — records intended PostgREST payloads without executing.
 * Fixtures should use InMemoryShadowStore; this exists so live soak can swap later.
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
