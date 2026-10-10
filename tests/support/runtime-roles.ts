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
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { TraceToken, traceWriter, type TraceStatement } from "../../scripts/b1/trace.js";
import { strictJson } from "../../services/kernel/src/database/strict-json.js";

export type RuntimeRole = "kj_worker" | "kj_door";
export const RUNTIME_ROLES: readonly RuntimeRole[] = ["kj_worker", "kj_door"];
const requestedMode=process.env["KJ_RUNTIME_ROLES"] ?? "enforce";
if(!["base","enforce","discover"].includes(requestedMode)) throw Error("HARNESS_REFUSED: unknown runtime role mode");
const MODE=requestedMode as "base"|"enforce"|"discover";
if(MODE==="base" && ["KJ_B1_STAGE_T","KJ_B1_RUN_TOKEN","KJ_B1_RUN_DIR","KJ_B1_RUN_HEADER"].some(k=>process.env[k]!==undefined))
  throw Error("HARNESS_REFUSED: base mode inside a runner stage");
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
let writer: ReturnType<typeof traceWriter> | undefined;
let currentTest = (): string | null => null;
if (process.env.VITEST) {
  const { expect } = await import("vitest");
  currentTest = () => expect.getState().currentTestName ?? null;
}
function record(statement: TraceStatement, error?: {code?:string;message?:string}): void {
  try {
  if (!writer) {
    const stageT = process.env.KJ_B1_STAGE_T === "1";
    const token = stageT ? TraceToken.parse(strictJson(process.env.KJ_B1_RUN_TOKEN ?? "")) :
      {runId:"0".repeat(32),suite:"local-"+MODE};
    if(stageT && !process.env.KJ_B1_TRACE_DIR) throw Error("TRACE_UNTRUSTED: trace directory absent");
    if(!stageT) mkdirSync(TRACE_DIR, {recursive:true});
    writer=traceWriter(TRACE_DIR,token);
  }
  writer.write(statement,error);
  } catch (failure) {
    process.exitCode=1;
    throw failure;
  }
}
const prepared = new WeakMap<object,Map<string,string>>();
function sqlOf(args: unknown[], session?:object): string {
  const config = args[0] as string | {text?:string;name?:string} | undefined;
  if(typeof config === "string") return config;
  if(config?.text !== undefined) {
    if(config.name && session) {
      let texts=prepared.get(session);
      if(!texts) prepared.set(session,texts=new Map());
      if(!texts.has(config.name)) texts.set(config.name,config.text);
    }
    return config.text;
  }
  const cached=config?.name && session ? prepared.get(session)?.get(config.name) : undefined;
  if(cached!==undefined) return cached;
  throw Error("TRACE_UNTRUSTED: runtime statement text unavailable");
}
function statement(role:RuntimeRole,caller:string,via:"login"|"set-role",sql:string,production:boolean):TraceStatement {
  return {role,caller,via,sql,test:currentTest(),classification:production?"production":"probe"};
}
/** Preserve callback and promise APIs while observing errors before the caller can absorb them. */
function dispatch(args:unknown[],run:(args:unknown[])=>Promise<unknown>,event:TraceStatement,observe=true):Promise<unknown> {
  const actual=[...args];
  let callback=typeof actual.at(-1)==="function" ? actual.pop() as (error:unknown,value?:unknown)=>void : undefined;
  const config=actual[0] as {callback?:typeof callback}|undefined;
  if(!callback && typeof config?.callback==="function") {
    callback=config.callback;actual[0]={...config,callback:undefined};
  }
  record(event);
  const result=Promise.resolve().then(()=>run(actual)).catch(error=>{
    if(observe && error?.code==="42501") record(event,error);
    throw error;
  });
  if(callback){
    const done=callback;
    void result.then(value=>done(null,value),error=>done(error));
    return undefined as unknown as Promise<unknown>;
  }
  return result;
}

/** A pool that already logs in as a runtime role is a genuine runtime pool: never shadowed, never emulated. */
function genuine(pool: pg.Pool): RuntimeRole | null {
  const options = (pool as unknown as { options: pg.PoolConfig }).options;
  let user = options.user;
  if (options.connectionString) try { user = decodeURIComponent(new URL(options.connectionString).username) || user; } catch { /* not a URL */ }
  return (RUNTIME_ROLES as readonly string[]).includes(user ?? "") ? (user as RuntimeRole) : null;
}

