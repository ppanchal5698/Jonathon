import { readdirSync, readFileSync, rmSync } from "node:fs";
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
    writeFileAtomic(
      resolveInside(this.dataDir, "projects", projectId, "extracted", sourceId, `${doc.revision_id}.locators.json`),
      `${JSON.stringify(doc)}\n`,
    );
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
}

export type { ExtractionStatus };
