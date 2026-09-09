import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createRuntimeRegistry, REPOSITORY_READ } from "../packages/capabilities/src/index.js";
import {
  NewSystemRuntimeAdapter,
  planRepositoryRead,
  verifyRepositoryRead,
} from "../packages/runtimes/src/index.js";
import { CapabilityInvocation } from "../packages/contracts/src/index.js";

const GCLOUD_PY =
  "C:\\Users\\jonny\\AppData\\Local\\Google\\Cloud SDK\\google-cloud-sdk\\lib\\gcloud.py";
const PYTHON =
  "C:\\Users\\jonny\\AppData\\Local\\Google\\Cloud SDK\\google-cloud-sdk\\platform\\bundledpython\\python.exe";

const EXPECTED =
  "ca0c81d91534b8dcd03e782ef1677bdae0298d2196e3192015d41486044c8061";
const EXPECTED_FROM_BYTES = createHash("sha256")
  .update(Buffer.from("KJ-000000 fixture notes\n", "utf8"))
  .digest("hex");

const REPO = "/home/jonny/new-system/.tmp-kj000000";
const taskId = randomUUID();
const idempotencyKey = `kj-000000-prod-${taskId}`;

/** IAP-SSH curl to VM :8766 — return Response with exact Spawner body (ZERO strip/rewrite). */
function vmSpawnFetch(url: string, init?: RequestInit): Promise<Response> {
  const u = new URL(url);
  if (!u.pathname.endsWith("/api/v1/spawn")) {
    return Promise.reject(new Error(`unexpected url ${url}`));
  }
  const body = String(init?.body ?? "");
  const b64 = Buffer.from(body, "utf8").toString("base64");
  const remote =
    `echo ${b64} | base64 -d > /tmp/kj-000000-spawn.json && ` +
    `curl -sS -X POST http://127.0.0.1:8766/api/v1/spawn ` +
    `-H 'Content-Type: application/json' -H 'Accept: application/json' ` +
    `--data-binary @/tmp/kj-000000-spawn.json`;
  const out = execFileSync(
    PYTHON,
    [
      GCLOUD_PY,
      "compute",
      "ssh",
      "instance-20260717-082134",
      "--zone=us-central1-b",
      "--tunnel-through-iap",
      `--command=${remote}`,
    ],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 180_000 },
  );
  // ZERO response surgery: pass Spawner body through unchanged.
  return Promise.resolve(
    new Response(out, { status: 200, headers: { "content-type": "application/json" } }),
  );
}

async function main() {
  if (EXPECTED !== EXPECTED_FROM_BYTES) {
    throw new Error(`fixture sha mismatch: ${EXPECTED_FROM_BYTES}`);
  }

  const runtime = createRuntimeRegistry();
  const adapter = new NewSystemRuntimeAdapter(runtime, {
    spawnerBaseUrl: "http://127.0.0.1:8766",
    caller: "kerneljson",
    tenantId: "estate",
    fetch: vmSpawnFetch as unknown as typeof fetch,
  });

  const invocation = CapabilityInvocation.parse({
    runId: randomUUID(),
    taskId,
    stepId: randomUUID(),
    trace: { traceId: randomUUID(), correlationId: randomUUID() },
    capability: REPOSITORY_READ,
    idempotencyKey,
    input: { repo_path: REPO, target_file: "NOTES.md", timeout_seconds: 45 },
  });

  const plan = planRepositoryRead(taskId);

  // First invoke (raw, zero surgery)
  const packed = await adapter.invoke(invocation);
  const verification = verifyRepositoryRead({
    taskId: packed.taskId,
    result: packed.result,
    evidence: packed.evidence,
    outcome: packed.outcome,
  });

  const output = packed.result.output as Record<string, unknown>;
  const timeoutSeconds = output.timeout_seconds;
  const surgeryNeeded = false;

  // Replay same idempotencyKey
  const packedReplay = await adapter.invoke(invocation);
  const replaySha = packedReplay.digests.contentSha256;
  const replayTimeout = (packedReplay.result.output as Record<string, unknown>).timeout_seconds;

  const rawStatus: "PASSED" | "FAILED" =
    verification.status === "PASSED" &&
    packed.digests.contentSha256 === EXPECTED &&
    timeoutSeconds === 45 &&
    replaySha === EXPECTED &&
    replayTimeout === 45 &&
    !surgeryNeeded
      ? "PASSED"
      : "FAILED";

  const report = {
    mission: "KJ-000000",
    phase: "3.3-track-a-timeout-seconds-contract",
    adapterAgainstLiveSpawnerZeroSurgery: {
      status: rawStatus,
      surgeryNeeded,
      timeout_seconds: timeoutSeconds,
      expectedTimeoutSeconds: 45,
    },
    replay: {
      idempotencyKey,
      contentSha256: replaySha,
      timeout_seconds: replayTimeout,
      shaMatch: replaySha === EXPECTED,
    },
    host: "instance-20260717-082134",
    spawnerHead: "c3472f26f7c5987fd3e5a6bf7001a1b7524e21a0",
    transport: "NewSystemRuntimeAdapter -> gcloud IAP SSH curl -> 127.0.0.1:8766",
    puttyNote: "gcloud ssh --ssh-flag=-L… fails on Windows PuTTY (unknown option -L9876:…)",
    taskId,
    idempotencyKey,
    digests: packed.digests,
    expectedSha256: EXPECTED,
    shaMatch: packed.digests.contentSha256 === EXPECTED,
    outcome: packed.outcome.status,
    verification,
    planRecipe: plan.recipe,
    repositoryReadUuid: REPOSITORY_READ.id,
    recordedAt: new Date().toISOString(),
  };

  mkdirSync("artifacts/local", { recursive: true });
  const artifactPath = "artifacts/local/kj-000000-production-raw-proof.json";
  writeFileSync(artifactPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));

  if (rawStatus !== "PASSED") {
    console.error(
      "FAIL: raw proof requires zero surgery, timeout_seconds===45, SHA match, and verifier PASSED",
    );
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});