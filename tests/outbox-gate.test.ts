import { describe, it, expect } from "vitest";
import {
  DEFAULT_MAX_PENDING_AGE_MS,
  DEFAULT_MAX_SENDING_AGE_MS,
  evaluateOutboxGate,
  type OutboxGateInput,
} from "../services/kernel/src/alerting/outbox-gate.js";
import { GateUsageError, parseArgs } from "../services/kernel/src/alerting/outbox-gate-cli.js";

const clean: OutboxGateInput = {
  counts: { DELIVERED: 4 },
  oldestPendingAgeMs: null,
  oldestSendingAgeMs: null,
  duplicateDelivered: 0,
  poisonErrorClasses: {},
};

describe("KJ-P2.2B POISON activation gate", () => {
  it("passes on the clean KJ-P2.1A baseline (4 DELIVERED, zero POISON)", () => {
    expect(evaluateOutboxGate(clean, { baselinePoison: 0 })).toEqual({ pass: true, failures: [] });
  });

  it("passes with a fresh in-flight PENDING row (the queued test notification before its tick)", () => {
    const v = evaluateOutboxGate({ ...clean, counts: { DELIVERED: 4, PENDING: 1 }, oldestPendingAgeMs: 30_000 }, { baselinePoison: 0 });
    expect(v.pass).toBe(true);
  });

  it("FAILS on any new POISON, naming its error class (a bad token or chat surfaces here)", () => {
    const v = evaluateOutboxGate(
      { ...clean, counts: { DELIVERED: 4, POISON: 1 }, poisonErrorClasses: { TelegramUnauthorizedError: 1 } },
      { baselinePoison: 0 },
    );
    expect(v.pass).toBe(false);
    expect(v.failures[0]).toMatch(/POISON rose from baseline 0 to 1/);
    expect(v.failures[0]).toContain("TelegramUnauthorizedError=1");
  });

  it("tolerates POISON that already existed in the baseline, but not one more", () => {
    const at = { ...clean, counts: { DELIVERED: 4, POISON: 2 } };
    expect(evaluateOutboxGate(at, { baselinePoison: 2 }).pass).toBe(true);
    expect(evaluateOutboxGate({ ...at, counts: { DELIVERED: 4, POISON: 3 } }, { baselinePoison: 2 }).pass).toBe(false);
  });

  it("FAILS on a stuck SENDING row (abandoned mid-attempt)", () => {
    const v = evaluateOutboxGate({ ...clean, counts: { SENDING: 1 }, oldestSendingAgeMs: DEFAULT_MAX_SENDING_AGE_MS + 1 }, { baselinePoison: 0 });
    expect(v.pass).toBe(false);
    expect(v.failures[0]).toMatch(/SENDING row stuck/);
  });

  it("FAILS on a PENDING row a natural tick has not delivered", () => {
    const v = evaluateOutboxGate({ ...clean, counts: { PENDING: 1 }, oldestPendingAgeMs: DEFAULT_MAX_PENDING_AGE_MS + 1 }, { baselinePoison: 0 });
    expect(v.pass).toBe(false);
    expect(v.failures[0]).toMatch(/PENDING row not delivered/);
  });

  it("FAILS on a duplicate delivery", () => {
    const v = evaluateOutboxGate({ ...clean, duplicateDelivered: 1 }, { baselinePoison: 0 });
    expect(v.pass).toBe(false);
    expect(v.failures[0]).toMatch(/duplicate send/);
  });

  it("reports every failure at once", () => {
    const v = evaluateOutboxGate(
      { counts: { POISON: 1, SENDING: 1, PENDING: 1 }, oldestPendingAgeMs: 9e6, oldestSendingAgeMs: 9e6, duplicateDelivered: 2, poisonErrorClasses: {} },
      { baselinePoison: 0 },
    );
    expect(v.failures).toHaveLength(4);
  });

  it("CLI requires an explicit numeric baseline (no silent default of zero)", () => {
    expect(() => parseArgs([])).toThrow(GateUsageError);
    expect(() => parseArgs(["--baseline-poison"])).toThrow(GateUsageError);
    expect(() => parseArgs(["--baseline-poison", "-1"])).toThrow(GateUsageError);
    expect(() => parseArgs(["--baseline-poison", "x"])).toThrow(GateUsageError);
    expect(parseArgs(["--baseline-poison", "0"])).toEqual({ baselinePoison: 0 });
  });
});
