import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
  CapabilityInvocation,
  CapabilityResult,
  Outcome,
  PolicyDecision,
} from "../packages/contracts/src/index.js";
import {
  CapabilityRegistry,
  createBuiltinRegistry,
  capabilityDigest,
  UPPERCASE,
  REVERSE,
  TextInput,
  TextOutput,
  type CapabilityDefinition,
} from "../packages/capabilities/src/index.js";
import { capabilityInvocation as request } from "../evals/fixtures/capabilities.js";

const registry = createBuiltinRegistry();
function custom(
  overrides: Partial<CapabilityDefinition> = {},
): CapabilityDefinition {
  return {
    metadata: registry.describe(UPPERCASE).metadata,
    inputSchema: TextInput,
    outputSchema: TextOutput,
    execute: () => ({ text: "KERNELJSON" }),
    verify: (_input, output) => TextOutput.parse(output).text === "KERNELJSON",
    ...overrides,
  };
}
it("discovers immutable exact versions and their JSON schemas", () => {
  const list = registry.list();
  expect(list).toHaveLength(2);
  expect(list[0]?.inputSchema).toMatchObject({
    type: "object",
    additionalProperties: false,
  });
  expect(() => list[0]!.metadata.permissions.push("network")).toThrow();
  expect(() => registry.describe({ ...UPPERCASE, version: "latest" })).toThrow(
    "NOT_FOUND",
  );
  expect(() => new CapabilityRegistry([custom(), custom()])).toThrow(
    "DUPLICATE_VERSION",
  );
});
it.each([
  [UPPERCASE, "  Straße  ", "STRASSE"],
  [REVERSE, "a😀b", "b😀a"],
  [UPPERCASE, "", ""],
  [REVERSE, "", ""],
])(
  "executes and independently verifies a built-in (%#)",
  (capability, input, output) => {
    const invocation = { ...request, capability, input: { text: input } };
    const result = registry.execute(invocation);
    expect(result.output).toEqual({ text: output });
    expect(registry.verify(invocation, result)).toEqual(result);
    expect(CapabilityResult.safeParse(result).success).toBe(true);
    expect(Outcome.safeParse(result).success).toBe(false);
    expect(PolicyDecision.safeParse(result).success).toBe(false);
  },
);
it.each([
  { ...request, runId: "bad" },
  { ...request, stepId: undefined },
  { ...request, trace: {} },
  { ...request, idempotencyKey: " " },
  { ...request, permissions: ["network"] },
  { ...request, implementation: "shell" },
])("rejects invalid or scope-expanding invocation fixtures (%#)", (raw) => {
  expect(CapabilityInvocation.safeParse(raw).success).toBe(false);
  expect(() => registry.execute(raw)).toThrow("INVALID_REQUEST");
});
it.each([
  { text: 1 },
  { text: "hi", shell: "whoami" },
  { text: "x".repeat(16385) },
])("validates capability-specific input before execution (%#)", (input) => {
  const execute = vi.fn(() => ({ text: "KERNELJSON" }));
  const r = new CapabilityRegistry([custom({ execute })]);
  expect(() => r.execute({ ...request, input })).toThrow("INVALID_INPUT");
  expect(execute).not.toHaveBeenCalled();
});
it.each([
  { riskClass: "HIGH" },
  { permissions: ["write"] },
  { implementationType: "API" },
  { implementationType: "MCP" },
  { implementationType: "SANDBOX" },
  { version: "latest" },
])(
  "refuses permissioned, external or unversioned registration (%#)",
  (extra) => {
    const metadata = { ...registry.describe(UPPERCASE).metadata, ...extra };
    expect(
      () =>
        new CapabilityRegistry([
          custom({ metadata: metadata as CapabilityDefinition["metadata"] }),
        ]),
    ).toThrow("UNSUPPORTED_CAPABILITY");
  },
);
it("detects output schema errors, incorrect results, thrown verifiers and implementation failures", () => {
  expect(() =>
    new CapabilityRegistry([custom({ execute: () => ({ text: 3 }) })]).execute(
      request,
    ),
  ).toThrow("INVALID_OUTPUT");
  expect(() =>
    new CapabilityRegistry([
      custom({ execute: () => ({ text: "wrong" }) }),
    ]).execute(request),
  ).toThrow("VERIFICATION_FAILED");
  expect(() =>
    new CapabilityRegistry([
      custom({
        verify: () => {
          throw new Error("private");
        },
      }),
    ]).execute(request),
  ).toThrow("VERIFICATION_FAILED");
  expect(() =>
    new CapabilityRegistry([
      custom({
        execute: () => {
          throw new Error("private");
        },
      }),
    ]).execute(request),
  ).toThrow("IMPLEMENTATION_FAILED");
});
it("does not let receipt hashes replace independent verification", () => {
  const result = registry.execute(request);
  const output = { text: "forged" };
  expect(() =>
    registry.verify(request, {
      ...result,
      output,
      outputDigest: capabilityDigest(output),
    }),
  ).toThrow("VERIFICATION_FAILED");
});
it("binds every receipt to task, step, trace, version, key, descriptor and input", () => {
  const result = registry.execute(request);
  for (const change of [
    { runId: request.taskId },
    { taskId: request.stepId },
    { stepId: request.taskId },
    { trace: { ...request.trace, traceId: request.taskId } },
    { capability: REVERSE },
    { idempotencyKey: "other" },
    { descriptorDigest: "0".repeat(64) },
    { requestDigest: "0".repeat(64) },
    { outputDigest: "0".repeat(64) },
  ])
    expect(() => registry.verify(request, { ...result, ...change })).toThrow(
      "INVALID_RECEIPT",
    );
});
it("canonical digests survive JSONB key order but preserve array order and values", () => {
  expect(capabilityDigest({ a: 1, b: 2 })).toBe(
    capabilityDigest({ b: 2, a: 1 }),
  );
  expect(capabilityDigest([1, 2])).not.toBe(capabilityDigest([2, 1]));
  expect(capabilityDigest({ a: 1 })).not.toBe(capabilityDigest({ a: "1" }));
  expect(
    registry.verify(
      JSON.parse(JSON.stringify(request)),
      registry.execute(request),
    ),
  ).toEqual(registry.execute(request));
});
it("captures registrations and refuses silent schema coercion", () => {
  const d = custom();
  const r = new CapabilityRegistry([d]);
  d.execute = () => ({ text: "changed" });
  expect(r.execute(request).output).toEqual({ text: "KERNELJSON" });
  const coercing = new CapabilityRegistry([
    custom({ inputSchema: z.strictObject({ text: z.string().trim() }) }),
  ]);
  expect(() => coercing.execute(request)).toThrow("INVALID_INPUT");
});
