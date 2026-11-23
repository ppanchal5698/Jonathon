import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import type { ExtractionStatus, Locator } from "@jonathon/contracts";
import YAML from "yaml";
import { z } from "zod";
import { AppError, sha256 } from "../util";
import { readText, writeFileAtomic, writeFileCreateOnly } from "./fsutil";
import { assertSafeSegment, ensureDirInside, resolveInside } from "./paths";

export interface ProjectManifest {
  id: string;
  name: string;
  description: string;
  ai_enabled: boolean;
  is_demo: boolean;
  created_at: string;
  updated_at: string;
}

const ManifestSchema = z.object({
  id: z.string(),
  name: z.string(),
  ai_enabled: z.boolean(),
  is_demo: z.boolean().default(false),
  created_at: z.string(),
  updated_at: z.string(),
});

/** Immutable facts about one source revision. Written once, never changed. */
export const SourceMetadataSchema = z.object({
  schema_version: z.literal(1),
  project_id: z.string(),
  source_id: z.string(),
  revision_id: z.string(),
  revision_number: z.number().int().positive(),
  display_name: z.string(),
  kind: z.enum(["file", "pasted_text"]),
  original_filename: z.string(),
  extension: z.string(),
  media_type: z.string(),
  size_bytes: z.number().int().nonnegative(),
  content_hash: z.string(),
  created_at: z.string(),
  created_by: z.string(),
});
export type SourceMetadata = z.infer<typeof SourceMetadataSchema>;

export interface ExtractedChunk {
  ordinal: number;
  heading: string | null;
  locator: Locator;
  text: string;
}

export const LocatorsDocSchema = z.object({
  schema_version: z.literal(1),
  revision_id: z.string(),
  extractor: z.string(),
  status: z.enum(["succeeded", "partially_succeeded", "failed", "unsupported", "needs_ocr"]),
  warnings: z.array(z.string()),
  chunks: z.array(
    z.object({
      ordinal: z.number().int(),
      heading: z.string().nullable(),
      locator: z.record(z.string(), z.union([z.string(), z.number()])),
      text: z.string(),
    }),
  ),
});
export type LocatorsDoc = z.infer<typeof LocatorsDocSchema>;

/** File layout for project manifests, sources, extraction artifacts and specification snapshots. */
export class ProjectFiles {
  constructor(readonly dataDir: string) {}

  // ----- project.md -----
  writeManifest(m: ProjectManifest): string {
    ensureDirInside(this.dataDir, "projects", m.id);
    const fm = YAML.stringify(
      { id: m.id, name: m.name, ai_enabled: m.ai_enabled, is_demo: m.is_demo, schema_version: 1, created_at: m.created_at, updated_at: m.updated_at },
      { lineWidth: 0, defaultStringType: "QUOTE_DOUBLE" },
    );
    const text = `---\n${fm.trimEnd()}\n---\n\n# ${m.name.replace(/\n/g, " ")}\n\n${m.description.trim()}\n`;
    writeFileAtomic(resolveInside(this.dataDir, "projects", m.id, "project.md"), text);
    return sha256(text);
  }

