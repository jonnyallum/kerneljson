/**
 * Phase S1 — KernelJSON production scheduler MVP (prep).
 *
 * Isolated, additive, removable. Nothing else in the kernel imports this module,
 * so deleting the folder + its test removes S1 entirely. The scheduler decides
 * only WHEN an admission request is emitted; KernelJSON Admission owns whether
 * canonical work exists.
 *
 * NOT wired to any runtime, timer, DB, or Restate durable execution yet — see
 * PHASE_S1_KERNELJSON_PRODUCTION_SCHEDULER_MVP_PREP_2026-09-10.md for the
 * durability/persistence design and the ownership boundaries.
 */
export * from "./spec.js";
export * from "./time.js";
export * from "./fire.js";
export * from "./policy.js";
export * from "./runtime.js";
export * from "./persistence.js";
export * from "./store.js";
export * from "./durable-timer.js";
