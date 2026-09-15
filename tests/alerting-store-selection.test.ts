import { describe, it, expect } from "vitest";
import type pg from "pg";
import { loadAlertStoreMode, selectAlertStateStore } from "../services/kernel/src/alerting/select-store.js";
import { AlertStateStoreUnavailableError, PgAlertStateStore } from "../services/kernel/src/alerting/pg-state-store.js";
import { InMemoryAlertStateStore } from "../services/kernel/src/alerting/state-store.js";

/**
 * KJ-P1.2 persistence-wiring fix — deterministic tests, no real Postgres
 * required. These exercise the failure-mode contract itself (does store
 * selection ever silently substitute memory for a broken postgres mode?) with
 * a mocked `pg.Pool`; the genuine cross-process persistence proof lives in
 * tests/alerting-postgres.integration.test.ts against a real throwaway DB.
 */

function fakePool(queryImpl: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>): pg.Pool {
  return { query: queryImpl } as unknown as pg.Pool;
}

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("loadAlertStoreMode", () => {
  it("defaults to postgres when unset — durable is the production-safe default", () => {
    expect(loadAlertStoreMode({})).toBe("postgres");
  });

  it('empty string is treated the same as unset (still "postgres"), matching SCHED_ARM_NEXT\'s convention', () => {
    expect(loadAlertStoreMode({ ALERT_STATE_STORE: "" })).toBe("postgres");
  });

  it('"memory" must be explicitly requested', () => {
    expect(loadAlertStoreMode({ ALERT_STATE_STORE: "memory" })).toBe("memory");
  });

  it('"postgres" is accepted explicitly too', () => {
    expect(loadAlertStoreMode({ ALERT_STATE_STORE: "postgres" })).toBe("postgres");
  });

  it("any other value fails closed (throws, never guesses)", () => {
    for (const bad of ["Postgres", "PG", "pg", "1", "true", " postgres"])
      expect(() => loadAlertStoreMode({ ALERT_STATE_STORE: bad }), `value ${JSON.stringify(bad)}`).toThrow();
  });
});

describe("unavailable/missing Postgres alert table fails clearly", () => {
  it("probe() throws AlertStateStoreUnavailableError on 42P01 (undefined_table), naming the migration", async () => {
    const pool = fakePool(async () => {
      throw pgError("42P01", 'relation "kernel_private.alert_state" does not exist');
    });
    const store = new PgAlertStateStore(pool);
    await expect(store.probe()).rejects.toThrow(AlertStateStoreUnavailableError);
    await expect(store.probe()).rejects.toThrow(/20260915220000_alert_state\.sql/);
  });

  it("selectAlertStateStore('postgres', pool) rejects with the same clear error when the table is missing", async () => {
    const pool = fakePool(async () => {
      throw pgError("42P01", 'relation "kernel_private.alert_state" does not exist');
    });
    await expect(selectAlertStateStore("postgres", pool)).rejects.toThrow(AlertStateStoreUnavailableError);
  });

  it("a genuine connectivity failure (not a missing table) is NOT relabelled as AlertStateStoreUnavailableError", async () => {
    const pool = fakePool(async () => {
      throw pgError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:5432");
    });
    const store = new PgAlertStateStore(pool);
    await expect(store.probe()).rejects.toThrow("connect ECONNREFUSED");
    await expect(store.probe()).rejects.not.toBeInstanceOf(AlertStateStoreUnavailableError);
  });
});

describe("configured postgres mode never silently falls back to memory", () => {
  it("a failing probe rejects — it does not resolve to an InMemoryAlertStateStore", async () => {
    const pool = fakePool(async () => {
      throw pgError("42P01", 'relation "kernel_private.alert_state" does not exist');
    });
    let resolved: unknown;
    let rejected = false;
    try {
      resolved = await selectAlertStateStore("postgres", pool);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(resolved).toBeUndefined();
  });

  it("a successful probe resolves to the real PgAlertStateStore, not InMemoryAlertStateStore", async () => {
    const pool = fakePool(async () => ({ rows: [] }));
    const store = await selectAlertStateStore("postgres", pool);
    expect(store).toBeInstanceOf(PgAlertStateStore);
    expect(store).not.toBeInstanceOf(InMemoryAlertStateStore);
  });

  it("mode='memory' does return InMemoryAlertStateStore — the explicit, non-default opt-out", async () => {
    const pool = fakePool(async () => {
      throw new Error("should never be queried in memory mode");
    });
    const store = await selectAlertStateStore("memory", pool);
    expect(store).toBeInstanceOf(InMemoryAlertStateStore);
  });
});