  readManifest(projectId: string): ProjectManifest | null {
    const text = readText(resolveInside(this.dataDir, "projects", projectId, "project.md"));
    if (text == null) return null;
    const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
    if (!m) return null;
    const fm = ManifestSchema.safeParse(YAML.parse(m[1]!, { maxAliasCount: 0 }));
    if (!fm.success || fm.data.id !== projectId) return null;
    const description = m[2]!.replace(/^\s*# .*\n/, "").trim();
    return { ...fm.data, description };
  }

  listProjectIds(): string[] {
    try {
      return readdirSync(ensureDirInside(this.dataDir, "projects")).filter((n) => /^prj_[0-9a-z]{26}$/.test(n));
    } catch {
      return [];
    }
  }

  // ----- sources -----
  writeOriginal(meta: SourceMetadata, bytes: Uint8Array): void {
    assertSafeSegment(meta.extension);
    if (sha256(bytes) !== meta.content_hash) throw new AppError("INTERNAL", "content hash mismatch while persisting original");
    ensureDirInside(this.dataDir, "projects", meta.project_id, "sources", meta.source_id, meta.revision_id);
    const base = ["projects", meta.project_id, "sources", meta.source_id, meta.revision_id] as const;
    // Original first, metadata second: metadata.json existing means the original is complete.
    writeFileCreateOnly(resolveInside(this.dataDir, ...base, `original.${meta.extension}`), bytes);
    writeFileCreateOnly(resolveInside(this.dataDir, ...base, "metadata.json"), `${JSON.stringify(meta, null, 2)}\n`);
  }

  readOriginal(projectId: string, sourceId: string, revisionId: string, extension: string): Buffer {
    const p = resolveInside(this.dataDir, "projects", projectId, "sources", sourceId, revisionId, `original.${assertSafeSegment(extension)}`);
    try {
      return readFileSync(p);
    } catch (e) {
      throw new AppError("SOURCE_NOT_FOUND", "original file is missing from storage", { cause: e });
    }
  }

  readMetadata(projectId: string, sourceId: string, revisionId: string): SourceMetadata | null {
    const text = readText(resolveInside(this.dataDir, "projects", projectId, "sources", sourceId, revisionId, "metadata.json"));
    if (text == null) return null;
    const r = SourceMetadataSchema.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  }

  /** Every persisted source revision (metadata present) for rebuilds. */
  listSourceRevisions(projectId: string): SourceMetadata[] {
    const out: SourceMetadata[] = [];
    let sources: string[] = [];
    try {
      sources = readdirSync(ensureDirInside(this.dataDir, "projects", projectId, "sources"));
    } catch {
      return out;
    }
    for (const s of sources.filter((n) => /^src_[0-9a-z]{26}$/.test(n))) {
      for (const r of readdirSync(resolveInside(this.dataDir, "projects", projectId, "sources", s)).filter((n) => /^rev_[0-9a-z]{26}$/.test(n))) {
        const meta = this.readMetadata(projectId, s, r);
        if (meta) out.push(meta);
      }
    }
    return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  writeExtraction(projectId: string, sourceId: string, doc: LocatorsDoc, markdown: string): void {
    ensureDirInside(this.dataDir, "projects", projectId, "extracted", sourceId);
    writeFileAtomic(resolveInside(this.dataDir, "projects", projectId, "extracted", sourceId, `${doc.revision_id}.md`), markdown);
    writeFileAtomic(resolveInside(this.dataDir, "projects", projectId, "extracted", sourceId, `${doc.revision_id}.locators.json`), `${JSON.stringify(doc)}\n`);
  }

  readExtraction(projectId: string, sourceId: string, revisionId: string): LocatorsDoc | null {
    const text = readText(resolveInside(this.dataDir, "projects", projectId, "extracted", sourceId, `${revisionId}.locators.json`));
    if (text == null) return null;
    const r = LocatorsDocSchema.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  }

  readExtractionMarkdown(projectId: string, sourceId: string, revisionId: string): string | null {
    return readText(resolveInside(this.dataDir, "projects", projectId, "extracted", sourceId, `${revisionId}.md`));
  }

  /** Human-confirmed deletion: removes the source's originals and extraction artifacts. */
  // ----- whole-project deletion (crash-safe; see ProjectService.delete) -----

  /**
   * Move projects/<id> and runtime-workspaces/<id> into staging/deleted-projects/<id>/ with one rename each. Atomic on
   * one filesystem: readers see the folder either in place or gone. Returns false when there was nothing to move.
   */
  stageProjectDeletion(projectId: string): boolean {
    assertSafeSegment(projectId);
    const target = resolveInside(this.dataDir, "staging", "deleted-projects", projectId);
    rmSync(target, { recursive: true, force: true }); // leftover of an earlier, already-committed attempt
    ensureDirInside(this.dataDir, "staging", "deleted-projects", projectId);
    let moved = false;
    for (const area of ["projects", "runtime-workspaces"]) {
      const from = resolveInside(this.dataDir, area, projectId);
      if (!existsSync(from)) continue;
      try {
        renameSync(from, resolveInside(this.dataDir, "staging", "deleted-projects", projectId, area));
        moved = true;
      } catch (e) {
        this.unstageProjectDeletion(projectId);
        throw new AppError("STORAGE_UNAVAILABLE", "could not move the project's files (is a file open in another program?)", { cause: e, retryable: true });
      }
    }
    return moved;
  }

  /** Undo stageProjectDeletion (the database transaction did not commit). */
  unstageProjectDeletion(projectId: string): void {
    for (const area of ["projects", "runtime-workspaces"]) {
      const staged = resolveInside(this.dataDir, "staging", "deleted-projects", projectId, area);
      const home = resolveInside(this.dataDir, area, projectId);
      if (existsSync(staged) && !existsSync(home)) {
        ensureDirInside(this.dataDir, area);
        renameSync(staged, home);
      }
    }
    rmSync(resolveInside(this.dataDir, "staging", "deleted-projects", projectId), { recursive: true, force: true });
  }

  /** Remove the staged copy for good (after the database transaction committed). */
  purgeStagedProject(projectId: string): void {
    rmSync(resolveInside(this.dataDir, "staging", "deleted-projects", projectId), { recursive: true, force: true, maxRetries: 3 });
  }

  /**
   * Startup recovery for an interrupted project deletion: if the database still has the project, the transaction never
   * committed, so the files go back; otherwise the deletion committed and the staged files are removed.
   */
  sweepDeletedProjects(projectExists: (projectId: string) => boolean): { restored: string[]; purged: string[] } {
    const out = { restored: [] as string[], purged: [] as string[] };
    let names: string[] = [];
    try {
      names = readdirSync(resolveInside(this.dataDir, "staging", "deleted-projects")).filter((n) => /^prj_[0-9a-z]{26}$/.test(n));
    } catch {
      return out;
    }
    for (const pid of names) {
      if (projectExists(pid)) {
        this.unstageProjectDeletion(pid);
        out.restored.push(pid);
      } else {
        this.purgeStagedProject(pid);
        out.purged.push(pid);
      }
    }
    return out;
  }

  deleteSourceFiles(projectId: string, sourceId: string): void {
    for (const area of ["sources", "extracted"]) {
      const p = resolveInside(this.dataDir, "projects", projectId, area, sourceId);
      rmSync(p, { recursive: true, force: true });
    }
  }

  // ----- specification snapshots -----
  writeSpecSnapshot(projectId: string, snapshotId: string, markdown: string): string {
    ensureDirInside(this.dataDir, "projects", projectId, "specifications");
    writeFileCreateOnly(resolveInside(this.dataDir, "projects", projectId, "specifications", `${snapshotId}.md`), markdown);
    return `projects/${projectId}/specifications/${snapshotId}.md`;
  }

  readSpecSnapshot(projectId: string, snapshotId: string): string | null {
    return readText(resolveInside(this.dataDir, "projects", projectId, "specifications", `${snapshotId}.md`));
  }

  // ----- memory graph (derived: rebuildable from sources and knowledge) -----
  writeGraphExtraction(projectId: string, revisionId: string, json: string): void {
    assertSafeSegment(revisionId);
    ensureDirInside(this.dataDir, "projects", projectId, "graph", "extractions");
    writeFileAtomic(resolveInside(this.dataDir, "projects", projectId, "graph", "extractions", `${revisionId}.json`), json);
  }

  /** Every stored graph extraction as [revision id, file text, mtime]. */
  listGraphExtractions(projectId: string): { revisionId: string; text: string; mtimeMs: number }[] {
    const dir = resolveInside(this.dataDir, "projects", projectId, "graph", "extractions");
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => /^rev_[0-9a-z]{26}\.json$/.test(n));
    } catch {
      return [];
    }
    const out: { revisionId: string; text: string; mtimeMs: number }[] = [];
    for (const n of names.sort()) {
      const p = resolveInside(dir, n);
      const text = readText(p);
      if (text != null) out.push({ revisionId: n.slice(0, -5), text, mtimeMs: statSync(p).mtimeMs });
    }
    return out;
  }

