/**
 * KJ-P4A - the one exception to "never forward a row's message to a transport".
 *
 * `delivery-worker.ts` deliberately replaces every outbox row's text with `<checkId>: <kind>
 * (<severity>)` before it reaches a notifier, because an alert's message can carry observation data
 * (URLs, errors). An operator reply is different in kind: it is the answer to a command Jonny sent,
 * and it is worthless if the text is withheld.
 *
 * So exactly one check-id shape, `OPERATOR.reply.<telegram update id>`, keeps its own text. That is
 * safe only because of who can create such rows: the Telegram channel adapter, which builds every
 * reply from fixed templates over validated fields (see channel/telegram/replies.ts, where the text
 * is a branded `ReplyText` that nothing else can mint). Any other check id keeps the old behaviour,
 * and a test pins both halves.
 */
export const OPERATOR_REPLY_PREFIX = "OPERATOR.reply.";
const OPERATOR_REPLY = /^OPERATOR\.reply\.\d{1,20}$/;

export const isOperatorReplyCheckId = (checkId: string): boolean => OPERATOR_REPLY.test(checkId);

export const operatorReplyCheckId = (updateId: number): string => `${OPERATOR_REPLY_PREFIX}${updateId}`;
