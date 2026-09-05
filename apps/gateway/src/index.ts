import {
  ApprovalAnswer,
  Id,
  type TenantContext,
} from "../../../packages/contracts/src/index.js";
import type { ControlPort } from "../../mission-control/src/server.js";
/** Credentials must represent the authenticated human context, resolved by trusted deployment code. */
export function createRestateControls(
  ingress: string,
  credentialsFor: (context: TenantContext) => Promise<Record<string, string>>,
): ControlPort {
  const base = new URL(ingress);
  if (!["http:", "https:"].includes(base.protocol))
    throw new Error("Invalid Restate URL");
  const send = async (
    context: TenantContext,
    taskId: string,
    handler: string,
    body: unknown,
  ) => {
    Id.parse(taskId);
    const response = await fetch(
      new URL(`/GoldenTaskWorkflowV1/${taskId}/${handler}`, base),
      {
        method: "POST",
        headers: {
          ...(await credentialsFor(context)),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) throw new Error("Workflow rejected control request");
  };
  return {
    approve: (ctx, id, answer) =>
      send(ctx, id, "approve", ApprovalAnswer.parse(answer)),
    cancel: (ctx, id) => send(ctx, id, "cancel", {}),
  };
}
