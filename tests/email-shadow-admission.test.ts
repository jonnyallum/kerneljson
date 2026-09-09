import { describe, expect, it, vi } from "vitest";
import {
  CompatibilityAdmissionAdapter,
  DEFAULT_MAILBOX_NAMESPACE,
  ESTATE_EMAIL_PRINCIPAL,
  ESTATE_TENANT_ID,
  EstateAdmissionRequest,
  InMemoryShadowStore,
  PostgrestShadowStore,
  CANARY_CONSUMER,
  SHADOW_CONSUMER,
  StubSqlShadowStore,
  deriveIdempotencyKey,
  estateDiscoveryKey,
  mapEmailToEstateAdmissionRequest,
  normalizeEmailSourceEventId,
  normalizeLiveSourceRef,
  simulateWouldBeAdmission,
  type EmailEnvelopeInput,
  type ShadowStoreWriter,
  type ShadowPersistInput,
} from "../packages/admission/src/index.js";

const RECEIVED = "2026-09-09T20:00:00.000Z";

function actionableClientEmail(
  overrides: Partial<EmailEnvelopeInput> = {},
): EmailEnvelopeInput {
  return {
    message_id: "<quote-review@littlejoe.example>",
    uid: 1001,
    from: "contact@littlejoestreeservices.co.uk",
    subject: "Urgent quote question on monthly SEO",
    snippet: "Hi, can we review the campaign ASAP?",
    received_at: RECEIVED,
    attachments: [
      {
        filename: "quote.pdf",
        size_bytes: 1000,
        mime_type: "application/pdf",
      },
    ],
    triage: {
      needs_action: true,
      urgency: "urgent",
      label: "client_comms",
      client: "Little Joe's Tree Services",
      action_triples: [
        {
          source_ref: "email:quote-review@littlejoe.example",
          assignee: "@jonny",
        },
      ],
      subject: "Urgent quote question on monthly SEO",
    },
    ...overrides,
  };
}

