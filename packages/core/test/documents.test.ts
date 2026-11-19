import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DOC_CATEGORIES, type GeneratedDocument } from "@jonathon/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { drainJobs } from "../../test-fixtures/src/index";
import { CATALOGUE } from "../src/docs/catalogue";
import { renderMarkdown, stripEvidenceIds } from "../src/services/documents";
import { conceptKey } from "../src/services/graph";
import { makeApp, type TestApp, USER } from "./helpers";

const enc = (s: string) => new TextEncoder().encode(s);
const MCP = { kind: "mcp_token" as const, tokenId: "mtk_x", name: "agent", scopes: ["read", "propose"] as ("read" | "propose")[], projectIds: [] as string[] };
let t: TestApp;
afterEach(() => t?.cleanup());

const BRIEF =
  "# Sign-up\n\nCustomers must verify their email address before ordering.\n\n# Orders\n\nWarehouse managers approve every purchase order over the limit.";
const SECOND = "# Reporting\n\nFinance analysts export monthly invoices to Excel for reconciliation.";

/** Run every runnable job, including debounced document refreshes (their start time is pulled forward). */
async function settle(app: TestApp["app"]) {
  for (let i = 0; i < 6; i++) {
    app.ctx.db.prepare("UPDATE jobs SET run_after = ? WHERE status = 'queued'").run(new Date(0).toISOString());
    const ran = await drainJobs(app, ["ingest", "extract_knowledge", "graph_extract", "generate_documents"]);
    if (!ran.length) break;
  }
}

function readDoc(dataDir: string, pid: string, type: string): GeneratedDocument {
  return JSON.parse(readFileSync(join(dataDir, "projects", pid, "documents", `${type}.json`), "utf8")) as GeneratedDocument;
}

async function project(): Promise<string> {
  t = makeApp({ scenario: "extraction" });
  const pid = t.app.projects.create(USER, { name: "Docs", ai_enabled: true }).id;
  t.app.sources.ingest(USER, pid, { filename: "brief.md", bytes: enc(BRIEF) });
  await settle(t.app);
  return pid;
}

describe("document catalogue", () => {
  it("covers all ten categories with unique, well-formed document types", () => {
    const ids = CATALOGUE.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(66);
    for (const [cat] of DOC_CATEGORIES) expect(CATALOGUE.some((d) => d.category === cat)).toBe(true);
    for (const d of CATALOGUE) {
      expect(d.id).toMatch(/^[a-z0-9_]{2,60}$/);
      expect(d.sections.length).toBeGreaterThan(2); // every document ends with open questions and conflicts
      expect(new Set(d.sections.map((s) => s.key)).size).toBe(d.sections.length);
      for (const s of d.sections) {
        if (s.mode === "compiled") expect(s.compiler).toBeTruthy();
        else expect(s.guide.length).toBeGreaterThan(10);
      }
    }
    expect(CATALOGUE.filter((d) => d.must_have).length).toBeGreaterThanOrEqual(20);
  });
});

