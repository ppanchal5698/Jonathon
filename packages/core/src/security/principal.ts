import { AppError } from "../util";

export type McpScope = "read" | "propose";

export type Principal =
  | { kind: "user"; userId: string; username: string }
  | { kind: "mcp_token"; tokenId: string; name: string; projectIds: string[]; scopes: McpScope[] }
  | { kind: "system"; name: string };

/**
 * read     – read knowledge, evidence, conversations, ask questions
 * propose  – create change proposals (MCP "propose" scope)
 * write    – create/edit drafts, upload sources, settings (human user, or the worker acting for one)
 * approve  – approve/reject/resolve knowledge (human user only, never MCP or system)
 */
export type Access = "read" | "propose" | "write" | "approve";

export function actorOf(p: Principal): { kind: string; id: string } {
  if (p.kind === "user") return { kind: "user", id: p.userId };
  if (p.kind === "mcp_token") return { kind: "mcp_token", id: p.tokenId };
  return { kind: "system", id: p.name };
}

export function actorLabel(p: Principal): string {
  if (p.kind === "user") return p.username;
  if (p.kind === "mcp_token") return `mcp:${p.name}`;
  return `system:${p.name}`;
}

export function can(p: Principal, projectId: string, access: Access): boolean {
  switch (p.kind) {
    case "user":
      return true; // single-user deployment: the local account owns every project
    case "system":
      return access !== "approve";
    case "mcp_token":
      if (!p.projectIds.includes(projectId)) return false;
      if (access === "read") return p.scopes.includes("read");
      if (access === "propose") return p.scopes.includes("propose");
      return false;
  }
}

/**
 * Throws FORBIDDEN. For MCP tokens a project outside the token's scope is reported as
 * PROJECT_NOT_FOUND so the token cannot probe which project IDs exist.
 */
export function assertAccess(p: Principal, projectId: string, access: Access): void {
  if (can(p, projectId, access)) return;
  if (p.kind === "mcp_token" && !p.projectIds.includes(projectId)) {
    throw new AppError("PROJECT_NOT_FOUND", "project not found");
  }
  throw new AppError("FORBIDDEN", `this credential cannot ${access} in this project`);
}

export function assertHuman(p: Principal): asserts p is Extract<Principal, { kind: "user" }> {
  if (p.kind !== "user") throw new AppError("FORBIDDEN", "only the signed-in human user can do this");
}
