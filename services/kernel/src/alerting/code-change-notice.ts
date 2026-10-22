/**
 * The third exception to "never forward a row's message to a transport" (after operator-reply.ts and
 * brief-notice.ts).
 *
 * A code-change notice is useless as `<checkId>: NEW (P3)`: Jonny needs the repository, the reason it failed
 * or the draft PR's link. So exactly one check-id shape, `MISSION.codeChange.<8 hex>.<started|failed|opened>`,
 * keeps its own text. That is safe only because of who creates such rows: the code-change mission, from
 * fixed templates over kernel-held values (the allowlisted repository, a failure code or check names, and a
 * PR link GitHub returned and the kernel validated). No model or diff text ever reaches it
 * (see mission/code-change-mission.ts codeChangeText). Any other check id keeps the old behaviour.
 */
const CODE_CHANGE = /^MISSION\.codeChange\.[0-9a-f]{8}\.(started|failed|opened)$/;

export const isCodeChangeCheckId = (checkId: string): boolean => CODE_CHANGE.test(checkId);

export type CodeChangeNoticeStatus = "STARTED" | "FAILED" | "PR_OPENED";

export const codeChangeCheckId = (taskId: string, status: CodeChangeNoticeStatus): string =>
  `MISSION.codeChange.${taskId.slice(0, 8)}.${status === "PR_OPENED" ? "opened" : status.toLowerCase()}`;