describe("project memory graph", () => {
  it("maps concepts from uploads, rejects names and quotes not in the evidence, and exports graphify JSON", async () => {
    const pid = await project();
    const job = t.app.ctx.queue.list({ projectId: pid }).find((j) => j.type === "graph_extract")!;
    expect(job.status).toBe("succeeded");
    const result = job.result as { concepts: number; relations: number; rejected: { text: string; reason: string }[] };
    expect(result.concepts).toBeGreaterThanOrEqual(1);
    expect(result.rejected.some((r) => r.text.startsWith("Quantum Ledger") && /not in the passages/.test(r.reason))).toBe(true);
    expect(result.rejected.some((r) => /quote is not in the cited passages/.test(r.reason))).toBe(true);

    const ov = t.app.graph.overview(USER, pid);
    expect(ov.by_type.source).toBe(1);
    expect(ov.by_type.passage).toBeGreaterThan(0);
    expect(ov.by_type.concept).toBeGreaterThanOrEqual(1);
    expect(ov.by_type.requirement).toBeGreaterThanOrEqual(1);
    expect(ov.documents_mapped).toBe(1);

    // Mentions are found by code: the concept node links to the passage that names it.
    const concept = t.app.graph.search(USER, pid, "Customers").find((n) => n.type === "concept")!;
    expect(concept).toBeTruthy();
    const detail = t.app.graph.node(USER, pid, concept.id);
    expect(detail.links.some((l) => l.relation === "mentions" && l.node.type === "passage")).toBe(true);
    const req = t.app.knowledge.list(USER, pid).find((e) => e.entity_type === "requirement")!;
    expect(t.app.graph.path(USER, pid, concept.id, `entity:${req.human_id}`).found).toBe(true);

    // graphify's schema: required node/edge fields, known file types, edges between existing nodes.
    const g = t.app.graph.graphifyJson(pid) as { nodes: Record<string, unknown>[]; links: Record<string, unknown>[] };
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const n of g.nodes) {
      for (const f of ["id", "label", "file_type", "source_file"]) expect(n[f]).toBeDefined();
      expect(["code", "document", "paper", "image", "rationale", "concept"]).toContain(n.file_type);
    }
    for (const l of g.links) {
      for (const f of ["source", "target", "relation", "confidence", "source_file"]) expect(l[f]).toBeDefined();
      expect(["EXTRACTED", "INFERRED", "AMBIGUOUS"]).toContain(l.confidence);
      expect(ids.has(l.source as string) && ids.has(l.target as string)).toBe(true);
    }
    expect(existsSync(join(t.dataDir, "projects", pid, "graph", "graph.json"))).toBe(true);
  });

  it("drops a removed document's passages and the concepts only it mentioned", async () => {
    const pid = await project();
    const second = t.app.sources.ingest(USER, pid, { filename: "reporting.md", bytes: enc(SECOND) });
    await settle(t.app);
    const before = t.app.graph.overview(USER, pid);
    expect(before.by_type.source).toBe(2);
    expect(t.app.graph.search(USER, pid, "Finance").some((n) => n.type === "concept")).toBe(true);
    t.app.sources.delete(USER, pid, second.source.id, "delete reporting.md");
    const after = t.app.graph.overview(USER, pid);
    expect(after.by_type.source).toBe(1);
    expect(t.app.graph.search(USER, pid, "Finance").some((n) => n.type === "concept")).toBe(false);
  });

  it("strips prompt-internal evidence ids from text people read", () => {
    expect(stripEvidenceIds("Angular is specified (E3, E4).")).toBe("Angular is specified.");
    expect(stripEvidenceIds("Shared login (REQ-020, E3, E4) with MFA")).toBe("Shared login (REQ-020) with MFA");
    expect(stripEvidenceIds("Version 18 (proposed default)")).toBe("Version 18 (proposed default)");
    expect(stripEvidenceIds("Uses E15 build (E15)")).toBe("Uses E15 build");
  });

  it("normalizes concept names", () => {
    expect(conceptKey("  Azure SQL ")).toBe("azure sql");
    expect(conceptKey("Node.js")).toBe("node.js");
    expect(conceptKey("C#")).toBe("c#");
  });
});

