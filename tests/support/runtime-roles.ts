/**
 * KJ-P8 B1 - run the suite's production code under the real runtime database roles.
 *
 * The existing tests build one owner pool and hand it to both their own setup SQL and the code under test. B1 needs
 * the code under test to hold only the privileges of `kj_worker` or `kj_door`, while test setup (migrations, seeds,
 * sabotage) keeps the owner. This module is loaded once per test process (vitest `setupFiles`) and decides, for every
 * statement, who is asking: it reads the call stack and finds the first frame that is not `pg` or this file.
 *
 *   - a frame in `tests/` or `scripts/`, in a deployment-authority module, or in library code that no runtime entry
 *     point imports -> the statement is test or operator SQL and runs as the owner;
 *   - otherwise the statement belongs to a runtime process: `kj_door` when the gateway is on the stack and the file is
 *     door-reachable, `kj_worker` in every other case.
 *
 * Two modes (KJ_RUNTIME_ROLES):
 *   enforce  (default) runtime statements are refused exactly as production would refuse them. When production code
 *            asks the pool for a connection it receives a genuine `kj_worker`/`kj_door` LOGIN session. When a test
 *            passes its own owner connection into production code, the statement runs under `SET ROLE`, which applies
 *            the same privilege and row level security checks.
 *   discover runtime statements run under `SET ROLE`; a 42501 refusal is recorded and the statement is retried as the
 *            owner so one run reports every missing privilege instead of stopping at the first.
 *
 * It never widens anything in production: it is test-only and is not imported by any runtime module.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

export type RuntimeRole = "kj_worker" | "kj_door";
export const RUNTIME_ROLES: readonly RuntimeRole[] = ["kj_worker", "kj_door"];
const MODE: "enforce" | "discover" = process.env["KJ_RUNTIME_ROLES"] === "discover" ? "discover" : "enforce";
const TRACE_DIR = resolve(process.env["KJ_B1_TRACE_DIR"] ?? "artifacts/local/b1-trace");

// Inside the worker container every production frame is the worker: the image holds no gateway code and no
// inventory script, so the role is fixed by the environment instead of derived from the import graph.
const FIXED = process.env["KJ_RUNTIME_ROLE_FIXED"] as RuntimeRole | undefined;
let deployment = new Set<string>(), workerFiles = new Set<string>(), doorFiles = new Set<string>();
if (!FIXED) {
  const graphPath = "../../scripts/b1/runtime-graph.mjs";
  const graph = (await import(graphPath)) as {
    ENTRY_POINTS: Record<RuntimeRole, string[]>; DEPLOYMENT_MODULES: string[]; reach: (entries: string[], exclude: string[]) => string[];
  };
  deployment = new Set(graph.DEPLOYMENT_MODULES);
  workerFiles = new Set(graph.reach(graph.ENTRY_POINTS.kj_worker, graph.DEPLOYMENT_MODULES));
  doorFiles = new Set(graph.reach(graph.ENTRY_POINTS.kj_door, graph.DEPLOYMENT_MODULES));
}
const SELF = "tests/support/runtime-roles.ts";
const FRAME = /((?:services|apps|packages|runtimes|tests|scripts)\/[A-Za-z0-9_./-]+\.(?:ts|mjs|js))/;

/**
 * Who is asking? `null` means the owner (test, operator tooling or non-deployed library code).
 * The OUTERMOST production frame decides: a shared helper such as `withTenant` acts for whoever called it, so a
 * library that no runtime process imports stays with the owner even when it borrows a worker-reachable helper.
 */
