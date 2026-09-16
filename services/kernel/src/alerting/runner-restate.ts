import * as restate from "@restatedev/restate-sdk";
import type { MonitorConfig } from "./runner-config.js";
import type { RunSummary } from "./runner.js";

export const ALERT_MONITOR = "ProductionAlertMonitor";
export const MONITOR_KEY = "production";
export interface Tick {
  sequence: number;
}
export interface MonitorContinuation {
  key: string;
  getNext(): Promise<number | null>;
  run(): Promise<RunSummary>;
  advance(next: number, delayMs: number): void;
}

/** Restate owns only this continuation cursor and delayed delivery, not task truth. */
export async function monitorTick(
  ctx: MonitorContinuation,
  req: Tick,
  cfg: MonitorConfig,
) {
  if (
    ctx.key !== MONITOR_KEY ||
    !req ||
    typeof req !== "object" ||
    !Number.isSafeInteger(req.sequence) ||
    req.sequence < 0 ||
    req.sequence >= Number.MAX_SAFE_INTEGER
  )
    throw new restate.TerminalError("Invalid monitor key or sequence", {
      errorCode: 400,
    });
  if (!cfg.enabled) return { result: "DISABLED" as const };
  if (req.sequence !== ((await ctx.getNext()) ?? 0))
    return { result: "DUPLICATE_OR_OUT_OF_ORDER" as const };
  const summary = await ctx.run();
  ctx.advance(req.sequence + 1, cfg.cadenceMs);
  return summary;
}

type MonitorApi = {
  tick: (ctx: restate.ObjectContext, req: Tick) => Promise<unknown>;
};
export function createAlertMonitorService(
  cfg: MonitorConfig,
  run: () => Promise<RunSummary>,
) {
  return restate.object({
    name: ALERT_MONITOR,
    handlers: {
      tick: async (ctx: restate.ObjectContext, req: Tick) =>
        monitorTick(
          {
            key: ctx.key,
            getNext: () => ctx.get<number>("nextSequence"),
            run: () =>
              ctx.run("collect-evaluate-persist-notify", async () => {
                console.log(
                  JSON.stringify({
                    event: "alert_monitor_started",
                    sequence: req.sequence,
                    startedAt: new Date().toISOString(),
                  }),
                );
                const summary = await run();
                console.log(
                  JSON.stringify({
                    event: "alert_monitor_run",
                    sequence: req.sequence,
                    ...summary,
                  }),
                );
                return summary;
              }),
            advance: (sequence, delay) => {
              ctx.set("nextSequence", sequence);
              ctx
                .objectSendClient<MonitorApi>(
                  { name: ALERT_MONITOR },
                  MONITOR_KEY,
                )
                .tick({ sequence }, restate.rpc.sendOpts({ delay }));
            },
          },
          req,
          cfg,
        ),
      status: restate.handlers.object.shared(
        async (ctx: restate.ObjectSharedContext) => ({
          enabled: cfg.enabled,
          cadenceMs: cfg.cadenceMs,
          nextSequence: (await ctx.get<number>("nextSequence")) ?? 0,
        }),
      ),
    },
  });
}
