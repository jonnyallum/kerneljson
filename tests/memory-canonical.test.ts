import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  MEMORY_CLASSES,
  MEMORY_INTENTS,
  MEMORY_ORIGINS,
  TRUST_FOR_ORIGIN,
  type MemoryClass,
  type MemoryIntent,
  type MemoryOrigin,
} from "../packages/contracts/src/index.js";
import { decidePromotion, looksLikeSecret } from "../services/memory/src/canonical/policy.js";
import { classifyRemember } from "../services/memory/src/canonical/classify.js";
import {
  buildAssembled,
  contextDigest,
  pack,
  packExternal,
  rankCandidates,
  renderContext,
  terms,
  tokenEstimate,
  type Candidate,
} from "../services/memory/src/canonical/assembler.js";
import { toExternalContext } from "../services/memory/src/canonical/sharedbrain.js";
import { loadMemoryConfig } from "../services/memory/src/canonical/config.js";
import { parseCommand, MAX_REMEMBER_CHARS } from "../services/kernel/src/channel/telegram/commands.js";
import { renderReply, USAGE_LINES } from "../services/kernel/src/channel/telegram/replies.js";

const TASK_EVIDENCE = [{ type: "TASK_EVIDENCE" as const, ref: "a/b" }];
const TG = [{ type: "TELEGRAM_UPDATE" as const, ref: "update:1" }];
const evidenceFor = (origin: MemoryOrigin) => (origin === "VERIFIED_OUTCOME" ? TASK_EVIDENCE : TG);

describe("KJ-P5 the promotion policy is a fixed table of origin, class and intent", () => {
  const decide = (origin: MemoryOrigin, cls: MemoryClass, intent: MemoryIntent = "NEW", content = "a plain sentence", targetClass?: MemoryClass) =>
    decidePromotion({ origin, candidate: { class: cls, content, intent, evidence: evidenceFor(origin) }, targetClass });

  it("never lets a model or the Shared Brain past HOLD, for any class or intent", () => {
    for (const origin of ["MODEL_PROPOSAL", "SHARED_BRAIN"] as const)
      for (const cls of MEMORY_CLASSES)
        for (const intent of MEMORY_INTENTS) {
          const r = decide(origin, cls, intent);
          expect(r.decision, `${origin}/${cls}/${intent}`).toBe("HOLD");
        }
  });

  it("lets an explicit operator instruction through, except identity-adjacent RELATIONSHIP which needs approval", () => {
    for (const cls of MEMORY_CLASSES) {
      const r = decide("OPERATOR_INSTRUCTION", cls);
      expect(r.decision, cls).toBe(cls === "RELATIONSHIP" ? "REQUIRE_APPROVAL" : "ALLOW");
    }
    // Changing or retracting a relationship memory is protected too, whatever class the request names.
    for (const intent of ["CORRECT", "RETRACT", "SUPERSEDE"] as const)
      expect(decide("OPERATOR_INSTRUCTION", "FACT", intent, "x", "RELATIONSHIP")).toMatchObject({ decision: "REQUIRE_APPROVAL", protected: true });
  });

  it("lets a verified outcome record an EPISODE, propose a LESSON or DECISION for approval, and nothing else", () => {
    for (const cls of MEMORY_CLASSES) {
      const r = decide("VERIFIED_OUTCOME", cls);
      const expected = cls === "EPISODE" ? "ALLOW" : cls === "LESSON" || cls === "DECISION" ? "REQUIRE_APPROVAL" : "REFUSE";
      expect(r.decision, cls).toBe(expected);
    }
    expect(decide("VERIFIED_OUTCOME", "EPISODE", "CORRECT").decision).toBe("REFUSE");
    expect(decide("VERIFIED_OUTCOME", "EPISODE", "RETRACT").decision).toBe("REFUSE");
    expect(decidePromotion({ origin: "VERIFIED_OUTCOME", candidate: { class: "EPISODE", content: "x", intent: "NEW", evidence: TG } }).decision).toBe("REFUSE");
  });

  it("refuses content shaped like a credential for every origin, before anything else", () => {
    const secrets = [
      "sk-abcdefghijklmnopqrstuvwxyz0123456789",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "AKIAABCDEFGHIJKLMNOP",
      "123456789:abcdefghijklmnopqrstuvwxyzABCDEFGHI",
      "-----BEGIN RSA PRIVATE KEY-----",
      "Bearer abcdefghijklmnopqrstuvwxyz012345",
      "postgres://user:hunter2@host/db",
      "password = correcthorsebatterystaple",
    ];
    for (const origin of MEMORY_ORIGINS)
      for (const s of secrets) expect(decide(origin, "FACT", "NEW", `note ${s} end`), `${origin} ${s}`).toMatchObject({ decision: "REFUSE", ruleId: "no-secrets" });
    for (const fine of ["I prefer short summaries", "the token bucket has 10 slots", "use a password manager", "sk-short"])
      expect(looksLikeSecret(fine), fine).toBeNull();
  });

  it("earns a fixed trust class per origin, which nothing in a candidate can raise", () => {
    expect(TRUST_FOR_ORIGIN).toEqual({
      OPERATOR_INSTRUCTION: "USER_AUTHORED",
      VERIFIED_OUTCOME: "INTERNAL_DERIVED",
      MODEL_PROPOSAL: "MODEL_DERIVED",
      SHARED_BRAIN: "UNTRUSTED_EXTERNAL",
    });
  });
});

