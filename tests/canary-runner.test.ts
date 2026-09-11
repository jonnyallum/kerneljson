import { describe, it, expect, vi } from "vitest";
import type pg from "pg";
import {
  parseArgs,
  resolveDatabaseUrl,
  formatResult,
  runCanaryOperation,
  CANARY_SPEC,
  type RunnerDeps,
} from "../services/kernel/src/tools/canary-runner.js";
import {
  provisionHumanPrincipal,
  InMemoryIdentityStore,
} from "../services/kernel/src/identity/provisioning.js";
import { InMemoryScheduleStore } from "../services/kernel/src/scheduler/store.js";
import {
  installDisabledCanary,
  type IdentityGate,
} from "../services/kernel/src/scheduler/canary-seed.js";

const TENANT = "5f970749-7507-894b-a2e4-872ce20a94b7";
const HUMAN = "da5c6dfc-38c5-4773-bd47-5c80ed908d75";
const SCHEDULE = "9c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const CREATED_AT = "2026-09-11T09:00:00.000+00:00";
const FAKE_URL = "postgresql://postgres:SUPER-SECRET-PW@db.example.supabase.co:5432/postgres";
const pool = {} as unknown as pg.Pool; // deps below never touch pg

function throwsCode(fn: () => unknown): string {
  try {
    fn();
    return "NO_THROW";
  } catch (e) {
    return (e as { code?: string }).code ?? (e as Error).name;
  }
}
async function rejectsCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "NO_THROW";
  } catch (e) {
    return (e as { code?: string }).code ?? (e as Error).name;
  }
}

const goodGate: IdentityGate = {
  async snapshot() {
    return {
      tenantExists: true,
      principalExists: true,
      ownerExists: true,
      ownerKind: "HUMAN",
      membershipExists: true,
    };
  },
};

// Deps wired to the REVIEWED domain functions over in-memory stores (no DB, no new logic).
const reviewedDeps: RunnerDeps = {
  provisionHuman: ({ principalId, tenantId }) =>
    provisionHumanPrincipal(new InMemoryIdentityStore({ tenants: [TENANT] }), {
      principalId,
      tenantId,
      role: "operator",
    }),
  installCanary: ({ scheduleId, tenantId, ownerId, createdAt }) =>
    installDisabledCanary(new InMemoryScheduleStore(), goodGate, {
    scheduleId,
    version: CANARY_SPEC.version,
    tenantId,
    principalId: ownerId,
    ownerId,
    createdBy: ownerId,
    name: CANARY_SPEC.name,
    timezone: CANARY_SPEC.timezone,
    calendar: CANARY_SPEC.calendar,
    missedRunPolicy: CANARY_SPEC.missedRunPolicy,
    overlapPolicy: CANARY_SPEC.overlapPolicy,
    nonexistentTimePolicy: CANARY_SPEC.nonexistentTimePolicy,
    maxBackfillRuns: CANARY_SPEC.maxBackfillRuns,
    perScheduleConcurrency: CANARY_SPEC.perScheduleConcurrency,
    createdAt,
    }),
};

describe("canary runner — arg parsing (fail closed, explicit)", () => {
  it("requires an explicit operation", () => {
    expect(throwsCode(() => parseArgs([]))).toBe("OPERATION_REQUIRED");
    expect(throwsCode(() => parseArgs(["frobnicate"]))).toBe("OPERATION_REQUIRED");
  });
  it("requires the operation's flags", () => {
    expect(throwsCode(() => parseArgs(["provision-human", "--principal-id", HUMAN]))).toBe("MISSING_ARG");
    expect(throwsCode(() => parseArgs(["install-canary", "--schedule-id", SCHEDULE]))).toBe("MISSING_ARG");
  });
  it("parses valid provision-human and install-canary invocations", () => {
    expect(parseArgs(["provision-human", "--principal-id", HUMAN, "--tenant-id", TENANT])).toEqual({
      operation: "provision-human",
      values: { "principal-id": HUMAN, "tenant-id": TENANT },
    });
    expect(
      parseArgs([
        "install-canary",
        "--schedule-id", SCHEDULE,
        "--tenant-id", TENANT,
        "--owner-id", HUMAN,
        "--created-at", CREATED_AT,
      ]).operation,
    ).toBe("install-canary");
  });
});

