import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { UPPERCASE, createBuiltinRegistry } from "../packages/capabilities/src/index.js";
import { CapabilityInvocation, Task, TaskStep } from "../packages/contracts/src/index.js";
import {
  APPROVAL_POLICY_VERSION,
  DEFAULT_APPROVAL_TTL_SECONDS,
  approvalPolicyRules,
  createControlTokenAuthenticator,
  loadApprovalBoundaryConfig,
} from "../services/kernel/src/approval-boundary.js";
import { evaluatePolicy } from "../services/kernel/src/policy.js";
import { DoorConfigError, loadDoorConfig } from "../apps/gateway/src/main.js";
import { task as fixture } from "../evals/fixtures/contracts.js";

/**
 * KJ-P4B: the production approval boundary. It adds no approval logic; it supplies the two things the
 * golden workflow was built to be given (policy rules and an authenticator) and refuses to start
 * half-configured. These tests pin what it accepts, what it refuses, and that a refusal never prints a value.
 */

const TENANT = "10000000-0000-4000-8000-000000000001";
const PRINCIPAL = "70000000-0000-4000-8000-000000000002";
const TOKEN = "SYNTHETIC-CONTROL-TOKEN-0123456789-abcdefghijklmnop";
const ENV = {
  KJ_APPROVAL_ENABLED: "true",
  KJ_ADMISSION_TENANT_ID: TENANT,
  KJ_ADMISSION_PRINCIPAL_ID: PRINCIPAL,
  KJ_CONTROL_TOKEN: TOKEN,
} as NodeJS.ProcessEnv;