describe("KJ-P5 /remember classification is deterministic and never guesses identity", () => {
  it("uses an explicit label when given, and the phrase rules otherwise", () => {
    expect(classifyRemember("preference: short summaries")).toEqual({ class: "PREFERENCE", content: "short summaries", explicit: true });
    expect(classifyRemember("Relationship: Sam is my accountant")).toMatchObject({ class: "RELATIONSHIP", explicit: true });
    expect(classifyRemember("I prefer concise deployment summaries")).toMatchObject({ class: "PREFERENCE", explicit: false });
    expect(classifyRemember("We decided to use Restate").class).toBe("DECISION");
    expect(classifyRemember("I will send the invoice on Friday").class).toBe("COMMITMENT");
    expect(classifyRemember("Lesson: verify the artefact").class).toBe("LESSON");
    expect(classifyRemember("The VM is in us-central1-b").class).toBe("FACT");
  });

  it("never infers RELATIONSHIP from a sentence", () => {
    for (const t of ["Sam is my accountant", "my wife is called Alex", "I work with Sam on the VAT return"]) expect(classifyRemember(t).class).not.toBe("RELATIONSHIP");
  });

  it("does not treat a label with no body as a label", () => {
    expect(classifyRemember("preference:")).toMatchObject({ explicit: false });
    expect(classifyRemember("preference:   ")).toMatchObject({ explicit: false });
  });
});

describe("KJ-P5 the Telegram grammar for memory", () => {
  it("parses the four commands", () => {
    expect(parseCommand("/remember I prefer short summaries")).toEqual({ kind: "REMEMBER", text: "I prefer short summaries" });
    expect(parseCommand("/remember@KernelBot  two   spaces kept as data")).toEqual({ kind: "REMEMBER", text: "two   spaces kept as data" });
    expect(parseCommand("/memories")).toEqual({ kind: "MEMORIES" });
    expect(parseCommand("/memory 6afad033")).toEqual({ kind: "MEMORY", ref: "6afad033" });
    expect(parseCommand("/forget 6AFAD033-1111")).toEqual({ kind: "FORGET", ref: "6afad033-1111" });
  });

  it("refuses malformed memory commands", () => {
    for (const bad of ["/remember", "/remember   ", "/memories now", "/memory", "/memory nothex!!", "/memory abc", "/forget", "/forget a b", "/forget 6afad033 extra", `/remember ${"x".repeat(MAX_REMEMBER_CHARS + 1)}`])
      expect(parseCommand(bad), bad).toEqual({ kind: "MALFORMED" });
  });

  it("keeps the length cap on every other command", () => {
    expect(parseCommand(`/task ${"a".repeat(300)}`)).toEqual({ kind: "MALFORMED" });
    expect(parseCommand(`/status ${"a".repeat(300)}`)).toEqual({ kind: "MALFORMED" });
  });

  it("lists the memory commands in the usage text", () => {
    for (const c of ["/remember <text>", "/memories", "/memory <id>", "/forget <id>"]) expect(USAGE_LINES).toContain(c);
  });
});

