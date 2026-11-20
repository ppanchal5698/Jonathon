import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { AppError } from "../util";
import { MIGRATIONS } from "./migrations";

export type Db = DatabaseSync;
export type Row = Record<string, SQLInputValue>;

/** Open the database, apply pragmas and forward-only migrations. */
export function openDatabase(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 10_000 });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA busy_timeout = 10000;");
  migrate(db);
  return db;
}

export function migrate(db: Db): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;`);
  const done = new Set(
    (db.prepare("SELECT id FROM schema_migrations").all() as { id: string }[]).map((r) => r.id),
  );
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(m.id, new Date().toISOString());
      db.exec("COMMIT");
      applied.push(m.id);
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return applied;
}

/**
 * Lease fence for code running inside a job handler. The worker runs each handler inside `leaseFence.run()`;
 * every tx() opened from that async context re-checks, while holding SQLite's write lock, that the job is still
 * `running` under this worker's lease. A worker that lost its lease (expired and recovered by another worker, or
 * cancelled) can therefore never commit stale results: knowledge file writes happen inside the same tx (see
 * KnowledgeStore.commit), after this check. Lease recovery also needs the write lock, so the lease cannot be
 * taken away between the check and COMMIT.
 */
export const leaseFence = new AsyncLocalStorage<{ jobId: string; workerId: string }>();

/**
 * Run `fn` inside BEGIN IMMEDIATE. This serializes application writers across the server and worker
 * processes (they share the database file). Nested calls join the outer transaction.
 */
export function tx<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn();
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (e) {
    throw new AppError("STORAGE_UNAVAILABLE", "database is busy or unavailable", { cause: e, retryable: true });
  }
  try {
    const fence = leaseFence.getStore();
    if (fence) {
      const owned = db
        .prepare("SELECT 1 AS ok FROM jobs WHERE id = ? AND lease_owner = ? AND status = 'running' AND cancel_requested = 0")
        .get(fence.jobId, fence.workerId);
      if (!owned) throw new AppError("LEASE_LOST", "this worker no longer holds the job's lease; its results were not committed");
    }
    const out = fn();
    if (out instanceof Promise) throw new Error("tx() callback must be synchronous");
    db.exec("COMMIT");
    return out;
  } catch (e) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw e;
  }
}

export function one<T = Row>(db: Db, sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function all<T = Row>(db: Db, sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function run(db: Db, sql: string, ...params: SQLInputValue[]): { changes: number } {
  const r = db.prepare(sql).run(...params);
  return { changes: Number(r.changes) };
}

export function hasFts5(db: Db): boolean {
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.__fts_probe USING fts5(x); DROP TABLE temp.__fts_probe;");
    return true;
  } catch {
    return false;
  }
}

export { MIGRATIONS };
