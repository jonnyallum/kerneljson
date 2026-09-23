import {
  MISSION_MEMORY_BUDGET,
  MISSION_MEMORY_CLASSES,
  type MissionMemoryContext,
  type MissionMemoryPort,
} from "../../../kernel/src/mission/memory-port.js";
import type { ExternalContextItem } from "../../../../packages/contracts/src/index.js";
import { renderContext } from "./assembler.js";
import type { CanonicalMemory } from "./service.js";
import type { SharedBrainBoundary } from "./sharedbrain.js";

/**
 * KJ-P5 - the read-only memory port a mission uses. It assembles a bounded context for the mission's principal and
 * tenant, and records the assembly against the model call it is for. It exposes `assemble` and nothing else, so what a
 * mission (or the model it calls) can do to memory is: read the bounded slice it was given.
 *
 * The Shared Brain, when wired, contributes external context only, labelled untrusted, with its source reference kept.
 * A Shared Brain failure never fails the mission and never blocks canonical memory.
 */
export function createMissionMemoryPort(memory: Pick<CanonicalMemory, "assemble">, brain?: Pick<SharedBrainBoundary, "contextFor">): MissionMemoryPort {
  return {
    async assemble(input): Promise<MissionMemoryContext> {
      const ctx = { tenantId: input.tenantId, principal: input.principal };
      let external: ExternalContextItem[] = [];
      if (brain) {
        try {
          external = await brain.contextFor(ctx, input.purpose, 3);
        } catch {
          external = [];
        }
      }
      const assembled = await memory.assemble(
        ctx,
        {
          purpose: input.purpose,
          project: input.project,
          allowedClasses: MISSION_MEMORY_CLASSES.filter(c => !input.allowedClasses || input.allowedClasses.includes(c)),
          budget: { maxItems: MISSION_MEMORY_BUDGET.maxItems, maxTokens: Math.min(input.maxTokens ?? MISSION_MEMORY_BUDGET.maxTokens, MISSION_MEMORY_BUDGET.maxTokens) },
        },
        { consumer: { taskId: input.taskId, stepId: input.stepId, callId: input.callId }, external },
      );
      return {
        status: "ASSEMBLED",
        assemblyId: assembled.assemblyId,
        digest: assembled.digest,
        text: renderContext(assembled),
        memories: assembled.items.map((i) => ({ memoryId: i.memoryId, version: i.version })),
        externalCount: assembled.external.length,
        usedTokens: assembled.budget.usedTokens,
      };
    },
  };
}