describe("KJ-P5 memory replies are fixed templates over safe fields", () => {
  const id = "6afad033-1111-4222-8333-444444444444";
  const line = (text: string | null, trustClass = "USER_AUTHORED") => ({ memoryId: id, version: 1, class: "PREFERENCE" as const, trustClass, text, digest: "a".repeat(64) });

  it("echoes only text the operator wrote, and never anything else", () => {
    const own = renderReply({ kind: "MEMORY_LIST", items: [line("I prefer short summaries")] });
    expect(own).toContain("I prefer short summaries");
    const derived = renderReply({ kind: "MEMORY_LIST", items: [line(null, "INTERNAL_DERIVED")] });
    expect(derived).toContain("not shown");
  });

  it("strips control characters and newlines, and bounds the length", () => {
    const text = `line one${String.fromCharCode(10)}line two${String.fromCharCode(7)}${"x".repeat(500)}`;
    const out = renderReply({ kind: "MEMORY_LIST", items: [line(text)] });
    expect(out).not.toContain(String.fromCharCode(7));
    expect(out.split(String.fromCharCode(10)).filter((l) => l.startsWith("6afad033")).length).toBe(1);
    expect(out.length).toBeLessThan(600);
  });

  it("replaces an unsafe id, rule or class with a question mark rather than echoing it", () => {
    const out = renderReply({ kind: "REMEMBERED", outcome: { state: "REFUSED", ruleId: "<script>alert(1)</script>", memoryId: null, version: null, class: "FACT", replayed: false } });
    expect(out).not.toContain("script");
    expect(out).toContain("?");
    const held = renderReply({ kind: "FORGOTTEN", outcome: { result: "HELD", ruleId: "Bad Rule!" } });
    expect(held).not.toContain("Bad Rule");
  });

  it("says plainly when nothing was remembered, held or needs approval", () => {
    const base = { memoryId: null, version: null, class: "RELATIONSHIP" as const, replayed: false };
    expect(renderReply({ kind: "REMEMBERED", outcome: { ...base, state: "AWAITING_APPROVAL", ruleId: "relationship-approval" } })).toContain("needs an approval");
    expect(renderReply({ kind: "REMEMBERED", outcome: { ...base, state: "HELD", ruleId: "model-candidate-only" } })).toContain("candidate only");
    expect(renderReply({ kind: "REMEMBERED", outcome: { ...base, state: "REJECTED", ruleId: "approval-denied" } })).toContain("not granted");
  });
});

const cand = (over: Partial<Candidate> & { memoryId: string }): Candidate => ({
  version: 1,
  class: "PREFERENCE",
  trustClass: "USER_AUTHORED",
  content: "I prefer concise summaries",
  contentDigest: "a".repeat(64),
  origin: "OPERATOR_INSTRUCTION",
  evidence: TG,
  promotedAt: "2026-09-21T10:00:00.000Z",
  subjectKind: "PRINCIPAL",
  conflictsWith: [],
  ...over,
});
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const REQUEST = { purpose: "write the deployment summary", allowedClasses: [...MEMORY_CLASSES], budget: { maxItems: 10, maxTokens: 400 } };

