import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

/**
 * KJ-P8 B1: the frozen manifest and the B1 migration are generated from the inventory and decisions. Moved unchanged
 * from tests/runtime-roles-catalogue.integration.test.ts into lane A: it needs no database, and it reads the B1
 * migration, which a stage T consumer may not do (ADR-0023 27.12.15 "Authority of a regression consumer").
 */
describe("B1 frozen manifest and migration are generated, not hand-edited", () => {
  it("the committed manifest and migration equal what the inventory and decisions produce", () => {
    expect(execFileSync("node", ["scripts/b1/build-manifest.mjs", "--check"], { encoding: "utf8" })).toContain("match their inputs");
  });
});
