import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AuthenticatorUnavailableError,
  CONTROL_HEADERS,
  ControlAuthError,
  InMemoryReplayStore,
  approvalFields,
  canonicalPayload,
  createControlSigner,
  createControlVerifier,
  sha256Hex,
  type CanonicalFields,
  type ControlRequest,
  type ReplayStore,
} from "../services/kernel/src/control-signing.js";
import { CONTROL_OTHER_KEY, CONTROL_TEST_KEY } from "./support/control-test-key.js";

/**
 * KJ-P4B.1: the signed control assertion. Restate journals every request header for 24 hours, so the
 * long-lived key must never be transmitted; what is transmitted must verify only for the exact request
 * it was made for, and be safe to redeliver. These tests pin the format, every binding, and the replay model.
 */
const KEY = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJ";
const TENANT = "22222222-2222-4222-8222-222222222222";
const PRINCIPAL = "33333333-3333-4333-8333-333333333333";
const TASK = "11111111-1111-4111-8111-111111111111";
const DIGEST = "a".repeat(64);
const SERVICE = "GoldenTaskWorkflowV1";
const T0 = 1_790_000_000; // seconds

const approveBody = (decision = "GRANTED", scopeDigest = DIGEST): string => JSON.stringify({ scopeDigest, decision });
const request = (over: Partial<ControlRequest> = {}): ControlRequest => ({
  service: SERVICE,
  handler: "approve",
  key: TASK,
  body: approveBody(),
  ...over,
});

function rig(o: { verifierKeys?: Record<string, string>; tenant?: string; principal?: string; freshness?: number } = {}) {
  const clock = { seconds: T0 };
  let n = 0;
  const replay = new InMemoryReplayStore(() => clock.seconds);
  const signWith = (keyId: string, key: string, nonce?: () => string) =>
    createControlSigner({ keyId, key, now: () => clock.seconds * 1000, nonce: nonce ?? (() => String(++n).padStart(22, "0")) });
  const sign = signWith("v1", KEY);
  const verify = createControlVerifier({
    keys: new Map(Object.entries(o.verifierKeys ?? { v1: KEY })),
    tenantId: o.tenant ?? TENANT,
    principalId: o.principal ?? PRINCIPAL,
    freshnessSeconds: o.freshness ?? 300,
    replay,
  });
  const headers = (h: Record<string, string>): Map<string, string> => new Map(Object.entries(h));
  const made = (r: ControlRequest = request()): Map<string, string> =>
    headers(sign({ ...r, tenantId: TENANT, principalId: PRINCIPAL }));
  const code = async (h: Map<string, string>, r: ControlRequest = request(), v = verify): Promise<string> => {
    try {
      await v(h, r);
      return "ACCEPTED";
    } catch (e) {
      return e instanceof ControlAuthError ? e.code : `OTHER:${(e as Error).name}`;
    }
  };
  return { clock, replay, sign, signWith, verify, headers, made, code };
}