describe("KJ-P5 the assembler is deterministic and bounded", () => {
  const pool = [
    cand({ memoryId: uuid(1), content: "I prefer concise deployment summaries", promotedAt: "2026-09-21T10:00:00.000Z" }),
    cand({ memoryId: uuid(2), class: "FACT", content: "the deployment target is the London VM", promotedAt: "2026-09-20T10:00:00.000Z" }),
    cand({ memoryId: uuid(3), class: "FACT", content: "unrelated note about tea", promotedAt: "2026-09-22T10:00:00.000Z" }),
    cand({ memoryId: uuid(4), class: "COMMITMENT", content: "I will review invoices weekly", promotedAt: "2026-09-19T10:00:00.000Z" }),
  ];

  it("selects by class-aware eligibility: always PREFERENCE and COMMITMENT, other classes only on term overlap", () => {
    const ranked = rankCandidates(pool, REQUEST.purpose);
    expect(ranked.map((c) => c.memoryId)).toEqual([uuid(1), uuid(2), uuid(4)]);
    expect(ranked.find((c) => c.memoryId === uuid(3))).toBeUndefined();
    expect(ranked.every((c) => c.reason.length > 0)).toBe(true);
  });

  it("gives the same order and digest whatever order the candidates arrive in", () => {
    const a = pack(rankCandidates(pool, REQUEST.purpose), REQUEST.budget);
    const b = pack(rankCandidates([...pool].reverse(), REQUEST.purpose), REQUEST.budget);
    expect(a.items.map((i) => i.memoryId)).toEqual(b.items.map((i) => i.memoryId));
    expect(contextDigest("t", REQUEST, a.items, [])).toBe(contextDigest("t", REQUEST, b.items, []));
  });

  it("changes the digest when the tenant, the request, or a selected version changes", () => {
    const sel = pack(rankCandidates(pool, REQUEST.purpose), REQUEST.budget);
    const base = contextDigest("t", REQUEST, sel.items, []);
    expect(contextDigest("u", REQUEST, sel.items, [])).not.toBe(base);
    expect(contextDigest("t", { ...REQUEST, purpose: "another purpose" }, sel.items, [])).not.toBe(base);
    expect(contextDigest("t", { ...REQUEST, budget: { maxItems: 9, maxTokens: 400 } }, sel.items, [])).not.toBe(base);
    const bumped = sel.items.map((i, k) => (k === 0 ? { ...i, version: i.version + 1 } : i));
    expect(contextDigest("t", REQUEST, bumped, [])).not.toBe(base);
    expect(contextDigest("t", REQUEST, sel.items, [{ ref: "shared-brain:x", text: "x", digest: "b".repeat(64), trustClass: "UNTRUSTED_EXTERNAL", tokens: 5 }])).not.toBe(base);
  });

  it("never exceeds the item or token budget, whatever the candidates and budgets, and records what it excluded", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let round = 0; round < 200; round++) {
      const many = Array.from({ length: 1 + Math.floor(rnd() * 30) }, (_, k) =>
        cand({ memoryId: uuid(k + 1), content: `I prefer note ${k} ${"w".repeat(Math.floor(rnd() * 300))}`, promotedAt: `2026-09-${String(1 + Math.floor(rnd() * 28)).padStart(2, "0")}T10:00:00.000Z` }),
      );
      const budget = { maxItems: 1 + Math.floor(rnd() * 12), maxTokens: 16 + Math.floor(rnd() * 600) };
      const sel = pack(rankCandidates(many, "note"), budget);
      expect(sel.items.length).toBeLessThanOrEqual(budget.maxItems);
      expect(sel.usedTokens).toBeLessThanOrEqual(budget.maxTokens);
      expect(sel.items.reduce((s, i) => s + i.tokens, 0)).toBe(sel.usedTokens);
      const eligible = rankCandidates(many, "note").length;
      expect(sel.items.length + Math.min(sel.excluded.length, 50)).toBeGreaterThanOrEqual(Math.min(eligible, sel.items.length + 50));
    }
  });

  it("excludes rather than truncates: an item that does not fit is dropped whole and recorded", () => {
    const big = cand({ memoryId: uuid(9), content: `I prefer ${"very long ".repeat(200)}` });
    const sel = pack(rankCandidates([big], "long"), { maxItems: 5, maxTokens: 50 });
    expect(sel.items).toEqual([]);
    expect(sel.excluded).toEqual([{ memoryId: uuid(9), version: 1, reason: "OVER_BUDGET" }]);
  });

  it("packs external items into what is left, counts the rest, and marks them untrusted", () => {
    const docs = toExternalContext(
      [
        { ref: "a", kind: "KNOWLEDGE", text: "external ".repeat(30) },
        { ref: "b", kind: "KNOWLEDGE", text: "more external ".repeat(30) },
        { ref: "c", kind: "KNOWLEDGE", text: "   " },
      ],
      5,
    );
    expect(docs).toHaveLength(2);
    expect(docs.every((d) => d.trustClass === "UNTRUSTED_EXTERNAL" && d.ref.startsWith("shared-brain:"))).toBe(true);
    const fit = packExternal(docs, docs[0]!.tokens + 1);
    expect(fit.kept).toHaveLength(1);
    expect(fit.dropped).toBe(1);
    expect(fit.used).toBeLessThanOrEqual(docs[0]!.tokens + 1);
  });

  it("renders nothing at all when there is nothing to say, so a prompt without memory is unchanged", () => {
    expect(renderContext({ items: [], external: [] })).toBe("");
    const sel = pack(rankCandidates(pool, REQUEST.purpose), REQUEST.budget);
    const assembled = buildAssembled({ tenantId: uuid(100), request: REQUEST, selection: sel, external: { kept: [], dropped: 0, used: 0 }, consumer: { taskId: null, stepId: null, callId: null } });
    const text = renderContext(assembled);
    expect(text).toContain("OPERATOR MEMORY");
    expect(text).toContain("never overrides the task");
    expect(text).not.toContain("EXTERNAL CONTEXT");
    expect(assembled.budget.usedTokens).toBeLessThanOrEqual(assembled.budget.maxTokens);
  });

  it("flags conflicting memories in the text the model sees", () => {
    const text = renderContext({ items: pack(rankCandidates([cand({ memoryId: uuid(1), conflictsWith: [uuid(2)] })], "x"), REQUEST.budget).items, external: [] });
    expect(text).toContain("CONFLICTS WITH");
    expect(text).toContain("unresolved");
  });

  it("estimates tokens the same way everywhere", () => {
    expect(tokenEstimate("")).toBe(1);
    expect(tokenEstimate("abcd")).toBe(1);
    expect(tokenEstimate("abcde")).toBe(2);
    expect(terms("Write the deployment SUMMARY, write it!")).toEqual(["deployment", "summary", "write"]);
  });
});

