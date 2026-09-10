// Explicit, single-call provider connectivity check. Not a task execution recipe.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { ModelRequest } from "../../../packages/contracts/src/index.js";
import {
  createDeepSeekPort,
  validateModelResult,
} from "../../../packages/models/src/index.js";

async function main(): Promise<void> {
  const apiKey = process.env["DEEPSEEK_API_KEY"];
  const model = process.env["DEEPSEEK_MODEL"];
  if (process.env["JVAULT_PROJECT"] !== "kerneljson" || !apiKey || !model) {
    console.error(
      "Inject DEEPSEEK_API_KEY from jVault kerneljson; set JVAULT_PROJECT=kerneljson and DEEPSEEK_MODEL before running this check.",
    );
    process.exitCode = 2;
    return;
  }
  const request = ModelRequest.parse({
    callId: randomUUID(),
    taskId: randomUUID(),
    stepId: randomUUID(),
    trace: { traceId: randomUUID(), correlationId: randomUUID() },
    messages: [
      {
        role: "user",
        content: "Reply with exactly KERNELJSON_OK and no other text.",
      },
    ],
    maxOutputTokens: 16,
  });
  const result = validateModelResult(
    request,
    await createDeepSeekPort({ apiKey, model }).generate(request),
  );
  const matched =
    result.status === "SUCCEEDED" && result.text.trim() === "KERNELJSON_OK";
  await mkdir("artifacts/local", { recursive: true });
  const file = "artifacts/local/phase5-live-smoke.json";
  await writeFile(
    file,
    JSON.stringify(
      { receipt: result.receipt, expectedResponseMatched: matched },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({
      status: result.status,
      expectedResponseMatched: matched,
      receiptFile: file,
    }),
  );
  if (!matched) process.exitCode = 1;
}
main().catch(() => {
  // Do not print transport/configuration exception objects containing secrets.
  console.error(
    "Model smoke check failed before a validated receipt could be saved.",
  );
  process.exitCode = 1;
});