describe("KJ-P4B.1 the canonical format, pinned by an independently computed vector", () => {
  const fields: CanonicalFields = {
    version: "1",
    keyId: "v1",
    method: "POST",
    service: SERVICE,
    handler: "approve",
    key: TASK,
    tenantId: TENANT,
    principalId: PRINCIPAL,
    scopeDigest: DIGEST,
    decision: "GRANTED",
    bodySha256: "e187ea9d88c30f7dad8b7c594a9aacebf62984365a0e16bdc4627773d06b18aa",
    issuedAt: "1790000000",
    nonce: "AAAAAAAAAAAAAAAAAAAAAA",
  };
  const CANONICAL =
    "kj-control/v1\n" +
    '["1","v1","POST","GoldenTaskWorkflowV1","approve","11111111-1111-4111-8111-111111111111",' +
    '"22222222-2222-4222-8222-222222222222","33333333-3333-4333-8333-333333333333",' +
    '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","GRANTED",' +
    '"e187ea9d88c30f7dad8b7c594a9aacebf62984365a0e16bdc4627773d06b18aa","1790000000","AAAAAAAAAAAAAAAAAAAAAA"]';
  // Computed by a separate Python HMAC over the literal text above, not by this code.
  const MAC = "a235f9d52da4b4f39df449597f3d979eb7085b8bb89221debe4ee9a80652368d";

  it("is a domain tag, a newline, then a JSON array of thirteen strings in a fixed order", () => {
    expect(canonicalPayload(fields)).toBe(CANONICAL);
    expect((JSON.parse(CANONICAL.split("\n")[1]!) as string[]).length).toBe(13);
  });

  it("signs those exact bytes: the header carries the independently computed HMAC-SHA256", () => {
    expect(createHmac("sha256", KEY).update(CANONICAL, "utf8").digest("hex")).toBe(MAC);
    const sign = createControlSigner({ keyId: "v1", key: KEY, now: () => T0 * 1000, nonce: () => "AAAAAAAAAAAAAAAAAAAAAA" });
    const headers = sign({ ...request(), tenantId: TENANT, principalId: PRINCIPAL });
    expect(headers).toEqual({
      "x-kj-control-version": "1",
      "x-kj-control-key-id": "v1",
      "x-kj-control-timestamp": "1790000000",
      "x-kj-control-nonce": "AAAAAAAAAAAAAAAAAAAAAA",
      "x-kj-control-body-sha256": fields.bodySha256,
      "x-kj-control-signature": MAC,
    });
  });

  it("binds every one of the thirteen fields: changing any single one changes the payload", () => {
    const base = canonicalPayload(fields);
    for (const name of Object.keys(fields) as Array<keyof CanonicalFields>) {
      const changed = { ...fields, [name]: name === "method" ? "GET" : `${fields[name]}x` } as CanonicalFields;
      expect(canonicalPayload(changed), name).not.toBe(base);
    }
  });

  it("cannot be confused by moving text across a field boundary", () => {
    const a = canonicalPayload({ ...fields, service: "AB", handler: "C" });
    const b = canonicalPayload({ ...fields, service: "A", handler: "BC" });
    const c = canonicalPayload({ ...fields, service: 'A","B', handler: "C" });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("uses dedicated headers and never Authorization", () => {
    expect(Object.values(CONTROL_HEADERS).sort()).toEqual([
      "x-kj-control-body-sha256",
      "x-kj-control-key-id",
      "x-kj-control-nonce",
      "x-kj-control-signature",
      "x-kj-control-timestamp",
      "x-kj-control-version",
    ]);
    const r = rig();
    expect([...r.made().keys()].some((k) => k.toLowerCase() === "authorization")).toBe(false);
  });
});

describe("KJ-P4B.1 accepting and refusing an assertion", () => {
  it("accepts a valid assertion and names the configured principal, not one from the request", async () => {
    const r = rig();
    expect(await r.verify(r.made(), request())).toEqual({ id: PRINCIPAL, kind: "HUMAN" });
  });

  it.each(Object.values(CONTROL_HEADERS))("refuses a request with the %s header missing", async (name) => {
    const r = rig();
    const h = r.made();
    h.delete(name);
    expect(await r.code(h)).toBe("MISSING");
  });

  it("refuses a request with no assertion at all", async () => {
    const r = rig();
    expect(await r.code(new Map())).toBe("MISSING");
  });

  it.each([
    ["an unsupported version", CONTROL_HEADERS.version, "2", "VERSION"],
    ["a key id with a space", CONTROL_HEADERS.keyId, "bad id", "MALFORMED"],
    ["a nonce that is too short", CONTROL_HEADERS.nonce, "short", "MALFORMED"],
    ["a timestamp that is not digits", CONTROL_HEADERS.timestamp, "12ab", "MALFORMED"],
    ["a body hash in upper case", CONTROL_HEADERS.bodySha256, "E".repeat(64), "MALFORMED"],
    ["a signature of the wrong length", CONTROL_HEADERS.signature, "ab".repeat(16), "MALFORMED"],
    ["a signature that is not hex", CONTROL_HEADERS.signature, "z".repeat(64), "MALFORMED"],
  ])("refuses %s", async (_label, name, value, expected) => {
    const r = rig();
    const h = r.made();
    h.set(name, value);
    expect(await r.code(h)).toBe(expected);
  });

  it("finds the headers whatever their case", async () => {
    const r = rig();
    const upper = new Map([...r.made()].map(([k, v]) => [k.toUpperCase(), v] as const));
    expect(await r.code(upper)).toBe("ACCEPTED");
  });

  it("refuses an unknown key id, and a known id whose key did not sign", async () => {
    const r = rig({ verifierKeys: { v1: KEY, v2: CONTROL_OTHER_KEY } });
    const unknown = r.headers(r.signWith("v9", KEY)({ ...request(), tenantId: TENANT, principalId: PRINCIPAL }));
    expect(await r.code(unknown)).toBe("UNKNOWN_KEY");
    const swapped = r.made();
    swapped.set(CONTROL_HEADERS.keyId, "v2"); // signed by v1's key, claims to be v2
    expect(await r.code(swapped)).toBe("SIGNATURE");
  });

  it("refuses an assertion signed with the wrong key", async () => {
    const r = rig();
    const forged = r.headers(r.signWith("v1", CONTROL_OTHER_KEY)({ ...request(), tenantId: TENANT, principalId: PRINCIPAL }));
    expect(await r.code(forged)).toBe("SIGNATURE");
  });
});

describe("KJ-P4B.1 an assertion verifies only for the exact request it was made for", () => {
  it("body changed after signing", async () => {
    const r = rig();
    const h = r.made();
    expect(await r.code(h, request({ body: approveBody("DENIED") }))).toBe("BODY");
    // Even if the attacker also rewrites the body-hash header to match the new body.
    const rewritten = new Map(h);
    rewritten.set(CONTROL_HEADERS.bodySha256, sha256Hex(approveBody("DENIED")));
    expect(await r.code(rewritten, request({ body: approveBody("DENIED") }))).toBe("SIGNATURE");
  });

  it("decision changed (approve turned into reject)", async () => {
    const r = rig();
    const h = r.made();
    h.set(CONTROL_HEADERS.bodySha256, sha256Hex(approveBody("DENIED")));
    expect(await r.code(h, request({ body: approveBody("DENIED") }))).toBe("SIGNATURE");
  });

  it("scope digest changed", async () => {
    const r = rig();
    const h = r.made();
    const other = approveBody("GRANTED", "b".repeat(64));
    h.set(CONTROL_HEADERS.bodySha256, sha256Hex(other));
    expect(await r.code(h, request({ body: other }))).toBe("SIGNATURE");
  });

  it("task changed (the same assertion used on another task)", async () => {
    const r = rig();
    expect(await r.code(r.made(), request({ key: "44444444-4444-4444-8444-444444444444" }))).toBe("SIGNATURE");
  });

  it("service or handler changed (an approve assertion used to cancel)", async () => {
    const r = rig();
    expect(await r.code(r.made(), request({ handler: "cancel" }))).toBe("SIGNATURE");
    expect(await r.code(r.made(), request({ service: "AutonomousChildTaskWorkflowV1" }))).toBe("SIGNATURE");
  });

  it("tenant changed (a verifier for another tenant)", async () => {
    const r = rig({ tenant: "55555555-5555-4555-8555-555555555555" });
    expect(await r.code(r.made())).toBe("SIGNATURE");
  });

  it("principal changed (a verifier for another principal)", async () => {
    const r = rig({ principal: "66666666-6666-4666-8666-666666666666" });
    expect(await r.code(r.made())).toBe("SIGNATURE");
  });

  it("timestamp or nonce edited", async () => {
    const r = rig();
    const t = r.made();
    t.set(CONTROL_HEADERS.timestamp, String(T0 + 1));
    expect(await r.code(t)).toBe("SIGNATURE");
    const n = r.made();
    n.set(CONTROL_HEADERS.nonce, "9".repeat(22));
    expect(await r.code(n)).toBe("SIGNATURE");
  });

  it("run and cancel are bound too: their whole body is hashed and they carry no scope digest or decision", async () => {
    const r = rig();
    const run = request({ handler: "run", body: '{"recipe":"uppercase/v1"}' });
    expect(await r.code(r.made(run), run)).toBe("ACCEPTED");
    expect(await r.code(r.made(run), { ...run, body: '{"recipe":"uppercase/v1","x":1}' })).toBe("BODY");
    const cancel = request({ handler: "cancel", body: "{}" });
    expect(await r.code(r.made(cancel), cancel)).toBe("ACCEPTED");
  });

  it("reads the approval fields from the body strictly", () => {
    expect(approvalFields("approve", approveBody())).toEqual({ scopeDigest: DIGEST, decision: "GRANTED" });
    expect(approvalFields("approve", new TextEncoder().encode(approveBody("DENIED")))).toEqual({ scopeDigest: DIGEST, decision: "DENIED" });
    expect(approvalFields("cancel", approveBody())).toEqual({ scopeDigest: "", decision: "" });
    for (const bad of ["not json", "{}", '{"scopeDigest":"x","decision":"GRANTED"}', `{"scopeDigest":"${DIGEST}","decision":"MAYBE"}`, `{"scopeDigest":"${DIGEST}","decision":"GRANTED","x":1}`])
      expect(approvalFields("approve", bad), bad).toEqual({ scopeDigest: "", decision: "" });
    expect(approvalFields("approve", new Uint8Array([0xff, 0xfe]))).toEqual({ scopeDigest: "", decision: "" });
  });
});

describe("KJ-P4B.1 replay: safe for Restate's redelivery, closed to an attacker", () => {
  it("accepts a first assertion within the freshness window, on both edges, and refuses just outside", async () => {
    const r = rig();
    const sign = (secondsAgo: number) => {
      const past = r.signWith("v1", KEY);
      const at = r.clock.seconds;
      r.clock.seconds = at - secondsAgo;
      const h = r.headers(past({ ...request(), tenantId: TENANT, principalId: PRINCIPAL }));
      r.clock.seconds = at;
      return h;
    };
    expect(await r.code(sign(300))).toBe("ACCEPTED");
    expect(await r.code(sign(301))).toBe("STALE");
    expect(await r.code(sign(-300))).toBe("ACCEPTED"); // 300 s in the future
    expect(await r.code(sign(-301))).toBe("STALE");
  });

  it("refuses a stale assertion that was never accepted, even though its signature is valid", async () => {
    const r = rig();
    const h = r.made();
    r.clock.seconds += 3600;
    expect(await r.code(h)).toBe("STALE");
    expect(r.replay.seen.size).toBe(0);
  });

  it("accepts an identical redelivery idempotently, even long after the window (Restate replays durable work)", async () => {
    const r = rig();
    const h = r.made();
    expect(await r.code(h)).toBe("ACCEPTED");
    r.clock.seconds += 2 * 3600;
    expect(await r.code(h)).toBe("ACCEPTED");
    expect(await r.code(h)).toBe("ACCEPTED");
    expect(r.replay.seen.size).toBe(1);
  });

  it("refuses the same nonce with a changed payload", async () => {
    const r = rig();
    const fixed = r.signWith("v1", KEY, () => "7".repeat(22));
    const first = r.headers(fixed({ ...request(), tenantId: TENANT, principalId: PRINCIPAL }));
    const otherBody = approveBody("DENIED");
    const second = r.headers(fixed({ ...request({ body: otherBody }), tenantId: TENANT, principalId: PRINCIPAL }));
    expect(await r.code(first)).toBe("ACCEPTED");
    expect(await r.code(second, request({ body: otherBody }))).toBe("CONFLICT");
    // The original is still accepted as an idempotent replay.
    expect(await r.code(first)).toBe("ACCEPTED");
  });

  it("refuses the same nonce on a different task, handler or timestamp", async () => {
    const r = rig();
    const fixed = r.signWith("v1", KEY, () => "8".repeat(22));
    const a = r.headers(fixed({ ...request(), tenantId: TENANT, principalId: PRINCIPAL }));
    expect(await r.code(a)).toBe("ACCEPTED");
    const otherTask = request({ key: "44444444-4444-4444-8444-444444444444" });
    expect(await r.code(r.headers(fixed({ ...otherTask, tenantId: TENANT, principalId: PRINCIPAL })), otherTask)).toBe("CONFLICT");
    r.clock.seconds += 5;
    expect(await r.code(r.headers(fixed({ ...request(), tenantId: TENANT, principalId: PRINCIPAL })))).toBe("CONFLICT");
  });

  it("touches the replay store only for an authentic assertion (unauthenticated traffic writes nothing)", async () => {
    const r = rig();
    const forged = r.headers(r.signWith("v1", CONTROL_OTHER_KEY)({ ...request(), tenantId: TENANT, principalId: PRINCIPAL }));
    for (let i = 0; i < 5; i++) await r.code(forged);
    const bodyless = r.made();
    await r.code(bodyless, request({ body: approveBody("DENIED") }));
    await r.code(new Map());
    expect(r.replay.admits).toBe(0);
    // Negative control: an authentic one does reach it.
    await r.code(r.made());
    expect(r.replay.admits).toBe(1);
  });

  it("reports 'could not decide' as unavailable, never as a refusal, so an outage is retried", async () => {
    const down: ReplayStore = {
      async admit() {
        throw new AuthenticatorUnavailableError();
      },
    };
    const clock = T0;
    const verify = createControlVerifier({ keys: new Map([["v1", KEY]]), tenantId: TENANT, principalId: PRINCIPAL, freshnessSeconds: 300, replay: down });
    const sign = createControlSigner({ keyId: "v1", key: KEY, now: () => clock * 1000 });
    const h = new Map(Object.entries(sign({ ...request(), tenantId: TENANT, principalId: PRINCIPAL })));
    const error = await verify(h, request()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AuthenticatorUnavailableError);
    expect(error).not.toBeInstanceOf(ControlAuthError);
  });
});

describe("KJ-P4B.1 the long-lived key never crosses the boundary", () => {
  it("is absent from every transmitted header, in clear, hex or base64", () => {
    const r = rig();
    const sign = r.signWith("v1", CONTROL_TEST_KEY);
    for (let i = 0; i < 50; i++) {
      const wire = JSON.stringify(sign({ ...request({ key: `1111111${i % 10}-1111-4111-8111-111111111111` }), tenantId: TENANT, principalId: PRINCIPAL }));
      expect(wire).not.toContain(CONTROL_TEST_KEY);
      expect(wire).not.toContain(Buffer.from(CONTROL_TEST_KEY).toString("hex"));
      expect(wire).not.toContain(Buffer.from(CONTROL_TEST_KEY).toString("base64"));
      expect(wire).not.toContain(Buffer.from(CONTROL_TEST_KEY).toString("base64url"));
    }
  });

  it("returns exactly six headers, each a non-secret assertion field", () => {
    const r = rig();
    const h = r.signWith("v1", KEY)({ ...request(), tenantId: TENANT, principalId: PRINCIPAL });
    expect(Object.keys(h)).toHaveLength(6);
    for (const v of Object.values(h)) expect(v).not.toContain(KEY);
  });

  it("cannot be substituted by a bearer: the admission bearer or the signing key itself, in Authorization, is not an assertion", async () => {
    const r = rig();
    expect(await r.code(new Map([["authorization", `Bearer ${KEY}`]]))).toBe("MISSING");
    expect(await r.code(new Map([["authorization", "Bearer SYNTHETIC-DOOR-BEARER-0123456789-abcdef"]]))).toBe("MISSING");
    // Nor does an Authorization header rescue an assertion that is otherwise wrong.
    const h = r.made();
    h.set("authorization", `Bearer ${KEY}`);
    h.set(CONTROL_HEADERS.signature, "0".repeat(64));
    expect(await r.code(h)).toBe("SIGNATURE");
  });
});

describe("KJ-P4B.1 key ids and rotation", () => {
  it("recognises the current and the previous key, and the door signs only with the one it is given", async () => {
    const r = rig({ verifierKeys: { v2: CONTROL_OTHER_KEY, v1: KEY } });
    expect(await r.code(r.made())).toBe("ACCEPTED"); // signed with v1, the previous
    const viaNew = r.headers(r.signWith("v2", CONTROL_OTHER_KEY)({ ...request({ key: "77777777-7777-4777-8777-777777777777" }), tenantId: TENANT, principalId: PRINCIPAL }));
    expect(await r.code(viaNew, request({ key: "77777777-7777-4777-8777-777777777777" }))).toBe("ACCEPTED");
  });

  it("stops recognising the previous key once it is removed", async () => {
    const r = rig({ verifierKeys: { v2: CONTROL_OTHER_KEY } });
    expect(await r.code(r.made())).toBe("UNKNOWN_KEY");
  });

  it("refuses to be built with a short key, a bad id or no key", () => {
    expect(() => createControlSigner({ keyId: "v1", key: "short" })).toThrow();
    expect(() => createControlSigner({ keyId: "bad id", key: KEY })).toThrow();
    const replay = new InMemoryReplayStore();
    const base = { tenantId: TENANT, principalId: PRINCIPAL, freshnessSeconds: 300, replay };
    expect(() => createControlVerifier({ ...base, keys: new Map([["v1", "short"]]) })).toThrow();
    expect(() => createControlVerifier({ ...base, keys: new Map([["bad id", KEY]]) })).toThrow();
    expect(() => createControlVerifier({ ...base, keys: new Map() })).toThrow();
  });

  it("does not put the key in any error it raises", async () => {
    const r = rig();
    const h = r.headers(r.signWith("v1", CONTROL_TEST_KEY)({ ...request(), tenantId: TENANT, principalId: PRINCIPAL }));
    const error = await r.verify(h, request()).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(String(error?.message) + String(error?.stack)).not.toContain(CONTROL_TEST_KEY);
    expect(String(error?.message) + String(error?.stack)).not.toContain(KEY);
  });
});