describe("Phase 4.1 Option C — Message-ID identity", () => {
  it("brackets/case/whitespace → same discovery key", () => {
    const a = normalizeEmailSourceEventId("  <AbC@Host>  ");
    const b = normalizeEmailSourceEventId("abc@host");
    const c = normalizeEmailSourceEventId("<ABC@HOST>");
    const d = normalizeEmailSourceEventId("<Ab C@Host>");
    expect(a).toBe("abc@host");
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(d).toBe(a);
    expect(estateDiscoveryKey(a)).toBe(estateDiscoveryKey(b));
  });

  it("retains raw_message_id as provenance on EstateAdmissionRequest", () => {
    const req = mapEmailToEstateAdmissionRequest(
      actionableClientEmail({ message_id: "<Quote-Review@LittleJoe.Example>" }),
    );
    expect(req.message_id).toBe("quote-review@littlejoe.example");
    expect(req.raw_message_id).toBe("<Quote-Review@LittleJoe.Example>");
    expect(req.estate_discovery_key).toBe(
      "email:quote-review@littlejoe.example|email-ingest-live",
    );
  });

  it("same Message-ID different UID → one discovery key", () => {
    const k1 = mapEmailToEstateAdmissionRequest(
      actionableClientEmail({ message_id: "<same@x.example>", uid: 1 }),
    ).estate_discovery_key;
    const k2 = mapEmailToEstateAdmissionRequest(
      actionableClientEmail({ message_id: "<SAME@x.example>", uid: 9999 }),
    ).estate_discovery_key;
    expect(k1).toBe(k2);
    expect(k1).toBe("email:same@x.example|email-ingest-live");
  });

  it("falls back to hostinger-uid-{mailbox_namespace}-{uid} when Message-ID missing", () => {
    expect(normalizeEmailSourceEventId(null, 42)).toBe(
      `hostinger-uid-${DEFAULT_MAILBOX_NAMESPACE}-42`,
    );
    expect(normalizeEmailSourceEventId("   ", 99)).toBe(
      `hostinger-uid-${DEFAULT_MAILBOX_NAMESPACE}-99`,
    );
    expect(
      normalizeEmailSourceEventId(null, 7, "custom-ns"),
    ).toBe("hostinger-uid-custom-ns-7");
  });

  it("handles malformed Message-ID by Option C normalise", () => {
    const req = mapEmailToEstateAdmissionRequest(
      actionableClientEmail({ message_id: "<<weird id@Host>>" }),
    );
    expect(req.message_id).toBe("weirdid@host");
    expect(req.raw_message_id).toBe("<<weird id@Host>>");
    expect(req.estate_discovery_key).toBe(
      "email:weirdid@host|email-ingest-live",
    );
  });

  it("missing Message-ID via hostinger-uid fallback on mapper", () => {
    const req = mapEmailToEstateAdmissionRequest(
      actionableClientEmail({
        message_id: null,
        messageId: null,
        id: null,
        uid: 777,
      }),
    );
    expect(req.estate_discovery_key).toBe(
      `email:hostinger-uid-${DEFAULT_MAILBOX_NAMESPACE}-777|email-ingest-live`,
    );
    expect(req.raw_message_id).toBeUndefined();
  });

  it("normalises live raw-bracket source_ref to discovery key", () => {
    expect(
      normalizeLiveSourceRef("email:<Msg-1@Example.com>|email-ingest-live"),
    ).toBe("email:msg-1@example.com|email-ingest-live");
  });

  it("uses documented estate tenant/principal mapping constants", () => {
    expect(ESTATE_TENANT_ID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(ESTATE_EMAIL_PRINCIPAL.kind).toBe("SERVICE");
  });
});

describe("Phase 4.1 — mapper fixtures (§6)", () => {
  it("maps simple actionable email → EstateAdmissionRequest", () => {
    const req = mapEmailToEstateAdmissionRequest(actionableClientEmail());
    const parsed = EstateAdmissionRequest.parse(req);
    expect(parsed.channel).toBe("email");
    expect(parsed.estate_discovery_key).toBe(
      "email:quote-review@littlejoe.example|email-ingest-live",
    );
    expect(parsed.objective).toBe(
      "Email triage: Urgent quote question on monthly SEO",
    );
    expect(parsed.raw_message_id).toBe("<quote-review@littlejoe.example>");
    expect(parsed.compatibility?.needs_action).toBe(true);
  });

  it("maps non-actionable (spam/newsletter) without inventing authority", () => {
    const req = mapEmailToEstateAdmissionRequest({
      message_id: "<spam1@x.example>",
      uid: 502,
      from: "prize@scam-winner-lottery.xyz",
      subject: "Congratulations you won the lottery crypto profit!",
      received_at: RECEIVED,
      triage: {
        needs_action: false,
        urgency: "low",
        label: "spam",
        action_triples: [],
        subject: "Congratulations you won the lottery crypto profit!",
      },
    });
    expect(req.compatibility?.needs_action).toBe(false);
    expect(req.compatibility?.label).toBe("spam");
  });

  it("maps reply thread refs", () => {
    const req = mapEmailToEstateAdmissionRequest(
      actionableClientEmail({
        message_id: "<reply-2@thread.example>",
        in_reply_to: "<root@thread.example>",
        references: ["<root@thread.example>", "<reply-1@thread.example>"],
      }),
    );
    expect(req.thread_refs).toEqual([
      "<root@thread.example>",
      "<root@thread.example>",
      "<reply-1@thread.example>",
    ]);
  });

  it("maps forward with new Message-ID as distinct discovery key", () => {
    const original = mapEmailToEstateAdmissionRequest(
      actionableClientEmail({ message_id: "<original@x.example>" }),
    );
    const forward = mapEmailToEstateAdmissionRequest(
      actionableClientEmail({
        message_id: "<forward-new@x.example>",
        subject: "Fwd: Urgent quote question on monthly SEO",
        triage: {
          needs_action: true,
          urgency: "urgent",
          label: "client_comms",
          client: "Little Joe's Tree Services",
          action_triples: [{ assignee: "@jonny" }],
          subject: "Fwd: Urgent quote question on monthly SEO",
        },
      }),
    );
    expect(forward.estate_discovery_key).not.toBe(original.estate_discovery_key);
  });

  it("maps attachment metadata only (names/sizes/mime)", () => {
    const req = mapEmailToEstateAdmissionRequest(
      actionableClientEmail({
        attachments: [
          {
            filename: "scope.docx",
            sizeBytes: 2048,
            contentType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          },
        ],
      }),
    );
    expect(req.attachments_manifest?.[0]?.filename).toBe("scope.docx");
  });

  it("maps long body/subject without storing raw secret bodies", () => {
    const longSubject = `Action required: ${"please review ".repeat(40)}end`;
    const req = mapEmailToEstateAdmissionRequest(
      actionableClientEmail({
        subject: longSubject,
        body: "x".repeat(50000),
        triage: {
          needs_action: true,
          urgency: "normal",
          label: "action_needed",
          action_triples: [{ assignee: "@keith" }],
          subject: longSubject,
        },
      }),
    );
    expect(req.objective.length).toBeLessThanOrEqual(220);
    expect(JSON.stringify(req)).not.toContain("x".repeat(1000));
  });

  it("scrubs secret-looking material out of objective/subject", () => {
    const req = mapEmailToEstateAdmissionRequest(
      actionableClientEmail({
        subject: "key sk-abcdefghijklmnopqrstuvwxyz012345",
        triage: {
          needs_action: true,
          urgency: "normal",
          label: "action_needed",
          action_triples: [{ assignee: "@keith" }],
          subject: "key sk-abcdefghijklmnopqrstuvwxyz012345",
        },
      }),
    );
    expect(req.objective).toContain("[REDACTED_SECRET]");
    expect(JSON.stringify(req)).not.toContain(
      "sk-abcdefghijklmnopqrstuvwxyz012345",
    );
  });
});

describe("Phase 4.1 — adapter + idempotency + Option C MATCH", () => {
  it("bracketed live source_ref → MATCH under Option C (not ACCEPTABLE_DIFFERENCE)", async () => {
    const adapter = new CompatibilityAdmissionAdapter(new InMemoryShadowStore());
    const result = await adapter.admitEmailShadow(actionableClientEmail(), {
      id: "act-1",
      source: "email-triage",
      source_ref: "email:<quote-review@littlejoe.example>|email-ingest-live",
      title: "Email triage: Urgent quote question on monthly SEO",
    });
    expect(result.verdict).toBe("MATCH");
    expect(result.reasons.some((r) => r.includes("Option C"))).toBe(true);
  });

  it("duplicate x10 → same discovery key / would-be taskId; one logical run", async () => {
    const store = new InMemoryShadowStore();
    const adapter = new CompatibilityAdmissionAdapter(store);
    const envelope = actionableClientEmail();
    const legacy = {
      id: "act-1",
      source: "email-triage",
      source_ref: "email:<quote-review@littlejoe.example>|email-ingest-live",
      title: "Email triage: Urgent quote question on monthly SEO",
    };
    const results = [];
    for (let i = 0; i < 10; i++) {
      results.push(await adapter.admitEmailShadow(envelope, legacy));
    }
    expect(new Set(results.map((r) => r.simulated!.estate_discovery_key)).size).toBe(1);
    expect(new Set(results.map((r) => r.simulated!.wouldBeTaskId)).size).toBe(1);
    expect(results.every((r) => r.verdict === "MATCH")).toBe(true);
    expect(store.runs).toHaveLength(1);
    expect(store.compares).toHaveLength(10);
    expect(store.compares.every((c) => c.consumer === SHADOW_CONSUMER)).toBe(true);
    expect(new Set(results.map((r) => r.run_id)).size).toBe(1);
  });

  it("idempotency: same email → same would-be taskId across retries", async () => {
    const store = new InMemoryShadowStore();
    const adapter = new CompatibilityAdmissionAdapter(store);
    const envelope = actionableClientEmail({
      message_id: "<stable-idem@example.com>",
    });
    const first = await adapter.admitEmailShadow(envelope);
    for (let i = 0; i < 9; i++) {
      const r = await adapter.admitEmailShadow(envelope);
      expect(r.simulated!.wouldBeTaskId).toBe(first.simulated!.wouldBeTaskId);
      expect(r.verdict).not.toBe("CONFLICT");
      expect(r.verdict).not.toBe("ERROR");
    }
    const key = deriveIdempotencyKey({
      tenantId: ESTATE_TENANT_ID,
      principalId: ESTATE_EMAIL_PRINCIPAL.id,
      estate_discovery_key: first.simulated!.estate_discovery_key,
    });
    expect(key).toBe(first.simulated!.idempotencyKey);
    expect(store.runs).toHaveLength(1);
  });

  it("changed body/objective same Message-ID → CONFLICT", async () => {
    const store = new InMemoryShadowStore();
    const adapter = new CompatibilityAdmissionAdapter(store);
    const base = actionableClientEmail({
      message_id: "<conflict-me@example.com>",
    });
    const first = await adapter.admitEmailShadow(base);
    expect(first.verdict).not.toBe("CONFLICT");
    const changed = actionableClientEmail({
      message_id: "<conflict-me@example.com>",
      subject: "Completely different objective now",
      triage: {
        needs_action: true,
        urgency: "urgent",
        label: "client_comms",
        client: "Little Joe's Tree Services",
        action_triples: [{ assignee: "@jonny" }],
        subject: "Completely different objective now",
      },
    });
    const second = await adapter.admitEmailShadow(changed);
    expect(second.verdict).toBe("CONFLICT");
    expect(second.simulated!.requestDigest).not.toBe(first.simulated!.requestDigest);
    // Conflict has different request_digest → distinct logical input_hash → 2 runs
    expect(store.runs.length).toBeGreaterThanOrEqual(2);
  });

  it("conflicting replay / MATERIAL as designed", async () => {
    const store = new InMemoryShadowStore();
    const adapter = new CompatibilityAdmissionAdapter(store);
    const envelope = actionableClientEmail({
      message_id: "<replay@example.com>",
    });
    await adapter.admitEmailShadow(envelope);
    const conflicting = await adapter.admitEmailShadow({
      ...envelope,
      triage: {
        needs_action: true,
        urgency: "low",
        label: "action_needed",
        action_triples: [{ assignee: "@keith" }],
        subject: "REPLAY CHANGED SUBJECT",
      },
    });
    expect(conflicting.verdict).toBe("CONFLICT");

    const material = await new CompatibilityAdmissionAdapter(
      new InMemoryShadowStore(),
    ).admitEmailShadow(envelope, {
      source: "dsp",
      source_ref: "email:replay@example.com|email-ingest-live",
      title: "Email triage: Urgent quote question on monthly SEO",
    });
    expect(material.verdict).toBe("MATERIAL_DIFFERENCE");
  });

  it("non-actionable shadow yields ACCEPTABLE_DIFFERENCE without legacy mint", async () => {
    const adapter = new CompatibilityAdmissionAdapter(new InMemoryShadowStore());
    const result = await adapter.admitEmailShadow({
      message_id: "<noreply@newsletter.example>",
      uid: 9,
      from: "noreply@newsletter.example",
      subject: "Weekly digest",
      received_at: RECEIVED,
      triage: {
        needs_action: false,
        urgency: "low",
        label: "information",
        action_triples: [],
        subject: "Weekly digest",
      },
    });
    expect(result.verdict).toBe("ACCEPTABLE_DIFFERENCE");
  });

  it("never claims Spawner / NewSystemRuntimeAdapter / actions writes", async () => {
    const store = new InMemoryShadowStore();
    const adapter = new CompatibilityAdmissionAdapter(store);
    await adapter.admitEmailShadow(actionableClientEmail());
    const output = store.runs[0]!.spawner_output!;
    expect(output.spawner_invoked).toBe(false);
    expect(output.new_system_runtime_invoked).toBe(false);
    expect(output.public_actions_written).toBe(false);
    expect(output.task_admissions_written).toBe(false);
  });

  it("StubSqlShadowStore records intended rows without executing HTTP", async () => {
    const stub = new StubSqlShadowStore();
    const adapter = new CompatibilityAdmissionAdapter(stub);
    await adapter.admitEmailShadow(actionableClientEmail());
    expect(stub.posted.some((p) => p.table === "spawner_shadow_runs")).toBe(true);
    expect(stub.posted.some((p) => p.table === "spawner_shadow_compare")).toBe(true);
    expect(stub.posted.every((p) => p.body._executed === false)).toBe(true);
  });

  it("pure simulateWouldBeAdmission is deterministic", () => {
    const req = mapEmailToEstateAdmissionRequest(
      actionableClientEmail({ message_id: "<det@example.com>" }),
    );
    expect(simulateWouldBeAdmission(req)).toEqual(simulateWouldBeAdmission(req));
  });
});

describe("Phase 4.1 — shadow persistence (canonical tables)", () => {
  it("PostgrestShadowStore upserts run + compare against schema with mock fetch", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const runId = "11111111-1111-4111-8111-111111111111";
    const compareId = "22222222-2222-4222-8222-222222222222";
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = (init?.method || "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url: u, body });
      if (method === "GET" && u.includes("spawner_shadow_runs")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (method === "POST" && u.includes("spawner_shadow_runs")) {
        expect(body.consumer).toBe(SHADOW_CONSUMER);
        expect(body.input_hash).toBeTruthy();
        expect(body.status).toBeTruthy();
        return new Response(
          JSON.stringify([
            {
              id: runId,
              consumer: body.consumer,
              input_hash: body.input_hash,
              spawner_output: body.spawner_output,
              latency_ms: body.latency_ms,
              cost_estimate: 0,
              status: body.status,
              created_at: RECEIVED,
            },
          ]),
          { status: 201 },
        );
      }
      if (method === "GET" && u.includes("spawner_shadow_compare")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (method === "POST" && u.includes("spawner_shadow_compare")) {
        expect(body.consumer).toBe(SHADOW_CONSUMER);
        expect(body.run_id).toBe(runId);
        expect(body.verdict).toBeTruthy();
        return new Response(
          JSON.stringify([
            {
              id: compareId,
              run_id: runId,
              consumer: body.consumer,
              verdict: body.verdict,
              diff_jsonb: body.diff_jsonb,
              created_at: RECEIVED,
            },
          ]),
          { status: 201 },
        );
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const store = new PostgrestShadowStore({
      restBaseUrl: "https://example.invalid/rest/v1",
      serviceRoleKey: "test-service-role-key-not-real",
      fetchImpl,
    });
    const adapter = new CompatibilityAdmissionAdapter(store);
    const result = await adapter.admitEmailShadow(actionableClientEmail());
    expect(result.run_id).toBe(runId);
    expect(result.compare_id).toBe(compareId);
    expect(calls.some((c) => c.method === "POST" && c.url.includes("spawner_shadow_runs"))).toBe(
      true,
    );
    expect(
      calls.some((c) => c.method === "POST" && c.url.includes("spawner_shadow_compare")),
    ).toBe(true);

    // Retry: existing run → PATCH + new compare attempt (same logical identity)
    const fetchRetry = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = (init?.method || "GET").toUpperCase();
      if (method === "GET" && u.includes("spawner_shadow_runs")) {
        return new Response(
          JSON.stringify([
            {
              id: runId,
              consumer: CANARY_CONSUMER,
  SHADOW_CONSUMER,
              input_hash: "abc",
              spawner_output: {},
              latency_ms: 1,
              cost_estimate: 0,
              status: "shadow_ok",
              created_at: RECEIVED,
            },
          ]),
          { status: 200 },
        );
      }
      if (method === "PATCH") {
        return new Response(
          JSON.stringify([
            {
              id: runId,
              consumer: CANARY_CONSUMER,
  SHADOW_CONSUMER,
              input_hash: "abc",
              spawner_output: {},
              latency_ms: 2,
              cost_estimate: 0,
              status: "shadow_ok",
              created_at: RECEIVED,
            },
          ]),
          { status: 200 },
        );
      }
      if (method === "GET" && u.includes("spawner_shadow_compare")) {
        return new Response(JSON.stringify([{ id: compareId }]), { status: 200 });
      }
      if (method === "POST" && u.includes("spawner_shadow_compare")) {
        const body = JSON.parse(String(init?.body));
        expect(body.diff_jsonb.attempt).toBe(2);
        return new Response(
          JSON.stringify([
            {
              id: "33333333-3333-4333-8333-333333333333",
              run_id: runId,
              consumer: CANARY_CONSUMER,
  SHADOW_CONSUMER,
              verdict: body.verdict,
              diff_jsonb: body.diff_jsonb,
              created_at: RECEIVED,
            },
          ]),
          { status: 201 },
        );
      }
      return new Response("bad", { status: 500 });
    }) as unknown as typeof fetch;

    const store2 = new PostgrestShadowStore({
      restBaseUrl: "https://example.invalid/rest/v1",
      serviceRoleKey: "test-service-role-key-not-real",
      fetchImpl: fetchRetry,
    });
    const again = await store2.persist({
      input_hash: "abc",
      status: "shadow_ok",
      latency_ms: 2,
      output: { mode: "shadow" },
      verdict: "MATCH",
      diff: { reasons: [] },
    });
    expect(again.run.id).toBe(runId);
    expect(again.compare.diff_jsonb.attempt).toBe(2);
  });
});

describe("Phase 4.1 — failure isolation", () => {
  it("store unavailable → admitEmailShadow throws; Safe wrapper returns ERROR", async () => {
    const failingStore: ShadowStoreWriter = {
      async persist(_input: ShadowPersistInput) {
        throw new Error("store unavailable");
      },
      async listRuns() {
        return [];
      },
      async listCompares() {
        return [];
      },
    };
    const adapter = new CompatibilityAdmissionAdapter(failingStore);
    await expect(adapter.admitEmailShadow(actionableClientEmail())).rejects.toThrow(
      /store also unavailable|store unavailable/,
    );
    const safe = await adapter.admitEmailShadowSafe(actionableClientEmail());
    expect(safe.verdict).toBe("ERROR");
    expect(safe.error).toMatch(/store/);
  });

  it("KJ sim / mapper unavailable → ERROR result (caller can catch)", async () => {
    const store = new InMemoryShadowStore();
    const adapter = new CompatibilityAdmissionAdapter(store);
    const result = await adapter.admitEmailShadow({
      message_id: null,
      messageId: null,
      id: null,
      uid: null,
      received_at: RECEIVED,
      triage: { needs_action: true, urgency: "normal", action_triples: [] },
    });
    expect(result.verdict).toBe("ERROR");
    expect(result.error).toMatch(/missing Message-ID/);
  });

  it("documents production cron isolation by non-coupling (static assert)", async () => {
    // Production email-ingest-live.py must not import packages/admission.
    // This fixture asserts the adapter exposes Safe path and never mutates actions.
    const store = new InMemoryShadowStore();
    const adapter = new CompatibilityAdmissionAdapter(store);
    const r = await adapter.admitEmailShadowSafe(actionableClientEmail());
    expect(r.mode).toBe("shadow");
    expect(r.consumer).toBe(SHADOW_CONSUMER);
    expect(store.runs[0]?.spawner_output?.public_actions_written).toBe(false);
  });
});


describe("Phase 5 canary admitEmailCanary (admission only)", () => {
  it("ADMITTED then REPLAY with same taskId; never marks public_actions", async () => {
    const store = new InMemoryShadowStore();
    const adapter = new CompatibilityAdmissionAdapter(store);
    const envelope = actionableClientEmail({
      message_id: "<kerneljson-email-authority-canary@phase5.jonnyai.test>",
      subject: "KERNELJSON EMAIL AUTHORITY CANARY",
      triage: {
        needs_action: true,
        urgency: "normal",
        label: "ops_canary",
        client: null,
        action_triples: [
          {
            source_ref:
              "email:kerneljson-email-authority-canary@phase5.jonnyai.test",
            assignee: "@keith",
          },
        ],
        subject: "KERNELJSON EMAIL AUTHORITY CANARY",
      },
    });
    const first = await adapter.admitEmailCanary(envelope);
    expect(first.status).toBe("ADMITTED");
    expect(first.taskId).toBe("3c509de0-fbd3-8b54-ade7-797094f828b7");
    const second = await adapter.admitEmailCanary(envelope);
    expect(second.status).toBe("REPLAY");
    expect(second.taskId).toBe(first.taskId);
    expect(store.runs.length).toBeGreaterThanOrEqual(1);
    expect(store.runs[0]?.spawner_output?.public_actions_written).toBe(false);
    expect(store.runs[0]?.spawner_output?.spawner_invoked).toBe(false);
    expect(store.runs[0]?.spawner_output?.consumer).toBe(CANARY_CONSUMER);
  });
});