describe("KJ-P5 configuration is fail-closed", () => {
  const ENV = { KJ_MEMORY_ENABLED: "true", KJ_ADMISSION_TENANT_ID: "11111111-1111-4111-8111-111111111111", KJ_ADMISSION_PRINCIPAL_ID: "22222222-2222-4222-8222-222222222222" };
  it("is off unless exactly true", () => {
    expect(loadMemoryConfig({})).toBeUndefined();
    expect(loadMemoryConfig({ KJ_MEMORY_ENABLED: "" })).toBeUndefined();
    expect(loadMemoryConfig({ KJ_MEMORY_ENABLED: "false" })).toBeUndefined();
    expect(() => loadMemoryConfig({ ...ENV, KJ_MEMORY_ENABLED: "yes" })).toThrow("refusing to guess");
  });
  it("refuses a partial configuration", () => {
    expect(() => loadMemoryConfig({ KJ_MEMORY_ENABLED: "true" })).toThrow("KJ_ADMISSION_TENANT_ID, KJ_ADMISSION_PRINCIPAL_ID");
    expect(() => loadMemoryConfig({ ...ENV, KJ_ADMISSION_TENANT_ID: "nope" })).toThrow("UUIDs");
    expect(() => loadMemoryConfig({ ...ENV, KJ_MEMORY_APPROVER_ID: "nope" })).toThrow("UUID");
    for (const ttl of ["5", "abc", "999999", "10"]) expect(() => loadMemoryConfig({ ...ENV, KJ_MEMORY_APPROVAL_TTL_SECONDS: ttl }), ttl).toThrow();
  });
  it("defaults sensibly and treats the approver as optional", () => {
    expect(loadMemoryConfig(ENV)).toEqual({ tenantId: ENV.KJ_ADMISSION_TENANT_ID, principalId: ENV.KJ_ADMISSION_PRINCIPAL_ID, approverId: null, approvalTtlSeconds: 86_400 });
    expect(loadMemoryConfig({ ...ENV, KJ_MEMORY_APPROVER_ID: "33333333-3333-4333-8333-333333333333", KJ_MEMORY_APPROVAL_TTL_SECONDS: "3600" })).toMatchObject({ approverId: "33333333-3333-4333-8333-333333333333", approvalTtlSeconds: 3600 });
  });
});

