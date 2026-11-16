import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AntigravityCliRuntime, createApp, createLogger, type JonathonApp, loadConfig, type ReasoningRuntime } from "@jonathon/core";
import { FAKE_AGY } from "../../test-fixtures/src/index";

export const USER = { kind: "user" as const, userId: "usr_test", username: "parth" };
export const SYSTEM = { kind: "system" as const, name: "worker" };

export function tempDir(prefix = "jon-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function fakeRuntime(dataDir: string, scenario: string, extra: string[] = [], timeoutMs = 15_000): AntigravityCliRuntime {
  return new AntigravityCliRuntime({
    dataDir,
    executable: process.execPath,
    argsPrefix: [FAKE_AGY, "--scenario", scenario, ...extra, "--"],
    timeoutMs,
    maxOutputBytes: 2 * 1024 * 1024,
    maxPromptChars: 200_000,
  });
}

export interface TestApp {
  app: JonathonApp;
  dataDir: string;
  cleanup(): void;
}

export function makeApp(opts: { scenario?: string; runtime?: ReasoningRuntime; dataDir?: string; env?: Record<string, string> } = {}): TestApp {
  const dataDir = opts.dataDir ?? tempDir();
  const config = loadConfig({
    JONATHON_DATA_DIR: dataDir,
    JONATHON_LOG_LEVEL: "silent",
    JONATHON_ASK_WAIT_MS: "0",
    JONATHON_PARSER_TIMEOUT_MS: "30000",
    ...opts.env,
  } as NodeJS.ProcessEnv);
  const runtime = opts.runtime ?? fakeRuntime(dataDir, opts.scenario ?? "answer-cite");
  const app = createApp(config, { runtime, log: createLogger("silent", "test") });
  // Tests act as the local user: create the account row so approval events reference a real user id.
  app.ctx.db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, created_at) VALUES (?,?,?,?)").run(USER.userId, USER.username, "x", new Date().toISOString());
  return {
    app,
    dataDir,
    cleanup(this: TestApp) {
      try {
        this.app.close();
      } catch {
        /* closed */
      }
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}
