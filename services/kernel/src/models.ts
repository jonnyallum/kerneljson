import { TerminalError, type Context } from "@restatedev/restate-sdk";
import {
  ModelRequest,
  ModelCallResult,
  type ModelCallReceipt,
} from "../../../packages/contracts/src/index.js";
import {
  validateModelResult,
  type ModelPort,
} from "../../../packages/models/src/index.js";

/** Record must be idempotent by callId and reject conflicting receipt content.
 * Provider I/O occurs only within ctx.run. A journaled failure remains a failure;
 * callers must explicitly authorize a new attempt with a new callId.
 */
export async function callModel(
  ctx: Pick<Context, "run">,
  port: ModelPort,
  raw: ModelRequest,
  record: (receipt: ModelCallReceipt) => Promise<void>,
): Promise<ModelCallResult> {
  const request = ModelRequest.parse(raw);
  const result = ModelCallResult.parse(
    await ctx.run(`model:${request.callId}:generate`, async () => {
      let result: ModelCallResult;
      try {
        result = validateModelResult(request, await port.generate(request));
      } catch {
        throw new TerminalError("ModelPort failed its result contract");
      }
      return result;
    }),
  );
  await ctx.run(`model:${request.callId}:receipt`, () =>
    record(result.receipt),
  );
  return result;
}
