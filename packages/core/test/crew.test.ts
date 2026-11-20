import type { Answer, ModelExtraction } from "@jonathon/contracts";
import { drainJobs } from "../../test-fixtures/src/index";
import { afterEach, describe, expect, it } from "vitest";
import { applyVerdicts, codeGate, numbersSupported, removeClaims, renderCandidates, specialistsFor, splitClaims } from "../src/services/crew";
import { makeApp, type TestApp, USER } from "./helpers";

const enc = (s: string) => new TextEncoder().encode(s);
let t: TestApp;
afterEach(() => t?.cleanup());

const req = (over: Partial<ModelExtraction["requirements"][number]> = {}): ModelExtraction["requirements"][number] => ({
  title: "FR-15 Special job price approval",
  description: "Special job price: enter negotiated cost and margin; margins under 30% need approval",
  type: "functional",
  module: "",
  feature_scope: "",
  actors: [],
  preconditions: [],
  behavior: ["Margins under 30% need approval"],
  alternate_flows: [],
  validation_rules: [],
  acceptance_criteria: ["Approval is requested within 24 hours"],
  priority_stated_in_source: "Must",
  evidence_ids: ["E1"],
  open_questions: [],
  ...over,
});
const empty = (): ModelExtraction => ({ requirements: [], open_questions: [], conflicts: [], requirement_updates: [] });
const EVIDENCE = "FR-15 | Special job price: enter negotiated cost and margin; margins under 30% need approval | Must";

describe("agent team: deterministic gates", () => {
  it("numbers must come from the cited evidence; evidence ids and Jonathon ids are not numbers", () => {
    expect(numbersSupported("Margins under 30% need approval", [EVIDENCE])).toBe(true);
    expect(numbersSupported("Approval is requested within 24 hours", [EVIDENCE])).toBe(false);
    expect(numbersSupported("FR-15 see E1 and REQ-004", [EVIDENCE])).toBe(true);
    expect(numbersSupported("Batches of 2000 rows", ["batches of 2,000 rows"])).toBe(true);
    expect(numbersSupported("under 3%", [EVIDENCE])).toBe(false);
  });

  it("plans and estimates never get the requirements or change specialists", () => {
    expect(specialistsFor("plan_or_estimate", true)).toEqual(["questions", "conflicts"]);
    expect(specialistsFor("requirements_spec", false)).toEqual(["requirements", "questions", "conflicts"]);
    expect(specialistsFor("requirements_spec", true)).toEqual(["requirements", "questions", "conflicts", "changes"]);
  });

  it("the code gate drops statements with invented numbers and requirements with invented IDs", () => {
    const x = empty();
    x.requirements = [req(), req({ title: "FR-99 Something", behavior: [] })];
    const g = codeGate(x, () => [EVIDENCE]);
    expect(g.kept.requirements).toHaveLength(1);
    expect(g.kept.requirements[0]!.acceptance_criteria).toEqual([]);
    expect(g.kept.requirements[0]!.behavior).toEqual(["Margins under 30% need approval"]);
    expect(g.rejected.map((r) => r.text)).toEqual(expect.arrayContaining(["FR-99 Something", "Approval is requested within 24 hours"]));
    expect(g.rejected.every((r) => r.by === "code")).toBe(true);
  });

  it("verdicts are applied fail-closed: unsupported and unanswered candidates are dropped, partial ones trimmed", () => {
    const x = empty();
    x.requirements = [req(), req({ title: "FR-16 Quote builder" })];
    x.open_questions = [{ question: "What is the minimum margin?", context: "", blocking: false, feature_scope: "", evidence_ids: ["E1"] }];
    const { lines, text } = renderCandidates(x);
    expect(text).toContain("R1-2 [acceptance_criteria] Approval is requested within 24 hours");
    const { kept, rejected } = applyVerdicts(x, lines, {
      verdicts: [
        { candidate_id: "R1", verdict: "partly_supported", unsupported_statement_ids: ["R1-2"], reason: "not stated" },
        { candidate_id: "R2", verdict: "unsupported", unsupported_statement_ids: [], reason: "no such requirement" },
        // Q1 has no verdict → dropped
      ],
    });
    expect(kept.requirements).toHaveLength(1);
    expect(kept.requirements[0]!.acceptance_criteria).toEqual([]);
    expect(kept.open_questions).toHaveLength(0);
    expect(rejected.map((r) => r.reason)).toEqual(expect.arrayContaining(["not stated", "no such requirement", "the verifier gave no verdict"]));
  });

  it("answers are split into claims and unsupported claims are removed cleanly", () => {
    const md =
      "## Threshold\n\nPrice changes over 15% are flagged [E1]. Invented rule: links expire after 24 hours.\n\n- Unit changes are flagged too [E1].\n- Invented: approvals take one day.";
    const claims = splitClaims(md);
    expect(claims.map((c) => c.text)).toEqual([
      "Price changes over 15% are flagged [E1].",
      "Invented rule: links expire after 24 hours.",
      "Unit changes are flagged too [E1].",
      "Invented: approvals take one day.",
    ]);
    const out = removeClaims(
      md,
      claims.filter((c) => c.text.startsWith("Invented")),
    );
    expect(out).toBe("## Threshold\n\nPrice changes over 15% are flagged [E1].\n\n- Unit changes are flagged too [E1].");
  });
});

