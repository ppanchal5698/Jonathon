/**
 * Back up the database AND the authoritative files, with a SHA-256 manifest.
 *
 *   pnpm backup --out <empty dir>            offline backup: refuses while a worker heartbeat is fresh (stop the stack first)
 *   pnpm backup --out <empty dir> --online   online backup of a running system (DB snapshot first; see services/backup.ts)
 *   pnpm backup --verify <backup dir>        re-hash every file and run SQLite's integrity check
 *
 * Docker: docker compose --profile tools run --rm backup  (see docs/docker.md).
 */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createBackup, loadConfig, loadDotEnv, verifyBackup } from "@jonathon/core";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

loadDotEnv();
const verifyDir = arg("--verify");
if (verifyDir) {
  const { manifest, problems } = verifyBackup(verifyDir);
  if (problems.length) {
    console.error(`backup INVALID (${problems.length} problem(s)):\n  ${problems.slice(0, 50).join("\n  ")}`);
    process.exit(1);
  }
  console.log(
    `backup ok: ${manifest!.files.length} files, created ${manifest!.created_at} (${manifest!.mode}), migrations ${manifest!.database.migrations.join(",")}`,
  );
  process.exit(0);
}

const out = arg("--out");
if (!out) {
  console.error("usage: backup --out <empty directory> [--online] | --verify <backup directory>");
  process.exit(2);
}
const online = args.includes("--online");
const config = loadConfig();
if (!existsSync(config.dbPath)) {
  console.error(`no database at ${config.dbPath}; is the data directory mounted?`);
  process.exit(1);
}
const db = new DatabaseSync(config.dbPath, { timeout: 10_000 });
try {
  if (!online) {
    const hb = db.prepare("SELECT last_seen_at FROM worker_heartbeats ORDER BY last_seen_at DESC LIMIT 1").get() as { last_seen_at: string } | undefined;
    if (hb && Date.now() - Date.parse(hb.last_seen_at) < 60_000) {
      console.error("a worker is running (fresh heartbeat). Stop the API and worker for an exact offline backup, or pass --online.");
      process.exit(1);
    }
  }
  const m = createBackup(db, config.dataDir, out, online ? "online" : "offline");
  const v = verifyBackup(out);
  if (v.problems.length) {
    console.error(`backup written but failed verification:\n  ${v.problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`backup ok: ${out} (${m.mode}; ${m.files.length} files; ${JSON.stringify(m.counts)})`);
} finally {
  db.close();
}
