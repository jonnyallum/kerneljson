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
  createControlAuthenticator,
  loadApprovalBoundaryConfig,
} from "../services/kernel/src/approval-boundary.js";
import { InMemoryReplayStore, createControlSigner } from "../services/kernel/src/control-signing.js";
import { evaluatePolicy } from "../services/kernel/src/policy.js";
import { DoorConfigError, loadDoorConfig } from "../apps/gateway/src/main.js";
import { task as fixture } from "../evals/fixtures/contracts.js";
import { CONTROL_OTHER_KEY, CONTROL_TEST_KEY } from "./support/control-test-key.js";

/**
 * KJ-P4B / KJ-P4B.1: the production approval boundary. It adds no approval logic; it supplies the two things the
 * golden workflow was built to be given (policy rules and an authenticator) and refuses to start
 * half-configured. These tests pin what it accepts, what it refuses, and that a refusal never prints a value.
 */

const TENANT = "10000000-0000-4000-8000-000000000001";
const PRINCIPAL = "70000000-0000-4000-8000-000000000002";
const KEY = CONTROL_TEST_KEY;
const ENV = {
  KJ_APPROVAL_ENABLED: "true",
  KJ_ADMISSION_TENANT_ID: TENANT,
  KJ_ADMISSION_PRINCIPAL_ID: PRINCIPAL,
  KJ_CONTROL_SIGNING_KEY: KEY,
} as NodeJS.ProcessEnv;

