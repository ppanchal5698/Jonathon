import { createHash } from "node:crypto";
import { type Dirent, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { audit } from "../audit";
import { all, one } from "../db";
import type { JobContext, JobOutcome } from "../jobs/worker";
import { assertHuman, type Principal } from "../security/principal";
import { isInside, sanitizeDisplayName, safeExtension } from "../storage/paths";
import { AppError } from "../util";
import { type Ctx, requireProject } from "./context";
import type { SourceService } from "./sources";

/** File types Jonathon can extract. Everything else in a folder is listed as skipped. */
export const IMPORTABLE_EXTENSIONS = new Set(["pdf", "docx", "xlsx", "pptx", "csv", "txt", "text", "log", "md", "markdown", "json", "html", "htm", "eml"]);
/** Folders that hold tooling, not client material. */
const SKIPPED_DIRS = new Set(["node_modules", "__pycache__", "venv", ".venv", "dist", "build", "bin", "obj", "target", ".next", "coverage"]);
const MAX_DEPTH = 12;
const MAX_ENTRIES = 20_000;
const MAX_FILES = 2_000;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

export type FolderFileStatus = "new" | "changed" | "unchanged" | "duplicate" | "skipped";

export interface FolderFile {
  /** Path relative to the chosen folder, with "/" separators. Also the source's display name. */
  path: string;
  size: number;
  status: FolderFileStatus;
  reason: string | null;
}

export interface FolderScan {
  root: string;
  recursive: boolean;
  files: FolderFile[];
  groups: { folder: string; importable: number; bytes: number }[];
  counts: Record<FolderFileStatus, number>;
  truncated: string | null;
}

/** Display name for a file in an imported folder: each segment cleaned, joined with "/". Never used as a path. */
export function folderDisplayName(rel: string): string {
  const parts = rel
    .split(/[\\/]+/)
    .filter(Boolean)
    .map(sanitizeDisplayName);
  const name = parts.join("/");
  return name.length > 240 ? `…${name.slice(-239)}` : name;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/**
 * Import every supported document under a folder on this computer. Only the signed-in person can do it (MCP tokens and
 * the worker cannot start one), the folder must be an absolute path to a real directory outside Jonathon's data and
 * source folders, links and junctions are never followed, and only files the scan listed as importable are read.
 */
export class FolderImportService {
  constructor(
    private readonly ctx: Ctx,
    private readonly sources: SourceService,
  ) {}

  /** Validate the folder the person typed. */
  resolveRoot(input: string): string {
    const raw = input.trim().replace(/^["']|["']$/g, "");
    if (!raw || !isAbsolute(raw)) throw new AppError("VALIDATION_FAILED", "enter the full path of a folder, for example C:\\Clients\\Acme");
    const root = resolve(raw);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(root);
    } catch {
      throw new AppError("NOT_FOUND", "that folder does not exist or cannot be read");
    }
    if (st.isSymbolicLink()) throw new AppError("UNSAFE_PATH", "the folder is a link or junction; choose the real folder");
    if (!st.isDirectory()) throw new AppError("VALIDATION_FAILED", "that path is a file, not a folder");
    const real = realpathSync(root);
    for (const own of [this.ctx.config.dataDir, this.ctx.config.repoRoot]) {
      if (isInside(resolve(real), resolve(own))) throw new AppError("UNSAFE_PATH", "that folder is inside Jonathon's own data or source folder");
    }
    // Allowlist (containers: the read-only /imports mount). Checked on the resolved real path, so a link inside an
    // allowed root that points elsewhere is refused, and so is any "..", even if the lexical path looked allowed.
    const roots = this.ctx.config.importRoots;
    if (roots.length) {
      const allowed = roots.some((r) => {
        let realRoot: string;
        try {
          realRoot = realpathSync(r);
        } catch {
          return false;
        }
        return isInside(resolve(real), resolve(realRoot));
      });
      if (!allowed) {
        throw new AppError("UNSAFE_PATH", `folder import is limited to ${roots.join(", ")}; put the folder there (read-only mount) and use that path`);
      }
    }
    return real;
  }

  scan(principal: Principal, projectId: string, body: { path: string; recursive: boolean }): FolderScan {
    assertHuman(principal);
    requireProject(this.ctx, principal, projectId, "write");
    return this.scanRoot(projectId, this.resolveRoot(body.path), body.recursive);
  }

  /** Queue the import as a background job (a large folder takes longer than one HTTP request should). */
  queueImport(principal: Principal, projectId: string, body: { path: string; recursive: boolean; files: string[] }) {
    assertHuman(principal);
    requireProject(this.ctx, principal, projectId, "write");
    const root = this.resolveRoot(body.path);
    const scan = this.scanRoot(projectId, root, body.recursive);
    const importable = new Set(scan.files.filter((f) => f.status === "new" || f.status === "changed").map((f) => f.path));
    const chosen = [...new Set(body.files)].filter((f) => importable.has(f));
    if (!chosen.length) throw new AppError("VALIDATION_FAILED", "none of the selected files are new or changed");
    return this.ctx.queue.enqueue({
      projectId,
      type: "import_folder",
      payload: { root, recursive: body.recursive, files: chosen, user: { userId: principal.userId, username: principal.username } },
      createdBy: principal.username,
      serialKey: `import:${projectId}`,
      maxAttempts: 1,
    });
  }

  async runImportJob(jc: JobContext): Promise<JobOutcome> {
    const projectId = jc.job.projectId;
    const p = jc.job.payload as { root: string; recursive: boolean; files: string[]; user: { userId: string; username: string } };
    const principal: Principal = { kind: "user", userId: p.user.userId, username: p.user.username };
    // Re-check everything at run time: the folder or its files may have changed since the scan.
    const root = this.resolveRoot(p.root);
    const scan = this.scanRoot(projectId, root, p.recursive);
    const byPath = new Map(scan.files.map((f) => [f.path, f]));
    const created: string[] = [];
    const revised: string[] = [];
    const unchanged: string[] = [];
    const failed: { path: string; reason: string }[] = [];
    for (const [i, rel] of p.files.entries()) {
      if (jc.signal.aborted) throw new AppError("JOB_CANCELLED", "cancelled");
      jc.progress("importing", `${i + 1} of ${p.files.length}: ${rel}`);
      const f = byPath.get(rel);
      if (!f || (f.status !== "new" && f.status !== "changed")) {
        if (f?.status === "unchanged" || f?.status === "duplicate") unchanged.push(rel);
        else failed.push({ path: rel, reason: f?.reason ?? "no longer in the folder" });
        continue;
      }
      try {
        const abs = this.safeJoin(root, rel);
        const bytes = new Uint8Array(readFileSync(abs));
        const display = folderDisplayName(rel);
        const existing = one<{ id: string }>(
          this.ctx.db,
          "SELECT id FROM sources WHERE project_id = ? AND display_name = ? AND deleted_at IS NULL",
          projectId,
          display,
        );
        const r = this.sources.ingest(principal, projectId, { filename: display, displayName: display, bytes, sourceId: existing?.id });
        if (r.duplicate) unchanged.push(rel);
        else if (existing) revised.push(rel);
        else created.push(rel);
      } catch (e) {
        failed.push({ path: rel, reason: e instanceof AppError ? e.message : (e as Error).message });
      }
    }
    audit(this.ctx.db, {
      principal,
      projectId,
      action: "source.folder_imported",
      entityType: "project",
      entityId: projectId,
      details: { root, files: p.files.length, created: created.length, new_revisions: revised.length, unchanged: unchanged.length, failed: failed.length },
    });
    if (!created.length && !revised.length && failed.length) throw new AppError("EXTRACTION_FAILED", `no file could be imported: ${failed[0]!.reason}`);
    return {
      status: failed.length ? "partially_succeeded" : "succeeded",
      result: {
        root,
        created: created.length,
        new_revisions: revised.length,
        unchanged: unchanged.length,
        failed,
        files: [...created, ...revised].slice(0, 200),
      },
    };
  }

  /** Resolve a relative path from a scan under the root, refusing anything that escapes it or passes through a link. */
  private safeJoin(root: string, rel: string): string {
    const abs = resolve(root, ...rel.split("/"));
    if (!isInside(abs, root) || abs === root) throw new AppError("UNSAFE_PATH", "file is outside the chosen folder");
    let cur = root;
    for (const part of relative(root, abs).split(sep)) {
      cur = join(cur, part);
      if (lstatSync(cur).isSymbolicLink()) throw new AppError("UNSAFE_PATH", "links and junctions are not followed");
    }
    return abs;
  }

  private scanRoot(projectId: string, root: string, recursive: boolean): FolderScan {
    const files: FolderFile[] = [];
    const skip = (path: string, size: number, reason: string) => files.push({ path, size, status: "skipped", reason });
    const own = [resolve(this.ctx.config.dataDir), resolve(this.ctx.config.repoRoot)];
    let entries = 0;
    let totalBytes = 0;
    let truncated: string | null = null;
    const queue: { dir: string; rel: string; depth: number }[] = [{ dir: root, rel: "", depth: 0 }];
    while (queue.length && !truncated) {
      const { dir, rel, depth } = queue.shift()!;
      let list: Dirent[];
      try {
        list = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        skip(rel || ".", 0, "folder cannot be read");
        continue;
      }
      for (const d of list) {
        if (++entries > MAX_ENTRIES) {
          truncated = `stopped after ${MAX_ENTRIES} entries; choose a smaller folder`;
          break;
        }
        const childRel = rel ? `${rel}/${d.name}` : d.name;
        const abs = join(dir, d.name);
        if (d.isSymbolicLink()) {
          skip(childRel, 0, "link or junction (not followed)");
          continue;
        }
        if (d.isDirectory()) {
          if (!recursive) continue;
          if (d.name.startsWith(".") || SKIPPED_DIRS.has(d.name.toLowerCase())) skip(`${childRel}/`, 0, "tooling folder (not scanned)");
          else if (own.some((o) => resolve(abs) === o)) skip(`${childRel}/`, 0, "Jonathon's own folder (not scanned)");
          else if (depth + 1 > MAX_DEPTH) skip(`${childRel}/`, 0, `deeper than ${MAX_DEPTH} levels (not scanned)`);
          else queue.push({ dir: abs, rel: childRel, depth: depth + 1 });
          continue;
        }
        if (!d.isFile()) continue;
        if (d.name.startsWith("~$") || d.name.startsWith(".")) {
          skip(childRel, 0, "hidden or temporary Office file");
          continue;
        }
        let size = 0;
        try {
          size = lstatSync(abs).size;
        } catch {
          skip(childRel, 0, "file cannot be read");
          continue;
        }
        const ext = safeExtension(d.name);
        if (!IMPORTABLE_EXTENSIONS.has(ext)) {
          skip(childRel, size, ext === "bin" ? "no file extension" : `.${ext} is not a supported document type`);
          continue;
        }
        if (size === 0) skip(childRel, size, "empty file");
        else if (size > this.ctx.config.maxUploadBytes) skip(childRel, size, `larger than ${Math.round(this.ctx.config.maxUploadBytes / 1048576)} MB`);
        else if (files.filter((f) => f.status !== "skipped").length >= MAX_FILES) truncated = `more than ${MAX_FILES} documents; import a sub-folder first`;
        else if (totalBytes + size > MAX_TOTAL_BYTES) truncated = "more than 2 GB of documents; import a sub-folder first";
        else {
          totalBytes += size;
          files.push({ path: childRel, size, status: "new", reason: null });
        }
      }
    }

    // Compare with what the project already holds: same name and content → unchanged; same name, new content → changed
    // (imported as a new revision of that source); same content under another name → duplicate.
    const byName = new Map(
      all<{ display_name: string; content_hash: string }>(
        this.ctx.db,
        "SELECT s.display_name, r.content_hash FROM sources s JOIN source_revisions r ON r.id = s.current_revision_id WHERE s.project_id = ? AND s.deleted_at IS NULL",
        projectId,
      ).map((r) => [r.display_name, r.content_hash]),
    );
    const hashes = new Set(
      all<{ content_hash: string }>(this.ctx.db, "SELECT content_hash FROM source_revisions WHERE project_id = ?", projectId).map((r) => r.content_hash),
    );
    for (const f of files) {
      if (f.status === "skipped") continue;
      let hash: string;
      try {
        hash = sha256(readFileSync(this.safeJoin(root, f.path)));
      } catch {
        f.status = "skipped";
        f.reason = "file cannot be read";
        continue;
      }
      const known = byName.get(folderDisplayName(f.path));
      if (known === hash) f.status = "unchanged";
      else if (known) f.status = "changed";
      else if (hashes.has(hash)) {
        f.status = "duplicate";
        f.reason = "the same content is already in this project under another name";
      }
    }

    const counts: Record<FolderFileStatus, number> = { new: 0, changed: 0, unchanged: 0, duplicate: 0, skipped: 0 };
    const groups = new Map<string, { importable: number; bytes: number }>();
    for (const f of files) {
      counts[f.status]++;
      const top = f.path.includes("/") ? f.path.slice(0, f.path.indexOf("/")) : ".";
      const g = groups.get(top) ?? { importable: 0, bytes: 0 };
      if (f.status === "new" || f.status === "changed") {
        g.importable++;
        g.bytes += f.size;
      }
      groups.set(top, g);
    }
    return {
      root,
      recursive,
      files,
      groups: [...groups.entries()].map(([folder, g]) => ({ folder, ...g })).sort((a, b) => a.folder.localeCompare(b.folder)),
      counts,
      truncated,
    };
  }
}