describe("generated technical documents", () => {
  it("compiles knowledge sections, writes and verifies the rest, and labels every item's basis", async () => {
    const pid = await project();
    t.app.documents.queueGenerate(USER, pid, ["srs", "hld", "coding_standards"]);
    await settle(t.app);
    const cat = t.app.documents.catalogue(USER, pid);
    expect(
      cat.documents
        .filter((d) => d.generated)
        .map((d) => d.id)
        .sort(),
    ).toEqual(["coding_standards", "hld", "srs"]);

    const srs = readDoc(t.dataDir, pid, "srs");
    const req = t.app.knowledge.list(USER, pid).find((e) => e.entity_type === "requirement")!;
    const functional = srs.sections.find((s) => s.key === "functional")!;
    expect(functional.mode).toBe("compiled");
    expect(functional.blocks.some((b) => b.cells[0] === req.human_id && b.basis === "knowledge")).toBe(true);

    const intro = srs.sections.find((s) => s.key === "introduction")!;
    const texts = intro.blocks.map((b) => b.text);
    expect(intro.blocks.some((b) => b.basis === "client_stated")).toBe(true);
    expect(intro.blocks.some((b) => b.basis === "evidence_based" && /restatement/.test(b.text))).toBe(true);
    expect(intro.blocks.some((b) => b.basis === "ai_proposed" && b.kind === "proposal")).toBe(true);
    expect(intro.blocks.some((b) => b.kind === "gap")).toBe(true);
    expect(intro.blocks.some((b) => b.kind === "diagram" && b.text.startsWith("flowchart"))).toBe(true);
    // Removed: invented number, a claim the verifier rejected, a fact citing nothing real, a non-Mermaid "diagram".
    expect(texts.some((x) => /10000/.test(x))).toBe(false);
    expect(texts.some((x) => /Unsupported claim/.test(x))).toBe(false);
    expect(texts.some((x) => /cites nothing real/.test(x))).toBe(false);
    expect(texts).not.toContain("not a diagram");
    const reasons = srs.removed.map((r) => r.reason).join(" | ");
    expect(reasons).toMatch(/numbers not found/);
    expect(reasons).toMatch(/verifier:/);
    expect(reasons).toMatch(/without a valid citation/);
    expect(reasons).toMatch(/not Mermaid/);
    // Every item is labelled; AI output is never pre-accepted.
    for (const s of srs.sections) for (const b of s.blocks) if (s.mode === "written") expect(b.review_state).toBe("proposed");

    const md = readFileSync(join(t.dataDir, "projects", pid, "documents", "srs.md"), "utf8");
    expect(md).toMatch(/^# Software Requirements Specification/);
    expect(md).toMatch(/\*\*Gap:\*\*/);
    expect(md).toMatch(/AI proposal/);
    expect(md).toMatch(/client-stated/);
    // The memory graph links each document to what it was built from.
    const docNode = t.app.graph.node(USER, pid, "document:srs");
    expect(docNode.links.some((l) => l.relation === "built_from" && l.node.type === "requirement")).toBe(true);
  });

  it("refreshes only when inputs change: new material updates documents, removing it rolls them back", async () => {
    const pid = await project();
    t.app.documents.queueGenerate(USER, pid, ["srs", "rtm"]);
    await settle(t.app);
    const r1 = readDoc(t.dataDir, pid, "srs");

    // Nothing changed: a refresh makes no new revision and calls no writer.
    t.app.ctx.queue.enqueue({
      projectId: pid,
      type: "generate_documents",
      payload: { mode: "refresh", doc_types: null, reasons: ["manual"] },
      createdBy: "test",
      serialKey: `docs:${pid}`,
    });
    await settle(t.app);
    expect(readDoc(t.dataDir, pid, "srs").revision).toBe(r1.revision);

    // New material: drafting, mapping and the debounced refresh produce a new revision that says why.
    const second = t.app.sources.ingest(USER, pid, { filename: "reporting.md", bytes: enc(SECOND) });
    await settle(t.app);
    const r2 = readDoc(t.dataDir, pid, "srs");
    expect(r2.revision).toBeGreaterThan(r1.revision);
    expect(r2.changes[0]!.reasons.join(" ")).toMatch(/knowledge changed|mapped concepts/);
    expect(r2.changes[0]!.added.length).toBeGreaterThan(0);
    const cites = (d: GeneratedDocument) =>
      d.sections.flatMap((s) => s.blocks.flatMap((b) => b.refs.filter((r) => r.kind === "chunk").map((r) => r.source_id)));
    const listed = () =>
      readDoc(t.dataDir, pid, "rtm")
        .sections.find((s) => s.key === "sources")!
        .blocks.map((b) => b.cells[0]);
    expect(listed()).toEqual(["brief.md", "reporting.md"]);

    // Removing the document: the refresh drops its evidence from the document and records the removal.
    t.app.sources.delete(USER, pid, second.source.id, "delete reporting.md");
    const queued = t.app.ctx.db.prepare("SELECT payload FROM jobs WHERE project_id = ? AND type = 'generate_documents' AND status = 'queued'").get(pid) as {
      payload: string;
    };
    expect((JSON.parse(queued.payload) as { reasons: string[] }).reasons).toContain("removed reporting.md");
    await settle(t.app);
    const r3 = readDoc(t.dataDir, pid, "srs");
    expect(r3.revision).toBeGreaterThan(r2.revision);
    expect(cites(r3)).not.toContain(second.source.id);
    expect(r3.changes[0]!.reasons).toContain("removed reporting.md");
    expect(listed()).toEqual(["brief.md"]);
  });

  it("never overwrites a person's edit: regenerated content waits, approval needs the phrase and a settled document", async () => {
    const pid = await project();
    t.app.documents.queueGenerate(USER, pid, ["srs"]);
    await settle(t.app);
    const r1 = readDoc(t.dataDir, pid, "srs");
    const edited = t.app.documents.editSection(USER, pid, "srs", "scope", {
      expected_revision: r1.revision,
      markdown: "Scope agreed with the client on the call: sign-up and orders only.",
    });
    expect(edited.document.sections.find((s) => s.key === "scope")!.human_edited).toBe(true);
    expect(() => t.app.documents.editSection(MCP, pid, "srs", "scope", { expected_revision: edited.document.revision, markdown: "x" })).toThrow();
    expect(() => t.app.documents.editSection(USER, pid, "srs", "scope", { expected_revision: r1.revision, markdown: "stale" })).toThrow(/revision/);

    // Someone edits the Markdown file by hand; the next save keeps their file in history.
    const mdPath = join(t.dataDir, "projects", pid, "documents", "srs.md");
    writeFileSync(mdPath, `${readFileSync(mdPath, "utf8")}\nHand-written note.\n`);

    t.app.sources.ingest(USER, pid, { filename: "reporting.md", bytes: enc(SECOND) });
    await settle(t.app);
    const r3 = readDoc(t.dataDir, pid, "srs");
    const scope = r3.sections.find((s) => s.key === "scope")!;
    expect(scope.blocks[0]!.text).toMatch(/agreed with the client/);
    expect(scope.pending_update).not.toBeNull();
    const kept = readdirSync(join(t.dataDir, "projects", pid, "documents", "history", "srs")).filter((f) => f.startsWith("external-edit"));
    expect(kept.length).toBe(1);
    expect(readFileSync(join(t.dataDir, "projects", pid, "documents", "history", "srs", kept[0]!), "utf8")).toMatch(/Hand-written note/);

    expect(() => t.app.documents.approve(USER, pid, "srs", { expected_revision: r3.revision, confirmation: "approve srs" })).toThrow(/regenerated sections/);
    const kept2 = t.app.documents.resolveSectionUpdate(USER, pid, "srs", "scope", { expected_revision: r3.revision, action: "keep" });
    expect(kept2.document.sections.find((s) => s.key === "scope")!.blocks[0]!.text).toMatch(/agreed with the client/);
    const rev = kept2.document.revision;
    expect(() => t.app.documents.approve(USER, pid, "srs", { expected_revision: rev, confirmation: "approve" })).toThrow(/approve srs/);
    expect(() => t.app.documents.approve(MCP, pid, "srs", { expected_revision: rev, confirmation: "approve srs" })).toThrow();
    const approved = t.app.documents.approve(USER, pid, "srs", { expected_revision: rev, confirmation: "approve srs" });
    expect(approved.approval?.approved_by).toBe("parth");
    expect(t.app.documents.catalogue(USER, pid).documents.find((d) => d.id === "srs")!.approved).toBe(true);
    expect(renderMarkdown(readDoc(t.dataDir, pid, "srs"), approved.approval)).toMatch(/approved by parth/);
  });

  it("exposes documents and the graph to MCP read tools but not edits", async () => {
    const pid = await project();
    t.app.documents.queueGenerate(USER, pid, ["tech_stack"]);
    await settle(t.app);
    // Gaps in a table section are notes, not rows: their text is not repeated as a cell.
    for (const sec of readDoc(t.dataDir, pid, "tech_stack").sections) for (const g of sec.blocks.filter((x) => x.kind === "gap")) expect(g.cells).toEqual([]);
    const agent = { ...MCP, projectIds: [pid] };
    expect(t.app.documents.get(agent, pid, "tech_stack").markdown).toMatch(/Tech stack/);
    expect(t.app.graph.overview(agent, pid).nodes).toBeGreaterThan(0);
    expect(() => t.app.documents.approve(agent, pid, "tech_stack", { expected_revision: 1, confirmation: "approve tech_stack" })).toThrow();
    expect(() => t.app.documents.queueGenerate(USER, pid, ["no_such_doc"])).toThrow(/unknown document type/);
  });
});
