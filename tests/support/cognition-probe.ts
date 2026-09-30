// Disposable Restate worker only. No provider/network credentials or production entrypoint imports.
import * as restate from "@restatedev/restate-sdk";
import { appendFileSync, existsSync, unlinkSync } from "node:fs";
import type { Ledger } from "../../services/kernel/src/ledger.js";
import type { CapabilityService } from "../../services/kernel/src/capability-service.js";
import type { KernelWorkflowOptions } from "../../services/kernel/src/executor/workflow.js";
import { PgFacultyRegistry } from "../../services/kernel/src/faculty/registry.js";
import { PgIdentityCognition } from "../../services/kernel/src/identity/cognition-binding.js";
import { assemblyDigestOf } from "../../services/kernel/src/mission/cognition-digests.js";
import type { ModelPort } from "../../packages/models/src/index.js";
import { fakeClaude, fakeGrok, githubResult } from "./mission-fixture.js";

export function createCognitionProbe(ledger: Ledger) {
  const service = restate.service({ name: "CognitionGithubFixtureV1", handlers: {
    githubRead: async (_ctx: restate.Context, _request: { repo: string }) => githubResult(),
  } });
  const identity = new PgIdentityCognition(ledger.pool, () => existsSync("/tmp/kerneljson-cognition-enabled"));
  const observe = (role: string, port: ModelPort): ModelPort => ({ generate: async (request) => {
    // Digests only, even in this disposable harness.
    appendFileSync("/tmp/kerneljson-cognition-calls.jsonl", JSON.stringify({
      taskId: request.taskId, role, assemblyDigest: assemblyDigestOf(request),
    }) + "\n");
    return port.generate(request);
  } });
  const options: KernelWorkflowOptions = {
    // The mission uses only githubRead; the production workflow still makes a real Restate service call.
    capabilityService: service as unknown as CapabilityService,
    mission: {
      analyst: observe("analyst", fakeClaude()), reviewer: observe("reviewer", fakeGrok()),
      notify: async () => {},
      faculties: new PgFacultyRegistry(ledger.pool, {
        analyst: { provider: "openrouter", model: "anthropic/claude-test" },
        reviewer: { provider: "openrouter", model: "x-ai/grok-test" },
      }),
      identity: {
        latch: async (input) => {
          const state = await identity.latch(input);
          if (existsSync("/tmp/kerneljson-cognition-latch-crash")) {
            unlinkSync("/tmp/kerneljson-cognition-latch-crash");
            if (existsSync("/tmp/kerneljson-cognition-enabled")) unlinkSync("/tmp/kerneljson-cognition-enabled");
            process.exit(137); // DB COMMIT succeeded, ctx.run has not acknowledged it.
          }
          return state;
        },
        authorize: (...args) => identity.authorize(...args),
      },
    },
  };
  return { service, options };
}