  graphExtractionStamp(projectId: string): string {
    const dir = resolveInside(this.dataDir, "projects", projectId, "graph", "extractions");
    try {
      return readdirSync(dir)
        .sort()
        .map((n) => `${n}:${statSync(resolveInside(dir, n)).mtimeMs}`)
        .join(",");
    } catch {
      return "";
    }
  }

  deleteGraphExtraction(projectId: string, revisionId: string): void {
    assertSafeSegment(revisionId);
    rmSync(resolveInside(this.dataDir, "projects", projectId, "graph", "extractions", `${revisionId}.json`), { force: true });
  }

  /** graph/graph.json in graphify's node-link format, so the graphify CLI can query it. */
  writeGraphJson(projectId: string, json: string): string {
    ensureDirInside(this.dataDir, "projects", projectId, "graph");
    const p = resolveInside(this.dataDir, "projects", projectId, "graph", "graph.json");
    if (readText(p) !== json) writeFileAtomic(p, json);
    return p;
  }

  // ----- generated technical documents -----
  readDocument(projectId: string, docType: string): string | null {
    assertSafeSegment(docType);
    return readText(resolveInside(this.dataDir, "projects", projectId, "documents", `${docType}.json`));
  }

  readDocumentMarkdown(projectId: string, docType: string): string | null {
    assertSafeSegment(docType);
    return readText(resolveInside(this.dataDir, "projects", projectId, "documents", `${docType}.md`));
  }

  /**
   * Write the document (JSON, authoritative) and its Markdown rendering. If the Markdown file was edited outside
   * Jonathon since the last rendering, the edited file is kept in history before it is replaced, never dropped.
   */
  writeDocument(
    projectId: string,
    docType: string,
    revision: number,
    json: string,
    markdown: string,
    lastRenderedHash: string,
  ): { externalEditKept: string | null } {
    assertSafeSegment(docType);
    ensureDirInside(this.dataDir, "projects", projectId, "documents", "history", docType);
    const mdPath = resolveInside(this.dataDir, "projects", projectId, "documents", `${docType}.md`);
    const current = readText(mdPath);
    let externalEditKept: string | null = null;
    if (current != null && lastRenderedHash && sha256(current) !== lastRenderedHash) {
      externalEditKept = `projects/${projectId}/documents/history/${docType}/external-edit-before-r${revision}-${Date.now()}.md`;
      writeFileAtomic(resolveInside(this.dataDir, ...externalEditKept.split("/")), current);
    }
    writeFileAtomic(resolveInside(this.dataDir, "projects", projectId, "documents", "history", docType, `r${revision}.json`), json);
    writeFileAtomic(resolveInside(this.dataDir, "projects", projectId, "documents", `${docType}.json`), json);
    writeFileAtomic(mdPath, markdown);
    return { externalEditKept };
  }

  listDocumentTypes(projectId: string): string[] {
    try {
      return readdirSync(resolveInside(this.dataDir, "projects", projectId, "documents"))
        .filter((n) => /^[a-z0-9_]{2,60}\.json$/.test(n))
        .map((n) => n.slice(0, -5));
    } catch {
      return [];
    }
  }
}

export type { ExtractionStatus };
