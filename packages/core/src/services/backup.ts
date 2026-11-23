import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
// app.ts → ops.ts → backup.ts → app.ts is a cycle; createApp is only used at call time, which ES modules allow.
import { createApp } from "../app";
import { DATA_DIR_MARKER, type JonathonConfig } from "../config";
import { DemoExtractiveRuntime } from "../runtime/demo";
import { nowIso } from "../util";

/**
 * Backup and restore of BOTH stores:
 *   - SQLite: copied with `VACUUM INTO` (a transactionally consistent snapshot; a plain copy of a live WAL database is not).
 *   - projects/: the authoritative files (originals, extractions, knowledge Markdown, history, documents, graph data).
 *
 * Recovery point.
 *   offline (API and worker stopped): the database snapshot and the file copy describe the same instant. Exact.
 *   online  (running system): the database is snapshotted FIRST, then files are copied. Files can only be newer than
 *           the database, never older. After restore, reconciliation imports newer knowledge files as new revisions
 *           (approvals never carry over to changed content, because approval events bind revision + semantic hash),
 *           and "Import projects found on disk" re-registers newer source revisions. Rebuildable projections (search
 *           index, knowledge projection) are rebuilt from files. Non-rebuildable records (accounts, MCP token hashes,
 *           conversations, jobs, approvals, audit) are exactly those in the database snapshot.
 */

export interface BackupManifest {
  format: "jonathon-backup/1";
  created_at: string;
  mode: "online" | "offline";
  database: { file: "jonathon.sqlite"; sha256: string; bytes: number; migrations: string[]; integrity: string };
  files: { path: string; bytes: number; sha256: string }[];
  counts: Record<string, number>;
}

const sha256File = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

function walk(root: string, base = root, out: string[] = []): string[] {
  if (!existsSync(root)) return out;
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isSymbolicLink()) continue; // Jonathon never creates links in its data root; never follow one into a backup
    if (e.isDirectory()) walk(p, base, out);
    else if (e.isFile()) out.push(relative(base, p).split(sep).join("/"));
  }
  return out;
}

const COUNT_TABLES = [
  "users",
  "projects",
  "sources",
  "source_revisions",
  "knowledge_entities",
  "approval_events",
  "audit_events",
  "mcp_tokens",
  "conversations",
  "messages",
  "jobs",
  "dead_letters",
];

function snapshotInfo(dbPath: string): { migrations: string[]; integrity: string; counts: Record<string, number> } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const integrity = (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
    const migrations = (db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: string }[]).map((r) => r.id);
    const counts: Record<string, number> = {};
    for (const t of COUNT_TABLES) {
      try {
        counts[t] = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
      } catch {
        /* table from a later migration */
      }
    }
    return { migrations, integrity, counts };
  } finally {
    db.close();
  }
}

/**
 * Write a backup directory: jonathon.sqlite + projects/ + manifest.json (hashes of every file).
 * `db` is any open connection to the live database (VACUUM INTO reads a consistent snapshot without blocking writers).
 */
