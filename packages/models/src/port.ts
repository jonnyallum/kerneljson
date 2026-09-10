import { ModelCallResult, ModelRequest } from "../../contracts/src/index.js";
import { modelDigest } from "./digest.js";

/** No permissions, tools, task lifecycle or provider configuration in this port. */
export interface ModelPort {
  generate(
    request: ModelRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ModelCallResult>;
}

/** Validates provenance, not the truth or authority of generated text. */
export function validateModelResult(
  rawRequest: ModelRequest,
  raw: unknown,
): ModelCallResult {
  const request = ModelRequest.parse(rawRequest);
  const result = ModelCallResult.parse(raw);
  const receipt = result.receipt;
  if (
    receipt.callId !== request.callId ||
    receipt.taskId !== request.taskId ||
    receipt.stepId !== request.stepId ||
    JSON.stringify(receipt.trace) !== JSON.stringify(request.trace) ||
    receipt.requestDigest !==
      modelDigest({
        provider: receipt.provider,
        model: receipt.model,
        request,
      }) ||
    (result.status === "SUCCEEDED" &&
      result.receipt.outputDigest !== modelDigest(result.text))
  )
    throw new Error("Model receipt does not match its request/result");
  return result;
}
