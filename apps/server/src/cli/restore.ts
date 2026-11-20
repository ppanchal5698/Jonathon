/**
 * Restore a backup into the configured data directory, then reconcile files with the database.
 * The API and worker MUST be stopped. Current data is moved to <data>/pre-restore-<timestamp>/, never deleted.
 *
 *   pnpm restore --from <backup dir> --yes
 *
 * Docker: docker compose stop server worker web
 *         docker compose --profile tools run --rm restore --from /backups/<name> --yes
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { reconcileAfterRestore, loadConfig, loadDotEnv, restoreBackup } from "@jonathon/core";

const args = process.argv.slice(2);
const from = args[args.indexOf("--from") + 1];
if (!args.includes("--from") || !from) {
  console.error("usage: restore --from <backup directory> --yes");
  process.exit(2);
}
if (!args.includes("--yes")) {
  console.error("restore replaces the live database and projects/ (they are moved aside, not deleted). Re-run with --yes to proceed.");
  process.exit(2);
}
loadDotEnv();
const config = loadConfig();
if (existsSync(config.dbPath)) {
  const db = new DatabaseSync(config.dbPath, { timeout: 5_000 });
  const hb = db.prepare("SELECT last_seen_at FROM worker_heartbeats ORDER BY last_seen_at DESC LIMIT 1").get() as { last_seen_at: string } | undefined;
  db.close();
  if (hb && Date.now() - Date.parse(hb.last_seen_at) < 60_000) {
    console.error("a worker is running (fresh heartbeat). Stop the API and worker first.");
    process.exit(1);
  }
}
const r = restoreBackup(from, config.dataDir, config.dbPath.split(/[\\/]/).pop());
console.log(`restored backup from ${r.manifest.created_at} (${r.manifest.mode}); previous data moved to ${r.moved_aside ?? "(nothing to move)"}`);
const report = reconcileAfterRestore(config);
console.log(`reconciled: ${JSON.stringify(report)}`);
