import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "@jonathon/contracts";
import { audit } from "../audit";
import { all, one, run, tx } from "../db";
import { actorLabel, assertHuman, type Principal } from "../security/principal";
import { AppError, newId, nowIso, parseJson } from "../util";
import { type Ctx, requireProject, toProject } from "./context";

export class ProjectService {
  constructor(private readonly ctx: Ctx) {}

  create(principal: Principal, input: { name: string; description?: string; ai_enabled?: boolean; is_demo?: boolean }): Project {
    if (principal.kind !== "user" && principal.kind !== "system") throw new AppError("FORBIDDEN", "only the local user can create projects");
    const id = newId("prj");
    const now = nowIso();
    const manifest = {
      id,
      name: input.name.trim(),
      description: input.description ?? "",
      ai_enabled: input.ai_enabled ?? false,
      is_demo: input.is_demo ?? false,
      created_at: now,
      updated_at: now,
    };
    const hash = this.ctx.files.writeManifest(manifest);
    tx(this.ctx.db, () => {
      run(
        this.ctx.db,
        `INSERT INTO projects (id, name, description, ai_enabled, knowledge_revision, is_demo, file_hash, created_at, updated_at)
         VALUES (?,?,?,?,0,?,?,?,?)`,
        id,
        manifest.name,
        manifest.description,
        manifest.ai_enabled ? 1 : 0,
        manifest.is_demo ? 1 : 0,
        hash,
        now,
        now,
      );
      audit(this.ctx.db, { principal, projectId: id, action: "project.created", details: { ai_enabled: manifest.ai_enabled, by: actorLabel(principal) } });
    });
    return this.get(principal, id);
  }

  list(principal: Principal): Project[] {
    const rows = all<Parameters<typeof toProject>[0]>(this.ctx.db, "SELECT * FROM projects ORDER BY updated_at DESC");
    const visible = principal.kind === "mcp_token" ? rows.filter((r) => principal.projectIds.includes(r.id) && principal.scopes.includes("read")) : rows;
    return visible.map(toProject);
  }

  get(principal: Principal, projectId: string): Project {
    return requireProject(this.ctx, principal, projectId, "read");
  }

  update(principal: Principal, projectId: string, patch: { name?: string; description?: string; ai_enabled?: boolean }): Project {
    const p = requireProject(this.ctx, principal, projectId, "write");
    if (patch.ai_enabled !== undefined && principal.kind !== "user") throw new AppError("FORBIDDEN", "only the local user can change AI processing permission");
    const next = {
      id: p.id,
      name: patch.name?.trim() ?? p.name,
      description: patch.description ?? p.description,
      ai_enabled: patch.ai_enabled ?? p.ai_enabled,
      is_demo: p.is_demo,
      created_at: p.created_at,
      updated_at: nowIso(),
    };
    const hash = this.ctx.files.writeManifest(next);
    tx(this.ctx.db, () => {
      run(
        this.ctx.db,
        "UPDATE projects SET name = ?, description = ?, ai_enabled = ?, file_hash = ?, updated_at = ? WHERE id = ?",
        next.name,
        next.description,
        next.ai_enabled ? 1 : 0,
        hash,
        next.updated_at,
        projectId,
      );
      audit(this.ctx.db, {
        principal,
        projectId,
        action: "project.updated",
        details: { fields: Object.keys(patch), ai_enabled: patch.ai_enabled },
      });
    });
    return this.get(principal, projectId);
  }

