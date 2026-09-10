import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { ScheduleSpec, fireIdentity, idempotencyKey } from "../services/kernel/src/scheduler/index.js";

/**
 * Phase S1-R0 — scheduler -> KernelJSON Admission IDENTITY MAPPING (pure, no DB).
 *
 * The admission door (apps/gateway/src/server.ts) dedupes on the `Idempotency-Key`
 * HTTP header (regex below, server.ts:18): keyDigest = sha256(key) feeds both the
 * durable `unique(tenant_id,principal_id,key_digest)` on kernel_private.task_admissions
 * AND the deterministic task id. So the scheduler's Restate adapter must send a
 * deterministic, replay-stable Idempotency-Key derived from the logical fire, and
 * must NOT invent a second random key.
 *
 * This proves the SCHEDULER half of the mapping purely: the correct header value is
 * `fireIdentity` (deterministic, distinct per logical fire, and a valid Idempotency-
 * Key), whereas the raw `idempotencyKey` is not header-legal. The gateway half
 * (same key -> one durable task; different payload -> 409; lost-ack -> same task;
 * concurrent duplicates -> one task) is proven by tests/gateway.test.ts.
 */

// Mirror of the gateway Idempotency-Key contract (apps/gateway/src/server.ts:18).
const GATEWAY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

function spec(scheduleId: string, version: string): ScheduleSpec {
  const human = randomUUID();
  return ScheduleSpec.parse({
    scheduleId,
    version,
    tenant: { id: randomUUID() },
    principal: { id: randomUUID(), kind: "SERVICE" },
    owner: { id: human, kind: "HUMAN" },
    timezone: "Europe/London",
    calendar: { kind: "dailyAt", hour: 1, minute: 30 },
    missedRunPolicy: "SKIP",
    maxBackfillRuns: 10,
    overlapPolicy: "FORBID",
    perScheduleConcurrency: 1,
    createdAt: new Date(0).toISOString(),
  });
}

describe("S1-R0 scheduler->admission identity mapping (pure)", () => {
  const SID = randomUUID();
  const WIN = "dailyAt/01:30|Europe/London|2026-09-11";

  it("same logical fire -> same fireIdentity (content-derived, not object identity)", () => {
    const a = fireIdentity(spec(SID, "v1"), WIN);
    const b = fireIdentity(spec(SID, "v1"), WIN); // different spec object, same scheduleId/version/window
    expect(a).toBe(b);
  });

  it("distinct logical fires -> distinct fireIdentity (scheduleId, version, window)", () => {
    const base = fireIdentity(spec(SID, "v1"), WIN);
    expect(fireIdentity(spec(randomUUID(), "v1"), WIN)).not.toBe(base); // other schedule
    expect(fireIdentity(spec(SID, "v2"), WIN)).not.toBe(base); // other version
    expect(fireIdentity(spec(SID, "v1"), "dailyAt/01:30|Europe/London|2026-09-12")).not.toBe(base); // other window
  });

  it("fireIdentity is a valid gateway Idempotency-Key; raw idempotencyKey is NOT", () => {
    const id = fireIdentity(spec(SID, "v1"), WIN);
    expect(GATEWAY_KEY.test(id)).toBe(true); // -> use fireIdentity as the header
    const raw = idempotencyKey(spec(SID, "v1"), WIN); // scheduleId|version|window
    expect(GATEWAY_KEY.test(raw)).toBe(false); // contains '|' and '/': not header-legal
  });

  it("mapping requires no second random key: fireIdentity is fully determined by the fire", () => {
    // Two independent derivations agree -> a Restate replay recomputes the same key.
    const runs = new Set([
      fireIdentity(spec(SID, "v1"), WIN),
      fireIdentity(spec(SID, "v1"), WIN),
      fireIdentity(spec(SID, "v1"), WIN),
    ]);
    expect(runs.size).toBe(1);
  });
});
