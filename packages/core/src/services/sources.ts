import type { ExtractionStatus, Job, Source, SourceRevision } from "@jonathon/contracts";
import { audit } from "../audit";
import { all, one, run, tx } from "../db";
import { detectType } from "../ingestion/detect";
import { runExtraction } from "../ingestion/run-extraction";
import type { JobContext, JobOutcome } from "../jobs/worker";
import { deleteChunksForRevision, insertChunk } from "../retrieval/indexer";
import { actorLabel, assertHuman, type Principal } from "../security/principal";
import { safeExtension, sanitizeDisplayName } from "../storage/paths";
import type { SourceMetadata } from "../storage/project-files";
import { AppError, newId, nowIso, parseJson, sha256 } from "../util";
import { type Ctx, requireProject } from "./context";
import { queueDocsRefresh } from "./documents";

interface RevRow {
  id: string;
  source_id: string;
  project_id: string;
  revision_number: number;
  content_hash: string;
  size_bytes: number;
  media_type: string;
  extension: string;
  original_filename: string;
  extraction_status: ExtractionStatus;
  extraction_warnings: string;
  extractor: string | null;
  chunk_count: number;
  created_at: string;
}

interface SourceRow {
  id: string;
  project_id: string;
  display_name: string;
  kind: "file" | "pasted_text";
  current_revision_id: string | null;
  created_at: string;
}

function toRevision(r: RevRow): SourceRevision {
  return {
    id: r.id,
    source_id: r.source_id,
    project_id: r.project_id,
    revision_number: r.revision_number,
    content_hash: r.content_hash,
    size_bytes: r.size_bytes,
    media_type: r.media_type,
    extension: r.extension,
    original_filename: r.original_filename,
    extraction_status: r.extraction_status,
    extraction_warnings: parseJson(r.extraction_warnings, []),
    extractor: r.extractor,
    chunk_count: r.chunk_count,
    created_at: r.created_at,
  };
}

export interface IngestResult {
  source: Source;
  revision: SourceRevision;
  job: Job | null;
  duplicate: boolean;
}

export class SourceService {
  constructor(private readonly ctx: Ctx) {}

  /** Steps 1-8 of the ingestion pipeline: authorize, validate, hash, dedupe, persist original, queue extraction. */
  ingest(
    principal: Principal,
    projectId: string,
    input: {
      filename: string;
      bytes: Uint8Array;
      kind?: "file" | "pasted_text";
      sourceId?: string;
      correlationId?: string;
      /** Already-sanitized display name (folder import: the file's path relative to the imported folder). */
      displayName?: string;
    },
  ): IngestResult {
    requireProject(this.ctx, principal, projectId, "write");
    if (input.bytes.length === 0) throw new AppError("VALIDATION_FAILED", "the file is empty");
    if (input.bytes.length > this.ctx.config.maxUploadBytes) {
      throw new AppError("FILE_TOO_LARGE", `file exceeds ${Math.round(this.ctx.config.maxUploadBytes / 1048576)} MB`);
    }
    const displayName = input.displayName ?? sanitizeDisplayName(input.filename);
    const extension = input.kind === "pasted_text" ? "md" : safeExtension(displayName);
    const hash = sha256(input.bytes);

    const dup = one<RevRow>(this.ctx.db, "SELECT * FROM source_revisions WHERE project_id = ? AND content_hash = ?", projectId, hash);
    if (dup) {
      return { source: this.get(principal, projectId, dup.source_id), revision: toRevision(dup), job: null, duplicate: true };
    }

    let sourceId = input.sourceId;
    let revisionNumber = 1;
    if (sourceId) {
      const s = one<SourceRow>(this.ctx.db, "SELECT * FROM sources WHERE id = ? AND project_id = ? AND deleted_at IS NULL", sourceId, projectId);
      if (!s) throw new AppError("SOURCE_NOT_FOUND", "source not found");
      revisionNumber = (one<{ n: number }>(this.ctx.db, "SELECT MAX(revision_number) AS n FROM source_revisions WHERE source_id = ?", sourceId)?.n ?? 0) + 1;
    } else sourceId = newId("src");
    const revisionId = newId("rev");
    const detected = detectType(input.bytes, extension);
    const meta: SourceMetadata = {
      schema_version: 1,
      project_id: projectId,
      source_id: sourceId,
      revision_id: revisionId,
      revision_number: revisionNumber,
      display_name: displayName,
      kind: input.kind ?? "file",
      original_filename: displayName,
      extension,
      media_type: detected.mediaType,
      size_bytes: input.bytes.length,
      content_hash: hash,
      created_at: nowIso(),
      created_by: actorLabel(principal),
    };
    // Immutable original first. If we crash after this, ops → rebuild imports it from metadata.json.
    this.ctx.files.writeOriginal(meta, input.bytes);

    const job = tx(this.ctx.db, () => {
      if (revisionNumber === 1) {
        run(
          this.ctx.db,
          "INSERT INTO sources (id, project_id, display_name, kind, current_revision_id, created_at) VALUES (?,?,?,?,?,?)",
          sourceId!,
          projectId,
          displayName,
          meta.kind,
          revisionId,
          meta.created_at,
        );
      } else {
        run(this.ctx.db, "UPDATE sources SET current_revision_id = ? WHERE id = ?", revisionId, sourceId!);
      }
      this.insertRevisionRow(meta);
      audit(this.ctx.db, {
        principal,
        projectId,
        action: "source.revision_created",
        entityType: "source",
        entityId: sourceId!,
        details: { revision_id: revisionId, revision_number: revisionNumber, size_bytes: meta.size_bytes, media_type: meta.media_type, sha256: hash },
        correlationId: input.correlationId ?? null,
      });
      return this.ctx.queue.enqueue({
        projectId,
        type: "ingest",
        payload: { revision_id: revisionId },
        createdBy: actorLabel(principal),
        idempotencyKey: `ingest:${revisionId}`,
        maxAttempts: 2,
        correlationId: input.correlationId ?? null,
      });
    });
    return { source: this.get(principal, projectId, sourceId), revision: this.revision(projectId, revisionId), job, duplicate: false };
  }

