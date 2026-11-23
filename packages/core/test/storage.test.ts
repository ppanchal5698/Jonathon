import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertSafeSegment, parseEntity, resolveInside, sanitizeDisplayName, semanticHash, serializeEntity, sha256, writeFileAtomic } from "@jonathon/core";
import { afterEach, describe, expect, it } from "vitest";
import { makeApp, SYSTEM, type TestApp, tempDir, USER } from "./helpers";

describe("path safety", () => {
  it("rejects traversal, encoded traversal, absolute paths, separators and reserved names", () => {
    for (const bad of [
      "..",
      "../x",
      "a/b",
      "a\\b",
      "%2e%2e",
      "..%2f",
      "C:",
      "C:\\x",
      "/etc/passwd",
      ".hidden",
      "con",
      "NUL.txt",
      "a:b",
      "x\u0000y",
      "trailing.",
      "",
    ]) {
      expect(() => assertSafeSegment(bad), bad).toThrow();
    }
    for (const ok of ["prj_0123456789abcdefghjkmnpqrs", "REQ-001.md", "original.pdf", "r12.md"]) expect(assertSafeSegment(ok)).toBe(ok);
  });

  it("refuses to resolve through a symlink or junction that escapes the root", () => {
    const root = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "secret.txt"), "secret");
    mkdirSync(join(root, "projects"), { recursive: true });
    symlinkSync(outside, join(root, "projects", "evil"), process.platform === "win32" ? "junction" : "dir");
    expect(() => resolveInside(root, "projects", "evil", "secret.txt")).toThrow(/symlink|outside/);
  });

  it("sanitizes display filenames without using them as paths", () => {
    expect(sanitizeDisplayName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeDisplayName("C:\\Windows\\win.ini")).toBe("win.ini");
    expect(sanitizeDisplayName("..\u202ecod.exe")).toBe("cod.exe");
    expect(sanitizeDisplayName("")).toBe("untitled");
  });

  it("atomic writes never leave temp files behind", () => {
    const dir = tempDir();
    const p = join(dir, "a.md");
    writeFileAtomic(p, "one");
    writeFileAtomic(p, "two");
    expect(readFileSync(p, "utf8")).toBe("two");
    expect(readdirSync(dir)).toEqual(["a.md"]);
  });
});

describe("entity file format", () => {
  it("round-trips frontmatter and sections and keeps unknown sections", () => {
    const t = makeApp();
    try {
      const p = t.app.projects.create(USER, { name: "P" });
      const doc = t.app.ctx.store.newDoc(p.id, "requirement", {
        title: "Verify email",
        fields: { actors: ["Customer"], feature_scopes: ["email-verification"] },
        sections: { description: "Desc", behavior: [{ text: "Send link", basis: "source_stated", review_state: "proposed" }], open_questions: ["Expiry?"] },
      });
      doc.human_id = "REQ-001";
      const text = serializeEntity(doc);
      const back = parseEntity(`${text}\n## My notes\nKeep me.\n`);
      expect(back.title).toBe("Verify email");
      expect(back.sections.behavior).toEqual([{ text: "Send link", basis: "source_stated", review_state: "proposed" }]);
      expect(back.sections._extra).toContain("Keep me.");
      expect(semanticHash(parseEntity(text))).toBe(semanticHash(doc));
    } finally {
      t.cleanup();
    }
  });

  it("rejects malformed frontmatter and invalid statuses", () => {
    expect(() => parseEntity("no frontmatter")).toThrow(/frontmatter/);
    expect(() => parseEntity("---\nid: x\n---\n")).toThrow(/invalid frontmatter/);
  });
});

