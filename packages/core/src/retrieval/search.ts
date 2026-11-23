import type { SearchableType, SearchHit } from "@jonathon/contracts";
import { all, type Db } from "../db";
import { parseJson } from "../util";

export interface SearchOptions {
  types?: SearchableType[];
  statuses?: string[];
  limit?: number;
  /** Exclude these chunk ids (already in context). */
  exclude?: Set<string>;
}

const ID_PATTERN = /\b(REQ|DEC|QUESTION|CONFLICT|CHANGE)-\d{3,6}\b/gi;

/** Turn free text into a safe FTS5 query: quoted terms joined with OR. Never passes FTS syntax through. */
export function ftsQuery(text: string): string | null {
  const terms = (
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]{2,}/gu) ?? []
  ).slice(0, 24);
  const uniq = [...new Set(terms)];
  if (uniq.length === 0) return null;
  return uniq.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

interface HitRow {
  chunk_id: string;
  kind: "evidence" | "knowledge";
  source_id: string | null;
  revision_id: string | null;
  entity_id: string | null;
  entity_type: string;
  title: string;
  heading: string | null;
  locator: string;
  text: string;
  human_id: string | null;
  status: string | null;
  approval_valid: number | null;
  score: number;
}

const SELECT = `SELECT c.id AS chunk_id, c.kind, c.source_id, c.revision_id, c.entity_id, c.entity_type, c.title, c.heading, c.locator, c.text,
  k.human_id, k.status, k.approval_valid`;

function toHit(r: HitRow): SearchHit & { text: string } {
  return {
    kind: r.kind,
    entity_type: (r.kind === "evidence" ? "source" : r.entity_type) as SearchableType,
    chunk_id: r.chunk_id,
    source_id: r.source_id,
    revision_id: r.revision_id,
    entity_id: r.entity_id,
    human_id: r.human_id,
    status: r.status,
    approval_valid: r.approval_valid == null ? null : r.approval_valid === 1,
    title: r.title,
    heading: r.heading,
    locator: parseJson(r.locator, {}),
    snippet: r.text.length > 320 ? `${r.text.slice(0, 317)}...` : r.text,
    score: r.score,
    text: r.text,
  };
}

/**
 * Project-scoped lexical search over source evidence and knowledge entities. The project filter is in
 * every SQL statement; there is no code path that searches across projects.
 */
export function searchProject(db: Db, projectId: string, query: string, opts: SearchOptions = {}): Array<SearchHit & { text: string }> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 60);
  const typeOk = (t: string, kind: string) => !opts.types || opts.types.includes((kind === "evidence" ? "source" : t) as SearchableType);
  const statusOk = (s: string | null, kind: string) => !opts.statuses || kind === "evidence" || (s != null && opts.statuses.includes(s));
  const out: Array<SearchHit & { text: string }> = [];
  const seen = new Set<string>(opts.exclude ?? []);

  // 1. Exact entity-ID lookup (REQ-001 etc.) ranks first.
  const ids = [...new Set((query.match(ID_PATTERN) ?? []).map((s) => s.toUpperCase()))];
  for (const hid of ids) {
    const rows = all<HitRow>(
      db,
      `${SELECT}, 1000.0 AS score FROM chunks c JOIN knowledge_entities k ON k.id = c.entity_id
       WHERE c.project_id = ? AND k.project_id = ? AND k.human_id = ?`,
      projectId,
      projectId,
      hid,
    );
    for (const r of rows) {
      if (seen.has(r.chunk_id) || !typeOk(r.entity_type, r.kind) || !statusOk(r.status, r.kind)) continue;
      seen.add(r.chunk_id);
      out.push(toHit(r));
    }
  }

  // 2. FTS5 with bm25 ranking (lower is better; negate for a positive score).
  const q = ftsQuery(query);
  if (q) {
    const rows = all<HitRow>(
      db,
      `${SELECT}, -bm25(chunks_fts, 1.0, 2.0, 1.5) AS score
       FROM chunks_fts f JOIN chunks c ON c.id = f.chunk_id
       LEFT JOIN knowledge_entities k ON k.id = c.entity_id AND k.project_id = c.project_id
       WHERE chunks_fts MATCH ? AND f.project_id = ? AND c.project_id = ?
         AND (c.kind = 'knowledge' OR c.revision_id = (SELECT s.current_revision_id FROM sources s WHERE s.id = c.source_id AND s.deleted_at IS NULL))
       ORDER BY bm25(chunks_fts, 1.0, 2.0, 1.5) LIMIT ?`,
      q,
      projectId,
      projectId,
      limit * 4,
    );
    for (const r of rows) {
      if (out.length >= limit) break;
      if (seen.has(r.chunk_id) || !typeOk(r.entity_type, r.kind) || !statusOk(r.status, r.kind)) continue;
      seen.add(r.chunk_id);
      out.push(toHit(r));
    }
  }
  return out.slice(0, limit);
}

/** Load chunks by id, restricted to one project (used to validate citations). */
export function chunksById(db: Db, projectId: string, ids: string[]): Map<string, HitRow> {
  const m = new Map<string, HitRow>();
  for (const id of ids) {
    const r = all<HitRow>(
      db,
      `${SELECT}, 0 AS score FROM chunks c LEFT JOIN knowledge_entities k ON k.id = c.entity_id AND k.project_id = c.project_id
       WHERE c.id = ? AND c.project_id = ?`,
      id,
      projectId,
    )[0];
    if (r) m.set(id, r);
  }
  return m;
}

/** Current search hits for specific chunk ids in one project (missing or superseded chunks are dropped). */
export function hitsById(db: Db, projectId: string, ids: string[]): Array<SearchHit & { text: string }> {
  const out: Array<SearchHit & { text: string }> = [];
  for (const [, r] of chunksById(db, projectId, ids)) {
    if (r.kind === "evidence") {
      const current = all<{ ok: number }>(
        db,
        "SELECT 1 AS ok FROM sources WHERE id = ? AND current_revision_id = ? AND deleted_at IS NULL",
        r.source_id,
        r.revision_id,
      );
      if (current.length === 0) continue;
    }
    out.push(toHit(r));
  }
  return out;
}
