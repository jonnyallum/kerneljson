import { TerminalError, type Context } from "@restatedev/restate-sdk";
import {
  CapabilityInvocation,
  type CapabilityResult,
} from "../../../packages/contracts/src/index.js";
import {
  CapabilityRegistry,
  CapabilityError,
} from "../../../packages/capabilities/src/index.js";

/** Receipt sink must atomically persist evidence/run/event and reject key conflicts. */
export async function callCapability(
  ctx: Pick<Context, "run">,
  registry: CapabilityRegistry,
  raw: CapabilityInvocation,
  record: (
    request: CapabilityInvocation,
    result: CapabilityResult,
  ) => Promise<void>,
): Promise<CapabilityResult> {
  const request = CapabilityInvocation.parse(raw);
  const result = await ctx.run(`capability:${request.runId}:execute`, () => {
    try {
      return registry.execute(request);
    } catch (error) {
      throw new TerminalError(
        error instanceof CapabilityError ? error.code : "CAPABILITY_FAILED",
      );
    }
  });
  await ctx.run(`capability:${request.runId}:receipt`, () =>
    record(request, result),
  );
  return result;
}
