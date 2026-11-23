import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createLogger, createRuntime, DemoExtractiveRuntime, type JonathonApp, loadConfig } from "@jonathon/core";
import { FAKE_AGY } from "@jonathon/test-fixtures";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/server";
import { freePort } from "./free-port";

let app: JonathonApp;
let api: FastifyInstance;
let mcp: FastifyInstance;
let dataDir: string;
let API = "";
let MCP = "";

beforeAll(async () => {
  const [apiPort, mcpPort] = [await freePort(), await freePort()];
  dataDir = mkdtempSync(join(tmpdir(), "jon-surface-"));
  const config = loadConfig({
    JONATHON_DATA_DIR: dataDir,
    JONATHON_PORT: String(apiPort),
    JONATHON_MCP_PORT: String(mcpPort),
    JONATHON_LOG_LEVEL: "silent",
    JONATHON_MODE: "demo",
  } as NodeJS.ProcessEnv);
  app = createApp(config, { runtime: new DemoExtractiveRuntime(), log: createLogger("silent", "t") });
  api = await buildServer(app, { surface: "api", port: apiPort });
  mcp = await buildServer(app, { surface: "mcp", port: mcpPort });
  await api.listen({ host: "127.0.0.1", port: apiPort });
  await mcp.listen({ host: "127.0.0.1", port: mcpPort });
  API = `http://127.0.0.1:${apiPort}`;
  MCP = `http://127.0.0.1:${mcpPort}`;
});

afterAll(async () => {
  await api?.close();
  await mcp?.close();
  app?.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

describe("separate MCP listener (JONATHON_MCP_PORT)", () => {
  it("the MCP listener serves only /mcp and health: the REST API and account setup are not reachable there", async () => {
    expect((await fetch(`${MCP}/api/v1/health`)).status).toBe(200);
    expect((await fetch(`${MCP}/api/v1/ready`)).status).toBe(200);
    expect((await fetch(`${MCP}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    for (const [method, path] of [
      ["GET", "/api/v1/setup/status"],
      ["POST", "/api/v1/setup/account"],
      ["POST", "/api/v1/auth/login"],
      ["GET", "/api/v1/projects"],
      ["GET", "/api/v1/auth/google/start"],
    ] as const) {
      const r = await fetch(`${MCP}${path}`, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      expect([path, r.status]).toEqual([path, 404]);
    }
  });

  it("the API listener serves REST but not /mcp", async () => {
    expect((await fetch(`${API}/api/v1/setup/status`)).status).toBe(200);
    expect((await fetch(`${API}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);
  });

  it("token creation reports the MCP listener's address", () => {
    expect(app.ctx.config.mcpPublicUrl).toBe(`${MCP}/mcp`);
  });
});

describe("runtime folder outside the data directory (JONATHON_RUNTIME_DIR)", () => {
  it("agy's working folder, settings and schemas live under the runtime folder; no data-directory path reaches agy", async () => {
    const data = mkdtempSync(join(tmpdir(), "jon-rt-data-"));
    const runtimeDir = mkdtempSync(join(tmpdir(), "jon-rt-run-"));
    const rec = join(runtimeDir, "record.json");
    const config = loadConfig({
      JONATHON_DATA_DIR: data,
      JONATHON_RUNTIME_DIR: runtimeDir,
      JONATHON_LOG_LEVEL: "silent",
      JONATHON_MODE: "live",
      AGY_PATH: process.execPath,
      JONATHON_ALLOW_TEST_HOOKS: "true",
      AGY_ARGS_PREFIX_JSON: JSON.stringify([FAKE_AGY, "--scenario", "answer-cite", "--record", rec, "--"]),
    } as NodeJS.ProcessEnv);
    const rt = createRuntime(config, createLogger("silent", "t"));
    const r = await rt.run({ projectId: "prj_0000000000000000000000000a", prompt: "<question>\nq\n</question>", schema: "answer" });
    expect(r.completion).toBe("success");
    const seen = JSON.parse(readFileSync(rec, "utf8")) as { args: string[]; cwd: string };
    const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
    expect(norm(seen.cwd).startsWith(norm(runtimeDir))).toBe(true);
    const agyArgs = seen.args.join(" ");
    expect(norm(agyArgs)).not.toContain(norm(data));
    expect(norm(agyArgs)).toContain(norm(runtimeDir));
    rmSync(data, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true, maxRetries: 3 });
  });
});