type AnyClient = pg.ClientBase & { __kjRole?: RuntimeRole; getTransactionStatus?: () => string | null };
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
async function emulate(client: AnyClient, role: RuntimeRole, event: TraceStatement, args: unknown[]): Promise<unknown> {
  const run = (...a: unknown[]) => clientQuery.apply(client, a);
  try {
    const inTx = client.getTransactionStatus?.() === "T";
    try { await run(`set role ${role}`); } catch (error) {
      if((error as {code?:string}).code!=="25P02") throw error;
      return await run(...args); // Already-aborted transaction retains PostgreSQL's error semantics.
    }
    // Never wrap transaction control: releasing the probe savepoint would destroy a savepoint the code just made.
    const probe = MODE === "discover" && inTx && !/^(begin|start|commit|end|rollback|abort|savepoint|release)\b/i.test(event.sql.trimStart());
    if (probe) await run("savepoint kj_b1_probe");
    try {
      const result = await run(...args);
      if (probe) await run("release savepoint kj_b1_probe").catch(() => undefined);
      return result;
    } catch (error) {
      const e = error as { code?: string; message?: string };
      if (e.code === "42501") record(event,e);
      if (MODE !== "discover" || e.code !== "42501") throw error;
      if (probe) await run("rollback to savepoint kj_b1_probe");
      await run("reset role");
      return await run(...args);
    }
  } finally {
    await run("reset role").catch(() => undefined);
  }
}

let installed = false;
export function installRuntimeRoles(): void {
  if(MODE==="base") return;
  if (installed) return;
  installed = true;
  Error.stackTraceLimit = Math.max(Error.stackTraceLimit ?? 10, 80);

  P.query = function (this: pg.Pool, ...args: unknown[]) {
    if (passthrough.getStore()) return poolQuery.apply(this,args);
    const {role:asked,caller}=attribute(new Error().stack),own=genuine(this),role=own ?? asked;
    if(!role) return passthrough.run(true,()=>poolQuery.apply(this,args));
    const login=Boolean(own) || MODE==="enforce";
    const event=statement(role,caller,login?"login":"set-role",sqlOf(args,this),Boolean(asked)||Boolean(FIXED));
    return dispatch(args,async actual=>{
      if(login) return passthrough.run(true,()=>poolQuery.apply(own?this:shadow(this,role),actual));
      const client=await passthrough.run(true,()=>poolConnect.apply(this,[])) as AnyClient & {release:()=>void};
      try{return await emulate(client,role,event,actual);}finally{client.release();}
    },event,login);
  };

  P.connect = function (this: pg.Pool, ...args: unknown[]) {
    if(passthrough.getStore()) return poolConnect.apply(this,args);
    const own=genuine(this),{role:asked}=attribute(new Error().stack);
    const role=own ?? (MODE==="enforce"?asked:null);
    const target=role && !own ? shadow(this,role) : this;
    if(args.length){
      const callback=args[0] as (error:unknown,client?:AnyClient,release?:()=>void)=>void;
      if(typeof callback!=="function") return poolConnect.apply(target,args);
      return passthrough.run(true,()=>poolConnect.apply(target,[(error:unknown,client?:AnyClient,release?:()=>void)=>{
        if(client && role) client.__kjRole=role;
        passthrough.exit(()=>callback(error,client,release));
      }]));
    }
    return (passthrough.run(true,()=>poolConnect.apply(target,[])) as Promise<AnyClient>).then(client=>{
      if(role) client.__kjRole=role;
      return client;
    });
  };

  P.end = async function (this: pg.Pool, ...args: unknown[]) {
    for (const s of shadows.get(this)?.values() ?? []) await poolEnd.apply(s, []).catch(() => undefined);
    return poolEnd.apply(this, args);
  };

  C.query = function (this: AnyClient, ...args: unknown[]) {
    if(passthrough.getStore()) return clientQuery.apply(this,args);
    const user=(this as unknown as {user?:string}).user;
    const own=this.__kjRole ?? ((RUNTIME_ROLES as readonly string[]).includes(user ?? "") ? user as RuntimeRole : null);
    const {role:asked,caller}=attribute(new Error().stack),role=own ?? asked;
    if(!role) return clientQuery.apply(this,args);
    const event=statement(role,caller,own?"login":"set-role",sqlOf(args,this),Boolean(asked)||Boolean(FIXED));
    return dispatch(args,actual=>own?clientQuery.apply(this,actual):emulate(this,role,event,actual),event,Boolean(own));
  };

}

if(MODE==="base") await import("./base-database.js");
installRuntimeRoles();
