import * as restate from "@restatedev/restate-sdk";
import type { PollSummary } from "./operator.js";

/**
 * KJ-P4A - the durable loop under the Telegram channel adapter, shaped exactly like the alert
 * monitor's (`alerting/runner-restate.ts`): one virtual-object key, a numbered tick, a delayed
 * self-send to arm the next one. Restate owns only that cursor and the delayed wake. It does not own
 * task truth, and it is not a scheduler: it decides nothing about WHEN work is admitted, only when the
 * adapter next asks Telegram whether there is a message.
 *
 * Exclusive per key, so two polls can never run at once. `tick` is idempotent on `sequence`: a
 * duplicate or out-of-order invocation is a no-op. The chain is started once, deliberately, by sending
 * `{"sequence": 0}` to `poll` (see the runbook), just as the monitor's was.
 */
export const TELEGRAM_OPERATOR = "TelegramOperator";
export const OPERATOR_KEY = "operator";

export interface PollRequest {
  sequence: number;
}
export interface Timing {
  pollIntervalMs: number;
  errorDelayMs: number;
}
export interface OperatorContinuation {
  key: string;
  getNext(): Promise<number | null>;
  run(): Promise<PollSummary>;
  advance(next: number, delayMs: number): void;
}

export async function operatorTick(ctx: OperatorContinuation, req: PollRequest, timing: Timing) {
  if (
    ctx.key !== OPERATOR_KEY ||
    !req ||
    typeof req !== "object" ||
    !Number.isSafeInteger(req.sequence) ||
    req.sequence < 0 ||
    req.sequence >= Number.MAX_SAFE_INTEGER
  )
    throw new restate.TerminalError("Invalid operator key or sequence", { errorCode: 400 });
  if (req.sequence !== ((await ctx.getNext()) ?? 0)) return { result: "DUPLICATE_OR_OUT_OF_ORDER" as const };
  const summary = await ctx.run();
  // A failed poll (bad token, a webhook clash, Telegram down) waits longer before the next attempt.
  ctx.advance(req.sequence + 1, summary.result === "OK" ? timing.pollIntervalMs : timing.errorDelayMs);
  return summary;
}

type OperatorApi = { poll: (ctx: restate.ObjectContext, req: PollRequest) => Promise<unknown> };

export function createTelegramOperatorService(timing: Timing, run: () => Promise<PollSummary>) {
  return restate.object({
    name: TELEGRAM_OPERATOR,
    handlers: {
      poll: async (ctx: restate.ObjectContext, req: PollRequest) =>
        operatorTick(
          {
            key: ctx.key,
            getNext: () => ctx.get<number>("nextSequence"),
            run: () =>
              ctx.run("poll-and-handle", async () => {
                const summary = await run();
                // Counts and a class name only: never a message, an id, a chat id or a token.
                if (summary.received > 0 || summary.result !== "OK")
                  console.log(JSON.stringify({ event: "telegram_operator_poll", sequence: req.sequence, ...summary }));
                return summary;
              }),
            advance: (sequence, delay) => {
              ctx.set("nextSequence", sequence);
              ctx
                .objectSendClient<OperatorApi>({ name: TELEGRAM_OPERATOR }, OPERATOR_KEY)
                .poll({ sequence }, restate.rpc.sendOpts({ delay }));
            },
          },
          req,
          timing,
        ),
      status: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext) => ({
        nextSequence: (await ctx.get<number>("nextSequence")) ?? 0,
      })),
    },
  });
}
