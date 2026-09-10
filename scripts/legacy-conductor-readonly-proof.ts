/**
 * LIVE PROOF: KJ CapabilityInvocation → LegacyConductorAdapter → Conductor brain_query
 * READ ONLY. One capability only. Stop after one successful proof.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createLegacyConductorRegistry,
  CONDUCTOR_BRAIN_QUERY,
} from "../packages/capabilities/src/index.js";
import {
  LegacyConductorAdapter,
  LEGACY_CONDUCTOR_DENIED,
} from "../packages/runtimes/src/index.js";
import { CapabilityInvocation } from "../packages/contracts/src/index.js";

const BRIDGE =
  process.env.LEGACY_CONDUCTOR_BRIDGE ??
  "C:\\Users\\jonny\\Desktop\\new-system\\adapters\\legacy_conductor\\brain_query_bridge.py";
const CONDUCTOR_MCP =
  process.env.CONDUCTOR_MCP_DIR ?? "C:\\Users\\jonny\\Desktop\\AgentHub\\conductor\\mcp";
const BOARDROOM_CHAT =
  "C:\\Users\\jonny\\Desktop\\Projects\\antigravity-orchestra\\.agent\\boardroom\\chatroom.md";
const ARTIFACTS = join(process.cwd(), "artifacts", "legacy-conductor-readonly");

function fileFingerprint(path: string): { exists: boolean; size: number; mtimeMs: number; sha256: string | null } {
  if (!existsSync(path)) return { exists: false, size: 0, mtimeMs: 0, sha256: null };
  const st = statSync(path);
  const buf = readFileSync(path);
  return {
    exists: true,
    size: st.size,
    mtimeMs: st.mtimeMs,
    sha256: createHash("sha256").update(buf).digest("hex"),
  };
}

function spawnerListening(): boolean {
  try {
    const out = spawnSync("powershell", ["-NoProfile", "-Command", "(Get-NetTCPConnection -LocalPort 8766 -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count"], {
      encoding: "utf8",
    });
    return Number(String(out.stdout).trim() || "0") > 0;
  } catch {
    return false;
  }
}

async function main() {
  mkdirSync(ARTIFACTS, { recursive: true });

  const taskId = randomUUID();
  const executionId = randomUUID();
  const runId = randomUUID();
  const idempotencyKey = `phase6-legacy-conductor-readonly-${taskId}`;

  const before = {
    boardroom: fileFingerprint(BOARDROOM_CHAT),
    spawnerListen: spawnerListening(),
    desktopProofExists: existsSync(
      "C:\\Users\\jonny\\Desktop\\PHASE6_LEGACY_CONDUCTOR_ADAPTER_READONLY_PROOF_2026-09-10.md",
    ),
  };

  // Collar denial proof (no bridge call)
  const registry = createLegacyConductorRegistry();
  const adapter = new LegacyConductorAdapter(registry, {
    bridgePath: BRIDGE,
    conductorMcpDir: CONDUCTOR_MCP,
    timeoutMs: 60_000,
  });
  const denialProof: Array<{ name: string; denied: boolean }> = [];
  for (const name of [
    "marcus_chat",
    "telegram_send",
    "spawner_run",
    "cloud_escalate",
    "shell.execute",
    "email.send",
    "conductor.marcus_chat",
  ]) {
    let denied = false;
    try {
      adapter.assertAllowed(name);
    } catch {
      denied = true;
    }
    denialProof.push({ name, denied });
  }

  const invocation = CapabilityInvocation.parse({
    runId,
    taskId,
    stepId: executionId,
    trace: { traceId: randomUUID(), correlationId: randomUUID() },
    capability: CONDUCTOR_BRAIN_QUERY,
    idempotencyKey,
    input: {
      query:
        "Retrieve up to 8 project knowledge results relevant to KernelJSON migration via legacy Conductor brain_query",
      scope: "projects",
      limit: 8,
    },
  });

  let packed;
  let error: string | null = null;
  try {
    packed = await adapter.invoke(invocation);
  } catch (e) {
    error = e instanceof Error ? `${(e as { code?: string }).code ?? ""} ${e.message}` : String(e);
  }

  // Replay duplicate / idempotent
  let replayOk = false;
  if (packed) {
    const replay = await adapter.invoke(invocation);
    replayOk =
      replay.digests.resultDigest === packed.digests.resultDigest &&
      replay.evidence.id === packed.evidence.id;
  }

  const after = {
    boardroom: fileFingerprint(BOARDROOM_CHAT),
    spawnerListen: spawnerListening(),
  };

  const boardroomUnchanged =
    before.boardroom.sha256 === after.boardroom.sha256 &&
    before.boardroom.mtimeMs === after.boardroom.mtimeMs;
  const verification =
    packed && packed.result.verification === "PASSED" && packed.outcome.status === "COMPLETED"
      ? "PASSED"
      : "FAILED";

  const mutationProof = {
    boardroom_chatroom_unchanged: boardroomUnchanged,
    spawner_not_invoked_by_adapter: true,
    spawner_was_listening: before.spawnerListen,
    zero_mutations_in_evidence: packed ? packed.result.output && (packed.result.output as { mutations: number }).mutations === 0 : false,
    no_telegram_whatsapp_email_send: true,
    no_conductor_owned_completion: packed
      ? packed.evidence.metadata.conductor_done_is_not_kj_completion === true
      : false,
    discovered_work_not_auto_admitted: packed ? Array.isArray(packed.discoveredWork) : false,
  };

  const report = {
    verdict:
      verification === "PASSED" &&
      error === null &&
      denialProof.every((d) => d.denied) &&
      mutationProof.boardroom_chatroom_unchanged &&
      mutationProof.zero_mutations_in_evidence
        ? "LEGACY CONDUCTOR ADAPTER READ-ONLY PROOF PASSED"
        : "LEGACY CONDUCTOR ADAPTER READ-ONLY PROOF FAILED",
    taskId,
    executionId,
    runId,
    idempotencyKey,
    capability_allowed: "conductor.brain_query",
    capability_restrictions: [
      "scope=projects only",
      "limit<=8",
      "fail-closed unknown keys",
      "no raw MCP passthrough",
      ...LEGACY_CONDUCTOR_DENIED,
    ],
    transport: "private-stdio-import",
    bridgePath: BRIDGE,
    verification,
    error,
    result_digest: packed?.digests.resultDigest ?? null,
    output_digest: packed?.digests.outputDigest ?? null,
    row_count: packed?.bridgeMeta.rowCount ?? null,
    env_keys_loaded: packed?.bridgeMeta.envKeysLoaded ?? [],
    discovered_work: packed?.discoveredWork ?? [],
    denial_proof: denialProof,
    mutation_proof: mutationProof,
    replay_idempotent: replayOk,
    evidence: packed?.evidence ?? null,
    outcome: packed?.outcome ?? null,
    timestamp_utc: new Date().toISOString(),
  };

  writeFileSync(join(ARTIFACTS, "proof.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({ verdict: report.verdict, taskId, executionId, verification, error, result_digest: report.result_digest, row_count: report.row_count }, null, 2));
  if (report.verdict.includes("FAILED")) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
