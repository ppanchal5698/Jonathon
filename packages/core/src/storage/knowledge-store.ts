import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ENTITY_SPECS, type EntityType, type KnowledgeEntity, type SourceRef } from "@jonathon/contracts";
import { audit } from "../audit";
import { all, type Db, one, run, tx } from "../db";
import type { Logger } from "../logger";
import { deleteChunksForEntity, insertChunk } from "../retrieval/indexer";
import { actorLabel, type Principal } from "../security/principal";
import { AppError, newId, nowIso, parseJson, sha256 } from "../util";
import {
  ENTITY_SCHEMA_VERSION,
  type EntityDoc,
  EntityParseError,
  entityPlainText,
  type FieldValue,
  normalizeFields,
  normalizeSections,
  parseEntity,
  type SectionValue,
  semanticHash,
  serializeEntity,
} from "./entity-format";
import { readText, writeFileAtomic, writeFileCreateOnly } from "./fsutil";
import { ensureDirInside, resolveInside } from "./paths";

interface EntityRow {
  id: string;
  project_id: string;
  entity_type: EntityType;
  human_id: string;
  title: string;
  status: string;
  revision: number;
  approval_event_id: string | null;
  approval_valid: number;
  feature_scopes: string;
  blocking: number;
  stale: number;
  file_state: KnowledgeEntity["file_state"];
  data: string;
  storage_path: string;
  file_hash: string;
  semantic_hash: string;
  updated_at: string;
}

interface Intent {
  id: string;
  project_id: string;
  entity_id: string;
  human_id: string;
  entity_type: EntityType;
  file_hash: string;
  at: string;
}

export interface ReconcileReport {
  project_id: string;
  intents_completed: string[];
  imported_new: string[];
  reimported: string[];
  external_edits: { human_id: string; from_revision: number; to_revision: number; approval_revoked: boolean }[];
  invalid_files: { path: string; reason: string }[];
  missing: string[];
  unchanged: number;
}

export interface CommitOptions {
  principal: Principal;
  /** null when creating a new entity. */
  expectedRevision: number | null;
  action: string;
  details?: Record<string, unknown>;
  correlationId?: string | null;
  /** Runs inside the transaction after the file write and before the projection update (e.g. insert approval event). */
  beforeProjection?: (doc: EntityDoc) => void;
  /** Allows committing over a file that changed externally (used by reconciliation itself). */
  acceptExternalFileHash?: string;
}

/**
 * Filesystem knowledge store. Files under `<data>/projects/<project>/` are authoritative; SQLite holds a
 * projection that can be rebuilt. Approval validity is always recomputed from approval_events.
 */
export class KnowledgeStore {
  /** Called after every committed knowledge change (used to refresh generated documents). */
  onChanged: ((projectId: string) => void) | null = null;

  constructor(
    readonly db: Db,
    readonly dataDir: string,
    private readonly log?: Logger,
  ) {
    mkdirSync(join(dataDir, "projects"), { recursive: true });
    mkdirSync(join(dataDir, "staging", "intents"), { recursive: true });
  }

  // ---------- paths ----------
  projectDir(projectId: string): string {
    return ensureDirInside(this.dataDir, "projects", projectId);
  }

  entityPath(projectId: string, type: EntityType, humanId: string): string {
    ensureDirInside(this.dataDir, "projects", projectId, ENTITY_SPECS[type].dir);
    return resolveInside(this.dataDir, "projects", projectId, ENTITY_SPECS[type].dir, `${humanId}.md`);
  }

  relativeEntityPath(projectId: string, type: EntityType, humanId: string): string {
    return `projects/${projectId}/${ENTITY_SPECS[type].dir}/${humanId}.md`;
  }

  private historyPath(projectId: string, humanId: string, name: string): string {
    ensureDirInside(this.dataDir, "projects", projectId, "history", humanId);
    return resolveInside(this.dataDir, "projects", projectId, "history", humanId, name);
  }

  // ---------- reading ----------
  getRow(projectId: string, humanIdOrId: string): EntityRow | undefined {
    return one<EntityRow>(this.db, "SELECT * FROM knowledge_entities WHERE project_id = ? AND (human_id = ? OR id = ?)", projectId, humanIdOrId, humanIdOrId);
  }

