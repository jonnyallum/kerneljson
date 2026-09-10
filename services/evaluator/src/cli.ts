import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { uppercaseSuite } from "../../../evals/golden/uppercase.js";
import { evaluate, promotionAllowed } from "./index.js";
import { uppercaseCandidate } from "./candidate.js";
const hash = createHash("sha256");
for (const file of [
  "packages/capabilities/src/index.ts",
  "services/evaluator/src/candidate.ts",
  "pnpm-lock.yaml",
])
  hash.update(file).update(await readFile(file));
const candidate = uppercaseCandidate(hash.digest("hex"));
const report = evaluate(uppercaseSuite, candidate, new Date().toISOString());
await mkdir("artifacts/local", { recursive: true });
await writeFile(
  "artifacts/local/golden-evaluation.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    passed: report.passed,
    cases: report.cases.length,
    candidateDigest: candidate.digest,
    report: "artifacts/local/golden-evaluation.json",
  }),
);
if (!promotionAllowed(report, uppercaseSuite, candidate.digest))
  process.exitCode = 1;
