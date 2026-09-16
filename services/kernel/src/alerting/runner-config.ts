export interface MonitorConfig {
  enabled: boolean;
  cadenceMs: number;
}

export function loadMonitorConfig(env: NodeJS.ProcessEnv): MonitorConfig {
  const flag = env["ALERT_RUNNER_ENABLED"] || "false";
  if (flag !== "true" && flag !== "false")
    throw new Error("ALERT_RUNNER_ENABLED must be true or false");
  const raw = env["ALERT_RUNNER_CADENCE_MS"] || "300000";
  const cadenceMs = Number(raw);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(cadenceMs) ||
    cadenceMs < 60000 ||
    cadenceMs > 86400000
  )
    throw new Error(
      "ALERT_RUNNER_CADENCE_MS must be an integer between 60000 and 86400000",
    );
  if (
    flag === "true" &&
    env["ALERT_STATE_STORE"] &&
    env["ALERT_STATE_STORE"] !== "postgres"
  )
    throw new Error(
      "Alert runner requires postgres state; memory is forbidden",
    );
  return { enabled: flag === "true", cadenceMs };
}
