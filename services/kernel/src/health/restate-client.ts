import type { RestateInvocationRow } from "./snapshot.js";

/**
 * Minimal READ-ONLY Restate admin client for the health model. Every method is a
 * GET or a `/query` (Restate's SQL introspection endpoint) — nothing here can ever
 * enable/disable a schedule, register a deployment, or send an invocation. This is
 * the exact `/query` mechanism proven live in production during S1D2 (Accept:
 * application/json for a JSON body instead of the default Arrow stream).
 */
export interface RestateAdminClient {
  health(): Promise<boolean>;
  /** Registered service names, from `sys_service` (Restate's own service catalog). */
  registeredServices(): Promise<string[]>;
  /** All invocations targeting a given virtual-object key (e.g. a schedule id),
   *  oldest first. */
  invocationsForKey(serviceKey: string): Promise<RestateInvocationRow[]>;
}

interface QueryRow {
  [column: string]: unknown;
}

function asString(row: QueryRow, col: string): string {
  const v = row[col];
  if (typeof v !== "string") throw new Error(`restate query row missing string column "${col}"`);
  return v;
}

function asStringOrNull(row: QueryRow, col: string): string | null {
  const v = row[col];
  return typeof v === "string" ? v : null;
}

export function createRestateAdminClient(
  adminUrl: string,
  fetchImpl: typeof fetch = fetch,
): RestateAdminClient {
  const base = adminUrl.replace(/\/+$/, "");

  async function query(sql: string): Promise<QueryRow[]> {
    const res = await fetchImpl(`${base}/query`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query: sql }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`restate /query failed: HTTP ${res.status}`);
    const body = (await res.json()) as { rows?: QueryRow[] };
    return body.rows ?? [];
  }

  return {
    async health(): Promise<boolean> {
      try {
        const res = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(5_000) });
        return res.ok;
      } catch {
        return false;
      }
    },

    async registeredServices(): Promise<string[]> {
      const rows = await query("select name from sys_service");
      return rows.map((r) => asString(r, "name"));
    },

    async invocationsForKey(serviceKey: string): Promise<RestateInvocationRow[]> {
      // serviceKey is always a UUID we generated/validated ourselves (the canonical
      // schedule id) — never end-user input — but the quote is still escaped defensively.
      //
      // `select *`, not a narrow column list: proven live against production during
      // S1D2 (and reproduced again during this module's own live validation) that
      // Restate's /query JSON encoder drops `scheduled_start_at` for a `scheduled`
      // invocation when the column is explicitly named in a narrow select — the same
      // row queried with `select *` returns it correctly. Root cause not fully
      // diagnosed; `select *` is the proven workaround, not a guess.
      const escaped = serviceKey.replace(/'/g, "''");
      const rows = await query(
        `select * from sys_invocation where target_service_key = '${escaped}' order by created_at`,
      );
      return rows.map((r) => ({
        id: asString(r, "id"),
        status: asString(r, "status"),
        scheduledStartAt: asStringOrNull(r, "scheduled_start_at"),
        invokedById: asStringOrNull(r, "invoked_by_id"),
        createdAt: asString(r, "created_at"),
        completedAt: asStringOrNull(r, "completed_at"),
      }));
    },
  };
}