export function createBackup(db: DatabaseSync, dataDir: string, outDir: string, mode: "online" | "offline"): BackupManifest {
  if (existsSync(outDir) && readdirSync(outDir).length) throw new Error(`backup target ${outDir} is not empty`);
  mkdirSync(outDir, { recursive: true });
  const dbOut = join(outDir, "jonathon.sqlite");
  db.exec(`VACUUM INTO '${dbOut.replace(/'/g, "''")}'`);
  const projectsSrc = join(dataDir, "projects");
  if (existsSync(projectsSrc))
    cpSync(projectsSrc, join(outDir, "projects"), {
      recursive: true,
      errorOnExist: true,
      verbatimSymlinks: true,
      filter: (src) => !lstatSync(src).isSymbolicLink(),
    });
  const info = snapshotInfo(dbOut);
  const files = walk(join(outDir, "projects")).map((rel) => {
    const p = join(outDir, "projects", ...rel.split("/"));
    return { path: `projects/${rel}`, bytes: statSync(p).size, sha256: sha256File(p) };
  });
  const manifest: BackupManifest = {
    format: "jonathon-backup/1",
    created_at: nowIso(),
    mode,
    database: { file: "jonathon.sqlite", sha256: sha256File(dbOut), bytes: statSync(dbOut).size, migrations: info.migrations, integrity: info.integrity },
    files,
    counts: { ...info.counts, files: files.length },
  };
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`, { mode: 0o600 });
  return manifest;
}

/** Re-hash everything a manifest lists and re-run SQLite's integrity check. Returns problems (empty = valid). */
export function verifyBackup(dir: string): { manifest: BackupManifest | null; problems: string[] } {
  const problems: string[] = [];
  const mp = join(dir, "manifest.json");
  if (!existsSync(mp)) return { manifest: null, problems: ["manifest.json is missing"] };
  const manifest = JSON.parse(readFileSync(mp, "utf8")) as BackupManifest;
  if (manifest.format !== "jonathon-backup/1") problems.push(`unknown backup format ${manifest.format}`);
  const dbPath = join(dir, manifest.database.file);
  if (!existsSync(dbPath)) problems.push("database file is missing");
  else {
    if (sha256File(dbPath) !== manifest.database.sha256) problems.push("database file hash does not match the manifest");
    const info = snapshotInfo(dbPath);
    if (info.integrity !== "ok") problems.push(`database integrity_check: ${info.integrity}`);
  }
  for (const f of manifest.files) {
    const p = join(dir, ...f.path.split("/"));
    if (!existsSync(p)) problems.push(`missing ${f.path}`);
    else if (sha256File(p) !== f.sha256) problems.push(`hash mismatch ${f.path}`);
  }
  return { manifest, problems };
}

/**
 * Restore a verified backup into `dataDir`. The API and worker MUST be stopped. Existing data is never deleted: the
 * current database files and projects/ are moved into <dataDir>/pre-restore-<timestamp>/ first.
 * Returns where the previous data went. Run reconciliation afterwards (restoreAndReconcile in scripts/restore.ts).
 */
export function restoreBackup(backupDir: string, dataDir: string, dbFileName = "jonathon.sqlite"): { moved_aside: string | null; manifest: BackupManifest } {
  const { manifest, problems } = verifyBackup(backupDir);
  if (!manifest || problems.length) throw new Error(`backup failed verification:\n  ${problems.join("\n  ")}`);
  mkdirSync(dataDir, { recursive: true });
  const existing = [dbFileName, `${dbFileName}-wal`, `${dbFileName}-shm`, "projects"].filter((n) => existsSync(join(dataDir, n)));
  let movedAside: string | null = null;
  if (existing.length) {
    movedAside = join(dataDir, `pre-restore-${nowIso().replace(/[:.]/g, "-")}`);
    mkdirSync(movedAside);
    for (const n of existing) renameSync(join(dataDir, n), join(movedAside, n));
  }
  cpSync(join(backupDir, manifest.database.file), join(dataDir, dbFileName));
  if (existsSync(join(backupDir, "projects"))) cpSync(join(backupDir, "projects"), join(dataDir, "projects"), { recursive: true, errorOnExist: true });
  if (!existsSync(join(dataDir, DATA_DIR_MARKER))) writeFileSync(join(dataDir, DATA_DIR_MARKER), `restored ${nowIso()} from ${manifest.created_at}\n`);
  return { moved_aside: movedAside, manifest };
}

/**
 * After a restore (API and worker stopped): drop heartbeats copied from the snapshot, re-register source revisions
 * whose files are newer than the database snapshot, and reconcile knowledge files with the projection (completes
 * crash intents, imports newer files as new revisions, never carries an approval over to changed content).
 * Jobs that were `running` in the snapshot have expired leases and are recovered by the next worker start.
 */
export function reconcileAfterRestore(config: JonathonConfig): {
  imported: { projects: number; source_revisions: number };
  projects: number;
  external_edits: number;
  intents_completed: number;
  missing: number;
} {
  const app = createApp(config, { runtime: new DemoExtractiveRuntime() });
  try {
    const system = { kind: "system" as const, name: "restore" };
    app.ctx.db.exec("DELETE FROM worker_heartbeats");
    const imported = app.ops.importFromFiles(system);
    const reports = app.ops.reconcile(system);
    return {
      imported,
      projects: reports.length,
      external_edits: reports.reduce((n, r) => n + r.external_edits.length + r.reimported.length + r.imported_new.length, 0),
      intents_completed: reports.reduce((n, r) => n + r.intents_completed.length, 0),
      missing: reports.reduce((n, r) => n + r.missing.length, 0),
    };
  } finally {
    app.close();
  }
}
