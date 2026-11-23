import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { drainJobs } from "../../test-fixtures/src/index";
import { folderDisplayName } from "../src/services/folder-import";
import { makeApp, type TestApp, tempDir, USER } from "./helpers";

const MCP = { kind: "mcp_token" as const, tokenId: "mtk_x", name: "agent", scopes: ["read", "propose"] as ("read" | "propose")[], projectIds: [] as string[] };
let t: TestApp;
afterEach(() => t?.cleanup());

function clientFolder(): string {
  const root = tempDir("jon-folder-");
  writeFileSync(join(root, "brief.md"), "# Brief\n\nCustomers must verify their email address.");
  mkdirSync(join(root, "specs", "deep"), { recursive: true });
  writeFileSync(join(root, "specs", "rules.txt"), "Orders over the limit need a manager.");
  writeFileSync(join(root, "specs", "deep", "notes.csv"), "id,rule\n1,Invoices are monthly");
  writeFileSync(join(root, "specs", "copy-of-brief.md"), "# Brief\n\nCustomers must verify their email address.");
  writeFileSync(join(root, "specs", "tool.exe"), "MZ binary");
  writeFileSync(join(root, "specs", "empty.txt"), "");
  writeFileSync(join(root, "~$open.docx"), "lock");
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "node_modules", "readme.md"), "package docs");
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "HEAD"), "ref");
  return root;
}

describe("folder import", () => {
  it("scans, imports in the background, and re-imports only what changed", async () => {
    t = makeApp({ scenario: "extraction" });
    const pid = t.app.projects.create(USER, { name: "Folder", ai_enabled: false }).id;
    const root = clientFolder();

    const scan = await t.app.folders.scan(USER, pid, { path: root, recursive: true });
    const status = Object.fromEntries(scan.files.map((f) => [f.path, f.status]));
    expect(status).toMatchObject({ "brief.md": "new", "specs/rules.txt": "new", "specs/deep/notes.csv": "new", "specs/copy-of-brief.md": "new" });
    expect(status["specs/tool.exe"]).toBe("skipped");
    expect(status["specs/empty.txt"]).toBe("skipped");
    expect(status["~$open.docx"]).toBe("skipped");
    expect(status["node_modules/"]).toBe("skipped");
    expect(status[".git/"]).toBe("skipped");
    expect(Object.keys(status).some((p) => p.startsWith("node_modules/readme"))).toBe(false);
    expect(scan.groups.find((g) => g.folder === "specs")?.importable).toBe(3);

    // Not recursive: only the folder's own files.
    expect((await t.app.folders.scan(USER, pid, { path: root, recursive: false })).files.filter((f) => f.status === "new").map((f) => f.path)).toEqual([
      "brief.md",
    ]);

    // Only paths the scan offered are imported; anything else in the request is ignored.
    const job = await t.app.folders.queueImport(USER, pid, {
      path: root,
      recursive: true,
      files: ["brief.md", "specs/rules.txt", "specs/copy-of-brief.md", "../outside.md", "specs/tool.exe"],
    });
    await drainJobs(t.app, ["import_folder"]);
    const done = t.app.ctx.queue.get(job.id);
    expect(done.status).toBe("succeeded");
    expect(done.result).toMatchObject({ created: 2, unchanged: 1 }); // the copy has the same content as brief.md
    const names = t.app.sources
      .list(USER, pid)
      .map((s) => s.display_name)
      .sort();
    expect(names).toEqual(["brief.md", "specs/rules.txt"]);

    // Second scan: imported files are unchanged; the content copy is a duplicate. Change one file → new revision.
    writeFileSync(join(root, "specs", "rules.txt"), "Orders over the limit need two managers.");
    const again = await t.app.folders.scan(USER, pid, { path: root, recursive: true });
    const s2 = Object.fromEntries(again.files.map((f) => [f.path, f.status]));
    expect(s2).toMatchObject({ "brief.md": "unchanged", "specs/rules.txt": "changed", "specs/copy-of-brief.md": "duplicate", "specs/deep/notes.csv": "new" });
    await t.app.folders.queueImport(USER, pid, { path: root, recursive: true, files: ["specs/rules.txt", "specs/deep/notes.csv"] });
    await drainJobs(t.app, ["import_folder"]);
    const sources = t.app.sources.list(USER, pid);
    expect(sources.length).toBe(3);
    expect(sources.find((s) => s.display_name === "specs/rules.txt")!.current!.revision_number).toBe(2);
  });

  it("refuses unsafe folders and non-human callers, and never follows links", async () => {
    t = makeApp({ scenario: "extraction" });
    const pid = t.app.projects.create(USER, { name: "Folder", ai_enabled: false }).id;
    const root = clientFolder();
    expect(() => t.app.folders.scan(USER, pid, { path: "relative/folder", recursive: true })).toThrow(/full path/);
    expect(() => t.app.folders.scan(USER, pid, { path: join(root, "missing"), recursive: true })).toThrow(/does not exist/);
    expect(() => t.app.folders.scan(USER, pid, { path: join(root, "brief.md"), recursive: true })).toThrow(/not a folder/);
    expect(() => t.app.folders.scan(USER, pid, { path: t.dataDir, recursive: true })).toThrow(/Jonathon's own/);
    expect(() => t.app.folders.scan(USER, pid, { path: t.app.ctx.config.repoRoot, recursive: true })).toThrow(/Jonathon's own/);
    expect(() => t.app.folders.scan({ ...MCP, projectIds: [pid] }, pid, { path: root, recursive: true })).toThrow();

    // A junction inside the folder pointing elsewhere is listed as skipped and not walked.
    const outside = tempDir("jon-outside-");
    writeFileSync(join(outside, "secret.md"), "not client material");
    symlinkSync(outside, join(root, "linked"), "junction");
    const scan = await t.app.folders.scan(USER, pid, { path: root, recursive: true });
    expect(scan.files.find((f) => f.path === "linked")?.reason).toMatch(/link or junction/);
    expect(scan.files.some((f) => f.path.includes("secret"))).toBe(false);
    expect(() => t.app.folders.scan(USER, pid, { path: join(root, "linked"), recursive: true })).toThrow(/link or junction/);
  });

  it("names imported files by their path inside the folder", () => {
    expect(folderDisplayName("specs/deep/notes.csv")).toBe("specs/deep/notes.csv");
    expect(folderDisplayName("a\\b<c>.md")).toBe("a/bc.md");
  });
});