describe("canary runner — DATABASE_URL (fail closed, never echoed)", () => {
  it("fails closed when DATABASE_URL is absent", () => {
    expect(throwsCode(() => resolveDatabaseUrl({}))).toBe("DATABASE_URL_MISSING");
    expect(throwsCode(() => resolveDatabaseUrl({ DATABASE_URL: "" }))).toBe("DATABASE_URL_MISSING");
  });
  it("never leaks the secret via formatResult", () => {
    const out = formatResult("provision-human", { provisioned: true, principalId: HUMAN, tenantId: TENANT });
    expect(out).not.toContain(FAKE_URL);
    expect(out).not.toContain("SUPER-SECRET-PW");
    expect(JSON.parse(out)).toEqual({
      operation: "provision-human",
      ok: true,
      result: { provisioned: true, principalId: HUMAN, tenantId: TENANT },
    });
  });
});

describe("canary runner — delegation only (no business logic, no raw SQL)", () => {
  it("dispatches provision-human to deps.provisionHuman with exact args", async () => {
    const deps: RunnerDeps = {
      provisionHuman: vi.fn(async () => ({ provisioned: true })),
      installCanary: vi.fn(async () => ({ installed: true })),
    };
    await runCanaryOperation(deps, pool, parseArgs(["provision-human", "--principal-id", HUMAN, "--tenant-id", TENANT]));
    expect(deps.provisionHuman).toHaveBeenCalledWith({ pool, principalId: HUMAN, tenantId: TENANT });
    expect(deps.installCanary).not.toHaveBeenCalled();
  });
  it("dispatches install-canary to deps.installCanary with exact args", async () => {
    const deps: RunnerDeps = {
      provisionHuman: vi.fn(async () => ({})),
      installCanary: vi.fn(async () => ({ installed: true })),
    };
    await runCanaryOperation(
      deps,
      pool,
      parseArgs(["install-canary", "--schedule-id", SCHEDULE, "--tenant-id", TENANT, "--owner-id", HUMAN, "--created-at", CREATED_AT]),
    );
    expect(deps.installCanary).toHaveBeenCalledWith({
      pool,
      scheduleId: SCHEDULE,
      tenantId: TENANT,
      ownerId: HUMAN,
      createdAt: CREATED_AT,
    });
  });
});

describe("canary runner — reviewed validation flows through the runner", () => {
  it("provision-human succeeds via the reviewed path", async () => {
    const r = (await runCanaryOperation(
      reviewedDeps,
      pool,
      parseArgs(["provision-human", "--principal-id", HUMAN, "--tenant-id", TENANT]),
    )) as { provisioned: boolean };
    expect(r.provisioned).toBe(true);
  });
  it("rejects a malformed principal id (reviewed MALFORMED_PRINCIPAL_UUID)", async () => {
    expect(
      await rejectsCode(
        runCanaryOperation(
          reviewedDeps,
          pool,
          parseArgs(["provision-human", "--principal-id", "not-a-uuid", "--tenant-id", TENANT]),
        ),
      ),
    ).toBe("MALFORMED_PRINCIPAL_UUID");
  });
  it("rejects a malformed tenant id (reviewed MALFORMED_TENANT_UUID)", async () => {
    expect(
      await rejectsCode(
        runCanaryOperation(
          reviewedDeps,
          pool,
          parseArgs(["provision-human", "--principal-id", HUMAN, "--tenant-id", "nope"]),
        ),
      ),
    ).toBe("MALFORMED_TENANT_UUID");
  });
  it("install-canary succeeds disabled via the reviewed path", async () => {
    const r = (await runCanaryOperation(
      reviewedDeps,
      pool,
      parseArgs(["install-canary", "--schedule-id", SCHEDULE, "--tenant-id", TENANT, "--owner-id", HUMAN, "--created-at", CREATED_AT]),
    )) as { installed: boolean };
    expect(r.installed).toBe(true);
  });
  it("rejects a malformed schedule id on install (reviewed MALFORMED_INPUT)", async () => {
    expect(
      await rejectsCode(
        runCanaryOperation(
          reviewedDeps,
          pool,
          parseArgs(["install-canary", "--schedule-id", "bad", "--tenant-id", TENANT, "--owner-id", HUMAN, "--created-at", CREATED_AT]),
        ),
      ),
    ).toBe("MALFORMED_INPUT");
  });
});