  insertRevisionRow(meta: SourceMetadata): void {
    run(
      this.ctx.db,
      `INSERT INTO source_revisions (id, source_id, project_id, revision_number, content_hash, size_bytes, media_type, extension, original_filename, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      meta.revision_id,
      meta.source_id,
      meta.project_id,
      meta.revision_number,
      meta.content_hash,
      meta.size_bytes,
      meta.media_type,
      meta.extension,
      meta.original_filename,
      meta.created_at,
    );
  }

  revision(projectId: string, revisionId: string): SourceRevision {
    const r = one<RevRow>(this.ctx.db, "SELECT * FROM source_revisions WHERE id = ? AND project_id = ?", revisionId, projectId);
    if (!r) throw new AppError("SOURCE_NOT_FOUND", "source revision not found");
    return toRevision(r);
  }

  list(principal: Principal, projectId: string): Source[] {
    requireProject(this.ctx, principal, projectId, "read");
    const rows = all<SourceRow>(this.ctx.db, "SELECT * FROM sources WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at DESC", projectId);
    return rows.map((s) => this.toSource(s, false));
  }

  get(principal: Principal, projectId: string, sourceId: string): Source {
    requireProject(this.ctx, principal, projectId, "read");
    const s = one<SourceRow>(this.ctx.db, "SELECT * FROM sources WHERE id = ? AND project_id = ? AND deleted_at IS NULL", sourceId, projectId);
    if (!s) throw new AppError("SOURCE_NOT_FOUND", "source not found");
    return this.toSource(s, true);
  }

  private toSource(s: SourceRow, withRevisions: boolean): Source {
    const cur = s.current_revision_id ? one<RevRow>(this.ctx.db, "SELECT * FROM source_revisions WHERE id = ?", s.current_revision_id) : undefined;
    const out: Source = {
      id: s.id,
      project_id: s.project_id,
      display_name: s.display_name,
      kind: s.kind,
      current_revision_id: s.current_revision_id,
      current: cur ? toRevision(cur) : null,
      created_at: s.created_at,
    };
    if (withRevisions) {
      out.revisions = all<RevRow>(this.ctx.db, "SELECT * FROM source_revisions WHERE source_id = ? ORDER BY revision_number DESC", s.id).map(toRevision);
    }
    return out;
  }

  chunks(principal: Principal, projectId: string, revisionId: string) {
    requireProject(this.ctx, principal, projectId, "read");
    const rev = this.revision(projectId, revisionId);
    const rows = all<{ id: string; ordinal: number; heading: string | null; locator: string; text: string }>(
      this.ctx.db,
      "SELECT id, ordinal, heading, locator, text FROM chunks WHERE project_id = ? AND revision_id = ? ORDER BY ordinal",
      projectId,
      revisionId,
    );
    return {
      revision: rev,
      chunks: rows.map((r) => ({ chunk_id: r.id, ordinal: r.ordinal, heading: r.heading, locator: parseJson(r.locator, {}), text: r.text })),
    };
  }

  original(principal: Principal, projectId: string, revisionId: string): { bytes: Buffer; filename: string; mediaType: string } {
    requireProject(this.ctx, principal, projectId, "read");
    const rev = this.revision(projectId, revisionId);
    const bytes = this.ctx.files.readOriginal(projectId, rev.source_id, rev.id, rev.extension);
    if (sha256(bytes) !== rev.content_hash) throw new AppError("STORAGE_UNAVAILABLE", "stored original does not match its recorded hash");
    return { bytes, filename: rev.original_filename, mediaType: rev.media_type };
  }

  /**
   * Human-confirmed deletion. Removes originals, extraction artifacts, chunks and projections.
   * Knowledge that cited the source keeps its (now dangling) references and is flagged for review.
   */
  delete(principal: Principal, projectId: string, sourceId: string, confirmation: string): { removed_revisions: number } {
    assertHuman(principal);
    const src = this.get(principal, projectId, sourceId);
    if (confirmation.trim() !== `delete ${src.display_name}`) {
      throw new AppError("CONFIRMATION_REQUIRED", `type "delete ${src.display_name}" to confirm`);
    }
    const revs = all<{ id: string }>(this.ctx.db, "SELECT id FROM source_revisions WHERE source_id = ?", sourceId);
    tx(this.ctx.db, () => {
      for (const r of revs) {
        deleteChunksForRevision(this.ctx.db, projectId, r.id);
        run(this.ctx.db, "UPDATE messages SET stale = 1 WHERE id IN (SELECT message_id FROM answer_sources WHERE revision_id = ?)", r.id);
      }
      run(this.ctx.db, "DELETE FROM source_revisions WHERE source_id = ?", sourceId);
      run(this.ctx.db, "DELETE FROM sources WHERE id = ?", sourceId);
      run(
        this.ctx.db,
        `UPDATE knowledge_entities SET stale = 1 WHERE project_id = ? AND EXISTS
           (SELECT 1 FROM json_each(knowledge_entities.data, '$.source_refs') WHERE json_extract(json_each.value, '$.source_id') = ?)`,
        projectId,
        sourceId,
      );
      audit(this.ctx.db, {
        principal,
        projectId,
        action: "source.deleted",
        entityType: "source",
        entityId: sourceId,
        details: { display_name: src.display_name, revisions: revs.length },
      });
    });
    this.ctx.files.deleteSourceFiles(projectId, sourceId);
    for (const r of revs) this.ctx.files.deleteGraphExtraction(projectId, r.id);
    // Generated documents built on this source are rebuilt without it (debounced).
    queueDocsRefresh(this.ctx, projectId, `removed ${src.display_name}`);
    return { removed_revisions: revs.length };
  }

  // ---------- job handler: steps 9-12 ----------
  async runIngestJob(jc: JobContext): Promise<JobOutcome> {
    const revisionId = String(jc.job.payload.revision_id ?? "");
    const rev = one<RevRow>(this.ctx.db, "SELECT * FROM source_revisions WHERE id = ? AND project_id = ?", revisionId, jc.job.projectId);
    if (!rev) throw new AppError("SOURCE_NOT_FOUND", "source revision no longer exists");
    jc.progress("reading original");
    const bytes = this.ctx.files.readOriginal(rev.project_id, rev.source_id, rev.id, rev.extension);
    if (sha256(bytes) !== rev.content_hash) throw new AppError("STORAGE_UNAVAILABLE", "stored original does not match its hash");
    const detected = detectType(bytes, rev.extension);
    jc.progress("extracting", detected.kind);
    const outcome = await runExtraction(bytes, detected.kind, { timeoutMs: this.ctx.config.parserTimeoutMs }, jc.signal);
    if (detected.reason && outcome.status !== "succeeded") outcome.warnings.unshift(detected.reason);
    const source = one<SourceRow>(this.ctx.db, "SELECT * FROM sources WHERE id = ?", rev.source_id)!;

    jc.progress("persisting extraction", `${outcome.chunks.length} chunks`);
    if (outcome.status !== "failed") {
      this.ctx.files.writeExtraction(
        rev.project_id,
        rev.source_id,
        { schema_version: 1, revision_id: rev.id, extractor: outcome.extractor, status: outcome.status, warnings: outcome.warnings, chunks: outcome.chunks },
        outcome.markdown,
      );
    }
    jc.progress("indexing");
    tx(this.ctx.db, () => {
      this.indexRevision(rev, source.display_name, outcome.chunks);
      run(
        this.ctx.db,
        "UPDATE source_revisions SET extraction_status = ?, extraction_warnings = ?, extractor = ?, extracted_hash = ?, chunk_count = ? WHERE id = ?",
        outcome.status,
        JSON.stringify(outcome.warnings),
        outcome.extractor,
        sha256(outcome.markdown),
        outcome.chunks.length,
        rev.id,
      );
      audit(this.ctx.db, {
        principal: { kind: "system", name: "worker" },
        projectId: rev.project_id,
        action: "source.extracted",
        entityType: "source",
        entityId: rev.source_id,
        details: { revision_id: rev.id, status: outcome.status, chunks: outcome.chunks.length, extractor: outcome.extractor },
      });
    });
    if (outcome.status === "failed") throw new AppError("EXTRACTION_FAILED", outcome.warnings.join("; ") || "extraction failed");

    // Step 12: queue AI interpretation only if Parth enabled AI processing for this project.
    let interpretationJob: string | null = null;
    const project = one<{ ai_enabled: number }>(this.ctx.db, "SELECT ai_enabled FROM projects WHERE id = ?", rev.project_id);
    if (project?.ai_enabled === 1 && outcome.chunks.length > 0 && (outcome.status === "succeeded" || outcome.status === "partially_succeeded")) {
      interpretationJob = this.ctx.queue.enqueue({
        projectId: rev.project_id,
        type: "extract_knowledge",
        payload: { revision_id: rev.id },
        createdBy: "system:worker",
        idempotencyKey: `extract:${rev.id}`,
        // One drafting run per project at a time, so each document sees what the previous one created (no duplicate races).
        serialKey: `extract:${rev.project_id}`,
        maxAttempts: 2,
      }).id;
      // Map the document's concepts into the project memory graph (one mapping run per project at a time).
      this.ctx.queue.enqueue({
        projectId: rev.project_id,
        type: "graph_extract",
        payload: { revision_id: rev.id },
        createdBy: "system:worker",
        idempotencyKey: `graph:${rev.id}`,
        serialKey: `graph:${rev.project_id}`,
        maxAttempts: 2,
      });
    }
    const jobStatus = outcome.status === "succeeded" ? "succeeded" : outcome.status;
    return {
      status: jobStatus as JobOutcome["status"],
      result: {
        revision_id: rev.id,
        extraction_status: outcome.status,
        chunks: outcome.chunks.length,
        warnings: outcome.warnings,
        interpretation_job_id: interpretationJob,
      },
    };
  }

  indexRevision(
    rev: { id: string; project_id: string; source_id: string },
    title: string,
    chunks: { ordinal: number; heading: string | null; locator: Record<string, string | number>; text: string }[],
  ): void {
    deleteChunksForRevision(this.ctx.db, rev.project_id, rev.id);
    for (const c of chunks) {
      insertChunk(this.ctx.db, {
        id: `c_${rev.id.slice(4)}_${c.ordinal}`,
        projectId: rev.project_id,
        kind: "evidence",
        sourceId: rev.source_id,
        revisionId: rev.id,
        entityType: "source",
        title,
        ordinal: c.ordinal,
        heading: c.heading,
        locator: c.locator,
        text: c.text,
      });
    }
  }
}
