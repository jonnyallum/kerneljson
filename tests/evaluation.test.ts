import { it, expect } from "vitest";
import { evaluate, promotionAllowed } from "../services/evaluator/src/index.js";
import { uppercaseCandidate } from "../services/evaluator/src/candidate.js";
import { uppercaseSuite } from "../evals/golden/uppercase.js";
import {
  EvaluationSuite,
  EvaluationReport,
} from "../packages/contracts/src/index.js";
const candidate = uppercaseCandidate("c".repeat(64)),
  at = "2026-09-05T00:00:00.000Z";
it("executes the golden corpus against the real registered capability", () => {
  const report = evaluate(uppercaseSuite, candidate, at);
  expect(report.cases).toHaveLength(5);
  expect(report.passed).toBe(true);
  expect(promotionAllowed(report, uppercaseSuite, candidate.digest)).toBe(true);
});
it("blocks a schema-valid semantic regression", () => {
  const report = evaluate(
    uppercaseSuite,
    { ...candidate, execute: (input) => input },
    at,
  );
  expect(report.passed).toBe(false);
  expect(promotionAllowed(report, uppercaseSuite, candidate.digest)).toBe(
    false,
  );
});
it("classifies thrown failures without exposing error content", () => {
  const report = evaluate(
    uppercaseSuite,
    {
      ...candidate,
      execute: () => {
        throw new Error("private-token");
      },
    },
    at,
  );
  expect(report.cases.every((c) => c.error === "EXECUTION_ERROR")).toBe(true);
  expect(JSON.stringify(report)).not.toContain("private-token");
});
it("rejects non-JSON outputs including unawaited promises", () => {
  for (const output of [
    undefined,
    () => 0,
    Promise.resolve({ text: "HELLO" }),
  ]) {
    const report = evaluate(
      uppercaseSuite,
      { ...candidate, execute: () => output },
      at,
    );
    expect(report.passed).toBe(false);
    expect(report.cases[0]?.error).toBe("INVALID_OUTPUT");
  }
});
it("requires exact candidate and suite versions with every case present", () => {
  const report = evaluate(uppercaseSuite, candidate, at);
  expect(promotionAllowed(report, uppercaseSuite, "d".repeat(64))).toBe(false);
  expect(
    promotionAllowed(
      report,
      { ...uppercaseSuite, version: "2" },
      candidate.digest,
    ),
  ).toBe(false);
  expect(
    promotionAllowed(
      { ...report, cases: report.cases.slice(1) },
      uppercaseSuite,
      candidate.digest,
    ),
  ).toBe(false);
});
it("rejects forged passing flags, duplicate cases and malformed suites", () => {
  const report = evaluate(
    uppercaseSuite,
    { ...candidate, execute: () => null },
    at,
  );
  expect(EvaluationReport.safeParse({ ...report, passed: true }).success).toBe(
    false,
  );
  expect(
    EvaluationSuite.safeParse({
      ...uppercaseSuite,
      cases: [uppercaseSuite.cases[0], uppercaseSuite.cases[0]],
    }).success,
  ).toBe(false);
  expect(
    EvaluationSuite.safeParse({ ...uppercaseSuite, cases: [] }).success,
  ).toBe(false);
});
it("does not let candidate mutation rewrite expected fixtures", () => {
  const before = JSON.stringify(uppercaseSuite);
  evaluate(
    uppercaseSuite,
    {
      ...candidate,
      execute: (input) => {
        if (input && typeof input === "object" && !Array.isArray(input))
          input["text"] = "mutated";
        return input;
      },
    },
    at,
  );
  expect(JSON.stringify(uppercaseSuite)).toBe(before);
});
