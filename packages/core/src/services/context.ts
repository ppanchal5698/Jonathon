import type { Project } from "@jonathon/contracts";
import type { JonathonConfig } from "../config";
import { type Db, one } from "../db";
import type { JobQueue } from "../jobs/queue";
import type { Logger } from "../logger";
import type { ReasoningRuntime } from "../runtime/types";
import type { AuthService } from "../security/auth";
import { type Access, assertAccess, type Principal } from "../security/principal";
import type { KnowledgeStore } from "../storage/knowledge-store";
import type { ProjectFiles } from "../storage/project-files";
import { AppError } from "../util";

export interface Ctx {
  config: JonathonConfig;
  db: Db;
  log: Logger;
  store: KnowledgeStore;
  files: ProjectFiles;
  queue: JobQueue;
  runtime: ReasoningRuntime;
  auth: AuthService;
}

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  ai_enabled: number;
  knowledge_revision: number;
  is_demo: number;
  created_at: string;
  updated_at: string;
}

export function toProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    ai_enabled: r.ai_enabled === 1,
    knowledge_revision: r.knowledge_revision,
    is_demo: r.is_demo === 1,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** Authorize and load a project. Unknown and unauthorized look the same to MCP tokens. */
export function requireProject(ctx: Ctx, principal: Principal, projectId: string, access: Access): Project {
  if (typeof projectId !== "string" || !/^prj_[0-9a-z]{26}$/.test(projectId)) throw new AppError("PROJECT_NOT_FOUND", "project not found");
  assertAccess(principal, projectId, access);
  const row = one<ProjectRow>(ctx.db, "SELECT * FROM projects WHERE id = ?", projectId);
  if (!row) throw new AppError("PROJECT_NOT_FOUND", "project not found");
  return toProject(row);
}

export function knowledgeRevision(ctx: Ctx, projectId: string): number {
  return one<{ k: number }>(ctx.db, "SELECT knowledge_revision AS k FROM projects WHERE id = ?", projectId)?.k ?? 0;
}
