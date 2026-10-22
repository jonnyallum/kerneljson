// code-change/v1 activation: prove a staged worker env BEFORE the worker is recreated with it. Runs in the NEW
// worker image with the staged env and this release's source tree mounted read-only at /check:
//
//   docker run --rm --env-file worker.after.env -v $BUILD:/check:ro kerneljson-worker:$SHORT \
//     node --import tsx /check/infrastructure/ops/code-change-config-check.ts
//
// It loads the configuration exactly as the worker will (a refusal here is a refusal at startup, which would stop
// the brief too), then checks the token against GitHub: it reaches every allowlisted repository and its two
// workflows, it does NOT reach a repository outside the allowlist, and the installed workflows are byte-identical
// to this release's templates. It prints names, models and HTTP codes only; the token never leaves process.env.
// Every line must be PASS and the last `CC_CONFIG OK`. With no code-change env it prints `CC_CONFIG NOT_CONFIGURED`
// and exits 1, which is the check failing on purpose.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadCodeChangeConfig } from "/app/services/kernel/src/mission/code-change-config.ts";
import { loadMissionConfig } from "/app/services/kernel/src/mission/config.ts";

const OUTSIDE = "jonnyallum/kerneljson";
const WORKFLOWS = ["kj-code-change.yml", "kj-test.yml"];
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

async function gh(token: string, path: string): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  let body: unknown = null;
  try {
    body = await r.json();
  } catch {}
  return { status: r.status, body };
}

const env = process.env;
if (!env["KJ_CODE_CHANGE_GITHUB_TOKEN"] && !env["KJ_CODE_CHANGE_REPOS"] && !env["KJ_CODE_CHANGE_CODER_MODEL"] && !env["KJ_CODE_CHANGE_REVIEWER_MODEL"]) {
  console.log("CC_CONFIG NOT_CONFIGURED");
  process.exit(1);
}
let mission: ReturnType<typeof loadMissionConfig>;
let config: ReturnType<typeof loadCodeChangeConfig>;
try {
  mission = loadMissionConfig(env);
  config = loadCodeChangeConfig(env);
} catch (error) {
  // The loaders' messages name variables, never values (tests/code-change-mission.test.ts).
  console.log(`FAIL configuration (${error instanceof Error ? error.message : "refused"})`);
  console.log("CC_CONFIG FAILED");
  process.exit(1);
}
check("mission runtimes configured", mission !== undefined, mission ? `analyst ${mission.analystModel}, reviewer ${mission.reviewerModel}` : "");
check("code-change configured", config !== undefined);
if (!config || !mission) {
  console.log("CC_CONFIG FAILED");
  process.exit(1);
}
console.log(`     repos ${config.allowedRepos.join(",")}; coder ${config.coderModel}; reviewer ${config.reviewerModel} via ${config.reviewerProvider}`);
check("capability service configured", Boolean(env["KJ_REPO_ROOT"]));

const token = config.token;
for (const repo of config.allowedRepos) {
  const meta = await gh(token, `/repos/${repo}`);
  const body = meta.body as { private?: boolean; default_branch?: string } | null;
  check(`token reaches ${repo}`, meta.status === 200, `HTTP ${meta.status}`);
  const branch = body?.default_branch ?? "main";
  for (const wf of WORKFLOWS) {
    const got = await gh(token, `/repos/${repo}/contents/.github/workflows/${wf}?ref=${encodeURIComponent(branch)}`);
    const content = (got.body as { content?: string } | null)?.content;
    const installed = content ? sha(Buffer.from(content, "base64")) : "";
    const template = sha(readFileSync(`/check/infrastructure/github/${wf}`));
    check(`${repo} ${wf} equals this release's template`, got.status === 200 && installed === template, `HTTP ${got.status}, ${installed.slice(0, 12) || "none"} vs ${template.slice(0, 12)}`);
  }
  const runs = await gh(token, `/repos/${repo}/actions/runs?per_page=1`);
  check(`token reads ${repo} Actions runs`, runs.status === 200, `HTTP ${runs.status}`);
}
const outside = await gh(token, `/repos/${OUTSIDE}`);
check(`token does NOT reach ${OUTSIDE}`, outside.status === 404, `HTTP ${outside.status}`);

console.log(failed === 0 ? "CC_CONFIG OK" : "CC_CONFIG FAILED");
process.exit(failed === 0 ? 0 : 1);