  /**
   * Permanently delete a project and everything Jonathon holds for it: originals, extractions, knowledge files and
   * history, generated documents, graph data, the runtime workspace, and every database row (sources, chunks and the
   * search index, knowledge, approvals, conversations and answers, jobs and dead letters). Signed-in human only, with
   * the typed phrase `delete <project name>`.
   *
   * Kept on purpose: audit events (metadata only, no document text; `project.deleted` records who and when) and the
   * MCP access log. MCP tokens lose the project from their scope; a token left with no project is revoked.
   * Out of reach: earlier backups, and copies held by Antigravity or the model provider.
   *
   * Crash safety: while holding SQLite's write lock, the project's folders are renamed into
   * staging/deleted-projects/<id>/, then the rows are deleted. If the transaction fails, the folders are renamed back.
   * After COMMIT the staged folders are removed; if the process dies in between, startup recovery
   * (ProjectFiles.sweepDeletedProjects) finishes the removal, or restores the folders when the project row still exists.
   * Refused while a job of this project is running; those jobs are asked to stop first.
   */
  delete(principal: Principal, projectId: string, confirmation: string): { deleted: string; name: string; sources: number; entities: number; jobs: number } {
    assertHuman(principal);
    const p = requireProject(this.ctx, principal, projectId, "write");
    const phrase = `delete ${p.name}`;
    if (confirmation.trim() !== phrase) throw new AppError("CONFIRMATION_REQUIRED", `type "${phrase}" to confirm`);
    const db = this.ctx.db;
    let staged = false;
    let counts = { sources: 0, entities: 0, jobs: 0 };
    try {
      tx(db, () => {
        const running = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM jobs WHERE project_id = ? AND status = 'running'", projectId)!.n;
        if (running) {
          // This transaction rolls back; the catch below asks the running jobs to stop.
          throw new AppError(
            "INVALID_TRANSITION",
            `${running} job(s) of this project are still running. They have been asked to stop; try again in a few seconds.`,
            {
              details: { running },
            },
          );
        }
        counts = {
          sources: one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM sources WHERE project_id = ?", projectId)!.n,
          entities: one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM knowledge_entities WHERE project_id = ?", projectId)!.n,
          jobs: one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM jobs WHERE project_id = ?", projectId)!.n,
        };
        staged = this.ctx.files.stageProjectDeletion(projectId);
        // Children first: foreign keys are enforced.
        for (const sql of [
          "DELETE FROM answer_sources WHERE project_id = ?",
          "DELETE FROM runtime_sessions WHERE project_id = ?",
          "DELETE FROM messages WHERE project_id = ?",
          "DELETE FROM conversations WHERE project_id = ?",
          "DELETE FROM dead_letters WHERE project_id = ?",
          "DELETE FROM job_attempts WHERE job_id IN (SELECT id FROM jobs WHERE project_id = ?)",
          "DELETE FROM jobs WHERE project_id = ?",
          "DELETE FROM chunks_fts WHERE project_id = ?",
          "DELETE FROM chunks WHERE project_id = ?",
          "DELETE FROM source_revisions WHERE project_id = ?",
          "DELETE FROM sources WHERE project_id = ?",
          "DELETE FROM approval_events WHERE project_id = ?",
          "DELETE FROM knowledge_entities WHERE project_id = ?",
          "DELETE FROM spec_snapshots WHERE project_id = ?",
          "DELETE FROM generated_documents WHERE project_id = ?",
        ]) {
          run(db, sql, projectId);
        }
        const now = nowIso();
        for (const t of all<{ id: string; project_ids: string }>(db, "SELECT id, project_ids FROM mcp_tokens")) {
          const ids = parseJson<string[]>(t.project_ids, []);
          if (!ids.includes(projectId)) continue;
          const rest = ids.filter((x) => x !== projectId);
          run(
            db,
            "UPDATE mcp_tokens SET project_ids = ?, revoked_at = CASE WHEN ? = 0 THEN COALESCE(revoked_at, ?) ELSE revoked_at END WHERE id = ?",
            JSON.stringify(rest),
            rest.length,
            now,
            t.id,
          );
        }
        run(db, "DELETE FROM projects WHERE id = ?", projectId);
        audit(db, { principal, projectId, action: "project.deleted", entityType: "project", entityId: projectId, details: { name: p.name, ...counts } });
      });
    } catch (e) {
      if (staged) this.ctx.files.unstageProjectDeletion(projectId);
      if ((e as AppError).code === "INVALID_TRANSITION") {
        run(db, "UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE project_id = ? AND status = 'running'", nowIso(), projectId);
      }
      throw e;
    }
    try {
      this.ctx.files.purgeStagedProject(projectId);
    } catch (e) {
      this.ctx.log.warn({ err: (e as Error).message, project_id: projectId }, "staged project files not removed yet; startup recovery will remove them");
    }
    this.dropIntents(projectId);
    return { deleted: projectId, name: p.name, ...counts };
  }

  /**
   * Startup recovery for an interrupted delete (API and worker both call it). Runs under SQLite's write lock, so it
   * waits for a delete that is still inside its transaction instead of racing it.
   */
  recoverInterruptedDeletes(): { restored: string[]; purged: string[] } {
    return tx(this.ctx.db, () => this.ctx.files.sweepDeletedProjects((pid) => !!one(this.ctx.db, "SELECT id FROM projects WHERE id = ?", pid)));
  }

  /** Crash-recovery intents of a deleted project would otherwise try to re-project its entities. */
  private dropIntents(projectId: string): void {
    const dir = join(this.ctx.config.dataDir, "staging", "intents");
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".json"));
    } catch {
      return;
    }
    for (const n of names) {
      try {
        if (parseJson<{ project_id?: string }>(readFileSync(join(dir, n), "utf8"), {}).project_id === projectId) rmSync(join(dir, n), { force: true });
      } catch {
        /* unreadable intent: reconciliation handles it */
      }
    }
  }

  activity(principal: Principal, projectId: string | null, limit = 50): Array<Record<string, unknown>> {
    if (projectId) requireProject(this.ctx, principal, projectId, "read");
    else if (principal.kind !== "user") throw new AppError("FORBIDDEN", "activity across projects is only visible to the local user");
    const rows = projectId
      ? all<Record<string, unknown>>(this.ctx.db, "SELECT * FROM audit_events WHERE project_id = ? ORDER BY at DESC LIMIT ?", projectId, limit)
      : all<Record<string, unknown>>(this.ctx.db, "SELECT * FROM audit_events ORDER BY at DESC LIMIT ?", limit);
    return rows.map((r) => ({ ...r, details: JSON.parse(String(r.details ?? "{}")) }));
  }
}
