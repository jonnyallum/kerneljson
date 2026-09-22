import type { MemoryClass } from "../../../../packages/contracts/src/index.js";

/**
 * KJ-P5 - deterministic classification of the text after Telegram `/remember`. No model is involved: the operator can
 * always be explicit with a leading class label (`preference: ...`), and otherwise a few plain phrases decide, with FACT
 * as the fallback. RELATIONSHIP is only ever chosen by an explicit label, because it is identity-adjacent and needs approval.
 */
const LABELS: Readonly<Record<string, MemoryClass>> = Object.freeze({
  fact: "FACT",
  preference: "PREFERENCE",
  decision: "DECISION",
  commitment: "COMMITMENT",
  lesson: "LESSON",
  episode: "EPISODE",
  relationship: "RELATIONSHIP",
  project: "PROJECT_KNOWLEDGE",
});

const LABELLED = /^(fact|preference|decision|commitment|lesson|episode|relationship|project)[ ]*:[ ]*(.+)$/is;
const PREFERENCE = /(^|[ ])(i prefer|prefer |i like|i want|i would rather|i'd rather|always |never )/i;
const DECISION = /((we|i) (decided|agreed|chose))|^decision:/i;
const COMMITMENT = /(i|we) (will|must|promise|commit)[ ]/i;
const LESSON = /(lesson|learned|learnt)/i;

export function classifyRemember(text: string): { class: MemoryClass; content: string; explicit: boolean } {
  const trimmed = text.trim();
  const labelled = LABELLED.exec(trimmed);
  const label = labelled?.[1]?.toLowerCase();
  const body = labelled?.[2]?.trim();
  if (label !== undefined && body !== undefined && body.length > 0) return { class: LABELS[label] as MemoryClass, content: body, explicit: true };
  if (PREFERENCE.test(trimmed)) return { class: "PREFERENCE", content: trimmed, explicit: false };
  if (DECISION.test(trimmed)) return { class: "DECISION", content: trimmed, explicit: false };
  if (COMMITMENT.test(trimmed)) return { class: "COMMITMENT", content: trimmed, explicit: false };
  if (LESSON.test(trimmed)) return { class: "LESSON", content: trimmed, explicit: false };
  return { class: "FACT", content: trimmed, explicit: false };
}