describe("KJ-P4B approval boundary configuration", () => {
  it("is off, and registers nothing, unless explicitly enabled", () => {
    expect(loadApprovalBoundaryConfig({})).toBeUndefined();
    expect(loadApprovalBoundaryConfig({ ...ENV, KJ_APPROVAL_ENABLED: "" })).toBeUndefined();
    expect(loadApprovalBoundaryConfig({ ...ENV, KJ_APPROVAL_ENABLED: "false" })).toBeUndefined();
  });

  it("loads the identity, the signing key under the default id, a five-minute window and a ten-minute deadline", () => {
    const c = loadApprovalBoundaryConfig(ENV)!;
    expect(c.tenantId).toBe(TENANT);
    expect(c.principalId).toBe(PRINCIPAL);
    expect(c.ttlMs).toBe(DEFAULT_APPROVAL_TTL_SECONDS * 1000);
    expect(DEFAULT_APPROVAL_TTL_SECONDS).toBe(600);
    expect([...c.control.keys]).toEqual([["v1", KEY]]);
    expect(c.control.freshnessSeconds).toBe(300);
  });

  it("carries a previous key only as a complete, different pair, for a controlled rotation", () => {
    const rotating = loadApprovalBoundaryConfig({
      ...ENV,
      KJ_CONTROL_KEY_ID: "v2",
      KJ_CONTROL_SIGNING_KEY_PREVIOUS: CONTROL_OTHER_KEY,
      KJ_CONTROL_KEY_ID_PREVIOUS: "v1",
    })!;
    expect([...rotating.control.keys.keys()].sort()).toEqual(["v1", "v2"]);
  });

  it.each([
    ["a guessed switch", { KJ_APPROVAL_ENABLED: "yes" }],
    ["no tenant", { KJ_ADMISSION_TENANT_ID: undefined }],
    ["no principal", { KJ_ADMISSION_PRINCIPAL_ID: undefined }],
    ["no signing key", { KJ_CONTROL_SIGNING_KEY: undefined }],
    ["an empty signing key", { KJ_CONTROL_SIGNING_KEY: "" }],
    ["a signing key that is too short", { KJ_CONTROL_SIGNING_KEY: "short-key" }],
    ["a key id with a space", { KJ_CONTROL_KEY_ID: "bad id" }],
    ["a key id that is too long", { KJ_CONTROL_KEY_ID: "x".repeat(17) }],
    ["a previous key without its id", { KJ_CONTROL_SIGNING_KEY_PREVIOUS: CONTROL_OTHER_KEY }],
    ["a previous id without its key", { KJ_CONTROL_KEY_ID_PREVIOUS: "v0" }],
    ["a previous key that is too short", { KJ_CONTROL_SIGNING_KEY_PREVIOUS: "short", KJ_CONTROL_KEY_ID_PREVIOUS: "v0" }],
    ["a previous id equal to the current one", { KJ_CONTROL_SIGNING_KEY_PREVIOUS: CONTROL_OTHER_KEY, KJ_CONTROL_KEY_ID_PREVIOUS: "v1" }],
    ["a previous key equal to the current one", { KJ_CONTROL_SIGNING_KEY_PREVIOUS: KEY, KJ_CONTROL_KEY_ID_PREVIOUS: "v0" }],
    ["a freshness window under 30 seconds", { KJ_CONTROL_FRESHNESS_SECONDS: "29" }],
    ["a freshness window over an hour", { KJ_CONTROL_FRESHNESS_SECONDS: "3601" }],
    ["a freshness window that is not a number", { KJ_CONTROL_FRESHNESS_SECONDS: "soon" }],
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
    for (const secret of [KEY, CONTROL_OTHER_KEY, TENANT, PRINCIPAL]) expect(message).not.toContain(secret);
  });

  it("accepts the deadline and freshness bounds and nothing outside them", () => {
    expect(loadApprovalBoundaryConfig({ ...ENV, KJ_APPROVAL_TTL_SECONDS: "30" })?.ttlMs).toBe(30_000);
    expect(loadApprovalBoundaryConfig({ ...ENV, KJ_APPROVAL_TTL_SECONDS: "86400" })?.ttlMs).toBe(86_400_000);
    expect(loadApprovalBoundaryConfig({ ...ENV, KJ_APPROVAL_TTL_SECONDS: "" })?.ttlMs).toBe(600_000);
    expect(loadApprovalBoundaryConfig({ ...ENV, KJ_CONTROL_FRESHNESS_SECONDS: "30" })?.control.freshnessSeconds).toBe(30);
    expect(loadApprovalBoundaryConfig({ ...ENV, KJ_CONTROL_FRESHNESS_SECONDS: "3600" })?.control.freshnessSeconds).toBe(3600);
  });

  it("no longer knows the old bearer token: setting it changes nothing and does not stand in for the key", () => {
    const env = { ...ENV, KJ_CONTROL_TOKEN: "SYNTHETIC-CONTROL-TOKEN-0123456789-abcdefghijklmnop" } as NodeJS.ProcessEnv;
    delete env["KJ_CONTROL_SIGNING_KEY"];
    expect(() => loadApprovalBoundaryConfig(env)).toThrow(/KJ_CONTROL_SIGNING_KEY/);
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

describe("KJ-P4B.1 the workflow's authenticator (signed assertions)", () => {
  const config = loadApprovalBoundaryConfig(ENV)!;
  const clock = { seconds: 1_790_000_000 };
  const request = { service: "GoldenTaskWorkflowV1", handler: "approve" as const, key: "11111111-1111-4111-8111-111111111111", body: new TextEncoder().encode(JSON.stringify({ scopeDigest: "a".repeat(64), decision: "GRANTED" })) };
  const sign = (over = {}) =>
    new Map(
      Object.entries(
        createControlSigner({ keyId: "v1", key: KEY, now: () => clock.seconds * 1000 })({ ...request, tenantId: TENANT, principalId: PRINCIPAL, ...over }),
      ),
    );

  it("names the door's principal, fixed by configuration, for a valid assertion", async () => {
    const authenticate = createControlAuthenticator(config, new InMemoryReplayStore(() => clock.seconds));
    expect(await authenticate(sign(), request)).toEqual({ id: PRINCIPAL, kind: "HUMAN" });
  });

  it("refuses the old credential shape: an Authorization bearer, even one holding the signing key", async () => {
    const authenticate = createControlAuthenticator(config, new InMemoryReplayStore(() => clock.seconds));
    for (const auth of [`Bearer ${KEY}`, "Bearer SYNTHETIC-CONTROL-TOKEN-0123456789-abcdefghijklmnop"])
      await expect(authenticate(new Map([["authorization", auth]]), request)).rejects.toThrow();
    await expect(authenticate(new Map(), request)).rejects.toThrow();
  });

  it("uses the workflow's own tenant and principal: an assertion for another principal does not verify", async () => {
    const authenticate = createControlAuthenticator(config, new InMemoryReplayStore(() => clock.seconds));
    await expect(authenticate(sign({ principalId: "66666666-6666-4666-8666-666666666666" }), request)).rejects.toThrow();
    await expect(authenticate(sign({ tenantId: "55555555-5555-4555-8555-555555555555" }), request)).rejects.toThrow();
  });

  it("honours the configured freshness window", async () => {
    const short = createControlAuthenticator(
      loadApprovalBoundaryConfig({ ...ENV, KJ_CONTROL_FRESHNESS_SECONDS: "30" })!,
      new InMemoryReplayStore(() => clock.seconds),
    );
    const h = sign();
    clock.seconds += 31;
    await expect(short(h, request)).rejects.toThrow();
    clock.seconds -= 31;
  });

  it("does not put the key in the error it throws", async () => {
    const authenticate = createControlAuthenticator(config, new InMemoryReplayStore(() => clock.seconds));
    const error = await authenticate(new Map([["authorization", `Bearer ${KEY}`]]), request).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(String(error?.message) + String(error?.stack)).not.toContain(KEY);
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
    for (const k of ["KJ_CONTROL_KEY_ID", "KJ_CONTROL_SIGNING_KEY_PREVIOUS", "KJ_CONTROL_KEY_ID_PREVIOUS", "KJ_CONTROL_FRESHNESS_SECONDS", "KJ_CONTROL_TOKEN"])
      delete process.env[k];
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
    for (const over of [{ KJ_CONTROL_SIGNING_KEY: undefined }, { KJ_ADMISSION_PRINCIPAL_ID: undefined }, { KJ_CONTROL_SIGNING_KEY: "short" }]) {
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
      expect(message).not.toContain(KEY);
    }
  });
});

describe("KJ-P4B.1 the door side of the boundary", () => {
  const door = {
    DATABASE_URL: "postgresql://unused@127.0.0.1:1/unused",
    KJ_ADMISSION_BEARER: "SYNTHETIC-DOOR-BEARER-0123456789-abcdef",
    KJ_ADMISSION_TENANT_ID: TENANT,
    KJ_ADMISSION_PRINCIPAL_ID: PRINCIPAL,
    KJ_ADMISSION_PRINCIPAL_KIND: "HUMAN",
  };

  it("signs nothing unless a signing key is configured, exactly as before", () => {
    expect(loadDoorConfig(door).controlSigning).toBeNull();
    expect(loadDoorConfig({ ...door, KJ_CONTROL_SIGNING_KEY: "" }).controlSigning).toBeNull();
  });

  it("carries a configured signing key under the default id, which is never the admission bearer", () => {
    const config = loadDoorConfig({ ...door, KJ_CONTROL_SIGNING_KEY: KEY });
    expect(config.controlSigning).toEqual({ keyId: "v1", key: KEY });
    expect(config.controlSigning?.key).not.toBe(config.bearer);
    expect(loadDoorConfig({ ...door, KJ_CONTROL_SIGNING_KEY: KEY, KJ_CONTROL_KEY_ID: "v2" }).controlSigning?.keyId).toBe("v2");
  });

  it("refuses a signing key that is too short and a bad key id, naming only the error code", () => {
    for (const [env, code] of [
      [{ KJ_CONTROL_SIGNING_KEY: "short" }, "KJ_CONTROL_SIGNING_KEY_TOO_SHORT"],
      [{ KJ_CONTROL_SIGNING_KEY: KEY, KJ_CONTROL_KEY_ID: "bad id" }, "KJ_CONTROL_KEY_ID_INVALID"],
    ] as const) {
      let error: unknown;
      try {
        loadDoorConfig({ ...door, ...env });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(DoorConfigError);
      expect((error as DoorConfigError).code).toBe(code);
      expect((error as Error).message).not.toContain(KEY);
    }
  });
});

describe("KJ-P4B.1 the deployment declares what the boundary reads", () => {
  const VARS = [
    "KJ_ADMISSION_PRINCIPAL_ID",
    "KJ_ADMISSION_TENANT_ID",
    "KJ_APPROVAL_ENABLED",
    "KJ_APPROVAL_TTL_SECONDS",
    "KJ_CONTROL_FRESHNESS_SECONDS",
    "KJ_CONTROL_KEY_ID",
    "KJ_CONTROL_KEY_ID_PREVIOUS",
    "KJ_CONTROL_SIGNING_KEY",
    "KJ_CONTROL_SIGNING_KEY_PREVIOUS",
  ];
  const yaml = readFileSync("infrastructure/docker/execution.compose.yaml", "utf8").replace(/\r\n/g, "\n");
  const workerBlock = yaml.slice(yaml.indexOf("\n  worker:"), yaml.indexOf("\nvolumes:"));
  const declared = (block: string, v: string): boolean => new RegExp(`^[ \\t]+${v}: \\$\\{${v}:-\\}[ \\t]*$`, "m").test(block);
  const envVarsRead = (src: string): string[] => [
      ...new Set(
        [...src.matchAll(/env\[\s*"([A-Z][A-Z0-9_]+)"\s*\]/g), ...src.matchAll(/whole\(env,\s*"([A-Z][A-Z0-9_]+)"/g)].map((m) => m[1]!),
      ),
    ];

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

  it("declares the signing key and its id in the door, empty by default, and no bearer token anywhere", () => {
    const gateway = readFileSync("infrastructure/docker/gateway.compose.yaml", "utf8").replace(/\r\n/g, "\n");
    for (const v of ["KJ_CONTROL_SIGNING_KEY", "KJ_CONTROL_KEY_ID"]) {
      expect(declared(gateway, v), v).toBe(true);
      expect(declared(gateway.replace(new RegExp(`^[ \\t]+${v}:.*\\n`, "m"), ""), v), v).toBe(false);
    }
    expect(gateway).not.toContain("KJ_CONTROL_TOKEN");
    expect(yaml).not.toContain("KJ_CONTROL_TOKEN");
  });

  it("the execution topology check requires the worker to declare them too", () => {
    const script = readFileSync("scripts/check-execution-topology.mjs", "utf8");
    for (const v of VARS) expect(script, v).toContain(`"${v}"`);
  });
});

describe("KJ-P4B.1 the env merge tool accepts the new keys and only in the right shape", () => {
  const python = ["python3", "python"].find((c) => spawnSync(c, ["--version"]).status === 0);
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const SIGNING = "SyntheticControlSigningKey_0123456789_abcdefghijklmnop";
  const DB = "postgresql://svc:SYNTH-DB-PASSWORD-9137@db.example.invalid:5432/kj";
  function merge(args: string[], key = SIGNING) {
    const d = mkdtempSync(join(tmpdir(), "kj-p4b1-merge-"));
    dirs.push(d);
    writeFileSync(join(d, "base.env"), `DATABASE_URL=${DB}\nKERNELJSON_RELEASE_ID=${"a".repeat(40)}\n`);
    writeFileSync(join(d, "control.txt"), `${key}\n`);
    const r = spawnSync(
      python!,
      ["scripts/runtime_env_merge.py", "merge", "--base", join(d, "base.env"), "--out", join(d, "new.env"), "--require-keys", "DATABASE_URL", ...args.map((a) => a.replace("@DIR@", d))],
      { encoding: "utf8" },
    );
    return { code: r.status ?? -1, out: r.stdout + r.stderr, file: join(d, "new.env") };
  }

  it("sets the switch, deadline, identity, key id and window as public keys, and the signing keys only from a file", () => {
    const r = merge([
      "--set-public", "KJ_APPROVAL_ENABLED=true",
      "--set-public", "KJ_APPROVAL_TTL_SECONDS=120",
      "--set-public", `KJ_ADMISSION_TENANT_ID=${TENANT}`,
      "--set-public", `KJ_ADMISSION_PRINCIPAL_ID=${PRINCIPAL}`,
      "--set-public", "KJ_CONTROL_KEY_ID=v1",
      "--set-public", "KJ_CONTROL_FRESHNESS_SECONDS=300",
      "--set-from", "KJ_CONTROL_SIGNING_KEY=@DIR@/control.txt",
    ]);
    expect(r.code, r.out).toBe(0);
    const text = readFileSync(r.file, "utf8");
    for (const line of ["KJ_APPROVAL_ENABLED=true", "KJ_CONTROL_KEY_ID=v1", "KJ_CONTROL_FRESHNESS_SECONDS=300", `KJ_CONTROL_SIGNING_KEY=${SIGNING}`])
      expect(text).toContain(line);
    expect(r.out).not.toContain(SIGNING);
  });

  it("can set the previous key pair for a rotation, key from a file", () => {
    const r = merge(["--set-public", "KJ_CONTROL_KEY_ID_PREVIOUS=v0", "--set-from", "KJ_CONTROL_SIGNING_KEY_PREVIOUS=@DIR@/control.txt"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain(SIGNING);
  });

  it.each([
    ["the signing key on argv", ["--set-public", `KJ_CONTROL_SIGNING_KEY=${SIGNING}`]],
    ["the previous signing key on argv", ["--set-public", `KJ_CONTROL_SIGNING_KEY_PREVIOUS=${SIGNING}`]],
    ["the retired bearer token name", ["--set-from", "KJ_CONTROL_TOKEN=@DIR@/control.txt"]],
    ["a non-boolean switch", ["--set-public", "KJ_APPROVAL_ENABLED=yes"]],
    ["a key id with a space", ["--set-public", "KJ_CONTROL_KEY_ID=bad id"]],
    ["a freshness window that is not digits", ["--set-public", "KJ_CONTROL_FRESHNESS_SECONDS=1e3"]],
    ["a deadline that is not digits", ["--set-public", "KJ_APPROVAL_TTL_SECONDS=1e3"]],
    ["a tenant that is not a uuid", ["--set-public", "KJ_ADMISSION_TENANT_ID=tenant"]],
    ["a principal that is not a uuid", ["--set-public", "KJ_ADMISSION_PRINCIPAL_ID=principal"]],
  ])("refuses %s", (_label, args) => {
    const r = merge(args);
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain(SIGNING);
  });

  it("refuses a signing key of the wrong shape, from a file", () => {
    for (const bad of ["short", "has spaces in it and is long enough to pass the length check", "x".repeat(200)]) {
      const r = merge(["--set-from", "KJ_CONTROL_SIGNING_KEY=@DIR@/control.txt"], bad);
      expect(r.code, bad.slice(0, 10)).not.toBe(0);
    }
  });
});
