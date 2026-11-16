import { accessSync, constants, cpSync, mkdirSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { audit } from "../audit";
import { all, hasFts5, one, run, tx } from "../db";
import type { JobContext, JobOutcome } from "../jobs/worker";
import { deleteAllChunks } from "../retrieval/indexer";
import { assertHuman, type Principal } from "../security/principal";
import type { ReconcileReport } from "../storage/knowledge-store";
import { AppError, nowIso } from "../util";
import { type Ctx, requireProject } from "./context";
import type { SourceService } from "./sources";

export class OpsService {
  constructor(
    private readonly ctx: Ctx,
    private readonly sources: SourceService,
  ) {}

  /** Re-import projects and sources from files that the projection does not know (e.g. after losing SQLite). */
  importFromFiles(principal: Principal): { projects: number; source_revisions: number } {
    if (principal.kind === "mcp_token") throw new AppError("FORBIDDEN", "not allowed");
    let projects = 0;
    let revisions = 0;
    for (const pid of this.ctx.files.listProjectIds()) {
      const m = this.ctx.files.readManifest(pid);
      if (!m) continue;
      if (!one(this.ctx.db, "SELECT id FROM projects WHERE id = ?", pid)) {
        run(
          this.ctx.db,
          "INSERT INTO projects (id, name, description, ai_enabled, knowledge_revision, is_demo, created_at, updated_at) VALUES (?,?,?,?,0,?,?,?)",
          pid,
          m.name,
          m.description,
          m.ai_enabled ? 1 : 0,
          m.is_demo ? 1 : 0,
          m.created_at,
          m.updated_at,
        );
        projects++;
      }
      for (const meta of this.ctx.files.listSourceRevisions(pid)) {
        if (one(this.ctx.db, "SELECT id FROM source_revisions WHERE id = ?", meta.revision_id)) continue;
        tx(this.ctx.db, () => {
          if (!one(this.ctx.db, "SELECT id FROM sources WHERE id = ?", meta.source_id)) {
            run(
              this.ctx.db,
              "INSERT INTO sources (id, project_id, display_name, kind, current_revision_id, created_at) VALUES (?,?,?,?,?,?)",
              meta.source_id,
              pid,
              meta.display_name,
              meta.kind,
              meta.revision_id,
              meta.created_at,
            );
          } else {
            run(this.ctx.db, "UPDATE sources SET current_revision_id = ? WHERE id = ? AND (SELECT revision_number FROM source_revisions WHERE id = current_revision_id) < ?", meta.revision_id, meta.source_id, meta.revision_number);
          }
          this.sources.insertRevisionRow(meta);
          const ex = this.ctx.files.readExtraction(pid, meta.source_id, meta.revision_id);
          if (ex) {
            run(
              this.ctx.db,
              "UPDATE source_revisions SET extraction_status = ?, extraction_warnings = ?, extractor = ?, chunk_count = ? WHERE id = ?",
              ex.status,
              JSON.stringify(ex.warnings),
              ex.extractor,
              ex.chunks.length,
              meta.revision_id,
            );
            this.sources.indexRevision({ id: meta.revision_id, project_id: pid, source_id: meta.source_id }, meta.display_name, ex.chunks);
          } else {
            this.ctx.queue.enqueue({ projectId: pid, type: "ingest", payload: { revision_id: meta.revision_id }, createdBy: "system:ops", idempotencyKey: `ingest:${meta.revision_id}` });
          }
        });
        revisions++;
      }
    }
    return { projects, source_revisions: revisions };
  }

  /** Reconcile one or all projects: complete crash intents, import external edits, flag missing files. */
  reconcile(principal: Principal, projectId?: string): ReconcileReport[] {
    if (principal.kind === "mcp_token") throw new AppError("FORBIDDEN", "not allowed");
    const ids = projectId ? [requireProject(this.ctx, principal, projectId, "write").id] : all<{ id: string }>(this.ctx.db, "SELECT id FROM projects").map((r) => r.id);
    const reports = ids.map((id) => this.ctx.store.reconcile(id, principal));
    audit(this.ctx.db, {
      principal,
      projectId: projectId ?? null,
      action: "ops.reconciled",
      details: { projects: ids.length, edits: reports.reduce((n, r) => n + r.external_edits.length, 0), invalid: reports.reduce((n, r) => n + r.invalid_files.length, 0) },
    });
    return reports;
  }

  /** Rebuild every rebuildable projection for a project from its files: entities, source chunks, FTS. */
  rebuildIndex(principal: Principal, projectId: string): { entities: number; chunks: number; report: ReconcileReport } {
    requireProject(this.ctx, principal, projectId, "write");
    const report = this.ctx.store.reconcile(projectId, principal);
    tx(this.ctx.db, () => {
      deleteAllChunks(this.ctx.db, projectId);
      for (const meta of this.ctx.files.listSourceRevisions(projectId)) {
        const ex = this.ctx.files.readExtraction(projectId, meta.source_id, meta.revision_id);
        if (ex && one(this.ctx.db, "SELECT id FROM source_revisions WHERE id = ?", meta.revision_id)) {
          this.sources.indexRevision({ id: meta.revision_id, project_id: projectId, source_id: meta.source_id }, meta.display_name, ex.chunks);
        }
      }
    });
    this.ctx.store.rebuildProjection(projectId, principal);
    const n = one<{ e: number; c: number }>(
      this.ctx.db,
      "SELECT (SELECT COUNT(*) FROM knowledge_entities WHERE project_id = ?) AS e, (SELECT COUNT(*) FROM chunks WHERE project_id = ?) AS c",
      projectId,
      projectId,
    )!;
    audit(this.ctx.db, { principal, projectId, action: "ops.reindexed", details: { entities: n.e, chunks: n.c } });
    return { entities: n.e, chunks: n.c, report };
  }

  async runReindexJob(jc: JobContext): Promise<JobOutcome> {
    const r = this.rebuildIndex({ kind: "system", name: "worker" }, jc.job.projectId);
    return { status: "succeeded", result: { entities: r.entities, chunks: r.chunks } };
  }

  /**
   * Consistent backup: SQLite via VACUUM INTO (operational state that cannot be rebuilt) plus a copy of the
   * projects/ tree (authoritative knowledge and originals). Not encrypted.
   */
  backup(principal: Principal): { path: string; created_at: string } {
    assertHuman(principal);
    const stamp = nowIso().replace(/[:.]/g, "-");
    const dir = join(this.ctx.config.dataDir, "backups", stamp);
    mkdirSync(dir, { recursive: true });
    this.ctx.db.exec(`VACUUM INTO '${join(dir, "jonathon.sqlite").replace(/'/g, "''")}'`);
    cpSync(join(this.ctx.config.dataDir, "projects"), join(dir, "projects"), { recursive: true, errorOnExist: false, verbatimSymlinks: true });
    audit(this.ctx.db, { principal, action: "ops.backup_created", details: { path: `backups/${stamp}` } });
    return { path: dir, created_at: stamp };
  }

  health(): Record<string, unknown> {
    let storageOk = true;
    let freeBytes: number | null = null;
    try {
      accessSync(this.ctx.config.dataDir, constants.W_OK);
      const s = statfsSync(this.ctx.config.dataDir);
      freeBytes = Number(s.bavail) * Number(s.bsize);
    } catch {
      storageOk = false;
    }
    const worker = one<{ last_seen_at: string }>(this.ctx.db, "SELECT last_seen_at FROM worker_heartbeats ORDER BY last_seen_at DESC LIMIT 1");
    const workerAlive = !!worker && Date.now() - Date.parse(worker.last_seen_at) < 15_000;
    const runtime = one<{ status: string; checked_at: string; details: string }>(this.ctx.db, "SELECT * FROM integration_health WHERE name = 'runtime'");
    const failed = one<{ n: number }>(this.ctx.db, "SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed'")!.n;
    const queued = one<{ n: number }>(this.ctx.db, "SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','retrying','running')")!.n;
    return {
      status: storageOk && workerAlive ? "ok" : "degraded",
      mode: this.ctx.config.mode,
      database: { ok: true, fts5: hasFts5(this.ctx.db) },
      storage: { ok: storageOk, free_bytes: freeBytes },
      worker: { alive: workerAlive, last_seen_at: worker?.last_seen_at ?? null },
      runtime: runtime ? { status: runtime.status, checked_at: runtime.checked_at, ...JSON.parse(runtime.details) } : { status: "unchecked" },
      jobs: { failed, active: queued },
    };
  }

  /** Runtime diagnostics. Installation and capability checks are local; the auth check contacts the provider. */
  async runtimeDiagnostics(includeAuth: boolean): Promise<Record<string, unknown>> {
    const installation = await this.ctx.runtime.inspectInstallation();
    const capabilities = installation.installed ? await this.ctx.runtime.inspectCapabilities() : null;
    const auth = includeAuth && installation.installed ? await this.ctx.runtime.checkAuthentication() : null;
    const status = !installation.installed
      ? this.ctx.runtime.provider === "demo-extractive"
        ? "demo"
        : "not_installed"
      : capabilities && !capabilities.compatible
        ? "incompatible"
        : auth?.status === "auth_required"
          ? "auth_required"
          : "ok";
    const details = { provider: this.ctx.runtime.provider, installation, capabilities, auth, auth_checked: includeAuth };
    run(
      this.ctx.db,
      "INSERT INTO integration_health (name, status, checked_at, details) VALUES ('runtime', ?, ?, ?) ON CONFLICT(name) DO UPDATE SET status = excluded.status, checked_at = excluded.checked_at, details = excluded.details",
      status,
      nowIso(),
      JSON.stringify(details),
    );
    return { status, ...details };
  }
}