describe("knowledge store", () => {
  let t: TestApp;
  afterEach(() => t?.cleanup());

  function setup() {
    t = makeApp();
    const p = t.app.projects.create(USER, { name: "Store" });
    const e = t.app.knowledge.createDraft(USER, p.id, "requirement", { title: "Email must be verified", sections: { description: "Verify." } });
    return { pid: p.id, e };
  }

  it("creates REQ-001 with history and refuses stale writes", () => {
    const { pid, e } = setup();
    expect(e.human_id).toBe("REQ-001");
    expect(e.revision).toBe(1);
    t.app.knowledge.updateDraft(USER, pid, "REQ-001", 1, { title: "Email must be verified first" });
    expect(() => t.app.knowledge.updateDraft(USER, pid, "REQ-001", 1, { title: "stale" })).toThrow(/revision 2, not 1/);
    expect(t.app.ctx.store.listRevisions(pid, "REQ-001")).toEqual([1, 2]);
    expect(t.app.knowledge.get(USER, pid, "REQ-001", 1).title).toBe("Email must be verified");
  });

  it("approval requires a human, a typed confirmation and binds to content", () => {
    const { pid } = setup();
    expect(() => t.app.knowledge.transition(SYSTEM, pid, "REQ-001", { to: "approved", expected_revision: 1, confirmation: "approve REQ-001" })).toThrow(
      /human/,
    );
    const mcp = { kind: "mcp_token" as const, tokenId: "tok_x", name: "claude", projectIds: [pid], scopes: ["read" as const, "propose" as const] };
    expect(() => t.app.knowledge.transition(mcp, pid, "REQ-001", { to: "approved", expected_revision: 1, confirmation: "approve REQ-001" })).toThrow();
    expect(() => t.app.knowledge.transition(USER, pid, "REQ-001", { to: "approved", expected_revision: 1 })).toThrow(/approve REQ-001/);
    const a = t.app.knowledge.transition(USER, pid, "REQ-001", { to: "approved", expected_revision: 1, confirmation: "approve REQ-001" });
    expect(a.status).toBe("approved");
    expect(a.approval_valid).toBe(true);
    expect(a.approval?.approved_by).toBe("parth");
  });

  it("blocks approval while AI-proposed statements are unreviewed", () => {
    const { pid } = setup();
    t.app.knowledge.updateDraft(USER, pid, "REQ-001", 1, {
      title: "Email must be verified",
      sections: { acceptance_criteria: [{ text: "AI idea", basis: "ai_inferred", review_state: "proposed" }] },
    });
    expect(() => t.app.knowledge.transition(USER, pid, "REQ-001", { to: "approved", expected_revision: 2, confirmation: "approve REQ-001" })).toThrow(
      /AI-proposed/,
    );
    t.app.knowledge.acceptProposedStatements(USER, pid, "REQ-001", 2);
    expect(t.app.knowledge.transition(USER, pid, "REQ-001", { to: "approved", expected_revision: 3, confirmation: "approve REQ-001" }).approval_valid).toBe(
      true,
    );
  });

  it("a manually typed 'status: approved' is not an approval", () => {
    const { pid } = setup();
    const path = join(t.dataDir, "projects", pid, "requirements", "REQ-001.md");
    writeFileSync(
      path,
      readFileSync(path, "utf8")
        .replace('status: "draft"', 'status: "approved"')
        .replace("approval_event_id: null", 'approval_event_id: "apv_forged0000000000000000000"'),
    );
    const report = t.app.ops.reconcile(USER, pid)[0]!;
    expect(report.external_edits[0]?.human_id).toBe("REQ-001");
    const e = t.app.knowledge.get(USER, pid, "REQ-001");
    expect(e.status).toBe("in_review");
    expect(e.approval_valid).toBe(false);
  });

  it("external edits to approved content revoke the approval and keep the edit", () => {
    const { pid } = setup();
    t.app.knowledge.transition(USER, pid, "REQ-001", { to: "approved", expected_revision: 1, confirmation: "approve REQ-001" });
    const spec = t.app.knowledge.featureSpec(USER, pid, "Email must be verified");
    expect(spec.requirements.map((r) => r.human_id)).toEqual(["REQ-001"]);
    const path = join(t.dataDir, "projects", pid, "requirements", "REQ-001.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("Verify.", "Verify within 10 minutes."));
    // Before reconciliation: content hash no longer matches the approval event.
    expect(() => t.app.knowledge.updateDraft(USER, pid, "REQ-001", 2, { title: "x" })).toThrow(/changed outside/);
    const report = t.app.ops.reconcile(USER, pid)[0]!;
    expect(report.external_edits[0]).toMatchObject({ human_id: "REQ-001", approval_revoked: true });
    const e = t.app.knowledge.get(USER, pid, "REQ-001");
    expect(e.status).toBe("in_review");
    expect(e.approval_valid).toBe(false);
    expect(e.sections.description).toContain("10 minutes");
    expect(existsSync(join(t.dataDir, "projects", pid, "history", "REQ-001", "r3.external-original.md"))).toBe(true);
    const stale = t.app.ctx.db.prepare("SELECT stale FROM spec_snapshots WHERE id = ?").get(spec.snapshot_id) as { stale: number };
    expect(stale.stale).toBe(1);
  });

  it("completes a write interrupted after the file rename (crash intent)", () => {
    const { pid } = setup();
    const path = join(t.dataDir, "projects", pid, "requirements", "REQ-001.md");
    const doc = parseEntity(readFileSync(path, "utf8"));
    doc.revision = 2;
    doc.title = "Written but projection never committed";
    const text = serializeEntity(doc);
    writeFileSync(path, text);
    mkdirSync(join(t.dataDir, "staging", "intents"), { recursive: true });
    writeFileSync(
      join(t.dataDir, "staging", "intents", "int_test.json"),
      JSON.stringify({
        id: "int_test",
        project_id: pid,
        entity_id: doc.id,
        human_id: "REQ-001",
        entity_type: "requirement",
        file_hash: sha256(text),
        at: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    const report = t.app.ops.reconcile(USER, pid)[0]!;
    expect(report.intents_completed).toEqual(["REQ-001"]);
    expect(report.external_edits).toEqual([]);
    expect(t.app.knowledge.get(USER, pid, "REQ-001").title).toBe("Written but projection never committed");
  });

  it("flags deleted files as missing and never deletes projections silently", () => {
    const { pid } = setup();
    rmSync(join(t.dataDir, "projects", pid, "requirements", "REQ-001.md"));
    expect(t.app.ops.reconcile(USER, pid)[0]!.missing).toEqual(["REQ-001"]);
    expect(t.app.knowledge.get(USER, pid, "REQ-001").file_state).toBe("missing");
  });
});
