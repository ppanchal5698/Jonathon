import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { drainJobs } from "../../test-fixtures/src/index";
import { afterEach, describe, expect, it } from "vitest";
import { bestExcerpt, keyTerms, sameStatement, similar, similarQuestion, topicTerms } from "../src/services/extraction";
import { containsWording } from "../src/util";
import { makeApp, type TestApp, USER } from "./helpers";

const enc = (s: string) => new TextEncoder().encode(s);
const MCP = { kind: "mcp_token" as const, tokenId: "mtk_x", name: "agent", scopes: ["read", "propose"] as ("read" | "propose")[], projectIds: [] as string[] };
let t: TestApp;
afterEach(() => t?.cleanup());

async function uploadAndExtract(app: TestApp["app"], pid: string, name: string, text: string) {
  app.sources.ingest(USER, pid, { filename: name, bytes: enc(text) });
  await drainJobs(app, ["ingest", "extract_knowledge"]); // ingest queues extract_knowledge automatically when AI processing is on
}

describe("documents → proposed knowledge → human review", () => {
  it("an upload automatically creates draft requirements, linked questions, conflicts and nothing approved", async () => {
    t = makeApp({ scenario: "extraction" });
    const pid = t.app.projects.create(USER, { name: "Auto", ai_enabled: true }).id;
    await uploadAndExtract(t.app, pid, "brief.md", "# Sign-up\n\nCustomers must verify their email address.\n\n# Links\n\nThe link expires after a while.");
    const all = t.app.knowledge.list(USER, pid);
    const req = all.find((e) => e.entity_type === "requirement")!;
    expect(req.status).toBe("draft");
    expect(req.fields.origin).toBe("ai_proposed");
    expect(String(req.sections.description)).toMatch(/verify/);
    const qs = all.filter((e) => e.entity_type === "open_question");
    expect(qs.length).toBe(2);
    // The requirement's own open question is a tracked QUESTION linked back to it, not duplicated text.
    const linked = qs.find((q) => (q.fields.related_requirements as string[]).includes(req.human_id))!;
    expect(linked).toBeTruthy();
    expect((req.sections.open_questions as string[])[0]).toMatch(new RegExp(`^${linked.human_id}: `));
    expect(all.some((e) => e.entity_type === "conflict")).toBe(true);
    expect(all.some((e) => e.approval_valid)).toBe(false);
  });

  it("a second document proposes a change to the existing requirement instead of a near-duplicate", async () => {
    t = makeApp({ scenario: "extraction" });
    const pid = t.app.projects.create(USER, { name: "Update", ai_enabled: true }).id;
    await uploadAndExtract(t.app, pid, "a.md", "Customers must verify their email address.");
    await uploadAndExtract(t.app, pid, "b.md", "Customers must verify their email address within one day of signing up.");
    const reqs = t.app.knowledge.list(USER, pid, { types: ["requirement"] });
    expect(reqs).toHaveLength(1); // same fixture title → recognised as a duplicate
    const proposals = t.app.knowledge.list(USER, pid, { types: ["change_proposal"] });
    expect(proposals).toHaveLength(1);
    const p = proposals[0]!;
    expect(p.status).toBe("open");
    expect(p.fields.requirement_id).toBe("REQ-001");
    expect(p.fields.origin).toBe("ai_proposed");
    const adds = p.sections.proposed_additions as string[];
    expect(adds.some((a) => /^\[behavior · client-stated\] /.test(a))).toBe(true);
    expect(adds.some((a) => /^\[acceptance_criteria · AI-inferred\] /.test(a))).toBe(true);
    expect(p.source_refs.length).toBeGreaterThan(0);
    // The requirement itself is untouched until a human accepts.
    expect(t.app.knowledge.get(USER, pid, "REQ-001").revision).toBe(2); // r1 created, r2 linked its question
  });

  it("accepting a requirement approves it in one revision with an approval event; models cannot", async () => {
    t = makeApp({ scenario: "extraction" });
    const pid = t.app.projects.create(USER, { name: "Accept", ai_enabled: true }).id;
    await uploadAndExtract(t.app, pid, "a.md", "Customers must verify their email address.");
    const req = t.app.knowledge.get(USER, pid, "REQ-001");
    expect(() => t.app.knowledge.accept(MCP, pid, "REQ-001", { expected_revision: req.revision, confirmation: "approve REQ-001" })).toThrow();
    expect(() => t.app.knowledge.accept(USER, pid, "REQ-001", { expected_revision: req.revision, confirmation: "yes" })).toThrow(/approve REQ-001/);
    const { entity } = t.app.knowledge.accept(USER, pid, "REQ-001", { expected_revision: req.revision, confirmation: "approve REQ-001" });
    expect(entity.status).toBe("approved");
    expect(entity.approval_valid).toBe(true);
    expect(entity.revision).toBe(req.revision + 1);
    for (const v of Object.values(entity.sections)) {
      if (Array.isArray(v)) for (const s of v) if (typeof s === "object") expect(s.review_state).toBe("accepted");
    }
  });

  it("accepting an AI change proposal applies it to the requirement and sends an approved requirement back to review", async () => {
    t = makeApp({ scenario: "extraction" });
    const pid = t.app.projects.create(USER, { name: "Apply", ai_enabled: true }).id;
    await uploadAndExtract(t.app, pid, "a.md", "Customers must verify their email address.");
    const r = t.app.knowledge.get(USER, pid, "REQ-001");
    t.app.knowledge.accept(USER, pid, "REQ-001", { expected_revision: r.revision, confirmation: "approve REQ-001" });
    // Uploaded after approval: the proposal's base revision is the approved revision.
    await uploadAndExtract(t.app, pid, "b.md", "Customers must verify their email address before ordering.");
    const p = t.app.knowledge.list(USER, pid, { types: ["change_proposal"] })[0]!;
    const before = t.app.knowledge.get(USER, pid, "REQ-001");
    expect(before.approval_valid).toBe(true);
    const out = t.app.knowledge.accept(USER, pid, p.human_id, { expected_revision: p.revision, confirmation: `accept ${p.human_id}` });
    expect(out.entity.status).toBe("accepted");
    const after = out.applied_to!;
    expect(after.human_id).toBe("REQ-001");
    expect(after.status).toBe("in_review");
    expect(after.approval_valid).toBe(false);
    expect(
      (after.sections.acceptance_criteria as { text: string; basis: string; review_state: string }[]).some(
        (s) => s.text === "AI-suggested follow-up criterion" && s.basis === "ai_inferred" && s.review_state === "accepted",
      ),
    ).toBe(true);
    expect(after.source_refs.length).toBeGreaterThan(before.source_refs.length);
  });

  it("a proposal whose requirement content changed since it was made cannot be applied", async () => {
    t = makeApp({ scenario: "extraction" });
    const pid = t.app.projects.create(USER, { name: "Stale", ai_enabled: true }).id;
    await uploadAndExtract(t.app, pid, "a.md", "Customers must verify their email address.");
    await uploadAndExtract(t.app, pid, "b.md", "Customers must verify their email address again.");
    const p = t.app.knowledge.list(USER, pid, { types: ["change_proposal"] })[0]!;
    const r = t.app.knowledge.get(USER, pid, "REQ-001");
    t.app.knowledge.updateDraft(USER, pid, "REQ-001", r.revision, { title: "Email verification (edited)" });
    expect(() => t.app.knowledge.accept(USER, pid, p.human_id, { expected_revision: p.revision, confirmation: `accept ${p.human_id}` })).toThrow(
      /changed since/,
    );
    const rej = t.app.knowledge.reject(USER, pid, p.human_id, { expected_revision: p.revision, confirmation: `reject ${p.human_id}` });
    expect(rej.status).toBe("rejected");
  });

  it("questions and conflicts: accept marks them reviewed (still open); reject withdraws/dismisses", async () => {
    t = makeApp({ scenario: "extraction" });
    const pid = t.app.projects.create(USER, { name: "QC", ai_enabled: true }).id;
    await uploadAndExtract(t.app, pid, "a.md", "# Sign-up\n\nCustomers must verify their email address.\n\n# Passwords\n\nPasswords need 8 characters.");
    const q = t.app.knowledge.list(USER, pid, { types: ["open_question"] })[0]!;
    const c = t.app.knowledge.list(USER, pid, { types: ["conflict"] })[0]!;
    const qa = t.app.knowledge.accept(USER, pid, q.human_id, { expected_revision: q.revision, confirmation: `accept ${q.human_id}` }).entity;
    expect(qa.status).toBe("open");
    expect(qa.fields.reviewed).toBe(true);
    const cd = t.app.knowledge.reject(USER, pid, c.human_id, { expected_revision: c.revision, confirmation: `dismiss ${c.human_id}` });
    expect(cd.status).toBe("dismissed");
  });

  it("delete is human-confirmed, keeps history with a tombstone, never reuses the ID, and is not resurrected", async () => {
    t = makeApp({ scenario: "extraction" });
    const pid = t.app.projects.create(USER, { name: "Del", ai_enabled: true }).id;
    await uploadAndExtract(t.app, pid, "a.md", "Customers must verify their email address.");
    await uploadAndExtract(t.app, pid, "b.md", "Customers must verify their email address soon.");
    const r = t.app.knowledge.get(USER, pid, "REQ-001");
    expect(() => t.app.knowledge.remove(MCP, pid, "REQ-001", { expected_revision: r.revision, confirmation: "delete REQ-001" })).toThrow();
    expect(() => t.app.knowledge.remove(USER, pid, "REQ-001", { expected_revision: r.revision, confirmation: "delete" })).toThrow(/delete REQ-001/);
    t.app.knowledge.remove(USER, pid, "REQ-001", { expected_revision: r.revision, confirmation: "delete REQ-001" });
    expect(() => t.app.knowledge.get(USER, pid, "REQ-001")).toThrow(/not found/);
    // Proposals targeting it go stale.
    expect(t.app.knowledge.list(USER, pid, { types: ["change_proposal"] })[0]!.status).toBe("stale");
    const hist = join(t.dataDir, "projects", pid, "history", "REQ-001");
    expect(readdirSync(hist).some((n) => /^deleted-r\d+\.json$/.test(n))).toBe(true);
    expect(existsSync(join(t.dataDir, "projects", pid, "requirements", "REQ-001.md"))).toBe(false);
    // Search no longer finds it.
    const { hits } = t.app.search(USER, pid, { query: "verify email", entity_types: ["requirement"] });
    expect(hits.some((h) => h.human_id === "REQ-001")).toBe(false);
    // The next requirement gets a fresh ID.
    const d = t.app.knowledge.createDraft(USER, pid, "requirement", { title: "Something else entirely" });
    expect(d.human_id).toBe("REQ-002");
    // Rebuilding the projection does not bring it back.
    t.app.ctx.store.rebuildProjection(pid, USER);
    expect(() => t.app.knowledge.get(USER, pid, "REQ-001")).toThrow(/not found/);
  });

  it("client wording is recognised despite punctuation and case; partial numbers never match", () => {
    const cell = "Vendor price lists arrive in random formats | Upload the file and the system reads it automatically";
    expect(containsWording(cell, "Upload the file and the system reads it automatically.")).toBe(true);
    expect(containsWording("Design & provision VNet (10.0.0.0/16) + ACA subnet", "design & provision VNet 10.0.0.0/16 + ACA subnet")).toBe(true);
    expect(containsWording("margins under 30% need approval", "margins under 3")).toBe(false);
    expect(containsWording("Passwords must be at least 12 characters", "Passwords must be at least 8 characters")).toBe(false);
  });

  it("conflicts are found across documents, with this document on side 1, and nothing is drafted from the other one", async () => {
    t = makeApp({ scenario: "extraction" });
    const pid = t.app.projects.create(USER, { name: "Cross", ai_enabled: true }).id;
    const spec = t.app.sources.ingest(USER, pid, {
      filename: "spec.md",
      bytes: enc("The pricing platform must store data in Azure SQL with private endpoints."),
    });
    const plan = t.app.sources.ingest(USER, pid, {
      filename: "tracker.md",
      bytes: enc("Task 3.3: provision PostgreSQL Flexible Server for the pricing platform data, with backups."),
    });
    await drainJobs(t.app, ["ingest"]);
    await drainJobs(t.app, ["extract_knowledge"]);
    const conflicts = t.app.knowledge.list(USER, pid, { types: ["conflict"] }).filter((c) => c.title.startsWith("Cross-document"));
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    const c = conflicts[0]!;
    const sides = c.sections.sides as string[];
    expect(sides[0]).toMatch(/^Side 1 \((spec|tracker)\.md\): /);
    expect(sides[1]).toMatch(/^Side 2 \((spec|tracker)\.md\): /);
    expect(sides[0]!.slice(0, 20)).not.toBe(sides[1]!.slice(0, 20));
    const sources = new Set(c.source_refs.map((r) => r.source_id));
    expect(sources).toEqual(new Set([spec.source.id, plan.source.id]));
    expect(c.source_refs.find((r) => r.label === "side 1")!.source_id).not.toBe(c.source_refs.find((r) => r.label === "side 2")!.source_id);
    // Requirements only ever cite the document they were drafted from.
    for (const r of t.app.knowledge.list(USER, pid, { types: ["requirement"] })) expect(new Set(r.source_refs.map((x) => x.source_id)).size).toBe(1);
  });

  it("drafting runs one document at a time per project", async () => {
    t = makeApp({ scenario: "extraction" });
    const pid = t.app.projects.create(USER, { name: "Serial", ai_enabled: true }).id;
    t.app.sources.ingest(USER, pid, { filename: "a.md", bytes: enc("Customers must verify their email address.") });
    t.app.sources.ingest(USER, pid, { filename: "b.md", bytes: enc("Passwords must be at least 12 characters.") });
    await drainJobs(t.app, ["ingest"]);
    const keys = t.app.ctx.db.prepare("SELECT serial_key FROM jobs WHERE type = 'extract_knowledge'").all() as { serial_key: string }[];
    expect(keys).toHaveLength(2);
    expect(new Set(keys.map((k) => k.serial_key))).toEqual(new Set([`extract:${pid}`]));
    const first = t.app.ctx.queue.claim("w1", 60_000, ["extract_knowledge"]);
    expect(first).toBeTruthy();
    expect(t.app.ctx.queue.claim("w2", 60_000, ["extract_knowledge"])).toBeNull(); // the second waits for the first
  });

  it("duplicate detection on paraphrases seen in real client documents", () => {
    // Questions the model raised three times from three documents.
    expect(
      similarQuestion(
        "What is the minimum margin for special job prices, and who approves below it?",
        "What is the minimum margin threshold for special job prices that requires manager approval?",
      ),
    ).toBe(true);
    expect(
      similarQuestion(
        "Which vendors keep the 5% burden, and why?",
        "Which specific vendors keep the 5% burden and under what criteria is burden applied or removed?",
      ),
    ).toBe(true);
    expect(similarQuestion("Who keeps truck freight rates current?", "Which pilot vendors are in Phase 1?")).toBe(false);
    // Different client IDs or numbers are never merged.
    expect(similar("FR-10 Search products by SKU", "FR-11 Search products by SKU and name")).toBe(false);
    expect(similar("Passwords must be at least 8 characters", "Passwords must be at least 12 characters")).toBe(false);
    // A more specific statement is new information, not a duplicate.
    expect(sameStatement("Customers must verify their email address.", "Customers must verify their email address within one day of signing up.")).toBe(false);
    expect(sameStatement("Flag price changes over 15%", "Flag price changes over 15%.")).toBe(true);
  });

  it("excerpts show the matching lines and search terms favour names and numbers", () => {
    const sheet = Array.from({ length: 40 }, (_, i) =>
      i === 29 ? "Row 30: Task = PostgreSQL Flexible Server, backups" : `Row ${i + 1}: Task = Filler work item ${i}`,
    ).join("\n");
    const ex = bestExcerpt(sheet, "Azure SQL vs PostgreSQL Flexible Server", 120);
    expect(ex).toContain("Row 30: Task = PostgreSQL Flexible Server");
    expect(ex.length).toBeLessThanOrEqual(120);
    const terms = keyTerms("The platform uses Azure SQL. The platform stores rules. Angular frontend, .NET backend, 500 rows.", 5);
    expect(terms).toEqual(expect.arrayContaining(["azure", "sql", "angular", "500"]));
    expect(terms).not.toContain("the");
    expect(topicTerms("Task 3.3: PostgreSQL Flexible Server, backups; FastAPI service; React portal")).toEqual(
      expect.arrayContaining(["database", "backend", "frontend"]),
    );
    expect(topicTerms("Customers must verify their email address")).toEqual([]);
  });

  it("near-duplicate detection", () => {
    expect(similar("Customers must verify their email address", "Customer must verify email address")).toBe(true);
    expect(similar("How long is the verification link valid?", "How long is the verification link valid")).toBe(true);
    expect(similar("Password length rules", "Invoice export format")).toBe(false);
  });
});
