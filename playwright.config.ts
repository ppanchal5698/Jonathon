import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * Browser tests run the real API server, worker and Next.js UI against a throwaway data directory.
 * The runtime is the real Antigravity adapter pointed at the FIXTURE CLI (no network, no model).
 */
const dataDir = process.env.E2E_DATA_DIR ?? mkdtempSync(join(tmpdir(), "jon-e2e-"));
process.env.E2E_DATA_DIR = dataDir;
const API_PORT = 4190;
const WEB_PORT = 3190;
const env = {
  JONATHON_MODE: "live",
  JONATHON_DATA_DIR: dataDir,
  JONATHON_PORT: String(API_PORT),
  JONATHON_WEB_ORIGINS: `http://127.0.0.1:${WEB_PORT}`,
  JONATHON_LOG_LEVEL: "info",
  JONATHON_ASK_WAIT_MS: "3000",
  JONATHON_ALLOW_TEST_HOOKS: "true",
  AGY_PATH: process.execPath,
  AGY_ARGS_PREFIX_JSON: JSON.stringify([join(process.cwd(), "packages/test-fixtures/runtime/fake-agy.mjs"), "--scenario", "answer-cite", "--"]),
  JONATHON_API_URL: `http://127.0.0.1:${API_PORT}`,
  // Own build folder so e2e never collides with a running `pnpm dev`.
  JONATHON_NEXT_DIST_DIR: ".next-e2e",
};

export default defineConfig({
  testDir: "e2e",
  timeout: 300_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  // Uses the system Microsoft Edge on Windows so no browser download is needed; override with PW_CHANNEL.
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "retain-on-failure",
    channel: process.env.PW_CHANNEL ?? (process.platform === "win32" ? "msedge" : undefined),
  },
  webServer: [
    { command: "pnpm --filter @jonathon/server start", url: `http://127.0.0.1:${API_PORT}/api/v1/health`, env, reuseExistingServer: false, timeout: 60_000 },
    { command: "pnpm --filter @jonathon/server start:worker", env, reuseExistingServer: false, timeout: 60_000, wait: { stdout: /worker started/ } },
    {
      command: `pnpm --filter @jonathon/web exec next dev --hostname 127.0.0.1 --port ${WEB_PORT}`,
      url: `http://127.0.0.1:${WEB_PORT}/login`,
      env,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