/** Every non-test source file, so an authority rule can be checked over the whole codebase and not only the files we remembered. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!["node_modules", "dist", ".git"].includes(name)) sources(path, out);
    } else if (path.endsWith(".ts") && !path.endsWith(".d.ts")) out.push(path);
  }
  return out;
}
const read = (path: string): string => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const SRC = ["packages", "services", "apps"].flatMap((d) => sources(d));
const SERVICE = join("services", "memory", "src", "canonical", "service.ts").replaceAll("\\", "/");
const norm = (p: string) => p.replaceAll("\\", "/");

describe("KJ-P5 authority is structural: it holds by what the code can reach, checked over the whole tree", () => {
  it("only the canonical memory service writes candidates, promotions, versions or relations", () => {
    const writers = SRC.filter((f) => /(insert\s+into|update|delete\s+from)\s+(public\.)?memory_(candidates|promotions|versions|relations)\b/i.test(read(f))).map(norm);
    expect(writers).toEqual([SERVICE]);
  });

  it("only the service and the Telegram memory port name the operator-instruction entry point", () => {
    const users = SRC.filter((f) => /submitOperatorInstruction|submitVerifiedOutcomeCandidate|settleApproval|flagConflict/.test(read(f))).map(norm).sort();
    expect(users).toEqual([SERVICE, "services/kernel/src/channel/telegram/memory-port.ts"].sort());
  });

  it("nothing in the mission path can write memory: it only holds the read-only port", () => {
    const missionFiles = SRC.filter((f) => norm(f).startsWith("services/kernel/src/mission/") || norm(f) === "services/kernel/src/executor/workflow.ts");
    for (const f of missionFiles) expect(read(f), f).not.toMatch(/submit(Operator|Model|External|VerifiedOutcome)|settleApproval|CanonicalMemory\b|memory_(candidates|promotions|versions)/);
    const port = read("services/kernel/src/mission/memory-port.ts");
    expect(port.match(/^\s+[a-zA-Z]+\(input: MissionMemoryRequest\)/gm)).toHaveLength(1);
    expect(port).toContain("assemble(input: MissionMemoryRequest)");
    const adapter = read("services/memory/src/canonical/mission-port.ts");
    expect(adapter).not.toMatch(/submit|settle|flag|retract/i);
  });

  it("the Shared Brain boundary can only read and submit candidates", () => {
    const brain = read("services/memory/src/canonical/sharedbrain.ts");
    expect(brain).toContain('Pick<CanonicalMemory, "submitExternalCandidate">');
    expect(brain).not.toMatch(/submitOperatorInstruction|submitModelCandidate|submitVerifiedOutcomeCandidate|settleApproval|flagConflict|assemble\(|listCurrent/);
    expect(brain.match(/search\(/g)?.length).toBeGreaterThanOrEqual(1);
    const iface = /export interface SharedBrainPort \{([^}]*)\}/.exec(brain)?.[1] ?? "";
    expect(iface.match(/\w+\(/g)).toEqual(["search("]);
  });

  it("no code sets an origin from a candidate: the origin comes only from the four entry points", () => {
    const svc = read(SERVICE);
    for (const o of MEMORY_ORIGINS) expect(svc.match(new RegExp(`this\\.submit\\("${o}"`, "g")), o).toHaveLength(1);
    // The submission contract has no origin, trust or state field for a source to set.
    const contract = read("packages/contracts/src/canonical-memory.ts");
    const submission = /export const CandidateSubmission = z([\s\S]*?)export type CandidateSubmission/.exec(contract)?.[1] ?? "";
    expect(submission).not.toMatch(/origin|trust|state|status|policy|promot/i);
  });

  it("the Telegram memory port exposes no promote, approve or assemble", () => {
    const port = read("services/kernel/src/channel/telegram/memory-port.ts");
    const iface = /export interface MemoryPort \{([\s\S]*?)\n\}/.exec(port)?.[1] ?? "";
    expect((iface.match(/^\s+(\w+)\(/gm) ?? []).map((m) => m.trim()).sort()).toEqual(["forget(", "list(", "remember(", "show("]);
    expect(port).not.toMatch(/settleApproval|assemble\(|approve/);
  });

  it("the migration grants nothing to public roles and turns row level security on for every table", () => {
    const sql = read("supabase/migrations/20260921180000_canonical_memory.sql");
    expect(sql).not.toMatch(/^\s*grant\s/im);
    for (const t of ["memory_candidates", "memory_promotions", "memory_versions", "memory_relations", "memory_context_assemblies"]) expect(sql).toContain(`'${t}'`);
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("revoke all on public.%I from public, anon, authenticated");
    expect(sql).toContain("security_invoker = true");
    expect(sql).toMatch(/promoted by|cannot be promoted to canonical memory/);
  });
});
