import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { testDatabase, type TestDatabase } from "./support/database.js";
import { readRelations, RELATION_INVENTORY_PATH } from "../scripts/b1/relation-inventory.js";
import { strictJson } from "../services/kernel/src/database/strict-json.js";

/**
 * Lane A (base-regression): the committed relation inventory equals the base chain's catalogue. The declared refusals
 * of the relation probes in tests/b1-required.json are derived from it, so drift here fails before any stage T run.
 */
let database: TestDatabase;
beforeAll(async () => { database = await testDatabase("kj_relation_inventory"); });
afterAll(async () => { await database?.close(); });
it("the committed relation inventory equals the base chain's relations in public and kernel_private", async () => {
  expect(await readRelations(database.pool)).toEqual(strictJson(readFileSync(RELATION_INVENTORY_PATH, "utf8")));
});
