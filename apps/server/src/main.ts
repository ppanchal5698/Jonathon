import { assertDataDirReady, createApp, loadConfig, loadDotEnv } from "@jonathon/core";
import { buildServer } from "./server";

/** API + MCP server. Binds to loopback by default. The worker is a separate process (worker.ts). */
async function main() {
  loadDotEnv();
  const config = loadConfig();
  assertDataDirReady(config);
  const app = createApp(config);
  const log = app.ctx.log;
  if (config.mode === "demo") log.warn("DEMO MODE: no AI runtime is used; answers are extractive and labelled demo-extractive");
  const deletes = app.projects.recoverInterruptedDeletes();
  if (deletes.restored.length || deletes.purged.length) log.warn(deletes, "recovered interrupted project deletions");
  const completed = app.ctx.store.completeIntents();
  if (completed.length) log.warn({ completed }, "completed interrupted knowledge writes");
  // One listener (native default), or REST and MCP on separate ports (JONATHON_MCP_PORT; Docker publishes only MCP).
  const servers = config.mcpPort
    ? [await buildServer(app, { surface: "api", port: config.port }), await buildServer(app, { surface: "mcp", port: config.mcpPort })]
    : [await buildServer(app)];
  await servers[0]!.listen({ host: config.host, port: config.port });
  if (servers[1]) await servers[1].listen({ host: config.host, port: config.mcpPort! });
  log.info(
    { host: config.host, port: config.port, mcp_port: config.mcpPort ?? config.port, data_dir: config.dataDir, mode: config.mode },
    "Jonathon API listening",
  );

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down API");
    await Promise.all(servers.map((s) => s.close()));
    app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  // Never print config or env; message only.
  console.error(`Jonathon API failed to start: ${(e as Error).message}`);
  process.exit(1);
});