export function attribute(stack: string | undefined): { role: RuntimeRole | null; caller: string } {
  let nearest: string | undefined, outermost: string | undefined;
  let door = false;
  for (const line of (stack ?? "").split(/\r?\n/)) {
    if (line.includes("node_modules")) continue;
    const m = FRAME.exec(line.replaceAll("\\", "/"));
    // The production pool guard is transparent: the statement belongs to whoever called through it.
    if (!m || m[1] === SELF || m[1] === "services/kernel/src/database/runtime-roles.ts") continue;
    const file = m[1]!;
    if (deployment.has(file)) return { role: null, caller: file };
    if (file.startsWith("tests/") || file.startsWith("scripts/")) { nearest ??= file; continue; }
    nearest ??= file;
    outermost = file;
    if (file.startsWith("apps/gateway/") || file.startsWith("apps/mission-control/")) door = true;
  }
  if (!outermost || !nearest || nearest.startsWith("tests/") || nearest.startsWith("scripts/")) return { role: null, caller: nearest ?? "unknown" };
  if (FIXED) return { role: FIXED, caller: nearest };
  // The door is the gateway process: a statement is the door's only when gateway code is on the stack.
  if (door && doorFiles.has(nearest)) return { role: "kj_door", caller: nearest };
  if (workerFiles.has(outermost) && workerFiles.has(nearest)) return { role: "kj_worker", caller: nearest };
  return { role: null, caller: nearest };
}

const passthrough = new AsyncLocalStorage<true>();
const seen = new Set<string>();
function record(event: Record<string, unknown>): void {
  const key = JSON.stringify(event);
  if (seen.has(key)) return;
  seen.add(key);
  try {
    mkdirSync(TRACE_DIR, { recursive: true });
    appendFileSync(resolve(TRACE_DIR, `${process.pid}.jsonl`), key + "\n");
  } catch {
    /* tracing must never change a test result */
  }
}
const sqlOf = (args: unknown[]): string => {
  const a = args[0] as string | { text?: string } | undefined;
  return (typeof a === "string" ? a : (a?.text ?? "")).replace(/\s+/g, " ").trim().slice(0, 600);
};

/** A pool that already logs in as a runtime role is a genuine runtime pool: never shadowed, never emulated. */
function genuine(pool: pg.Pool): RuntimeRole | null {
  const options = (pool as unknown as { options: pg.PoolConfig }).options;
  let user = options.user;
  if (options.connectionString) try { user = decodeURIComponent(new URL(options.connectionString).username) || user; } catch { /* not a URL */ }
  return (RUNTIME_ROLES as readonly string[]).includes(user ?? "") ? (user as RuntimeRole) : null;
}

/** Enforce mode: a refusal of a runtime statement is recorded (and still thrown), so "zero unexpected 42501" is a count. */
function watch<T>(result: T, role: RuntimeRole, caller: string, sql: string): T {
  if (MODE === "enforce" && result && typeof (result as unknown as Promise<unknown>).then === "function")
    (result as unknown as Promise<unknown>).then(undefined, (error: { code?: string; message?: string }) => {
      if (error?.code === "42501") record({ kind: "refused", role, caller, message: error.message, sql });
    });
  return result;
}

type AnyClient = pg.ClientBase & { __kjRole?: RuntimeRole; __kjBusy?: boolean; getTransactionStatus?: () => string | null };
type Query = (...args: unknown[]) => Promise<unknown>;
const P = pg.Pool.prototype as unknown as { query: Query; connect: Query; end: Query };
const C = pg.Client.prototype as unknown as { query: Query };
const poolQuery = P.query, poolConnect = P.connect, poolEnd = P.end, clientQuery = C.query;

const shadows = new WeakMap<object, Map<RuntimeRole, pg.Pool>>();
function shadow(pool: pg.Pool, role: RuntimeRole): pg.Pool {
  let byRole = shadows.get(pool);
  if (!byRole) shadows.set(pool, (byRole = new Map()));
  let s = byRole.get(role);
  if (!s) {
    const options = { ...(pool as unknown as { options: pg.PoolConfig }).options };
    if (options.connectionString) {
      const url = new URL(options.connectionString);
      url.username = role;
      url.password = "";
      options.connectionString = url.toString();
    } else options.user = role;
    s = new pg.Pool(options);
    s.on("connect", (client) => { (client as AnyClient).__kjRole = role; });
    s.on("error", () => { /* surfaced by the caller's own query */ });
    byRole.set(role, s);
  }
  return s;
}