describe("KJ-P4B approval boundary configuration", () => {
  it("is off, and registers nothing, unless explicitly enabled", () => {
    expect(loadApprovalBoundaryConfig({})).toBeUndefined();
    expect(loadApprovalBoundaryConfig({ ...ENV, KJ_APPROVAL_ENABLED: "" })).toBeUndefined();
    expect(loadApprovalBoundaryConfig({ ...ENV, KJ_APPROVAL_ENABLED: "false" })).toBeUndefined();
  });

  it("loads the identity, the token and a ten-minute default deadline", () => {
    expect(loadApprovalBoundaryConfig(ENV)).toEqual({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      token: TOKEN,
      ttlMs: DEFAULT_APPROVAL_TTL_SECONDS * 1000,
    });
    expect(DEFAULT_APPROVAL_TTL_SECONDS).toBe(600);
  });

  it.each([
    ["a guessed switch", { KJ_APPROVAL_ENABLED: "yes" }],
    ["no tenant", { KJ_ADMISSION_TENANT_ID: undefined }],
    ["no principal", { KJ_ADMISSION_PRINCIPAL_ID: undefined }],
    ["no token", { KJ_CONTROL_TOKEN: undefined }],
    ["an empty token", { KJ_CONTROL_TOKEN: "" }],
    ["a token that is too short", { KJ_CONTROL_TOKEN: "short-token" }],
    ["a tenant that is not a uuid", { KJ_ADMISSION_TENANT_ID: "tenant-1" }],
    ["a principal that is not a uuid", { KJ_ADMISSION_PRINCIPAL_ID: "principal-1" }],
    ["a deadline that is not a number", { KJ_APPROVAL_TTL_SECONDS: "soon" }],
    ["a deadline under 30 seconds", { KJ_APPROVAL_TTL_SECONDS: "29" }],
    ["a deadline over a day", { KJ_APPROVAL_TTL_SECONDS: "86401" }],
    ["a fractional deadline", { KJ_APPROVAL_TTL_SECONDS: "60.5" }],
    ["a negative deadline", { KJ_APPROVAL_TTL_SECONDS: "-60" }],
  ])("refuses %s, and the error names no value", (_label, over) => {
    const env = { ...ENV, ...over } as NodeJS.ProcessEnv;
    for (const [k, v] of Object.entries(over)) if (v === undefined) delete env[k];
    let message = "";
    try {
      loadApprovalBoundaryConfig(env);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain(TENANT);
    expect(message).not.toContain(PRINCIPAL);
  });

  it("accepts the deadline bounds and nothing outside them", () => {
    expect(loadApprovalBoundaryConfig({ ...ENV, KJ_APPROVAL_TTL_SECONDS: "30" })?.ttlMs).toBe(30_000);
    expect(loadApprovalBoundaryConfig({ ...ENV, KJ_APPROVAL_TTL_SECONDS: "86400" })?.ttlMs).toBe(86_400_000);
    expect(loadApprovalBoundaryConfig({ ...ENV, KJ_APPROVAL_TTL_SECONDS: "" })?.ttlMs).toBe(600_000);
  });
});

describe("KJ-P4B the one policy rule", () => {
  const config = loadApprovalBoundaryConfig(ENV)!;
  const rules = approvalPolicyRules(config);

  it("is exactly one rule: uppercase, for the door principal, approved by that same human, with the deadline", () => {
    expect(rules.version).toBe(APPROVAL_POLICY_VERSION);
    expect(rules.rules).toEqual([
      {
        tenantId: TENANT,
        principalId: PRINCIPAL,
        capability: UPPERCASE,
        effect: "APPROVAL_REQUIRED",
        approver: { id: PRINCIPAL, kind: "HUMAN" },
        ttlMs: 600_000,
      },
    ]);
  });

  const registry = createBuiltinRegistry();
  function evaluate(principalId: string, tenantId: string, capability = UPPERCASE) {
    const task = Task.parse({
      ...fixture,
      id: randomUUID(),
      traceId: randomUUID(),
      principal: { id: principalId, kind: "HUMAN" },
      tenant: { id: tenantId },
      status: "COMPILED",
    });
    const invocation = CapabilityInvocation.parse({
      runId: randomUUID(),
      taskId: task.id,
      stepId: randomUUID(),
      trace: { traceId: task.traceId, correlationId: task.id },
      capability,
      idempotencyKey: "policy-uppercase-1",
      input: { text: "hello" },
    });
    const step = TaskStep.parse({
      id: invocation.stepId,
      taskId: task.id,
      kind: "DETERMINISTIC_FUNCTION",
      status: "READY",
      dependencies: [],
      requiredCapabilities: [capability],
      riskClass: "LOW",
      retryPolicy: { maxAttempts: 1, backoffMs: 0 },
      input: invocation.input,
      idempotencyKey: invocation.idempotencyKey,
    });
    return evaluatePolicy(rules, task, step, invocation, registry.describe(capability), randomUUID(), new Date().toISOString());
  }

  it("requires approval for the door principal's uppercase task, bound to a human approver and a future deadline", () => {
    const e = evaluate(PRINCIPAL, TENANT);
    expect(e.decision.decision).toBe("APPROVAL_REQUIRED");
    expect(e.approver).toEqual({ id: PRINCIPAL, kind: "HUMAN" });
    expect(Date.parse(e.expiresAt!)).toBeGreaterThan(Date.now());
    expect(e.scope.policyVersion).toBe(APPROVAL_POLICY_VERSION);
  });

  it("negative control: any other principal or tenant matches no rule and is denied, not approved", () => {
    expect(evaluate(randomUUID(), TENANT).decision.decision).toBe("DENY");
    expect(evaluate(PRINCIPAL, randomUUID()).decision.decision).toBe("DENY");
  });

  it("the scope digest differs for a different task, so one approval can never approve another", () => {
    const a = evaluate(PRINCIPAL, TENANT);
    const b = evaluate(PRINCIPAL, TENANT);
    expect(a.scopeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(a.scopeDigest).not.toBe(b.scopeDigest);
  });
});

describe("KJ-P4B the control-token authenticator", () => {
  const authenticate = createControlTokenAuthenticator({ token: TOKEN, principalId: PRINCIPAL });
  const headers = (auth?: string): ReadonlyMap<string, string> => new Map(auth === undefined ? [] : [["authorization", auth]]);

  it("names the door's principal, fixed by configuration, for the right token", async () => {
    expect(await authenticate(headers(`Bearer ${TOKEN}`))).toEqual({ id: PRINCIPAL, kind: "HUMAN" });
  });

  it.each([
    ["no header", undefined],
    ["an empty header", ""],
    ["no scheme", TOKEN],
    ["the wrong scheme", `Basic ${TOKEN}`],
    ["a lower-case scheme", `bearer ${TOKEN}`],
    ["an empty token", "Bearer "],
    ["a wrong token", `Bearer ${TOKEN}x`],
    ["a prefix of the token", `Bearer ${TOKEN.slice(0, -1)}`],
    ["the token with a trailing space", `Bearer ${TOKEN} `],
    ["another token of the same length", `Bearer ${"Z".repeat(TOKEN.length)}`],
  ])("refuses %s", async (_label, auth) => {
    await expect(authenticate(headers(auth))).rejects.toThrow();
  });

  it("negative control: an authenticator built for another token refuses this one", async () => {
    const other = createControlTokenAuthenticator({ token: TOKEN + "-rotated", principalId: PRINCIPAL });
    await expect(other(headers(`Bearer ${TOKEN}`))).rejects.toThrow();
    expect(await other(headers(`Bearer ${TOKEN}-rotated`))).toEqual({ id: PRINCIPAL, kind: "HUMAN" });
  });

  it("never reads the identity from the request: an identity header changes nothing", async () => {
    const withIdentity = new Map([
      ["authorization", `Bearer ${TOKEN}`],
      ["x-principal-id", "70000000-0000-4000-8000-0000000000ff"],
    ]);
    expect(await authenticate(withIdentity)).toEqual({ id: PRINCIPAL, kind: "HUMAN" });
  });

  it("does not put the token in the error it throws", async () => {
    const error = await authenticate(headers(`Bearer ${TOKEN}x`)).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error?.message ?? "").not.toContain(TOKEN);
  });
});

describe("KJ-P4B worker registration", () => {
  const saved = { ...process.env };
  const DIGEST = "27255772beb1418e462fe262a2a747c53bf6a34973c3ad75907f7505a32f2b10";
  const names = (services: readonly unknown[]): string[] => services.map((s) => (s as { name: string }).name);
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...saved };
    process.env["DATABASE_URL"] = "postgresql://unused@127.0.0.1:1/unused";
    process.env["KJ_REPO_ROOT"] = process.cwd();
    process.env["SCHED_RECIPE"] = "claude_md_check/v1";
    process.env["SCHED_APPROVED_SHA256"] = DIGEST;
    delete process.env["ALERT_RUNNER_ENABLED"];
    delete process.env["TELEGRAM_INBOUND_ENABLED"];
    for (const k of Object.keys(ENV)) delete process.env[k];
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("registers GoldenTaskWorkflowV1 only when the boundary is enabled, and every other service is unchanged", async () => {
    const off = names((await import("../services/kernel/src/index.js")).services);
    expect(off).not.toContain("GoldenTaskWorkflowV1");
    vi.resetModules();
    Object.assign(process.env, ENV);
    const on = names((await import("../services/kernel/src/index.js")).services);
    expect(on).toEqual([...off, "GoldenTaskWorkflowV1"]);
  });

  it("serves no approval workflow for an empty or false switch", async () => {
    for (const flag of ["", "false"]) {
      vi.resetModules();
      Object.assign(process.env, ENV, { KJ_APPROVAL_ENABLED: flag });
      expect(names((await import("../services/kernel/src/index.js")).services), JSON.stringify(flag)).not.toContain("GoldenTaskWorkflowV1");
    }
  });

  it("refuses to start half-configured, and the failure names no value", async () => {
    for (const over of [{ KJ_CONTROL_TOKEN: undefined }, { KJ_ADMISSION_PRINCIPAL_ID: undefined }, { KJ_CONTROL_TOKEN: "short" }]) {
      vi.resetModules();
      Object.assign(process.env, ENV);
      for (const [k, v] of Object.entries(over)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      let message = "";
      try {
        await import("../services/kernel/src/index.js");
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, JSON.stringify(over)).not.toBe("");
      expect(message).not.toContain(TOKEN);
    }
  });
});

describe("KJ-P4B the door side of the boundary", () => {
  const door = {
    DATABASE_URL: "postgresql://unused@127.0.0.1:1/unused",
    KJ_ADMISSION_BEARER: "SYNTHETIC-DOOR-BEARER-0123456789-abcdef",
    KJ_ADMISSION_TENANT_ID: TENANT,
    KJ_ADMISSION_PRINCIPAL_ID: PRINCIPAL,
    KJ_ADMISSION_PRINCIPAL_KIND: "HUMAN",
  };

  it("has no control token unless one is configured, exactly as before", () => {
    expect(loadDoorConfig(door).controlToken).toBeNull();
    expect(loadDoorConfig({ ...door, KJ_CONTROL_TOKEN: "" }).controlToken).toBeNull();
  });

  it("carries a configured control token, which is never the admission bearer", () => {
    const config = loadDoorConfig({ ...door, KJ_CONTROL_TOKEN: TOKEN });
    expect(config.controlToken).toBe(TOKEN);
    expect(config.controlToken).not.toBe(config.bearer);
  });

  it("refuses a control token that is too short, naming only the error code", () => {
    let error: unknown;
    try {
      loadDoorConfig({ ...door, KJ_CONTROL_TOKEN: "short" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DoorConfigError);
    expect((error as DoorConfigError).code).toBe("KJ_CONTROL_TOKEN_TOO_SHORT");
    expect((error as Error).message).not.toContain("short-");
  });
});

describe("KJ-P4B the deployment declares what the boundary reads", () => {
  const VARS = ["KJ_ADMISSION_PRINCIPAL_ID", "KJ_ADMISSION_TENANT_ID", "KJ_APPROVAL_ENABLED", "KJ_APPROVAL_TTL_SECONDS", "KJ_CONTROL_TOKEN"];
  const yaml = readFileSync("infrastructure/docker/execution.compose.yaml", "utf8").replace(/\r\n/g, "\n");
  const workerBlock = yaml.slice(yaml.indexOf("\n  worker:"), yaml.indexOf("\nvolumes:"));
  const declared = (block: string, v: string): boolean => new RegExp(`^[ \\t]+${v}: \\$\\{${v}:-\\}[ \\t]*$`, "m").test(block);
  const envVarsRead = (src: string): string[] => [...new Set([...src.matchAll(/env\[\s*"([A-Z][A-Z0-9_]+)"\s*\]/g)].map((m) => m[1]!))];

  it("declares every variable approval-boundary.ts reads in the worker, empty by default", () => {
    const read = envVarsRead(readFileSync("services/kernel/src/approval-boundary.ts", "utf8"));
    expect(read.sort()).toEqual(VARS);
    for (const v of VARS) expect(declared(workerBlock, v), v).toBe(true);
  });

  it("negative control: with its passthrough lines removed, the check flags every variable", () => {
    let without = workerBlock;
    for (const v of VARS) without = without.replace(new RegExp(`^[ \\t]+${v}:.*\\n`, "m"), "");
    for (const v of VARS) expect(declared(without, v), v).toBe(false);
  });

  it("declares the control token in the door, empty by default", () => {
    const gateway = readFileSync("infrastructure/docker/gateway.compose.yaml", "utf8").replace(/\r\n/g, "\n");
    expect(declared(gateway, "KJ_CONTROL_TOKEN")).toBe(true);
    expect(declared(gateway.replace(/^[ \t]+KJ_CONTROL_TOKEN:.*\n/m, ""), "KJ_CONTROL_TOKEN")).toBe(false);
  });

  it("the execution topology check requires the worker to declare them too", () => {
    const script = readFileSync("scripts/check-execution-topology.mjs", "utf8");
    for (const v of VARS) expect(script, v).toContain(`"${v}"`);
  });
});

describe("KJ-P4B the env merge tool accepts the new keys and only in the right shape", () => {
  const python = ["python3", "python"].find((c) => spawnSync(c, ["--version"]).status === 0);
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const CONTROL = "SyntheticControlToken_0123456789_abcdefghijklmnop";
  const DB = "postgresql://svc:SYNTH-DB-PASSWORD-9137@db.example.invalid:5432/kj";
  function merge(args: string[], token = CONTROL) {
    const d = mkdtempSync(join(tmpdir(), "kj-p4b-merge-"));
    dirs.push(d);
    writeFileSync(join(d, "base.env"), `DATABASE_URL=${DB}\nKERNELJSON_RELEASE_ID=${"a".repeat(40)}\n`);
    writeFileSync(join(d, "control.txt"), `${token}\n`);
    const r = spawnSync(
      python!,
      ["scripts/runtime_env_merge.py", "merge", "--base", join(d, "base.env"), "--out", join(d, "new.env"), "--require-keys", "DATABASE_URL", ...args.map((a) => a.replace("@DIR@", d))],
      { encoding: "utf8" },
    );
    return { code: r.status ?? -1, out: r.stdout + r.stderr, file: join(d, "new.env") };
  }

  it("sets the switch, deadline and identity as public keys, and the token only from a file", () => {
    const r = merge([
      "--set-public", "KJ_APPROVAL_ENABLED=true",
      "--set-public", "KJ_APPROVAL_TTL_SECONDS=120",
      "--set-public", `KJ_ADMISSION_TENANT_ID=${TENANT}`,
      "--set-public", `KJ_ADMISSION_PRINCIPAL_ID=${PRINCIPAL}`,
      "--set-from", "KJ_CONTROL_TOKEN=@DIR@/control.txt",
    ]);
    expect(r.code, r.out).toBe(0);
    const text = readFileSync(r.file, "utf8");
    for (const line of ["KJ_APPROVAL_ENABLED=true", "KJ_APPROVAL_TTL_SECONDS=120", `KJ_ADMISSION_TENANT_ID=${TENANT}`, `KJ_CONTROL_TOKEN=${CONTROL}`])
      expect(text).toContain(line);
    expect(r.out).not.toContain(CONTROL);
  });

  it.each([
    ["the token on argv", ["--set-public", `KJ_CONTROL_TOKEN=${CONTROL}`]],
    ["a non-boolean switch", ["--set-public", "KJ_APPROVAL_ENABLED=yes"]],
    ["a deadline that is not digits", ["--set-public", "KJ_APPROVAL_TTL_SECONDS=1e3"]],
    ["a tenant that is not a uuid", ["--set-public", "KJ_ADMISSION_TENANT_ID=tenant"]],
    ["a principal that is not a uuid", ["--set-public", "KJ_ADMISSION_PRINCIPAL_ID=principal"]],
  ])("refuses %s", (_label, args) => {
    const r = merge(args);
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain(CONTROL);
  });

  it("refuses a control token of the wrong shape, from a file", () => {
    for (const bad of ["short", "has spaces in it and is long enough to pass the length check", "x".repeat(200)]) {
      const r = merge(["--set-from", "KJ_CONTROL_TOKEN=@DIR@/control.txt"], bad);
      expect(r.code, bad.slice(0, 10)).not.toBe(0);
    }
  });
});
