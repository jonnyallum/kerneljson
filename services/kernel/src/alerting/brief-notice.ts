/**
 * The second exception to "never forward a row's message to a transport" (the first is operator-reply.ts).
 *
 * A completed morning brief is worthless as `<checkId>: NEW (P3)`: the brief IS the notification. So
 * exactly one check-id shape, `MISSION.morningBrief.<8 hex>.completed`, keeps its own text. That is
 * safe only because of who creates such rows: the brief mission, after the ledger has committed
 * COMPLETED, from a brief whose every item cited the persisted evidence and passed an independent
 * review (see mission/brief.ts briefMessage). A failed brief keeps the redacted summary, and any
 * other check id keeps the old behaviour; a test pins all three.
 */
const BRIEF_COMPLETED = /^MISSION\.morningBrief\.[0-9a-f]{8}\.completed$/;

export const isBriefCompletedCheckId = (checkId: string): boolean => BRIEF_COMPLETED.test(checkId);

export const briefCheckId = (taskId: string, status: "COMPLETED" | "FAILED"): string =>
  `MISSION.morningBrief.${taskId.slice(0, 8)}.${status.toLowerCase()}`;
