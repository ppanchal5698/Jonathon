import { writeFileSync } from "node:fs";
import { assertDataDirReady, createApp, loadConfig, loadDotEnv } from "@jonathon/core";

/**
 * Background worker: ingestion, answering, AI interpretation, reindex. Separate process so a slow runtime or a
 * parser never blocks the API. Shares the SQLite file with the API; leases make crashes recoverable.
 */
async function main() {
  loadDotEnv();
  const config = loadConfig();
  assertDataDirReady(config);
  const app = createApp(config);
  const log = app.ctx.log.child({ component: "worker" });
  const deletes = app.projects.recoverInterruptedDeletes();
  if (deletes.restored.length || deletes.purged.length) log.warn(deletes, "recovered interrupted project deletions");
  // Local-only diagnostics at startup (version + flags). The provider auth check is NOT run automatically.
  const diag = await app.ops.runtimeDiagnostics(false);
  log.info({ runtime: diag.status, provider: diag.provider }, "runtime inspected");
  const sweep = () => {
    try {
      const n = app.ops.sweepExpired();
      if (Object.values(n).some((v) => v > 0)) log.info(n, "expired records removed");
    } catch (e) {
      log.warn({ err: (e as Error).message }, "expired-record sweep failed");
    }
  };
  sweep();
  const sweeper = setInterval(sweep, 3_600_000);
  sweeper.unref();
  const worker = app.startWorker();
  log.info({ worker_id: worker.workerId, concurrency: config.workerConcurrency }, "worker started");
  // Docker worker with its own agy home: handle "Sign in with Google" / "Sign out" requests from the UI.
  const authAgent = config.agyHome && config.mode === "live" ? app.startRuntimeAuthAgent() : null;
  if (authAgent) log.info("agy sign-in requests are handled by this worker");

  // Container health check: a file whose mtime advances only while this worker's own heartbeat row (written by the
  // job loop) is fresh. A hung loop therefore turns the container unhealthy. Path from JONATHON_HEALTH_FILE.
  const healthFile = process.env.JONATHON_HEALTH_FILE;
  const health = healthFile
    ? setInterval(() => {
        try {
          const row = app.ctx.db.prepare("SELECT last_seen_at FROM worker_heartbeats WHERE worker_id = ?").get(worker.workerId) as
            | { last_seen_at: string }
            | undefined;
          if (row && Date.now() - Date.parse(row.last_seen_at) < 30_000) writeFileSync(healthFile, row.last_seen_at);
        } catch {
          /* unhealthy: file goes stale */
        }
      }, 10_000)
    : null;

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    if (health) clearInterval(health);
    log.info({ signal, active: worker.activeJobs }, "stopping worker; releasing running jobs");
    await authAgent?.stop();
    await app.ctx.runtime.cancel();
    await worker.stop();
    app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error(`Jonathon worker failed to start: ${(e as Error).message}`);
  process.exit(1);
});
