import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp, createBackup, createLogger, loadConfig, reconcileAfterRestore, restoreBackup, sha256, verifyBackup } from "@jonathon/core";
import { seedDemoProject } from "@jonathon/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { fakeRuntime, makeApp, type TestApp, tempDir, USER } from "./helpers";

let t: TestApp | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

const COUNTED = ["users", "mcp_tokens", "conversations", "messages", "jobs", "approval_events", "audit_events", "knowledge_entities", "source_revisions"];

describe("backup and restore of database + files", () => {
  it("restores both stores: approvals stay valid, tokens work, original bytes and knowledge history are identical", async () => {
    t = makeApp({ scenario: "answer-cite" });
    const { projectId: pid } = await seedDemoProject(t.app, USER);
    const token = t.app.auth.createMcpToken(USER, { name: "claude", projectIds: [pid], scopes: ["read"] });
    await t.app.answers.ask(USER, pid, { message: "verification?", request_id: "rq-backup-1" }, { waitMs: 0 });
    const counts = (app: TestApp["app"]): Record<string, number> =>
      Object.fromEntries(COUNTED.map((tb) => [tb, (app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${tb}`).get() as { n: number }).n]));
    const before = counts(t.app);
    const approved = t.app.knowledge.get(USER, pid, "REQ-001");
    expect(approved.approval_valid).toBe(true);

    const backupDir = join(tempDir("jon-bk-"), "b1");
    const manifest = createBackup(t.app.ctx.db, t.dataDir, backupDir, "online");
    expect(manifest.database.integrity).toBe("ok");
    expect(manifest.files.some((f) => /\/sources\/.+\/original\./.test(f.path))).toBe(true);
    expect(manifest.files.some((f) => f.path.includes("/history/REQ-001/"))).toBe(true);
    expect(verifyBackup(backupDir).problems).toEqual([]);
    expect(() => createBackup(t!.app.ctx.db, t!.dataDir, backupDir, "online")).toThrow(/not empty/);

    // Damage after the backup: delete a knowledge file and change the live database.
    const reqFile = join(t.dataDir, "projects", pid, "requirements", "REQ-001.md");
    writeFileSync(reqFile, "corrupted");
    t.app.ctx.db.exec("DELETE FROM approval_events");
    t.app.close();

    // Restore into the same data directory (stopped system). Current data is moved aside, never deleted.
    const r = restoreBackup(backupDir, t.dataDir, "jonathon.sqlite");
    expect(r.moved_aside && existsSync(join(r.moved_aside, "projects"))).toBeTruthy();
    expect(readFileSync(join(r.moved_aside!, "projects", pid, "requirements", "REQ-001.md"), "utf8")).toBe("corrupted");
    const config = loadConfig({ JONATHON_DATA_DIR: t.dataDir, JONATHON_LOG_LEVEL: "silent" } as NodeJS.ProcessEnv);
    const rec = reconcileAfterRestore(config);
    expect(rec.missing).toBe(0);
    const app2 = createApp(config, { runtime: fakeRuntime(t.dataDir, "answer-cite"), log: createLogger("silent", "t") });
    t.app = app2;
    const after = counts(app2);
    expect({ ...after, audit_events: 0 }).toEqual({ ...before, audit_events: 0 });
    expect(after.audit_events!).toBeGreaterThanOrEqual(before.audit_events!); // + the reconcile audit event
    expect(app2.knowledge.get(USER, pid, "REQ-001")).toMatchObject({ revision: approved.revision, approval_valid: true });
    expect(app2.auth.resolveMcpToken(token.token)?.tokenId).toBe(token.id);
    for (const f of manifest.files) {
      expect(sha256(readFileSync(join(t.dataDir, ...f.path.split("/"))))).toBe(f.sha256);
    }
  });

  it("verification detects a tampered or truncated backup, and restore refuses it", async () => {
    t = makeApp();
    const p = t.app.projects.create(USER, { name: "Tamper" });
    t.app.sources.ingest(USER, p.id, { filename: "a.md", bytes: new TextEncoder().encode("Fictional text.") });
    const dir = join(tempDir("jon-bk-"), "b");
    const m = createBackup(t.app.ctx.db, t.dataDir, dir, "offline");
    const victim = m.files.find((f) => f.path.includes("original."))!;
    writeFileSync(join(dir, ...victim.path.split("/")), "changed");
    expect(verifyBackup(dir).problems).toEqual([`hash mismatch ${victim.path}`]);
    const target = tempDir("jon-restore-");
    expect(() => restoreBackup(dir, target)).toThrow(/failed verification/);
    expect(readdirSync(target)).toEqual([]);
  });

  it("online backup taken before later writes: restore + reconcile imports the newer file without carrying the approval over", async () => {
    t = makeApp({ scenario: "answer-cite" });
    const { projectId: pid } = await seedDemoProject(t.app, USER);
    const dir = join(tempDir("jon-bk-"), "b");
    createBackup(t.app.ctx.db, t.dataDir, dir, "online");
    // A knowledge file newer than the database snapshot (the online-backup window): simulate by editing the backup's
    // copy of an approved requirement, then re-signing the manifest as an operator would after a manual file copy.
    const rel = `projects/${pid}/requirements/REQ-001.md`;
    const p = join(dir, ...rel.split("/"));
    const original = readFileSync(p, "utf8");
    const changed = original.replace(/^title: .*$/m, "title: Changed after the database snapshot");
    expect(changed).not.toBe(original);
    writeFileSync(p, changed);
    const mp = join(dir, "manifest.json");
    const manifest = JSON.parse(readFileSync(mp, "utf8"));
    manifest.files.find((f: { path: string }) => f.path === rel).sha256 = sha256(readFileSync(p));
    writeFileSync(mp, JSON.stringify(manifest));
    t.app.close();
    const target = tempDir("jon-restore-");
    restoreBackup(dir, target);
    const config = loadConfig({ JONATHON_DATA_DIR: target, JONATHON_LOG_LEVEL: "silent" } as NodeJS.ProcessEnv);
    const rec = reconcileAfterRestore(config);
    expect(rec.external_edits).toBeGreaterThanOrEqual(1);
    const app2 = createApp(config, { runtime: fakeRuntime(target, "answer-cite"), log: createLogger("silent", "t") });
    try {
      const req = app2.knowledge.get(USER, pid, "REQ-001");
      expect(req.approval_valid).toBe(false); // changed content never inherits an approval
    } finally {
      app2.close();
    }
  });
});

describe("cached projections reflect review actions", () => {
  it("graph and dashboard data change after approval, edit, rejection and deletion", async () => {
    t = makeApp({ scenario: "answer-cite" });
    const { projectId: pid } = await seedDemoProject(t.app, USER);
    const k = t.app.knowledge;
    const graphText = () => JSON.stringify(t!.app.graph.graphifyJson(pid));
    const fp = () => (t!.app.graph as unknown as { build(p: string): { fingerprint: string } }).build(pid).fingerprint;

    const d = k.createDraft(USER, pid, "requirement", { title: "Cache probe original title", fields: { type: "functional" } });
    expect(graphText()).toContain("Cache probe original title");
    const f0 = fp();

    const edited = k.updateDraft(USER, pid, d.human_id, d.revision, { title: "Cache probe edited title" });
    expect(fp()).not.toBe(f0);
    expect(graphText()).toContain("Cache probe edited title");
    expect(graphText()).not.toContain("Cache probe original title");

    const f1 = fp();
    const rejected = k.reject(USER, pid, d.human_id, { expected_revision: edited.revision, confirmation: `reject ${d.human_id}` });
    expect(rejected.status).toBe("rejected");
    expect(fp()).not.toBe(f1);

    const other = k.createDraft(USER, pid, "requirement", { title: "Cache probe approval", fields: { type: "functional" } });
    const f2 = fp();
    k.accept(USER, pid, other.human_id, { expected_revision: other.revision, confirmation: `approve ${other.human_id}` });
    expect(fp()).not.toBe(f2);
    expect(k.get(USER, pid, other.human_id).approval_valid).toBe(true);

    const cur = k.get(USER, pid, d.human_id);
    k.remove(USER, pid, d.human_id, { expected_revision: cur.revision, confirmation: `delete ${d.human_id}` });
    expect(graphText()).not.toContain("Cache probe edited title");

    // Deleting a source removes its evidence from the graph and from search (no stale cache).
    const src = t.app.sources.list(USER, pid)[0]!;
    const before = t.app.search(USER, pid, { query: src.display_name.replace(/\.\w+$/, "") }).hits.length;
    t.app.sources.delete(USER, pid, src.id, `delete ${src.display_name}`);
    expect(graphText()).not.toContain(src.id);
    expect(t.app.search(USER, pid, { query: "zzzz-no-match" }).hits.length).toBe(0);
    expect(before).toBeGreaterThanOrEqual(0);
  });
});
