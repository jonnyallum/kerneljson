import pg from "pg";
import { deliverRows } from "../../alerting/delivery-worker.js";
import { isOperatorReplyCheckId } from "../../alerting/operator-reply.js";
import { PgNotificationOutboxStore } from "../../alerting/pg-outbox-store.js";
import { selectNotifier } from "../../alerting/select-notifier.js";
import { loadTransportConfig } from "../../alerting/transport-config.js";
import { loadApprovalBoundaryConfig } from "../../approval-boundary.js";
import { createApprovalsPort } from "./approvals.js";
import { HttpBotApi } from "./bot-api.js";
import { PgCardStore } from "./pg-card-store.js";
import { HttpDoorClient } from "./door-client.js";
import { PgInboxStore } from "./pg-inbox-store.js";
import { pollOnce } from "./operator.js";
import { loadOperatorConfig } from "./operator-config.js";
import { createTelegramOperatorService } from "./restate-service.js";
import { PgStatusReader } from "./status.js";
import { HttpUpdateSource } from "./updates.js";

/**
 * KJ-P4A - wire the channel adapter from the environment. Returns undefined unless
 * TELEGRAM_INBOUND_ENABLED=true, in which case the worker registers exactly what it did before.
 * Config problems throw here, at startup, before any connection or registration.
 */
export function productionTelegramOperator(env: NodeJS.ProcessEnv) {
  const config = loadOperatorConfig(env);
  if (!config) return undefined;
  const { notifier, transport } = selectNotifier(loadTransportConfig(env));
  // A separate bounded pool, like the monitor's: the channel cannot starve the task worker.
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 3,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    query_timeout: 15000,
  });
  pool.on("error", () => console.error("telegram_operator_pool_error"));
  const outbox = new PgNotificationOutboxStore(pool);
  const delivery = { outbox, notifier, transport };
  const door = new HttpDoorClient(config.admissionUrl, config.authorization);
  // KJ-P4B: approval cards and buttons, only when the approval boundary is configured too. The channel
  // shows approvals for the door's one principal in the door's tenant, and asks the door to answer them.
  const boundary = loadApprovalBoundaryConfig(env);
  const approvals = boundary
    ? createApprovalsPort({
        tenantId: boundary.tenantId,
        approverId: boundary.principalId,
        cards: new PgCardStore(pool),
        bot: new HttpBotApi({ botToken: config.botToken, chatId: config.chatId }),
        door,
        now: () => new Date(),
      })
    : undefined;
  const deps = {
    limits: config.limits,
    source: new HttpUpdateSource({ botToken: config.botToken, callbackQueries: approvals !== undefined }),
    inbox: new PgInboxStore(pool),
    door,
    ...(approvals ? { approvals } : {}),
    status: new PgStatusReader(pool),
    outbox,
    deliver: async (ids: readonly string[]) => {
      await deliverRows(delivery, ids);
    },
    // Replies an earlier attempt could not send (Telegram was down, the worker restarted) are retried
    // at the start of every poll, on the outbox's own backoff, well before the monitor's next tick.
    deliverDue: async () => {
      const due = await outbox.listDue(new Date().toISOString(), 50);
      const ids = due.filter((row) => isOperatorReplyCheckId(row.checkId)).map((row) => row.notificationId);
      if (ids.length > 0) await deliverRows(delivery, ids);
    },
    now: () => new Date(),
  };
  return createTelegramOperatorService(
    { pollIntervalMs: config.pollIntervalMs, errorDelayMs: config.errorDelayMs },
    () => pollOnce(deps),
  );
}
