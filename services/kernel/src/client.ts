import { z } from "zod";
import { Id, Task } from "../../../packages/contracts/src/index.js";
import { SubmitTask, Signal } from "./deterministic.js";
const DecisionResponse = z.strictObject({
  decision: Signal,
  semantics: z.literal("first-decision-wins"),
});
// Private service API. Identity must be established by a trusted caller; this is not a public gateway.
export class TaskClient {
  constructor(private readonly ingress: string) {}
  private async call(
    id: string,
    handler: string,
    input: unknown,
  ): Promise<unknown> {
    Id.parse(id);
    const response = await fetch(
      `${this.ingress}/TaskWorkflow/${id}/${handler}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    if (!response.ok)
      throw new Error(`Task API returned HTTP ${response.status}`);
    return response.json() as Promise<unknown>;
  }
  async submit(input: Task): Promise<unknown> {
    const task = SubmitTask.parse(input);
    return this.call(task.id, "run/send", task);
  }
  async status(id: string): Promise<Task | null> {
    return Task.nullable().parse(await this.call(id, "status", {}));
  }
  async signal(id: string): Promise<z.infer<typeof DecisionResponse>> {
    return DecisionResponse.parse(
      await this.call(id, "signal", { action: "RESUME" }),
    );
  }
  async cancel(id: string): Promise<z.infer<typeof DecisionResponse>> {
    return DecisionResponse.parse(await this.call(id, "cancel", {}));
  }
}