  get(projectId: string, humanIdOrId: string): KnowledgeEntity {
    const row = this.getRow(projectId, humanIdOrId);
    if (!row) throw new AppError("ENTITY_NOT_FOUND", `${humanIdOrId} not found in this project`);
    return this.toView(row);
  }

  /** Read one historical revision from history/ (authoritative file copy). */
  getRevision(projectId: string, humanId: string, revision: number): KnowledgeEntity {
    const row = this.getRow(projectId, humanId);
    if (!row) throw new AppError("ENTITY_NOT_FOUND", `${humanId} not found in this project`);
    const text = readText(this.historyPath(projectId, row.human_id, `r${revision}.md`));
    if (text == null) throw new AppError("ENTITY_NOT_FOUND", `${humanId} revision ${revision} not found`);
    const doc = parseEntity(text);
    return this.docToView(doc, row.storage_path, sha256(text), "ok", false);
  }

  listRevisions(projectId: string, humanId: string): number[] {
    const row = this.getRow(projectId, humanId);
    if (!row) throw new AppError("ENTITY_NOT_FOUND", `${humanId} not found`);
    const dir = this.historyPath(projectId, row.human_id, "x").replace(/[\\/]x$/, "");
    try {
      return readdirSync(dir)
        .map((n) => /^r(\d+)\.md$/.exec(n)?.[1])
        .filter((x): x is string => !!x)
        .map(Number)
        .sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  /**
   * Filtered in SQL, and approval events loaded once for the whole list instead of one query per approved entity
   * (the review queue on a 2,334-entity project measured 132 ms p50 with per-row queries).
   */
  list(projectId: string, filter: { types?: EntityType[]; statuses?: string[] } = {}): KnowledgeEntity[] {
    const where = ["project_id = ?"];
    const params: string[] = [projectId];
    if (filter.types?.length) {
      where.push(`entity_type IN (${filter.types.map(() => "?").join(",")})`);
      params.push(...filter.types);
    }
    if (filter.statuses?.length) {
      where.push(`status IN (${filter.statuses.map(() => "?").join(",")})`);
      params.push(...filter.statuses);
    }
    const rows = all<EntityRow>(this.db, `SELECT * FROM knowledge_entities WHERE ${where.join(" AND ")} ORDER BY entity_type, human_id`, ...params);
    const events = new Map(
      all<Record<string, unknown>>(this.db, "SELECT * FROM approval_events WHERE project_id = ? AND action = 'approve' AND actor_kind = 'user'", projectId).map(
        (e) => [String(e.id), e],
      ),
    );
    // The row's semantic_hash was computed from this same document when the projection was written.
    return rows.map((r) => this.docToView(this.rowToDoc(r), r.storage_path, r.file_hash, r.file_state, r.stale === 1, events, r.semantic_hash));
  }

  readDocFromFile(projectId: string, type: EntityType, humanId: string): { doc: EntityDoc; text: string } | null {
    const text = readText(this.entityPath(projectId, type, humanId));
    if (text == null) return null;
    return { doc: parseEntity(text), text };
  }

  // ---------- writing ----------
  /**
   * Next free human id (REQ-001 …). Starts after the highest id in the projection (indexed), then steps past any id
   * that is already taken on disk: a live file not yet reconciled, or the history folder of a deleted entity (deleted
   * ids are never reused). Two existence checks per step instead of listing the entity and history folders on every
   * create. Callers hold the write lock (writeTx), so API and worker cannot allocate the same id.
   */
  private nextHumanId(projectId: string, type: EntityType): string {
    const prefix = ENTITY_SPECS[type].prefix;
    const top = one<{ n: number | null }>(
      this.db,
      "SELECT MAX(CAST(substr(human_id, ?) AS INTEGER)) AS n FROM knowledge_entities WHERE project_id = ? AND human_id LIKE ?",
      prefix.length + 2,
      projectId,
      `${prefix}-%`,
    )?.n;
    const dir = join(this.projectDir(projectId), ENTITY_SPECS[type].dir);
    const history = join(this.projectDir(projectId), "history");
    for (let n = (top ?? 0) + 1; ; n++) {
      const id = `${prefix}-${String(n).padStart(3, "0")}`;
      if (!existsSync(join(dir, `${id}.md`)) && !existsSync(join(history, id))) return id;
    }
  }

  newDoc(
    projectId: string,
    type: EntityType,
    input: {
      title: string;
      fields?: Record<string, unknown>;
      sections?: Record<string, unknown>;
      source_refs?: SourceRef[];
      status?: string;
    },
  ): EntityDoc {
    const spec = ENTITY_SPECS[type];
    const now = nowIso();
    const status = input.status ?? spec.initialStatus;
    if (!spec.statuses.includes(status)) throw new AppError("INVALID_TRANSITION", `invalid initial status ${status}`);
    if (spec.approvalStatuses.includes(status)) throw new AppError("INVALID_TRANSITION", "entities cannot be created already approved");
    return {
      id: newId(spec.idPrefix),
      human_id: "",
      project_id: projectId,
      entity_type: type,
      schema_version: ENTITY_SCHEMA_VERSION,
      revision: 1,
      status,
      title: input.title.trim(),
      created_at: now,
      updated_at: now,
      supersedes: null,
      approval_event_id: null,
      fields: normalizeFields(type, input.fields ?? {}),
      sections: normalizeSections(type, input.sections ?? {}),
      source_refs: input.source_refs ?? [],
    };
  }

  private pendingIntents: string[] = [];
  /**
   * File changes made inside the current write transaction, newest last, each with how to reverse it. SQLite rolls
   * back its own rows; this rolls back the files, so a multi-entity operation that fails half-way (a stale revision on
   * its second entity, a lost lease, a constraint) leaves the data root exactly as it was, and no intent for the next
   * startup to "complete".
   */
  private undo: { what: string; reverse: () => void }[] = [];

  /**
   * Run store writes (and any other SQL) inside one tx(); remove write intents only once it commits, and reverse the
   * transaction's file changes if it does not. Services that combine several writes must use this instead of tx().
   */
  writeTx<T>(fn: () => T): T {
    const outer = this.db.isTransaction;
    // A new top-level transaction: entries left by an earlier plain tx() (already committed or rolled back) must never
    // be reversed by this one.
    if (!outer) this.undo = [];
    try {
      const out = tx(this.db, fn);
      if (!outer) this.finishIntents(true);
      return out;
    } catch (e) {
      if (!outer) this.finishIntents(false);
      throw e;
    }
  }

  /** Call after an outer tx() that wrapped store writes has committed (true) or failed (false). */
  finishIntents(committed: boolean): void {
    const paths = this.pendingIntents;
    const undo = this.undo;
    this.pendingIntents = [];
    this.undo = [];
    if (committed) {
      for (const p of paths) rmSync(p, { force: true });
      return;
    }
    for (const u of undo.reverse()) {
      try {
        u.reverse();
      } catch (e) {
        // Leave it for reconciliation (the intent, if any, stays) rather than hide the original error.
        this.log?.error({ err: (e as Error).message, what: u.what }, "could not undo a file change after a failed write");
      }
    }
  }

  /** Record how to reverse a file change made inside the current write transaction. */
  private track(what: string, reverse: () => void): void {
    if (this.db.isTransaction) this.undo.push({ what, reverse });
  }

  /** Atomically replace (or create) a live file, remembering its previous content for rollback. */
  private replaceTracked(path: string, text: string): void {
    const previous = readText(path);
    writeFileAtomic(path, text);
    this.track(`write ${path}`, () => (previous == null ? rmSync(path, { force: true }) : writeFileAtomic(path, previous)));
  }

  /** Create a file that must not exist yet (history, tombstones, intents); rollback removes it. */
  private createTracked(path: string, text: string): void {
    writeFileCreateOnly(path, text);
    this.track(`create ${path}`, () => rmSync(path, { force: true }));
  }

  /** Create a new entity file (revision 1). */
  create(doc: EntityDoc, opts: Omit<CommitOptions, "expectedRevision">): EntityDoc {
    return this.writeTx(() => {
      if (!doc.human_id) doc.human_id = this.nextHumanId(doc.project_id, doc.entity_type);
      return this.commit(doc, { ...opts, expectedRevision: null });
    });
  }

  /**
   * Write a new revision of an existing entity. `mutate` receives a copy of the current document;
   * the store sets revision/updated_at.
   */
  update(
    projectId: string,
    humanId: string,
    expectedRevision: number,
    mutate: (doc: EntityDoc) => void,
    opts: Omit<CommitOptions, "expectedRevision">,
  ): EntityDoc {
    return this.writeTx(() => {
      const row = this.getRow(projectId, humanId);
      if (!row) throw new AppError("ENTITY_NOT_FOUND", `${humanId} not found in this project`);
      const current = this.readDocFromFile(projectId, row.entity_type, row.human_id);
      if (!current) throw new AppError("EXTERNAL_EDIT_PENDING", `${humanId} file is missing; run reconciliation`);
      const next: EntityDoc = structuredClone(current.doc);
      mutate(next);
      next.id = current.doc.id;
      next.human_id = current.doc.human_id;
      next.project_id = current.doc.project_id;
      next.entity_type = current.doc.entity_type;
      next.created_at = current.doc.created_at;
      next.revision = current.doc.revision + 1;
      next.updated_at = nowIso();
      next.fields = normalizeFields(next.entity_type, next.fields);
      next.sections = normalizeSections(next.entity_type, next.sections);
      return this.commit(next, { ...opts, expectedRevision });
    });
  }

  /** Core write protocol. Must run inside tx(). See ADR 0002. */
  private commit(doc: EntityDoc, opts: CommitOptions): EntityDoc {
    const { project_id: projectId, entity_type: type, human_id: humanId } = doc;
    const path = this.entityPath(projectId, type, humanId);
    const existingText = readText(path);
    const row = this.getRow(projectId, humanId);

    if (opts.expectedRevision === null) {
      if (existingText != null || row) throw new AppError("REVISION_CONFLICT", `${humanId} already exists`);
    } else {
      if (!row || existingText == null) throw new AppError("ENTITY_NOT_FOUND", `${humanId} not found`);
      const fileHash = sha256(existingText);
      if (fileHash !== row.file_hash && fileHash !== opts.acceptExternalFileHash) {
        throw new AppError("EXTERNAL_EDIT_PENDING", `${humanId} was changed outside Jonathon. Run reconciliation to import the edit before changing it here.`);
      }
      if (row.revision !== opts.expectedRevision) {
        throw new AppError("REVISION_CONFLICT", `${humanId} is at revision ${row.revision}, not ${opts.expectedRevision}`, {
          details: { current_revision: row.revision },
        });
      }
    }

    const text = serializeEntity(doc);
    const fileHash = sha256(text);
    const intent: Intent = {
      id: newId("int"),
      project_id: projectId,
      entity_id: doc.id,
      human_id: humanId,
      entity_type: type,
      file_hash: fileHash,
      at: nowIso(),
    };
    const intentPath = resolveInside(this.dataDir, "staging", "intents", `${intent.id}.json`);
    writeFileAtomic(intentPath, JSON.stringify(intent));
    this.track(`intent ${intent.id}`, () => rmSync(intentPath, { force: true }));
    this.createTracked(this.historyPath(projectId, humanId, `r${doc.revision}.md`), text);
    this.replaceTracked(path, text);

    opts.beforeProjection?.(doc);
    this.upsertProjection(doc, fileHash, "ok");
    run(this.db, "UPDATE projects SET knowledge_revision = knowledge_revision + 1, updated_at = ? WHERE id = ?", nowIso(), projectId);
    this.onChanged?.(projectId);
    audit(this.db, {
      principal: opts.principal,
      projectId,
      action: opts.action,
      entityType: type,
      entityId: humanId,
      details: { revision: doc.revision, status: doc.status, ...opts.details },
      correlationId: opts.correlationId ?? null,
    });
    // The intent is removed only after the transaction commits (see finishIntents). If we crash or the
    // commit fails, the intent stays and reconciliation completes or discards it.
    this.pendingIntents.push(intentPath);
    return doc;
  }

  /**
   * Delete an entity (human-confirmed workflow in KnowledgeService). The live file and its projection row go away;
   * history/<HID>/ keeps every revision plus a deleted-r<n>.json tombstone, so the ID is never reused and the
   * content stays auditable. Approval events are kept as historical records.
   */
  remove(projectId: string, humanId: string, expectedRevision: number, opts: { principal: Principal; details?: Record<string, unknown> }): EntityDoc {
    return this.writeTx(() => {
      const row = this.getRow(projectId, humanId);
      if (!row) throw new AppError("ENTITY_NOT_FOUND", `${humanId} not found in this project`);
      const path = this.entityPath(projectId, row.entity_type, row.human_id);
      const text = readText(path);
      if (text == null || sha256(text) !== row.file_hash) {
        throw new AppError("EXTERNAL_EDIT_PENDING", `${row.human_id} was changed outside Jonathon. Run reconciliation before deleting it.`);
      }
      if (row.revision !== expectedRevision) {
        throw new AppError("REVISION_CONFLICT", `${row.human_id} is at revision ${row.revision}, not ${expectedRevision}`, {
          details: { current_revision: row.revision },
        });
      }
      const doc = parseEntity(text);
      // The last revision is already in history (create-only); the tombstone records who deleted it and when.
      const tombstone = {
        human_id: row.human_id,
        entity_id: row.id,
        entity_type: row.entity_type,
        revision: row.revision,
        file_hash: row.file_hash,
        deleted_by: actorLabel(opts.principal),
        deleted_at: nowIso(),
      };
      this.createTracked(this.historyPath(projectId, row.human_id, `deleted-r${row.revision}.json`), `${JSON.stringify(tombstone, null, 2)}\n`);
      run(this.db, "DELETE FROM knowledge_entities WHERE id = ?", row.id);
      deleteChunksForEntity(this.db, projectId, row.id);
      run(this.db, "UPDATE projects SET knowledge_revision = knowledge_revision + 1, updated_at = ? WHERE id = ?", nowIso(), projectId);
      this.onChanged?.(projectId);
      audit(this.db, {
        principal: opts.principal,
        projectId,
        action: "entity.deleted",
        entityType: row.entity_type,
        entityId: row.human_id,
        details: { revision: row.revision, status: row.status, ...opts.details },
      });
      {
        const previous = readText(path);
        rmSync(path, { force: true });
        if (previous != null) this.track(`delete ${path}`, () => writeFileAtomic(path, previous));
      }
      return doc;
    });
  }

  /** True when the entity was deleted in Jonathon (a tombstone exists in its history folder). */
  isDeleted(projectId: string, humanId: string): boolean {
    try {
      return readdirSync(join(this.projectDir(projectId), "history", humanId)).some((n) => /^deleted-r\d+\.json$/.test(n));
    } catch {
      return false;
    }
  }

  approvalFor(doc: EntityDoc, semHash: string, preloaded?: Map<string, Record<string, unknown>>): { valid: boolean; event: Record<string, unknown> | null } {
    const spec = ENTITY_SPECS[doc.entity_type];
    if (!spec.approvalStatuses.includes(doc.status) || !doc.approval_event_id) return { valid: false, event: null };
    if (preloaded) {
      // Same conditions as the query below (the map holds only approve events by a user in this project).
      const e = preloaded.get(doc.approval_event_id);
      const ok = !!e && e.entity_id === doc.id && Number(e.revision) === doc.revision && e.semantic_hash === semHash;
      return { valid: ok, event: ok ? e! : null };
    }
    const ev = one<Record<string, unknown>>(
      this.db,
      `SELECT * FROM approval_events WHERE id = ? AND project_id = ? AND entity_id = ? AND revision = ?
         AND semantic_hash = ? AND action = 'approve' AND actor_kind = 'user'`,
      doc.approval_event_id,
      doc.project_id,
      doc.id,
      doc.revision,
      semHash,
    );
    return { valid: !!ev, event: ev ?? null };
  }

  /** Update the SQLite projection and retrieval chunk for one entity. Call inside tx(). */
  upsertProjection(doc: EntityDoc, fileHash: string, fileState: KnowledgeEntity["file_state"]): void {
    const sem = semanticHash(doc);
    const { valid } = this.approvalFor(doc, sem);
    const scopes = Array.isArray(doc.fields.feature_scopes) ? (doc.fields.feature_scopes as string[]) : [];
    const blocking = doc.fields.blocking === true ? 1 : 0;
    const data = JSON.stringify({
      created_at: doc.created_at,
      supersedes: doc.supersedes,
      schema_version: doc.schema_version,
      fields: doc.fields,
      sections: doc.sections,
      source_refs: doc.source_refs,
    });
    run(
      this.db,
      `INSERT INTO knowledge_entities (id, project_id, entity_type, human_id, title, status, revision, approval_event_id, approval_valid,
         feature_scopes, blocking, stale, file_state, data, storage_path, file_hash, semantic_hash, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, status=excluded.status, revision=excluded.revision,
         approval_event_id=excluded.approval_event_id, approval_valid=excluded.approval_valid, feature_scopes=excluded.feature_scopes,
         blocking=excluded.blocking, file_state=excluded.file_state, data=excluded.data, storage_path=excluded.storage_path,
         file_hash=excluded.file_hash, semantic_hash=excluded.semantic_hash, updated_at=excluded.updated_at`,
      doc.id,
      doc.project_id,
      doc.entity_type,
      doc.human_id,
      doc.title,
      doc.status,
      doc.revision,
      doc.approval_event_id,
      valid ? 1 : 0,
      JSON.stringify(scopes),
      blocking,
      fileState,
      data,
      this.relativeEntityPath(doc.project_id, doc.entity_type, doc.human_id),
      fileHash,
      sem,
      doc.updated_at,
    );
    deleteChunksForEntity(this.db, doc.project_id, doc.id);
    insertChunk(this.db, {
      id: `k_${doc.id}`,
      projectId: doc.project_id,
      kind: "knowledge",
      entityId: doc.id,
      entityType: doc.entity_type,
      title: `${doc.human_id}: ${doc.title}`,
      ordinal: 0,
      heading: doc.human_id,
      locator: { entity: doc.human_id, revision: doc.revision },
      text: entityPlainText(doc),
    });
  }

  private docToView(
    doc: EntityDoc,
    storagePath: string,
    _fileHash: string,
    fileState: KnowledgeEntity["file_state"],
    stale: boolean,
    preloaded?: Map<string, Record<string, unknown>>,
    knownSemanticHash?: string,
  ): KnowledgeEntity {
    const sem = knownSemanticHash ?? semanticHash(doc);
    const { valid, event } = this.approvalFor(doc, sem, preloaded);
    return {
      id: doc.id,
      human_id: doc.human_id,
      project_id: doc.project_id,
      entity_type: doc.entity_type,
      schema_version: doc.schema_version,
      revision: doc.revision,
      status: doc.status,
      title: doc.title,
      fields: doc.fields,
      sections: doc.sections as KnowledgeEntity["sections"],
      source_refs: doc.source_refs,
      supersedes: doc.supersedes,
      approval_event_id: doc.approval_event_id,
      approval_valid: valid,
      approval: event
        ? {
            event_id: String(event.id),
            approved_by: String(event.actor_id),
            approved_at: String(event.at),
            revision: Number(event.revision),
            note: (event.note as string | null) ?? null,
          }
        : null,
      semantic_hash: sem,
      stale,
      file_state: fileState,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
      storage_path: storagePath,
    };
  }

  rowToDoc(row: EntityRow): EntityDoc {
    const d = parseJson<{
      created_at: string;
      supersedes: string | null;
      schema_version: number;
      fields: Record<string, FieldValue>;
      sections: Record<string, SectionValue>;
      source_refs: SourceRef[];
    }>(row.data, { created_at: row.updated_at, supersedes: null, schema_version: 1, fields: {}, sections: {}, source_refs: [] });
    return {
      id: row.id,
      human_id: row.human_id,
      project_id: row.project_id,
      entity_type: row.entity_type,
      schema_version: d.schema_version,
      revision: row.revision,
      status: row.status,
      title: row.title,
      created_at: d.created_at,
      updated_at: row.updated_at,
      supersedes: d.supersedes,
      approval_event_id: row.approval_event_id,
      fields: d.fields,
      sections: d.sections,
      source_refs: d.source_refs,
    };
  }

  toView(row: EntityRow): KnowledgeEntity {
    return this.docToView(this.rowToDoc(row), row.storage_path, row.file_hash, row.file_state, row.stale === 1);
  }

  // ---------- reconciliation ----------

  /** Complete or discard write intents left by a crash. */
  completeIntents(projectId?: string): string[] {
    const dir = join(this.dataDir, "staging", "intents");
    const done: string[] = [];
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".json"));
    } catch {
      return done;
    }
    for (const n of names) {
      const p = join(dir, n);
      const intent = parseJson<Intent | null>(readText(p), null);
      if (!intent || (projectId && intent.project_id !== projectId)) continue;
      // Skip intents younger than 30 s: they may belong to a write that is still committing.
      if (Date.now() - Date.parse(intent.at) < 30_000) continue;
      try {
        tx(this.db, () => {
          const text = readText(this.entityPath(intent.project_id, intent.entity_type, intent.human_id));
          if (text != null && sha256(text) === intent.file_hash) {
            const row = this.getRow(intent.project_id, intent.human_id);
            if (!row || row.file_hash !== intent.file_hash) {
              this.upsertProjection(parseEntity(text), intent.file_hash, "ok");
              done.push(intent.human_id);
            }
          }
        });
        rmSync(p, { force: true });
      } catch (e) {
        this.log?.warn({ err: (e as Error).message, intent: intent.id }, "could not complete write intent");
      }
    }
    return done;
  }

  /**
   * Compare every entity file with the projection. Imports external edits as new revisions and never
   * lets changed content keep an old approval. Never deletes files.
   */
  reconcile(projectId: string, principal: Principal): ReconcileReport {
    const report: ReconcileReport = {
      project_id: projectId,
      intents_completed: this.completeIntents(projectId),
      imported_new: [],
      reimported: [],
      external_edits: [],
      invalid_files: [],
      missing: [],
      unchanged: 0,
    };
    const seen = new Set<string>();
    for (const type of Object.keys(ENTITY_SPECS) as EntityType[]) {
      const spec = ENTITY_SPECS[type];
      let names: string[] = [];
      try {
        names = readdirSync(ensureDirInside(this.dataDir, "projects", projectId, spec.dir));
      } catch {
        continue;
      }
      for (const name of names) {
        const m = new RegExp(`^(${spec.prefix}-\\d{3,6})\\.md$`).exec(name);
        if (!m) continue;
        const humanId = m[1]!;
        const rel = `projects/${projectId}/${spec.dir}/${name}`;
        seen.add(humanId);
        const path = this.entityPath(projectId, type, humanId);
        const text = readText(path);
        if (text == null) continue;
        const fileHash = sha256(text);
        const row = this.getRow(projectId, humanId);
        if (!row && this.isDeleted(projectId, humanId)) {
          // Never resurrect a deleted entity: its ID is retired. The file is left untouched for the user to remove.
          report.invalid_files.push({ path: rel, reason: `${humanId} was deleted in Jonathon; this file was not imported` });
          continue;
        }
        if (row && row.file_hash === fileHash) {
          if (row.file_state !== "ok") run(this.db, "UPDATE knowledge_entities SET file_state = 'ok' WHERE id = ?", row.id);
          report.unchanged++;
          continue;
        }
        let doc: EntityDoc;
        try {
          doc = parseEntity(text);
        } catch (e) {
          const reason = e instanceof EntityParseError ? e.message : "unreadable";
          report.invalid_files.push({ path: rel, reason });
          if (row) run(this.db, "UPDATE knowledge_entities SET file_state = 'invalid_file' WHERE id = ?", row.id);
          continue;
        }
        if (doc.project_id !== projectId || doc.human_id !== humanId || doc.entity_type !== type || (row && row.id !== doc.id)) {
          report.invalid_files.push({ path: rel, reason: "identity fields (id, human_id, project_id, entity_type) do not match" });
          if (row) run(this.db, "UPDATE knowledge_entities SET file_state = 'invalid_file' WHERE id = ?", row.id);
          continue;
        }
        // A file identical to its own history copy was written by Jonathon (e.g. the projection was lost or
        // restored from an older backup). Re-import it as-is; approval validity is recomputed from approval_events.
        const own = this.readHistoryRaw(projectId, humanId, doc.revision);
        if (own != null && sha256(own) === fileHash && (!row || doc.revision >= row.revision)) {
          tx(this.db, () => this.upsertProjection(doc, fileHash, "ok"));
          report.reimported.push(humanId);
          continue;
        }
        // Keep the raw external file verbatim so formatting is never lost.
        const nextRevision = (row?.revision ?? 0) + 1;
        try {
          writeFileCreateOnly(this.historyPath(projectId, humanId, `r${nextRevision}.external-original.md`), text);
        } catch {
          /* already preserved by an earlier attempt */
        }

        if (!row) {
          // A new file created outside Jonathon: import it. It cannot carry an approval.
          const imported: EntityDoc = { ...doc, revision: 1, approval_event_id: null };
          if (spec.approvalStatuses.includes(imported.status)) imported.status = "in_review";
          imported.fields = { ...imported.fields, origin: "external_edit" };
          this.writeTx(() => {
            this.commitExternal(imported, null, fileHash, principal, "entity.external_import");
          });
          report.imported_new.push(humanId);
          continue;
        }

        const contentChanged = semanticHash(doc) !== row.semantic_hash;
        const wasApproved = row.approval_valid === 1;
        const next: EntityDoc = { ...doc, revision: nextRevision, updated_at: nowIso() };
        // Approval events bind to an exact revision and content hash. An imported external revision never
        // inherits an approval: if the file claims an approval status it goes back to review.
        let approvalRevoked = false;
        if (spec.approvalStatuses.includes(next.status)) {
          next.status = "in_review";
          next.approval_event_id = null;
          approvalRevoked = wasApproved;
        } else if (wasApproved) {
          next.approval_event_id = null;
          approvalRevoked = true;
        }
        this.writeTx(() => {
          this.commitExternal(next, row.revision, fileHash, principal, "entity.external_edit_imported", {
            content_changed: contentChanged,
            approval_revoked: approvalRevoked,
          });
          if (approvalRevoked) this.markDependentsStale(projectId, humanId);
        });
        report.external_edits.push({ human_id: humanId, from_revision: row.revision, to_revision: nextRevision, approval_revoked: approvalRevoked });
      }
    }
    for (const row of all<EntityRow>(this.db, "SELECT * FROM knowledge_entities WHERE project_id = ?", projectId)) {
      if (!seen.has(row.human_id)) {
        run(this.db, "UPDATE knowledge_entities SET file_state = 'missing' WHERE id = ?", row.id);
        report.missing.push(row.human_id);
      }
    }
    return report;
  }

  private commitExternal(
    doc: EntityDoc,
    expectedRevision: number | null,
    externalHash: string,
    principal: Principal,
    action: string,
    details: Record<string, unknown> = {},
  ): void {
    // The file on disk is the external version; we rewrite it normalized, at the next revision.
    const path = this.entityPath(doc.project_id, doc.entity_type, doc.human_id);
    const text = serializeEntity(doc);
    const fileHash = sha256(text);
    this.createTracked(this.historyPath(doc.project_id, doc.human_id, `r${doc.revision}.md`), text);
    const current = readText(path);
    if (current == null || sha256(current) !== externalHash) {
      throw new AppError("REVISION_CONFLICT", `${doc.human_id} changed again during reconciliation; retry`);
    }
    this.replaceTracked(path, text);
    this.upsertProjection(doc, fileHash, "ok");
    run(this.db, "UPDATE projects SET knowledge_revision = knowledge_revision + 1, updated_at = ? WHERE id = ?", nowIso(), doc.project_id);
    this.onChanged?.(doc.project_id);
    audit(this.db, {
      principal,
      projectId: doc.project_id,
      action,
      entityType: doc.entity_type,
      entityId: doc.human_id,
      details: { revision: doc.revision, previous_revision: expectedRevision, status: doc.status, ...details },
    });
  }

  /** Flag specification snapshots and answers that relied on an entity whose approval was revoked. */
  markDependentsStale(projectId: string, humanId: string): void {
    run(
      this.db,
      `UPDATE spec_snapshots SET stale = 1 WHERE project_id = ? AND EXISTS (SELECT 1 FROM json_each(spec_snapshots.entity_revisions) WHERE json_each.key = ?)`,
      projectId,
      humanId,
    );
    run(
      this.db,
      `UPDATE messages SET stale = 1 WHERE project_id = ? AND id IN (
         SELECT a.message_id FROM answer_sources a JOIN knowledge_entities k ON k.id = a.entity_id WHERE k.human_id = ? AND a.project_id = ?)`,
      projectId,
      humanId,
      projectId,
    );
  }

  /** Re-import every entity file into the projection (after reconciling edits). */
  rebuildProjection(projectId: string, principal: Principal): ReconcileReport {
    const report = this.reconcile(projectId, principal);
    tx(this.db, () => {
      for (const row of all<EntityRow>(this.db, "SELECT * FROM knowledge_entities WHERE project_id = ? AND file_state = 'ok'", projectId)) {
        const f = this.readDocFromFile(projectId, row.entity_type, row.human_id);
        if (f) this.upsertProjection(f.doc, sha256(f.text), "ok");
      }
    });
    return report;
  }

  readRawFile(projectId: string, type: EntityType, humanId: string): string | null {
    return readText(this.entityPath(projectId, type, humanId));
  }

  readHistoryRaw(projectId: string, humanId: string, revision: number): string | null {
    try {
      return readFileSync(this.historyPath(projectId, humanId, `r${revision}.md`), "utf8");
    } catch {
      return null;
    }
  }
}
