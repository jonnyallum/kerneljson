import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // KJ-P8 B1: production code under test runs as kj_worker / kj_door, never as the database owner.
    setupFiles: ["tests/support/runtime-roles.ts"],
    testTimeout: 120000,
    hookTimeout: 120000,
    fileParallelism: false,
  },
});
