import { all, type Db, run } from "../db";
import { nowIso, sha256 } from "../util";

export interface ChunkInput {
  id: string;
  projectId: string;
  kind: "evidence" | "knowledge";
  sourceId?: string | null;
  revisionId?: string | null;
  entityId?: string | null;
  entityType: string;
  title: string;
  ordinal: number;
  heading?: string | null;
  locator?: Record<string, string | number>;
  text: string;
}

/** Insert a chunk and its FTS row. Call inside a transaction. */
export function insertChunk(db: Db, c: ChunkInput): void {
  run(
    db,
    `INSERT INTO chunks (id, project_id, kind, source_id, revision_id, entity_id, entity_type, title, ordinal, heading, locator, text, content_hash, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    c.id,
    c.projectId,
    c.kind,
    c.sourceId ?? null,
    c.revisionId ?? null,
    c.entityId ?? null,
    c.entityType,
    c.title,
    c.ordinal,
    c.heading ?? null,
    JSON.stringify(c.locator ?? {}),
    c.text,
    sha256(c.text),
    nowIso(),
  );
  run(db, "INSERT INTO chunks_fts (text, heading, title, chunk_id, project_id) VALUES (?,?,?,?,?)", c.text, c.heading ?? "", c.title, c.id, c.projectId);
}

function deleteChunkIds(db: Db, ids: string[]): void {
  for (const id of ids) {
    run(db, "DELETE FROM chunks_fts WHERE chunk_id = ?", id);
    run(db, "DELETE FROM chunks WHERE id = ?", id);
  }
}

export function deleteChunksForEntity(db: Db, projectId: string, entityId: string): void {
  const ids = all<{ id: string }>(db, "SELECT id FROM chunks WHERE project_id = ? AND entity_id = ?", projectId, entityId).map((r) => r.id);
  deleteChunkIds(db, ids);
}

export function deleteChunksForRevision(db: Db, projectId: string, revisionId: string): void {
  const ids = all<{ id: string }>(db, "SELECT id FROM chunks WHERE project_id = ? AND revision_id = ?", projectId, revisionId).map((r) => r.id);
  deleteChunkIds(db, ids);
}

export function deleteAllChunks(db: Db, projectId: string): void {
  run(db, "DELETE FROM chunks_fts WHERE project_id = ?", projectId);
  run(db, "DELETE FROM chunks WHERE project_id = ?", projectId);
}
