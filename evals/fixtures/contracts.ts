import * as c from "../../packages/contracts/src/index.js";
import { CRITERION } from "../../services/kernel/src/deterministic.js";
export const id = "10000000-0000-4000-8000-000000000001";
export const otherId = "10000000-0000-4000-8000-000000000002";
export const at = "2026-09-05T12:00:00.000Z";
export const principal = { id, kind: "HUMAN" as const };
export const task = c.Task.parse({
  id,
  principal,
  tenant: { id },
  objective: "kerneljson",
  acceptanceCriteria: [CRITERION],
  constraints: [],
  riskClass: "LOW",
  status: "RECEIVED",
  traceId: id,
  createdAt: at,
});
export const evidence = c.Evidence.parse({
  id,
  taskId: id,
  stepId: otherId,
  type: "DETERMINISTIC_RESULT",
  source: "test",
  digest: "a".repeat(64),
  capturedAt: at,
  metadata: { output: 42 },
});
export const outcome = c.Outcome.parse({
  taskId: id,
  status: "COMPLETED",
  acceptanceResults: [
    { criterion: CRITERION, passed: true, evidenceRefs: [id] },
  ],
  evidenceRefs: [id],
  summary: "Verified",
  completedAt: at,
});
export const validFixtures = [
  { name: "PrincipalRef", schema: c.PrincipalRef, value: principal },
  { name: "TenantRef", schema: c.TenantRef, value: { id } },
  {
    name: "TraceRef",
    schema: c.TraceRef,
    value: { traceId: id, correlationId: id },
  },
  {
    name: "IntentEnvelope",
    schema: c.IntentEnvelope,
    value: {
      id,
      principal,
      tenant: { id },
      source: "local-test",
      objective: "test",
      attachments: [],
      contextRefs: [],
      receivedAt: at,
      trace: { traceId: id, correlationId: id },
    },
  },
  { name: "Task", schema: c.Task, value: task },
  {
    name: "TaskStep",
    schema: c.TaskStep,
    value: {
      id,
      taskId: id,
      kind: "DETERMINISTIC_FUNCTION",
      status: "READY",
      dependencies: [],
      requiredCapabilities: [],
      riskClass: "LOW",
      retryPolicy: { maxAttempts: 1, backoffMs: 0 },
      input: { text: "test" },
    },
  },
  {
    name: "TaskEvent",
    schema: c.TaskEvent,
    value: {
      id,
      taskId: id,
      type: "TASK_CREATED",
      occurredAt: at,
      actor: principal,
      traceId: id,
      payload: { nested: { value: 1 } },
    },
  },
  { name: "Evidence", schema: c.Evidence, value: evidence },
  {
    name: "Capability",
    schema: c.Capability,
    value: {
      id,
      version: "1",
      description: "deterministic",
      inputSchemaRef: "input/v1",
      outputSchemaRef: "output/v1",
      riskClass: "LOW",
      permissions: [],
      implementationType: "DETERMINISTIC",
      verificationRequirements: ["digest"],
    },
  },
  {
    name: "PolicyDecision",
    schema: c.PolicyDecision,
    value: {
      id,
      taskId: id,
      capability: { id, version: "1" },
      decision: "DENY",
      reasonCode: "NO_GRANT",
      evaluatedAt: at,
      policyVersion: "1",
    },
  },
  {
    name: "Approval",
    schema: c.Approval,
    value: {
      id,
      taskId: id,
      requestedFrom: principal,
      requestedAt: at,
      status: "PENDING",
    },
  },
  { name: "Outcome", schema: c.Outcome, value: outcome },
];