describe("agent team: end to end with the fixture runtime", () => {
  it("each role runs once per batch; the verifier's rejections are applied and reported with reasons", async () => {
    t = makeApp({ scenario: "verifier-rejects" });
    const pid = t.app.projects.create(USER, { name: "Crew", ai_enabled: true }).id;
    t.app.sources.ingest(USER, pid, {
      filename: "spec.md",
      bytes: enc("# Sign-up\n\nCustomers must verify their email address.\n\n# Links\n\nThe link expires after a while."),
    });
    await drainJobs(t.app, ["ingest", "extract_knowledge"]);
    const job = t.app.ctx.db.prepare("SELECT result FROM jobs WHERE type = 'extract_knowledge'").get() as { result: string };
    const r = JSON.parse(job.result) as {
      team: { document_kind: string; agents: Record<string, { runs: number }>; rejected: { text: string; by: string; reason: string }[] };
    };
    expect(r.team.document_kind).toBe("requirements_spec");
    expect(Object.keys(r.team.agents).sort()).toEqual(["classify", "conflicts", "questions", "requirements", "verify_draft"]);
    expect(r.team.rejected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "AI-suggested criterion", by: "verifier" }),
        expect.objectContaining({ text: "How long is the verification link valid?", by: "verifier" }),
      ]),
    );
    const reqs = t.app.knowledge.list(USER, pid, { types: ["requirement"] });
    expect(reqs).toHaveLength(1);
    expect((reqs[0]!.sections.acceptance_criteria as unknown[]).length).toBe(0);
    const qs = t.app.knowledge.list(USER, pid, { types: ["open_question"] }).map((q) => q.title);
    expect(qs).not.toContain("How long is the verification link valid?");
  });

  it("a plan or estimate only gets the questions and conflicts specialists", async () => {
    t = makeApp({ scenario: "extraction" });
    const pid = t.app.projects.create(USER, { name: "Plan", ai_enabled: true }).id;
    t.app.sources.ingest(USER, pid, {
      filename: "tracker.md",
      bytes: enc("# Project plan\n\nMilestone 1: kickoff. Task: customers must verify their email address (build)."),
    });
    await drainJobs(t.app, ["ingest", "extract_knowledge"]);
    const job = t.app.ctx.db.prepare("SELECT result FROM jobs WHERE type = 'extract_knowledge'").get() as { result: string };
    const r = JSON.parse(job.result) as { team: { document_kind: string; agents: Record<string, unknown> } };
    expect(r.team.document_kind).toBe("plan_or_estimate");
    expect(r.team.agents.requirements).toBeUndefined();
    expect(t.app.knowledge.list(USER, pid, { types: ["requirement"] })).toHaveLength(0);
  });

  async function ask(app: TestApp["app"], pid: string, message: string): Promise<Answer> {
    const pending = await app.answers.ask(USER, pid, { message }, { waitMs: 0 });
    await drainJobs(app, ["answer"]);
    return (await app.answers.waitForAnswer(USER, pid, (pending as { job_id: string }).job_id, 0)) as Answer;
  }

  it("the answer verifier checks every claim; a supported answer keeps its status", async () => {
    t = makeApp({ scenario: "answer-cite" });
    const pid = t.app.projects.create(USER, { name: "Ask", ai_enabled: true }).id;
    t.app.sources.ingest(USER, pid, { filename: "x.md", bytes: enc("Customers must verify their email address before ordering.") });
    await drainJobs(t.app, ["ingest"]);
    const a = await ask(t.app, pid, "Must customers verify their email?");
    expect(a.verification).not.toBeNull();
    expect(a.verification!.checked).toBeGreaterThan(0);
    expect(a.verification!.removed).toEqual([]);
    expect(a.status).toBe("answered");
  });

  it("an answer whose verifier cannot run is labelled unverified and never 'answered'", async () => {
    t = makeApp({ scenario: "answer-verifier-fails" });
    const pid = t.app.projects.create(USER, { name: "Ask2", ai_enabled: true }).id;
    t.app.sources.ingest(USER, pid, { filename: "x.md", bytes: enc("Customers must verify their email address before ordering.") });
    await drainJobs(t.app, ["ingest"]);
    const a = await ask(t.app, pid, "Must customers verify their email?");
    expect(a.verification).toBeNull();
    expect(a.status).not.toBe("answered");
    expect(a.warnings.join(" ")).toMatch(/NOT verified/);
    expect(a.implementation_ready).toBe(false);
  });

  it("unsupported claims are removed from the answer and listed with the reason", async () => {
    t = makeApp({ scenario: "answer-unknown-citation" });
    const pid = t.app.projects.create(USER, { name: "Ask3", ai_enabled: true }).id;
    t.app.sources.ingest(USER, pid, { filename: "x.md", bytes: enc("Customers must verify their email address before ordering.") });
    await drainJobs(t.app, ["ingest"]);
    const a = await ask(t.app, pid, "How long do links last?");
    // The fixture answer invents "links expire after 24 hours" with a citation to evidence that does not exist.
    expect(a.answer_markdown).not.toMatch(/24 hours/);
    expect(a.status).not.toBe("answered");
  });
});
