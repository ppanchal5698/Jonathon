import { defineConfig } from "vitest/config";

/** Optional live tests against the real Antigravity CLI. They send fictional text to the model provider. */
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.live.test.ts", "apps/*/test/**/*.live.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
});
