import { createHash } from "node:crypto";
import type { MemoryClass, TenantContext } from "../../../../../packages/contracts/src/index.js";
import { classifyRemember } from "../../../../memory/src/canonical/classify.js";
import { MemoryError, type CanonicalMemory, type MemoryView, type SubmissionResult } from "../../../../memory/src/canonical/service.js";

/**
 * KJ-P5 - the Telegram channel's view of canonical memory. Telegram is a CHANNEL ADAPTER: it carries an explicit
 * instruction to the kernel and carries the answer back. It decides nothing. `remember` submits an operator
 * instruction candidate and the kernel's policy decides; `forget` submits a retraction candidate, which appends a
 * version and leaves every earlier version in place (real deletion is a separate capability that does not exist here).
 *
 * The port is the ONLY memory surface the channel sees. It has no way to promote, sign off or build context.
 */
export type MemoryOutcomeState = "PROMOTED" | "AWAITING_APPROVAL" | "HELD" | "REFUSED" | "REJECTED";

export interface RememberOutcome {
  state: MemoryOutcomeState;
  ruleId: string;
  memoryId: string | null;
  version: number | null;
  class: MemoryClass;
  replayed: boolean;
}

export interface MemoryLine {
  memoryId: string;
  version: number;
  class: MemoryClass;
  trustClass: string;
  /** Present only for USER_AUTHORED memories: text the operator wrote. Anything else is shown by digest, never echoed. */
  text: string | null;
  digest: string;
}

export interface MemoryDetail {
  memoryId: string;
  status: "CURRENT" | "RETRACTED" | "SUPERSEDED";
  class: MemoryClass;
  supersededBy: string | null;
  conflictsWith: string[];
  versions: Array<{ version: number; kind: "ASSERT" | "RETRACT"; trustClass: string; origin: string; text: string | null; digest: string; promotedAt: string; evidence: string[] }>;
}

export type ForgetOutcome =
  | { result: "RETRACTED"; memoryId: string; version: number; replayed: boolean }
  | { result: "ALREADY_RETRACTED"; memoryId: string }
  | { result: "NOT_FOUND" }
  | { result: "AMBIGUOUS" }
  | { result: "REFUSED"; ruleId: string }
  | { result: "HELD"; ruleId: string };

export type ShowOutcome = { result: "FOUND"; detail: MemoryDetail } | { result: "NOT_FOUND" } | { result: "AMBIGUOUS" };

export interface MemoryPort {
  remember(input: { updateId: number; text: string }): Promise<RememberOutcome>;
  list(): Promise<MemoryLine[]>;
  show(ref: string): Promise<ShowOutcome>;
  forget(input: { updateId: number; ref: string }): Promise<ForgetOutcome>;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const line = (v: { memoryId: string; version: number; class: MemoryClass; trustClass: string; content: string; contentDigest: string }): MemoryLine => ({
  memoryId: v.memoryId,
  version: v.version,
  class: v.class,
  trustClass: v.trustClass,
  text: v.trustClass === "USER_AUTHORED" ? v.content : null,
  digest: v.contentDigest,
});

export function createMemoryPort(memory: CanonicalMemory, ctx: TenantContext): MemoryPort {
  const evidence = (updateId: number, text: string) => [{ type: "TELEGRAM_UPDATE" as const, ref: `update:${updateId}`, digest: sha256(text) }];
  const key = (updateId: number) => `telegram:upd:${updateId}`;
  const detail = (view: MemoryView): MemoryDetail => ({
    memoryId: view.memoryId,
    status: view.status,
    class: view.head.class,
    supersededBy: view.supersededBy,
    conflictsWith: view.conflictsWith,
    versions: view.versions.map((v) => ({
      version: v.version,
      kind: v.kind,
      trustClass: v.trustClass,
      origin: v.provenance.origin,
      text: v.trustClass === "USER_AUTHORED" ? v.content : null,
      digest: v.contentDigest,
      promotedAt: v.promotedAt,
      evidence: v.evidence.map((e) => `${e.type}:${e.ref}`),
    })),
  });
  const shape = (r: SubmissionResult, cls: MemoryClass): RememberOutcome => ({
    state: r.state as MemoryOutcomeState,
    ruleId: r.ruleId,
    memoryId: r.memoryId,
    version: r.version,
    class: cls,
    replayed: r.replayed,
  });

  return {
    async remember({ updateId, text }) {
      const c = classifyRemember(text);
      const result = await memory.submitOperatorInstruction(ctx, {
        idempotencyKey: key(updateId),
        class: c.class,
        content: c.content,
        subject: { kind: "PRINCIPAL", ref: ctx.principal.id },
        evidence: evidence(updateId, text),
        reason: "explicit /remember instruction from the operator",
        intent: "NEW",
      });
      return shape(result, c.class);
    },

    async list() {
      return (await memory.listCurrent(ctx, { limit: 10 })).map(line);
    },

    async show(ref) {
      try {
        const view = await memory.find(ctx, ref);
        return view ? { result: "FOUND", detail: detail(view) } : { result: "NOT_FOUND" };
      } catch (error) {
        if (error instanceof MemoryError && error.code === "AMBIGUOUS") return { result: "AMBIGUOUS" };
        throw error;
      }
    },

    async forget({ updateId, ref }) {
      let view: MemoryView | null;
      try {
        view = await memory.find(ctx, ref);
      } catch (error) {
        if (error instanceof MemoryError && error.code === "AMBIGUOUS") return { result: "AMBIGUOUS" };
        throw error;
      }
      if (!view) return { result: "NOT_FOUND" };
      // A retried update that already retracted this memory finds it retracted; the recorded candidate says so.
      const result = await memory.submitOperatorInstruction(ctx, {
        idempotencyKey: key(updateId),
        class: view.head.class,
        content: "",
        subject: view.head.subject,
        evidence: evidence(updateId, `forget ${view.memoryId}`),
        reason: "explicit /forget instruction from the operator",
        intent: "RETRACT",
        targetMemoryId: view.memoryId,
      });
      if (result.state === "PROMOTED" && result.memoryId !== null && result.version !== null)
        return { result: "RETRACTED", memoryId: result.memoryId, version: result.version, replayed: result.replayed };
      if (result.ruleId === "target-retracted") return { result: "ALREADY_RETRACTED", memoryId: view.memoryId };
      if (result.state === "REFUSED") return { result: "REFUSED", ruleId: result.ruleId };
      return { result: "HELD", ruleId: result.ruleId };
    },
  };
}
