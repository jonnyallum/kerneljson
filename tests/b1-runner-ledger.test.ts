import { describe, it } from "vitest";
import { CASE_TIMEOUT, expectFixturePassed, runCase } from "./support/b1-runner.js";
import type { Profile } from "../scripts/b1/hooks.js";

/**
 * ADR-0023 27.12.11 and 27.12.9 LEDGER-B to LEDGER-F, the six frozen _ledger snapshot refusals (CON-45) and EPH-13,
 * through the governed runner and the pinned engine. LEDGER-A is the unhooked positive control in
 * b1-runner-lifecycle.test.ts. The ledger state is set by a registered hook, never by the runner or the engine.
 */
const t=(label:string,profile:Profile,hooks:string[])=>
  it.concurrent(label,async()=>{expectFixturePassed(await runCase(label,profile,hooks));},CASE_TIMEOUT);

describe.concurrent("CON-45 the six frozen _ledger snapshot refusals (S2, refused at S3)",()=>{
  t("ledger absent","none",["ledger-absent"]);
  t("ledger head wrong (EPH-13 newest)","none",["ledger-wrong-head"]);
  t("ledger gap of three","none",["ledger-gap"]);
  t("ledger extra row","none",["ledger-extra"]);
  t("ledger records B1","none",["ledger-b1-recorded"]);
  t("stamp function absent","none",["stamp-missing"]);
});
describe.concurrent("EPH-13 a missing base row at S2 (refused at S3, before the gate)",()=>{
  t("EPH-13 oldest","none",["ledger-oldest-missing"]);
  t("EPH-13 middle","none",["ledger-middle-missing"]);
});
describe.concurrent("LEDGER cases after the snapshot",()=>{
  t("LEDGER-B B1 applied outside the engine: S7 fails ledger set equality","none",["b1-outside-engine"]);
  t("LEDGER-C B1 already recorded: the gate refuses, the engine is not invoked","none",["ledger-b1-row-after-snapshot"]);
  t("LEDGER-D commit-time failure: no B1 effect and no B1 row","none",["ledger-commit-failure"]);
  t("LEDGER-E oldest missing","none",["ledger-oldest-missing-after-snapshot"]);
  t("LEDGER-E middle missing","none",["ledger-middle-missing-after-snapshot"]);
  t("LEDGER-E newest missing","none",["ledger-newest-missing-after-snapshot"]);
  t("LEDGER-F extra version","none",["ledger-extra-after-snapshot"]);
});
