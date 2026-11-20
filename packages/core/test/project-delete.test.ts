import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { seedDemoProject } from "@jonathon/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { makeApp, SYSTEM, type TestApp, USER } from "./helpers";

const PROJECT_TABLES = [
  "sources",
  "source_revisions",
  "chunks",
  "knowledge_entities",
  "approval_events",
  "conversations",
  "messages",
  "answer_sources",
  "runtime_sessions",
  "jobs",
  "dead_letters",
  "spec_snapshots",
  "generated_documents",
];

let t: TestApp | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

const rows = (app: TestApp["app"], pid: string) =>
  Object.fromEntries(
    PROJECT_TABLES.map((tb) => [tb, (app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${tb} WHERE project_id = ?`).get(pid) as { n: number }).n]),
  );

describe("deleting a whole project", () => {
  it("removes every file and row of that project, keeps other projects intact, narrows MCP tokens and leaves an audit record", async () => {
    t = makeApp({ scenario: "answer-cite" });
    const { projectId: pid } = await seedDemoProject(t.app, USER);
    await t.app.answers.ask(USER, pid, { message: "verification?", request_id: "rq-del-1" }, { waitMs: 0 });
    const other = t.app.projects.create(USER, { name: "Keep me", ai_enabled: true }).id;
    t.app.sources.ingest(USER, other, { filename: "keep.md", bytes: new TextEncoder().encode("Customers must keep their invoices.") });
    const only = t.app.auth.createMcpToken(USER, { name: "only-deleted", projectIds: [pid], scopes: ["read"] });
    const both = t.app.auth.createMcpToken(USER, { name: "both", projectIds: [pid, other], scopes: ["read"] });
    const otherBefore = rows(t.app, other);
    expect(Object.values(rows(t.app, pid)).some((n) => n > 0)).toBe(true);
    expect(existsSync(join(t.dataDir, "projects", pid))).toBe(true);

    const name = t.app.projects.get(USER, pid).name;
    expect(() => t!.app.projects.delete(USER, pid, "delete")).toThrow(/to confirm/);
    expect(() => t!.app.projects.delete(SYSTEM, pid, `delete ${name}`)).toThrow(/only the signed-in human/);
    expect(() =>
      t!.app.projects.delete({ kind: "mcp_token", tokenId: "x", name: "c", projectIds: [pid], scopes: ["read", "propose"] }, pid, `delete ${name}`),
    ).toThrow();

    const r = t.app.projects.delete(USER, pid, `delete ${name}`);
    expect(r).toMatchObject({ deleted: pid, name });
    expect(Object.values(rows(t.app, pid)).every((n) => n === 0)).toBe(true);
    expect(t.app.ctx.db.prepare("SELECT COUNT(*) AS n FROM chunks_fts WHERE project_id = ?").get(pid)).toEqual({ n: 0 });
    expect(t.app.ctx.db.prepare("SELECT id FROM projects WHERE id = ?").get(pid)).toBeUndefined();
    expect(existsSync(join(t.dataDir, "projects", pid))).toBe(false);
    expect(existsSync(join(t.dataDir, "runtime-workspaces", pid))).toBe(false);
    expect(existsSync(join(t.dataDir, "staging", "deleted-projects", pid))).toBe(false);
    expect(() => t!.app.projects.get(USER, pid)).toThrow(/not found/);

    // Nothing else changed.
    expect(rows(t.app, other)).toEqual(otherBefore);
    expect(existsSync(join(t.dataDir, "projects", other, "project.md"))).toBe(true);
    // Credentials: a token scoped only to the deleted project is revoked; a shared one keeps the other project.
    expect(t.app.auth.resolveMcpToken(only.token)).toBeNull();
    expect(t.app.auth.resolveMcpToken(both.token)?.projectIds).toEqual([other]);
    // The audit log keeps who deleted what and when (metadata only).
    const ev = t.app.ctx.db.prepare("SELECT actor_kind, details FROM audit_events WHERE action = 'project.deleted' AND project_id = ?").get(pid) as {
      actor_kind: string;
      details: string;
    };
    expect(ev.actor_kind).toBe("user");
    expect(JSON.parse(ev.details)).toMatchObject({ name });
    // "Import projects found on disk" cannot bring it back.
    expect(t.app.ops.importFromFiles(USER).projects).toBe(0);
  });

  it("refuses while a job of the project is running, asks it to stop, and changes nothing", () => {
    t = makeApp();
    const pid = t.app.projects.create(USER, { name: "Busy" }).id;
    const job = t.app.ctx.queue.enqueue({ projectId: pid, type: "reindex", payload: {}, createdBy: "t" });
    t.app.ctx.queue.claim("w", 60_000, ["reindex"]);
    expect(() => t!.app.projects.delete(USER, pid, "delete Busy")).toThrow(/still running/);
    expect(t.app.ctx.queue.get(job.id)).toMatchObject({ status: "running", cancel_requested: true });
    expect(existsSync(join(t.dataDir, "projects", pid, "project.md"))).toBe(true);
    t.app.ctx.queue.fail(job.id, "w", "JOB_CANCELLED", "stopped");
    expect(t.app.projects.delete(USER, pid, "delete Busy").deleted).toBe(pid);
  });

  it("rolls the files back when the database transaction fails", () => {
    t = makeApp();
    const pid = t.app.projects.create(USER, { name: "Rollback" }).id;
    t.app.sources.ingest(USER, pid, { filename: "a.md", bytes: new TextEncoder().encode("Fictional text.") });
    t.app.ctx.db.exec("CREATE TEMP TRIGGER fail_project_delete BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;");
    expect(() => t!.app.projects.delete(USER, pid, "delete Rollback")).toThrow(/simulated failure/);
    expect(existsSync(join(t.dataDir, "projects", pid, "project.md"))).toBe(true);
    expect(existsSync(join(t.dataDir, "staging", "deleted-projects", pid))).toBe(false);
    expect(t.app.sources.list(USER, pid)).toHaveLength(1);
  });

  it("startup recovery restores files of an uncommitted delete and purges those of a committed one", () => {
    t = makeApp();
    const kept = t.app.projects.create(USER, { name: "Crash before commit" }).id;
    const gone = t.app.projects.create(USER, { name: "Crash after commit" }).id;
    const stage = (pid: string) => {
      mkdirSync(join(t!.dataDir, "staging", "deleted-projects", pid), { recursive: true });
      renameSync(join(t!.dataDir, "projects", pid), join(t!.dataDir, "staging", "deleted-projects", pid, "projects"));
    };
    stage(kept); // process died after the rename, before COMMIT: the row still exists
    stage(gone); // process died after COMMIT, before the purge: the row is gone
    t.app.ctx.db.exec("PRAGMA foreign_keys = OFF");
    t.app.ctx.db.prepare("DELETE FROM projects WHERE id = ?").run(gone);
    writeFileSync(join(t.dataDir, "staging", "deleted-projects", "not-a-project"), "ignored");
    const r = t.app.projects.recoverInterruptedDeletes();
    expect(r).toEqual({ restored: [kept], purged: [gone] });
    expect(existsSync(join(t.dataDir, "projects", kept, "project.md"))).toBe(true);
    expect(existsSync(join(t.dataDir, "staging", "deleted-projects", gone))).toBe(false);
    expect(existsSync(join(t.dataDir, "projects", gone))).toBe(false);
  });
});
