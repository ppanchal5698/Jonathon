import type { Project } from "@jonathon/contracts";
import { audit } from "../audit";
import { all, run, tx } from "../db";
import { actorLabel, type Principal } from "../security/principal";
import { AppError, newId, nowIso } from "../util";
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

  activity(principal: Principal, projectId: string | null, limit = 50): Array<Record<string, unknown>> {
    if (projectId) requireProject(this.ctx, principal, projectId, "read");
    else if (principal.kind !== "user") throw new AppError("FORBIDDEN", "activity across projects is only visible to the local user");
    const rows = projectId
      ? all<Record<string, unknown>>(this.ctx.db, "SELECT * FROM audit_events WHERE project_id = ? ORDER BY at DESC LIMIT ?", projectId, limit)
      : all<Record<string, unknown>>(this.ctx.db, "SELECT * FROM audit_events ORDER BY at DESC LIMIT ?", limit);
    return rows.map((r) => ({ ...r, details: JSON.parse(String(r.details ?? "{}")) }));
  }
}
