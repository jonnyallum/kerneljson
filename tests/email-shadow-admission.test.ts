import { describe, expect, it } from "vitest";
import {
  CompatibilityAdmissionAdapter,
  ESTATE_EMAIL_PRINCIPAL,
  ESTATE_TENANT_ID,
  EstateAdmissionRequest,
  InMemoryShadowStore,
  SHADOW_CONSUMER,
  StubSqlShadowStore,
  deriveIdempotencyKey,
  estateDiscoveryKey,
  mapEmailToEstateAdmissionRequest,
  normalizeEmailSourceEventId,
  normalizeLiveSourceRef,
  simulateWouldBeAdmission,
  type EmailEnvelopeInput,
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

describe("Track B EMAIL shadow admission — identity", () => {
  it("normalises Message-ID (strip whitespace/brackets, lower-case)", () => {
    expect(normalizeEmailSourceEventId("  <AbC@Host>  ")).toBe("abc@host");
    expect(normalizeEmailSourceEventId("Already-Clean@x")).toBe(
      "already-clean@x",
    );
  });

  it("falls back to hostinger-uid-{uid} when Message-ID missing", () => {
    expect(normalizeEmailSourceEventId(null, 42)).toBe("hostinger-uid-42");
    expect(normalizeEmailSourceEventId("   ", 99)).toBe("hostinger-uid-99");
  });

  it("builds estate_discovery_key matching live source_ref form", () => {
    const id = normalizeEmailSourceEventId("<msg-1@example.com>");
    expect(estateDiscoveryKey(id)).toBe(
      "email:msg-1@example.com|email-ingest-live",
    );
  });

  it("normalises live raw-bracket source_ref to discovery key", () => {
    expect(
      normalizeLiveSourceRef(
        "email:<Msg-1@Example.com>|email-ingest-live",
      ),
    ).toBe("email:msg-1@example.com|email-ingest-live");
  });

  it("uses documented estate tenant/principal mapping constants", () => {
    expect(ESTATE_TENANT_ID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(ESTATE_EMAIL_PRINCIPAL.kind).toBe("SERVICE");
    expect(ESTATE_EMAIL_PRINCIPAL.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("Track B EMAIL shadow admission — mapper fixtures", () => {
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
    expect(parsed.tenant_ref.id).toBe(ESTATE_TENANT_ID);
    expect(parsed.principal_ref).toEqual(ESTATE_EMAIL_PRINCIPAL);
    expect(parsed.compatibility?.needs_action).toBe(true);
    expect(parsed.compatibility?.owner_hint).toBe("@jonny");
    expect(parsed.attachments_manifest?.[0]?.filename).toBe("quote.pdf");
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
    expect(req.estate_discovery_key).toContain("|email-ingest-live");
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
    expect(req.estate_discovery_key).toBe(
      "email:reply-2@thread.example|email-ingest-live",
    );
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
    expect(forward.estate_discovery_key).toBe(
      "email:forward-new@x.example|email-ingest-live",
    );
  });

  it("maps attachment metadata only (names/sizes/mime)", () => {
    const req = mapEmailToEstateAdmissionRequest(
      actionableClientEmail({
        attachments: [
          {
            filename: "scope.docx",
            sizeBytes: 2048,
            contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          },
        ],
      }),
    );
    expect(req.attachments_manifest).toEqual([
      {
        filename: "scope.docx",
        size_bytes: 2048,
        mime_type:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
    ]);
  });

  it("handles malformed Message-ID by normalising remaining characters", () => {
    const req = mapEmailToEstateAdmissionRequest(
      actionableClientEmail({
        message_id: "<<weird id@Host>>",
      }),
    );
    expect(req.message_id).toBe("weirdid@host");
    expect(req.estate_discovery_key).toBe(
      "email:weirdid@host|email-ingest-live",
    );
  });

  it("handles missing Message-ID via hostinger-uid fallback", () => {
    const req = mapEmailToEstateAdmissionRequest(
      actionableClientEmail({
        message_id: null,
        messageId: null,
        id: null,
        uid: 777,
      }),
    );
    expect(req.estate_discovery_key).toBe(
      "email:hostinger-uid-777|email-ingest-live",
    );
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
    expect(req.objective.startsWith("Email triage:")).toBe(true);
    expect(req.objective.length).toBeLessThanOrEqual(220);
    expect(JSON.stringify(req)).not.toContain("x".repeat(1000));
  });

  it("scrubs secret-looking material out of objective/subject (never stores raw secrets)", () => {
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
    expect(JSON.stringify(req)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
    expect(req.subject).toContain("[REDACTED_SECRET]");
  });
});

describe("Track B EMAIL shadow admission — adapter + idempotency", () => {
  it("duplicate x10 → same discovery key and would-be taskId", async () => {
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
    const keys = new Set(
      results.map((r) => r.simulated!.estate_discovery_key),
    );
    const taskIds = new Set(results.map((r) => r.simulated!.wouldBeTaskId));
    const idem = new Set(results.map((r) => r.simulated!.idempotencyKey));
    expect(keys.size).toBe(1);
    expect(taskIds.size).toBe(1);
    expect(idem.size).toBe(1);
    expect(results[0]!.verdict === "MATCH" || results[0]!.verdict === "ACCEPTABLE_DIFFERENCE").toBe(
      true,
    );
    expect(store.runs).toHaveLength(10);
    expect(store.compares.every((c) => c.consumer === SHADOW_CONSUMER)).toBe(
      true,
    );
    expect(
      results.every(
        (r) =>
          r.diff &&
          (r as { simulated?: { wouldBeTaskId: string } }).simulated &&
          true,
      ),
    ).toBe(true);
  });

  it("idempotency: same email → same discovery key → same would-be taskId across 10 retries", async () => {
    const store = new InMemoryShadowStore();
    const adapter = new CompatibilityAdmissionAdapter(store);
    const envelope = actionableClientEmail({
      message_id: "<stable-idem@example.com>",
    });
    const first = await adapter.admitEmailShadow(envelope);
    const retries = [];
    for (let i = 0; i < 9; i++) {
      retries.push(await adapter.admitEmailShadow(envelope));
    }
    for (const r of retries) {
      expect(r.simulated!.estate_discovery_key).toBe(
        first.simulated!.estate_discovery_key,
      );
      expect(r.simulated!.wouldBeTaskId).toBe(first.simulated!.wouldBeTaskId);
      expect(r.simulated!.idempotencyKey).toBe(first.simulated!.idempotencyKey);
      expect(r.verdict).not.toBe("CONFLICT");
      expect(r.verdict).not.toBe("ERROR");
    }
    const key = deriveIdempotencyKey({
      tenantId: ESTATE_TENANT_ID,
      principalId: ESTATE_EMAIL_PRINCIPAL.id,
      estate_discovery_key: first.simulated!.estate_discovery_key,
    });
    expect(key).toBe(first.simulated!.idempotencyKey);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
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
    expect(second.simulated!.estate_discovery_key).toBe(
      first.simulated!.estate_discovery_key,
    );
    expect(second.simulated!.keyDigest).toBe(first.simulated!.keyDigest);
    expect(second.simulated!.requestDigest).not.toBe(
      first.simulated!.requestDigest,
    );
  });

  it("conflicting replay payload classified CONFLICT / MATERIAL as designed", async () => {
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
    expect(result.simulated!.wouldBeTaskId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
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
    expect(stub.posted.some((p) => p.table === "spawner_shadow_runs")).toBe(
      true,
    );
    expect(stub.posted.some((p) => p.table === "spawner_shadow_compare")).toBe(
      true,
    );
    expect(stub.posted.every((p) => p.body._executed === false)).toBe(true);
  });

  it("pure simulateWouldBeAdmission is deterministic", () => {
    const req = mapEmailToEstateAdmissionRequest(
      actionableClientEmail({ message_id: "<det@example.com>" }),
    );
    const a = simulateWouldBeAdmission(req);
    const b = simulateWouldBeAdmission(req);
    expect(a).toEqual(b);
  });
});
