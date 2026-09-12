import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSealedRepositoryReader,
  SealedReadError,
  verifyClaudeMdCheck,
} from "../packages/runtimes/src/index.js";
import {
  createRuntimeRegistry,
  REPOSITORY_READ,
} from "../packages/capabilities/src/index.js";
import {
  CapabilityInvocation,
  Evidence,
  Outcome,
  Task,
  TaskStep,
} from "../packages/contracts/src/index.js";
import { compileIntent, criteria } from "../services/kernel/src/compiler/index.js";
import { planTask, projectStep } from "../services/kernel/src/planner/index.js";
import { verifyPlanCompletion } from "../services/kernel/src/executor/index.js";
import { kernelSubmission } from "../evals/fixtures/kernel.js";

const RECIPE = "claude_md_check/v1";
// LF body pinned so its sha256 is the "approved" digest for these tests.
const CLAUDE_MD = "# CLAUDE.md\nGovernance anchor.\n";
const APPROVED = createHash("sha256").update(Buffer.from(CLAUDE_MD, "utf8")).digest("hex");
const OTHER = createHash("sha256").update(Buffer.from(CLAUDE_MD + "drift\n", "utf8")).digest("hex");

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "kj-sealed-"));
  writeFileSync(join(root, "CLAUDE.md"), CLAUDE_MD, "utf8");
  writeFileSync(join(root, "NOTES.md"), "not the anchor\n", "utf8");
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("sealed repository reader — confinement and hashing", () => {
  it("reads CLAUDE.md and reports the LF content_sha256 with mutations_detected=0", () => {
    const out = createSealedRepositoryReader({ repositoryRoot: root })({
      target_file: "CLAUDE.md",
    });
    expect(out.content_sha256).toBe(APPROVED);
    expect(out.mutations_detected).toBe(0);
    expect(out.target_path).toBe("CLAUDE.md");
    expect(out.capability).toBe("repository.read");
    // The receipt never contains the file contents.
    expect(JSON.stringify(out)).not.toContain("Governance anchor");
  });

  it("normalises CRLF to LF so the hash is line-ending independent", () => {
    const crlf = mkdtempSync(join(tmpdir(), "kj-crlf-"));
    writeFileSync(join(crlf, "CLAUDE.md"), CLAUDE_MD.replaceAll("\n", "\r\n"), "utf8");
    try {
      const out = createSealedRepositoryReader({ repositoryRoot: crlf })({
        target_file: "CLAUDE.md",
      });
      expect(out.content_sha256).toBe(APPROVED);
    } finally {
      rmSync(crlf, { recursive: true, force: true });
    }
  });

  const cases: Array<[string, () => string, string]> = [
    ["absolute path", () => join(root, "CLAUDE.md"), "ABSOLUTE_PATH_REJECTED"],
    ["`..` traversal", () => "../secret.txt", "TRAVERSAL_REJECTED"],
    ["nested `..` traversal", () => "sub/../../secret.txt", "TRAVERSAL_REJECTED"],
    ["missing file", () => "MISSING.md", "READ_FAILED"],
  ];
  for (const [label, target, code] of cases) {
    it(`fails closed on ${label} (${code})`, () => {
      const read = createSealedRepositoryReader({ repositoryRoot: root });
      let thrown: unknown;
      try {
        read({ target_file: target() });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(SealedReadError);
      expect((thrown as SealedReadError).code).toBe(code);
    });
  }

  it("fails closed on an oversized file (FILE_TOO_LARGE)", () => {
    const read = createSealedRepositoryReader({ repositoryRoot: root, maxBytes: 4 });
    expect(() => read({ target_file: "CLAUDE.md" })).toThrow(SealedReadError);
  });

  it("fails closed on a symlink escaping the root (SYMLINK_ESCAPE_REJECTED)", () => {
    const outside = mkdtempSync(join(tmpdir(), "kj-outside-"));
    writeFileSync(join(outside, "target.md"), "outside\n", "utf8");
    const linked = mkdtempSync(join(tmpdir(), "kj-linkroot-"));
    let supported = true;
    try {
      symlinkSync(join(outside, "target.md"), join(linked, "CLAUDE.md"));
    } catch {
      supported = false; // symlink creation not permitted (e.g. non-admin Windows)
    }
    try {
      if (!supported) return;
      const read = createSealedRepositoryReader({ repositoryRoot: linked });
      let thrown: unknown;
      try {
        read({ target_file: "CLAUDE.md" });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(SealedReadError);
      expect((thrown as SealedReadError).code).toBe("SYMLINK_ESCAPE_REJECTED");
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(linked, { recursive: true, force: true });
    }
  });
});

describe("verifier over real sealed output", () => {
  function pack(targetFile: string, approved: string) {
    const registry = createRuntimeRegistry(
      createSealedRepositoryReader({ repositoryRoot: root }),
    );
    const invocation = CapabilityInvocation.parse({
      runId: randomUUID(),
      taskId: "60000000-0000-4000-8000-0000000000b1",
      stepId: "60000000-0000-4000-8000-0000000000b2",
      trace: {
        traceId: "60000000-0000-4000-8000-0000000000b3",
        correlationId: "60000000-0000-4000-8000-0000000000b1",
      },
      capability: REPOSITORY_READ,
      idempotencyKey: "unit-1",
      input: { target_file: targetFile },
    });
    const result = registry.execute(invocation);
    const output = result.output as Record<string, unknown>;
    const evidenceId = "60000000-0000-4000-8000-0000000000b4";
    const evidence = Evidence.parse({
      id: evidenceId,
      taskId: invocation.taskId,
      stepId: invocation.stepId,
      type: "TOOL_RECEIPT",
      source: "kerneljson:repository-read-local/v1",
      digest: String(output["content_sha256"]),
      capturedAt: "2026-09-12T09:00:00.000+00:00",
      metadata: {
        target_path: output["target_path"] ?? null,
        content_sha256: output["content_sha256"] ?? null,
        mutations_detected: output["mutations_detected"] ?? null,
      },
    });
    const outcome = Outcome.parse({
      taskId: invocation.taskId,
      status: "COMPLETED",
      acceptanceResults: [
        { criterion: criteria[RECIPE], passed: true, evidenceRefs: [evidenceId] },
      ],
      evidenceRefs: [evidenceId],
      summary: "ok",
      completedAt: "2026-09-12T09:00:00.000+00:00",
    });
    return verifyClaudeMdCheck({
      taskId: invocation.taskId,
      result,
      evidence,
      outcome,
      approvedContentSha256: approved,
    });
  }

  it("PASSES when the sealed read matches the approved digest", () => {
    const v = pack("CLAUDE.md", APPROVED);
    expect(v.status).toBe("PASSED");
    expect(v.failures).toEqual([]);
  });

  it("FAILS CLAUDE_MD_DRIFT when the approved digest differs", () => {
    const v = pack("CLAUDE.md", OTHER);
    expect(v.status).toBe("FAILED");
    expect(v.failures).toContain("CLAUDE_MD_DRIFT");
  });

  it("FAILS TARGET_NOT_CLAUDE_MD when a different file is read", () => {
    const v = pack("NOTES.md", APPROVED);
    expect(v.status).toBe("FAILED");
    expect(v.failures).toContain("TARGET_NOT_CLAUDE_MD");
  });
});

describe("ledger completion backstop (verifyPlanCompletion capability branch)", () => {
  function fixture(overrides: {
    contentSha256?: string;
    mutations?: number;
    targetPath?: string;
    omitReceipt?: boolean;
  } = {}) {
    const { task: received } = compileIntent({ ...kernelSubmission, recipe: RECIPE });
    // verifyPlanCompletion runs at the completion commit, where the prior task state is
    // VERIFYING (the workflow emits VERIFYING before COMPLETED).
    const task = Task.parse({ ...received, status: "VERIFYING", startedAt: received.createdAt });
    const plan = planTask(task, RECIPE);
    const node = plan.steps[0]!;
    const step = TaskStep.parse({
      ...projectStep(node),
      status: "COMPLETED",
      input: node.input,
      output: { capability: "repository.read" },
    });
    const evidenceId = "60000000-0000-4000-8000-0000000000c1";
    const contentSha256 = overrides.contentSha256 ?? APPROVED;
    const evidence = Evidence.parse({
      id: evidenceId,
      taskId: task.id,
      stepId: node.id,
      type: "TOOL_RECEIPT",
      source: "kerneljson:repository-read-local/v1",
      digest: contentSha256,
      capturedAt: "2026-09-12T09:00:00.000+00:00",
      metadata: {
        target_path: overrides.targetPath ?? "CLAUDE.md",
        content_sha256: contentSha256,
        mutations_detected: overrides.mutations ?? 0,
      },
    });
    const outcome = Outcome.parse({
      taskId: task.id,
      status: "COMPLETED",
      acceptanceResults: [
        { criterion: task.acceptanceCriteria[0]!, passed: true, evidenceRefs: [evidenceId] },
      ],
      evidenceRefs: [evidenceId],
      summary: "ok",
      completedAt: "2026-09-12T09:00:00.000+00:00",
    });
    const records = overrides.omitReceipt ? [] : [{ record: evidence, step }];
    return { task, outcome, plan, step, records };
  }

  const canary = { recipe: RECIPE, approvedContentSha256: APPROVED };

  it("accepts a valid receipt matching the approved digest", () => {
    const f = fixture();
    expect(() =>
      verifyPlanCompletion(f.task, f.outcome, f.plan, [f.step], f.records, canary),
    ).not.toThrow();
  });

  it("rejects a drifted receipt", () => {
    const f = fixture({ contentSha256: OTHER });
    expect(() =>
      verifyPlanCompletion(f.task, f.outcome, f.plan, [f.step], f.records, canary),
    ).toThrow(/CLAUDE_MD_DRIFT/);
  });

  it("rejects a mutation-detected receipt", () => {
    const f = fixture({ mutations: 1 });
    expect(() =>
      verifyPlanCompletion(f.task, f.outcome, f.plan, [f.step], f.records, canary),
    ).toThrow(/MUTATIONS_DETECTED/);
  });

  it("rejects a wrong-target receipt", () => {
    const f = fixture({ targetPath: "NOTES.md" });
    expect(() =>
      verifyPlanCompletion(f.task, f.outcome, f.plan, [f.step], f.records, canary),
    ).toThrow(/TARGET_NOT_CLAUDE_MD/);
  });

  it("rejects a missing receipt", () => {
    const f = fixture({ omitReceipt: true });
    expect(() =>
      verifyPlanCompletion(f.task, f.outcome, f.plan, [f.step], f.records, canary),
    ).toThrow(/Missing capability receipt/);
  });

  it("fails closed when no approved digest is configured (APPROVED_DIGEST_SHAPE)", () => {
    const f = fixture();
    expect(() =>
      verifyPlanCompletion(f.task, f.outcome, f.plan, [f.step], f.records),
    ).toThrow(/APPROVED_DIGEST_SHAPE/);
  });
});
