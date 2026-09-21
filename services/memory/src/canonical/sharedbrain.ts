import { createHash } from "node:crypto";
import {
  MAX_MEMORY_CONTENT_CHARS,
  MEMORY_CLASSES,
  type ExternalContextItem,
  type MemoryClass,
  type MemorySubject,
  type TenantContext,
} from "../../../../packages/contracts/src/index.js";
import { tokenEstimate } from "./assembler.js";
import { MemoryError, type CanonicalMemory, type SubmissionResult } from "./service.js";

/**
 * KJ-P5 - the Shared Brain boundary (ADR-0018). The Shared Brain is a knowledge and retrieval source. This file is an
 * interface and two pure conversions, nothing more:
 *
 *   - the PORT can only READ (it has one method, `search`). There is no write, promote or identity method to call;
 *   - what it returns is UNTRUSTED_EXTERNAL context, recorded as external and keeping its source reference;
 *   - anything it proposes as memory goes through `submitExternalCandidate`, which can only ever produce a HELD
 *     candidate. The boundary is typed against that one method of the service, so it cannot reach promotion at all.
 *
 * No bulk migration is implemented or implied. A real adapter for the Shared Brain is a separate, later change.
 */
export interface SharedBrainDocument {
  /** The Shared Brain's own reference for the document. Kept as the provenance of anything derived from it. */
  ref: string;
  kind: "KNOWLEDGE" | "CANDIDATE_MEMORY" | "SOURCE_DOCUMENT";
  text: string;
  /** For CANDIDATE_MEMORY only: what the Shared Brain suggests. A suggestion, never a decision. */
  proposedClass?: MemoryClass;
  subject?: MemorySubject;
}

export interface SharedBrainPort {
  search(query: { tenantId: string; text: string; limit: number }): Promise<SharedBrainDocument[]>;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const clean = (text: string): string => text.normalize("NFC").trim();

/** External knowledge as untrusted context items, source reference kept, size bounded. */
export function toExternalContext(docs: readonly SharedBrainDocument[], limit: number): ExternalContextItem[] {
  const items: ExternalContextItem[] = [];
  for (const doc of docs) {
    if (items.length >= limit) break;
    const text = clean(doc.text).slice(0, MAX_MEMORY_CONTENT_CHARS);
    if (text.length === 0) continue;
    const ref = `shared-brain:${doc.ref}`.slice(0, 200);
    items.push({ ref, text, digest: sha256(text), trustClass: "UNTRUSTED_EXTERNAL", tokens: tokenEstimate(`- [external ${ref}] ${text}`) });
  }
  return items;
}

export class SharedBrainBoundary {
  constructor(
    private readonly port: SharedBrainPort,
    private readonly memory: Pick<CanonicalMemory, "submitExternalCandidate">,
  ) {}

  /** Read-only: external knowledge to place in a context beside canonical memory, labelled untrusted. */
  async contextFor(ctx: TenantContext, text: string, limit = 5): Promise<ExternalContextItem[]> {
    const docs = await this.port.search({ tenantId: ctx.tenantId, text, limit });
    return toExternalContext(docs, limit);
  }

  /** Turn the Shared Brain's candidate memories into HELD candidates. Never canonical, whatever the Shared Brain says. */
  async proposeCandidates(ctx: TenantContext, text: string, limit = 5): Promise<{ submitted: SubmissionResult[]; skipped: number }> {
    const docs = await this.port.search({ tenantId: ctx.tenantId, text, limit });
    const submitted: SubmissionResult[] = [];
    let skipped = 0;
    for (const doc of docs) {
      const body = clean(doc.text);
      const proposed = doc.proposedClass;
      if (doc.kind !== "CANDIDATE_MEMORY" || proposed === undefined || !MEMORY_CLASSES.includes(proposed) || body.length === 0 || body.length > MAX_MEMORY_CONTENT_CHARS) {
        skipped++;
        continue;
      }
      try {
        submitted.push(
          await this.memory.submitExternalCandidate(ctx, {
          idempotencyKey: `shared-brain:${doc.ref}`.slice(0, 200).padEnd(8, "_"),
          class: proposed,
          content: body,
          subject: doc.subject ?? { kind: "TENANT", ref: ctx.tenantId },
          evidence: [{ type: "EXTERNAL_DOCUMENT", ref: doc.ref.slice(0, 200), digest: sha256(body) }],
          reason: "proposed by the Shared Brain as external knowledge",
          intent: "NEW",
          }),
        );
      } catch (error) {
        if (!(error instanceof MemoryError) || error.code !== "CONFLICT") throw error;
        skipped++;
      }
    }
    return { submitted, skipped };
  }
}
