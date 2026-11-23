import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { drainJobs } from "../../test-fixtures/src/index";
import { afterEach, describe, expect, it } from "vitest";
import { makeApp, type TestApp, USER } from "./helpers";

const enc = (s: string) => new TextEncoder().encode(s);
let t: TestApp;
afterEach(() => t?.cleanup());

/** Every file under the project's knowledge folders and the intents folder, with contents. */
function snapshot(dataDir: string, pid: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, `${rel}/${e.name}`);
      else out[`${rel}/${e.name}`] = readFileSync(p, "utf8");
    }
  };
  for (const area of ["requirements", "decisions", "open-questions", "conflicts", "proposals", "history"]) walk(join(dataDir, "projects", pid, area), area);
  walk(join(dataDir, "staging", "intents"), "intents");
  return out;
}

const rows = (app: TestApp["app"], pid: string) =>
  app.ctx.db.prepare("SELECT human_id, revision, status, file_hash FROM knowledge_entities WHERE project_id = ? ORDER BY human_id").all(pid);

describe("a multi-entity write that fails half-way leaves files and database exactly as they were", () => {
  it("accepting a change proposal with a stale revision changes nothing, and a correct retry still works", async () => {
    t = makeApp({ scenario: "extraction" });
    const pid = t.app.projects.create(USER, { name: "Rollback", ai_enabled: true }).id;
    t.app.sources.ingest(USER, pid, { filename: "a.md", bytes: enc("Customers must verify their email address.") });
    await drainJobs(t.app, ["ingest", "extract_knowledge"]);
    t.app.sources.ingest(USER, pid, { filename: "b.md", bytes: enc("Customers must verify their email address before ordering.") });
    await drainJobs(t.app, ["ingest", "extract_knowledge"]);
    const p = t.app.knowledge.list(USER, pid, { types: ["change_proposal"] })[0]!;
    const filesBefore = snapshot(t.dataDir, pid);
    const rowsBefore = rows(t.app, pid);

    // The requirement is updated first, then the proposal's stale revision fails: everything must roll back.
    expect(() => t.app.knowledge.accept(USER, pid, p.human_id, { expected_revision: p.revision + 7, confirmation: `accept ${p.human_id}` })).toThrow(
      /revision/,
    );
    expect(snapshot(t.dataDir, pid)).toEqual(filesBefore);
    expect(rows(t.app, pid)).toEqual(rowsBefore);
    // Nothing for startup recovery to "complete", and reconciliation sees no external edit.
    expect(t.app.ctx.store.completeIntents()).toEqual([]);
    const rec = t.app.ops.reconcile(USER, pid)[0]!;
    expect({ edits: rec.external_edits, invalid: rec.invalid_files }).toEqual({ edits: [], invalid: [] });

    const ok = t.app.knowledge.accept(USER, pid, p.human_id, { expected_revision: p.revision, confirmation: `accept ${p.human_id}` });
    expect(ok.entity.status).toBe("accepted");
    expect(ok.applied_to?.human_id).toBe("REQ-001");
  });

  it("resolving a conflict with a stale revision creates no decision file and no history", async () => {
    t = makeApp({ scenario: "extraction" });
    const pid = t.app.projects.create(USER, { name: "Conflict rollback", ai_enabled: true }).id;
    t.app.sources.ingest(USER, pid, {
      filename: "a.md",
      bytes: enc("# Sign-up\n\nCustomers must verify their email address.\n\n# Passwords\n\nPasswords need 8 characters."),
    });
    await drainJobs(t.app, ["ingest", "extract_knowledge"]);
    const c = t.app.knowledge.list(USER, pid, { types: ["conflict"] })[0]!;
    const filesBefore = snapshot(t.dataDir, pid);
    const rowsBefore = rows(t.app, pid);
    const body = {
      question: "Which rule applies?",
      selected: "The first statement",
      rationale: "Confirmed with the client.",
      options: [],
      confirmation: `resolve ${c.human_id}`,
    };

    expect(() => t.app.knowledge.resolveConflict(USER, pid, c.human_id, { ...body, expected_revision: c.revision + 3 })).toThrow(/revision/);
    expect(snapshot(t.dataDir, pid)).toEqual(filesBefore);
    expect(rows(t.app, pid)).toEqual(rowsBefore);
    expect(t.app.ctx.db.prepare("SELECT COUNT(*) AS n FROM approval_events WHERE project_id = ?").get(pid)).toEqual({ n: 0 });

    const ok = t.app.knowledge.resolveConflict(USER, pid, c.human_id, { ...body, expected_revision: c.revision });
    expect(ok.decision.approval_valid).toBe(true);
    expect(ok.conflict.status).toBe("resolved");
  });
});

describe("startup migrations", () => {
  it("two processes migrating the same new database at once both succeed (API and worker start together)", async () => {
    const { spawn } = await import("node:child_process");
    const { tempDir } = await import("./helpers");
    const dbPath = join(tempDir(), "race.sqlite");
    const script =
      "import { openDatabase } from '@jonathon/core'; const db = openDatabase(process.argv[1]); console.log(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n); db.close();";
    const run = () =>
      new Promise<string>((resolve, reject) => {
        const c = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, dbPath], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        c.stdout.on("data", (d) => (out += d));
        c.stderr.on("data", (d) => (err += d));
        c.on("close", (code) =>
          code === 0
            ? resolve(out.trim())
            : reject(
                new Error(
                  err
                    .split("\n")
                    .filter((l) => !/ExperimentalWarning|--trace-warnings/.test(l))
                    .join("\n")
                    .slice(0, 400),
                ),
              ),
        );
      });
    const results = await Promise.all([run(), run(), run(), run()]);
    const { MIGRATIONS } = await import("@jonathon/core");
    expect(results).toEqual(Array(4).fill(String(MIGRATIONS.length)));
  }, 60_000);
});

describe("human id allocation", () => {
  it("never reuses a deleted id and skips ids taken by files on disk that are not reconciled yet", async () => {
    const { writeFileSync } = await import("node:fs");
    t = makeApp();
    const pid = t.app.projects.create(USER, { name: "Ids" }).id;
    const k = t.app.knowledge;
    const mk = (title: string) => k.createDraft(USER, pid, "requirement", { title, fields: { type: "functional" } }).human_id;
    expect([mk("one"), mk("two"), mk("three")]).toEqual(["REQ-001", "REQ-002", "REQ-003"]);
    const r3 = k.get(USER, pid, "REQ-003");
    k.remove(USER, pid, "REQ-003", { expected_revision: r3.revision, confirmation: "delete REQ-003" });
    expect(mk("four")).toBe("REQ-004"); // REQ-003's history folder keeps its id reserved
    // A file someone dropped into requirements/ (not in the database yet) holds REQ-005.
    writeFileSync(join(t.dataDir, "projects", pid, "requirements", "REQ-005.md"), "placeholder");
    expect(mk("six")).toBe("REQ-006");
  });
});
