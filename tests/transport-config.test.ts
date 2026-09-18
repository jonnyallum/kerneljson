import { describe, it, expect } from "vitest";
import { loadTransportConfig } from "../services/kernel/src/alerting/transport-config.js";

describe("loadTransportConfig", () => {
  it("defaults to console when ALERT_TRANSPORT is unset or empty", () => {
    expect(loadTransportConfig({})).toEqual({ mode: "console" });
    expect(loadTransportConfig({ ALERT_TRANSPORT: "" })).toEqual({ mode: "console" });
  });

  it("selects console explicitly", () => {
    expect(loadTransportConfig({ ALERT_TRANSPORT: "console" })).toEqual({ mode: "console" });
  });

  it("selects telegram when both required values are present", () => {
    expect(
      loadTransportConfig({
        ALERT_TRANSPORT: "telegram",
        TELEGRAM_BOT_TOKEN: "123:abc",
        TELEGRAM_CHAT_ID: "-100999",
      }),
    ).toEqual({ mode: "telegram", botToken: "123:abc", chatId: "-100999" });
  });

  it("fails closed — never silently falls back to console — when TELEGRAM_BOT_TOKEN is missing", () => {
    expect(() => loadTransportConfig({ ALERT_TRANSPORT: "telegram", TELEGRAM_CHAT_ID: "-100999" })).toThrow(
      /TELEGRAM_BOT_TOKEN/,
    );
  });

  it("fails closed when TELEGRAM_CHAT_ID is missing", () => {
    expect(() => loadTransportConfig({ ALERT_TRANSPORT: "telegram", TELEGRAM_BOT_TOKEN: "123:abc" })).toThrow(
      /TELEGRAM_CHAT_ID/,
    );
  });

  it("fails closed when both are missing", () => {
    expect(() => loadTransportConfig({ ALERT_TRANSPORT: "telegram" })).toThrow();
  });

  it("fails closed when either value is set but empty", () => {
    expect(() =>
      loadTransportConfig({ ALERT_TRANSPORT: "telegram", TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "-100999" }),
    ).toThrow();
  });

  it("rejects an unrecognised ALERT_TRANSPORT value rather than guessing", () => {
    expect(() => loadTransportConfig({ ALERT_TRANSPORT: "slack" })).toThrow(/console.*telegram|telegram.*console/i);
  });

  it("never includes a secret value in its own thrown error message", () => {
    try {
      loadTransportConfig({ ALERT_TRANSPORT: "telegram", TELEGRAM_BOT_TOKEN: "super-secret-token-value" });
      throw new Error("expected loadTransportConfig to throw");
    } catch (err) {
      expect(String(err)).not.toContain("super-secret-token-value");
    }
  });
});