/** Run one statement on an owner session with the privileges of `role`. */
async function emulate(client: AnyClient, role: RuntimeRole, caller: string, args: unknown[]): Promise<unknown> {
  const run = (...a: unknown[]) => clientQuery.apply(client, a);
  client.__kjBusy = true;
  try {
    const inTx = client.getTransactionStatus?.() === "T";
    try { await run(`set role ${role}`); } catch { return await run(...args); } // aborted transaction: fail as it would
    // Never wrap transaction control: releasing the probe savepoint would destroy a savepoint the code just made.
    const probe = MODE === "discover" && inTx && !/^(begin|start|commit|end|rollback|abort|savepoint|release)\b/i.test(sqlOf(args));
    if (probe) await run("savepoint kj_b1_probe");
    try {
      const result = await run(...args);
      if (probe) await run("release savepoint kj_b1_probe").catch(() => undefined);
      return result;
    } catch (error) {
      const e = error as { code?: string; message?: string };
      if (MODE !== "discover" || e.code !== "42501") throw error;
      record({ kind: "denied", role, caller, message: e.message, sql: sqlOf(args) });
      if (probe) await run("rollback to savepoint kj_b1_probe");
      await run("reset role");
      return await run(...args);
    }
  } finally {
    await run("reset role").catch(() => undefined);
    client.__kjBusy = false;
  }
}

let installed = false;
export function installRuntimeRoles(): void {
  if (installed) return;
  installed = true;
  Error.stackTraceLimit = Math.max(Error.stackTraceLimit ?? 10, 80);

  P.query = function (this: pg.Pool, ...args: unknown[]) {
    if (passthrough.getStore() || typeof args.at(-1) === "function") return poolQuery.apply(this, args);
    if (genuine(this)) return passthrough.run(true, () => poolQuery.apply(this, args));
    const { role, caller } = attribute(new Error().stack);
    if (!role) return passthrough.run(true, () => poolQuery.apply(this, args));
    record({ kind: "use", role, caller, via: MODE === "enforce" ? "login" : "set-role", sql: sqlOf(args) });
    if (MODE === "enforce") return watch(passthrough.run(true, () => poolQuery.apply(shadow(this, role), args)), role, caller, sqlOf(args));
    return (async () => {
      const client = (await passthrough.run(true, () => poolConnect.apply(this, []))) as AnyClient & { release: () => void };
      try { return await emulate(client, role, caller, args); } finally { client.release(); }
    })();
  };

  P.connect = function (this: pg.Pool, ...args: unknown[]) {
    if (passthrough.getStore() || args.length) return poolConnect.apply(this, args);
    const own = genuine(this);
    if (own) return (poolConnect.apply(this, args) as Promise<AnyClient>).then((c) => { c.__kjRole = own; return c; });
    const { role } = attribute(new Error().stack);
    if (!role || MODE === "discover") return poolConnect.apply(this, args);
    return passthrough.run(true, () => poolConnect.apply(shadow(this, role), args));
  };

  P.end = async function (this: pg.Pool, ...args: unknown[]) {
    for (const s of shadows.get(this)?.values() ?? []) await poolEnd.apply(s, []).catch(() => undefined);
    return poolEnd.apply(this, args);
  };

  C.query = function (this: AnyClient, ...args: unknown[]) {
    if (this.__kjBusy || typeof args.at(-1) === "function") return clientQuery.apply(this, args);
    const text = sqlOf(args);
    if (this.__kjRole) {
      if (passthrough.getStore()) return clientQuery.apply(this, args);
      const { caller, role: asked } = attribute(new Error().stack);
      record({ kind: "use", role: this.__kjRole, caller, via: "login", sql: text });
      // Only production statements count as runtime refusals; a test probing the role directly is a deliberate probe.
      return asked ? watch(clientQuery.apply(this, args), this.__kjRole, caller, text) : clientQuery.apply(this, args);
    }
    if (passthrough.getStore()) return clientQuery.apply(this, args);
    const { role, caller } = attribute(new Error().stack);
    if (!role) return clientQuery.apply(this, args);
    record({ kind: "use", role, caller, via: "set-role", sql: text });
    return watch(emulate(this, role, caller, args), role, caller, text);
  };
}

installRuntimeRoles();
