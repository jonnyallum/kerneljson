import { Task, Id } from "../../../../packages/contracts/src/index.js";
import { compileIntent } from "./index.js";
export class KernelClient {
  constructor(private readonly ingress: string) {}
  private async call(
    id: string,
    handler: string,
    input: unknown,
  ): Promise<unknown> {
    Id.parse(id);
    const response = await fetch(
      `${this.ingress}/KernelWorkflowV1/${id}/${handler}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    if (!response.ok)
      throw new Error(`Kernel API returned HTTP ${response.status}`);
    return response.json() as Promise<unknown>;
  }
  async submit(raw: unknown): Promise<{ taskId: string }> {
    const { task, submission } = compileIntent(raw);
    await this.call(task.id, "run/send", submission);
    return { taskId: task.id };
  }
  async status(id: string): Promise<Task | null> {
    return Task.nullable().parse(await this.call(id, "status", {}));
  }
  async signal(id: string): Promise<unknown> {
    return this.call(id, "signal", { action: "RESUME" });
  }
  async cancel(id: string): Promise<unknown> {
    return this.call(id, "cancel", {});
  }
}
