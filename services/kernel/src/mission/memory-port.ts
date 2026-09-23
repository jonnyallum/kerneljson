import type { MemoryClass, PrincipalRef } from "../../../../packages/contracts/src/index.js";

/**
 * KJ-P5 - how a mission asks for canonical memory. The kernel owns this interface; the memory service implements it.
 * It is deliberately READ-ONLY: it can assemble a bounded context and nothing else. There is no way through it to
 * submit, promote, correct or retract, so a mission (and the models it calls) cannot write canonical memory.
 */
export interface MissionMemoryRequest {
  tenantId: string;
  principal: PrincipalRef;
  taskId: string;
  stepId: string;
  /** The model call this context is for. Recorded, so the exact context of one execution can be found again. */
  callId: string;
  /** The mission question. Used to rank memories; never stored as memory. */
  purpose: string;
  /** The repository the mission is about, so project knowledge for it can be selected. */
  project: string;
  /** Optional narrowing from the pinned faculty; never expands mission defaults. */
  allowedClasses?: MemoryClass[];
  maxTokens?: number;
}

/** Plain JSON on purpose: the workflow journals it, so a replay sees exactly what the first run saw. */
export interface MissionMemoryContext {
  status: "ASSEMBLED" | "UNAVAILABLE";
  assemblyId: string | null;
  digest: string | null;
  /** The text placed in the prompt. Empty when there is nothing to say. */
  text: string;
  memories: Array<{ memoryId: string; version: number }>;
  externalCount: number;
  usedTokens: number;
}

export interface MissionMemoryPort {
  assemble(input: MissionMemoryRequest): Promise<MissionMemoryContext>;
}

/** What a mission asks for by default: no episodes or relationships, a small fixed budget. */
export const MISSION_MEMORY_CLASSES: MemoryClass[] = ["PREFERENCE", "COMMITMENT", "DECISION", "FACT", "LESSON", "PROJECT_KNOWLEDGE"];
export const MISSION_MEMORY_BUDGET = Object.freeze({ maxItems: 12, maxTokens: 1500 });

export const NO_MEMORY: MissionMemoryContext = Object.freeze({
  status: "ASSEMBLED",
  assemblyId: null,
  digest: null,
  text: "",
  memories: [],
  externalCount: 0,
  usedTokens: 0,
});

/** The execution-evidence record of what a model was given. Present in the analyst's evidence only when memory was in play. */
export function memoryEvidence(context: MissionMemoryContext): Record<string, unknown> {
  return {
    status: context.status,
    assembly_id: context.assemblyId,
    context_digest: context.digest,
    memories: context.memories.map((m) => ({ memory_id: m.memoryId, version: m.version })),
    external_count: context.externalCount,
    used_tokens: context.usedTokens,
  };
}
