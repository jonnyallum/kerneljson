import { createHash } from "node:crypto";
import { z } from "zod";
import {
  Capability,
  CapabilityInvocation,
  CapabilityResult,
  Json,
} from "../../contracts/src/index.js";

export type JsonValue = z.infer<typeof Json>;
export interface CapabilityDefinition {
  metadata: Capability;
  inputSchema: z.ZodType<JsonValue>;
  outputSchema: z.ZodType<JsonValue>;
  execute(input: JsonValue): unknown;
  verify(input: JsonValue, output: JsonValue): boolean;
}
export type CapabilityErrorCode =
  | "INVALID_REQUEST"
  | "DUPLICATE_VERSION"
  | "UNSUPPORTED_CAPABILITY"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "INVALID_OUTPUT"
  | "IMPLEMENTATION_FAILED"
  | "VERIFICATION_FAILED"
  | "INVALID_RECEIPT";
export class CapabilityError extends Error {
  constructor(readonly code: CapabilityErrorCode) {
    super(code);
  }
}

// Canonical JSON makes receipts stable across jsonb object-key ordering.
export function capabilityDigest(value: unknown): string {
  function canonical(v: JsonValue): string {
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    if (v !== null && typeof v === "object")
      return `{${Object.keys(v)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonical(v[k]!)}`)
        .join(",")}}`;
    return JSON.stringify(v);
  }
  return createHash("sha256")
    .update(canonical(Json.parse(value)))
    .digest("hex");
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export interface CapabilityDescriptor {
  metadata: Capability;
  inputSchema: JsonValue;
  outputSchema: JsonValue;
  digest: string;
}
interface Entry {
  definition: CapabilityDefinition;
  descriptor: CapabilityDescriptor;
}

/** Trusted code registry, not a plugin loader or an execution sandbox. */
export class CapabilityRegistry {
  readonly #entries = new Map<string, Entry>();
  constructor(definitions: readonly CapabilityDefinition[]) {
    for (const definition of definitions) {
      const metadata = Capability.parse(definition.metadata);
      if (
        metadata.implementationType !== "DETERMINISTIC" ||
        metadata.riskClass !== "LOW" ||
        metadata.permissions.length ||
        !/^\d+\.\d+\.\d+$/.test(metadata.version)
      )
        throw new CapabilityError("UNSUPPORTED_CAPABILITY");
      const key = `${metadata.id}@${metadata.version}`;
      if (this.#entries.has(key))
        throw new CapabilityError("DUPLICATE_VERSION");
      const inputSchema = Json.parse(z.toJSONSchema(definition.inputSchema));
      const outputSchema = Json.parse(z.toJSONSchema(definition.outputSchema));
      const descriptor = freeze({
        metadata,
        inputSchema,
        outputSchema,
        digest: capabilityDigest({ metadata, inputSchema, outputSchema }),
      });
      this.#entries.set(key, {
        definition: { ...definition, metadata },
        descriptor,
      });
    }
  }
  list(): readonly CapabilityDescriptor[] {
    return Object.freeze(
      [...this.#entries.values()]
        .map((e) => e.descriptor)
        .sort((a, b) =>
          `${a.metadata.id}@${a.metadata.version}`.localeCompare(
            `${b.metadata.id}@${b.metadata.version}`,
          ),
        ),
    );
  }
  describe(ref: { id: string; version: string }): CapabilityDescriptor {
    return this.entry(ref).descriptor;
  }
  private entry(ref: { id: string; version: string }): Entry {
    const entry = this.#entries.get(`${ref.id}@${ref.version}`);
    if (!entry) throw new CapabilityError("NOT_FOUND");
    return entry;
  }
  private prepare(raw: unknown) {
    const parsed = CapabilityInvocation.safeParse(raw);
    if (!parsed.success) throw new CapabilityError("INVALID_REQUEST");
    const request = parsed.data;
    const entry = this.entry(request.capability);
    const input = entry.definition.inputSchema.safeParse(request.input);
    if (!input.success) throw new CapabilityError("INVALID_INPUT");
    // Persist/hash the exact submitted value. Schemas cannot silently coerce it.
    if (capabilityDigest(input.data) !== capabilityDigest(request.input))
      throw new CapabilityError("INVALID_INPUT");
    return { request, entry, input: freeze(input.data) };
  }
  execute(raw: unknown): CapabilityResult {
    const { request, entry, input } = this.prepare(raw);
    let output: unknown;
    try {
      output = entry.definition.execute(input);
    } catch {
      throw new CapabilityError("IMPLEMENTATION_FAILED");
    }
    const parsed = entry.definition.outputSchema.safeParse(output);
    if (!parsed.success) throw new CapabilityError("INVALID_OUTPUT");
    const result = CapabilityResult.parse({
      runId: request.runId,
      taskId: request.taskId,
      stepId: request.stepId,
      trace: request.trace,
      capability: request.capability,
      idempotencyKey: request.idempotencyKey,
      requestDigest: capabilityDigest(request),
      descriptorDigest: entry.descriptor.digest,
      output: parsed.data,
      outputDigest: capabilityDigest(parsed.data),
      verification: "PASSED",
    });
    return this.verify(request, result);
  }
  verify(raw: unknown, rawResult: unknown): CapabilityResult {
    const { request, entry, input } = this.prepare(raw);
    const parsed = CapabilityResult.safeParse(rawResult);
    if (!parsed.success) throw new CapabilityError("INVALID_RECEIPT");
    const result = parsed.data;
    if (
      result.runId !== request.runId ||
      result.taskId !== request.taskId ||
      result.stepId !== request.stepId ||
      capabilityDigest(result.trace) !== capabilityDigest(request.trace) ||
      capabilityDigest(result.capability) !==
        capabilityDigest(request.capability) ||
      result.idempotencyKey !== request.idempotencyKey ||
      result.requestDigest !== capabilityDigest(request) ||
      result.descriptorDigest !== entry.descriptor.digest ||
      result.outputDigest !== capabilityDigest(result.output)
    )
      throw new CapabilityError("INVALID_RECEIPT");
    const output = entry.definition.outputSchema.safeParse(result.output);
    if (
      !output.success ||
      capabilityDigest(output.data) !== capabilityDigest(result.output)
    )
      throw new CapabilityError("INVALID_OUTPUT");
    let verified = false;
    try {
      verified = entry.definition.verify(input, freeze(output.data)) === true;
    } catch {
      /* sanitize verifier failures */
    }
    if (!verified) throw new CapabilityError("VERIFICATION_FAILED");
    return freeze(result);
  }
}

export const TextInput = z.strictObject({ text: z.string().max(16_384) });
export const TextOutput = z.strictObject({ text: z.string().max(49_152) });
export const UPPERCASE = Object.freeze({
  id: "60000000-0000-4000-8000-000000000001",
  version: "1.0.0",
});
export const REVERSE = Object.freeze({
  id: "60000000-0000-4000-8000-000000000002",
  version: "1.0.0",
});
function definition(
  ref: { id: string; version: string },
  description: string,
  execute: (text: string) => string,
  verify: (input: string, output: string) => boolean,
): CapabilityDefinition {
  return {
    metadata: Capability.parse({
      ...ref,
      description,
      inputSchemaRef: "kerneljson:text-input/v1",
      outputSchemaRef: "kerneljson:text-output/v1",
      riskClass: "LOW",
      permissions: [],
      implementationType: "DETERMINISTIC",
      verificationRequirements: ["recompute-text/v1"],
    }),
    inputSchema: TextInput,
    outputSchema: TextOutput,
    execute: (input) => ({ text: execute(TextInput.parse(input).text) }),
    verify: (input, output) =>
      verify(TextInput.parse(input).text, TextOutput.parse(output).text),
  };
}
export function createBuiltinRegistry(): CapabilityRegistry {
  return new CapabilityRegistry([
    definition(
      UPPERCASE,
      "Trim and uppercase text",
      (text) => text.trim().toUpperCase(),
      (input, output) => output === input.trim().toUpperCase(),
    ),
    definition(
      REVERSE,
      "Reverse Unicode code points",
      (text) => Array.from(text).reverse().join(""),
      (input, output) => {
        let expected = "";
        for (const point of input) expected = point + expected;
        return output === expected;
      },
    ),
  ]);
}
