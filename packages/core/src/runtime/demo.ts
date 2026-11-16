import type { ModelExtraction, ModelTurn } from "@jonathon/contracts";
import { AppError } from "../util";
import { parseEvidence, parseQuestion } from "./prompt-format";
import type { AuthInfo, CapabilityInfo, InstallationInfo, NormalizedRuntimeResult, ReasoningRuntime, RuntimeRunRequest } from "./types";

const STOP = new Set("the a an and or of to in on for is are be with what how when does do which who this that it as at by from".split(" "));

function terms(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

function firstSentence(text: string, max = 220): string {
  const s = text.replace(/\s+/g, " ").trim();
  const m = /^(.{20,}?[.!?])(\s|$)/.exec(s);
  return (m ? m[1]! : s).slice(0, max);
}

/**
 * DEMO MODE ONLY. No AI is involved. Answers are extractive quotes of retrieved evidence and drafts are
 * keyword heuristics. Every result is labelled provider "demo-extractive" with a warning.
 * It never claims implementation readiness and never resolves conflicts.
 */
export class DemoExtractiveRuntime implements ReasoningRuntime {
  readonly provider = "demo-extractive" as const;

  configHash(): string {
    return "demo-extractive-v1";
  }
  async prepare(): Promise<void> {}
  async inspectInstallation(): Promise<InstallationInfo> {
    return { installed: false, executable: "(demo mode: Antigravity is not used)", version: null, error: null };
  }
  async checkAuthentication(): Promise<AuthInfo> {
    return { status: "unknown", detail: "demo mode does not contact any model provider", contactsProvider: true };
  }
  async inspectCapabilities(): Promise<CapabilityInfo> {
    return { compatible: false, flags: {}, missing: [], globalRuleFiles: [], notes: ["demo mode: no runtime"] };
  }
  async cancel(): Promise<number> {
    return 0;
  }
  resume(_id: string, req: RuntimeRunRequest): Promise<NormalizedRuntimeResult> {
    return this.run(req);
  }

  async run(req: RuntimeRunRequest): Promise<NormalizedRuntimeResult> {
    if (req.signal?.aborted) throw new AppError("JOB_CANCELLED", "cancelled");
    const started = Date.now();
    const evidence = parseEvidence(req.prompt);
    const structured = req.schema === "answer" ? this.answer(req.prompt, evidence) : this.extract(evidence);
    return {
      provider: "demo-extractive",
      runtimeVersion: null,
      model: null,
      conversationId: null,
      requestedConversationId: null,
      contextRebuilt: false,
      completion: "success",
      envelopeStatus: "SUCCESS",
      finishedReason: null,
      text: JSON.stringify(structured),
      structured,
      usage: null,
      warnings: ["DEMO MODE: no AI reasoning was performed. Output is extractive and heuristic."],
      permissionDenials: [],
      durationMs: Date.now() - started,
      exitCode: 0,
    };
  }

  private answer(prompt: string, evidence: ReturnType<typeof parseEvidence>): ModelTurn {
    const q = terms(parseQuestion(prompt));
    const scored = evidence
      .map((e) => ({ e, score: terms(e.text).filter((t) => q.includes(t)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    const conflicts = evidence.filter((e) => e.authority === "open_conflict");
    const questions = evidence.filter((e) => e.authority === "open_question");
    if (scored.length === 0) {
      return {
        action: "answer",
        evidence_queries: [],
        status: "insufficient_evidence",
        answer_markdown: "**Demo mode (no AI).** No retrieved evidence matched this question.",
        citations: [],
        requirement_ids: [],
        decision_ids: [],
        inferences: [],
        unresolved_questions: [],
        conflicts: [],
        claims_implementation_ready: false,
      };
    }
    const lines = scored.map(({ e }) => `- ${e.title} (${e.locator}): "${firstSentence(e.text)}" [${e.id}]`);
    return {
      action: "answer",
      evidence_queries: [],
      status: conflicts.length ? "conflicting_sources" : "partially_answered",
      answer_markdown: `**Demo mode (no AI).** These retrieved passages look relevant. They are quoted, not interpreted:\n\n${lines.join("\n")}`,
      citations: scored.map(({ e }) => ({ evidence_id: e.id, quote: firstSentence(e.text) })),
      requirement_ids: scored.map(({ e }) => /^(REQ-\d+)/.exec(e.title)?.[1]).filter((x): x is string => !!x),
      decision_ids: scored.map(({ e }) => /^(DEC-\d+)/.exec(e.title)?.[1]).filter((x): x is string => !!x),
      inferences: [],
      unresolved_questions: questions.map((e) => firstSentence(e.text)),
      conflicts: conflicts.map((e) => ({ summary: firstSentence(e.text), evidence_ids: [e.id] })),
      claims_implementation_ready: false,
    };
  }

  private extract(evidence: ReturnType<typeof parseEvidence>): ModelExtraction {
    const reqs: ModelExtraction["requirements"] = [];
    for (const e of evidence) {
      for (const sentence of e.text.split(/(?<=[.!?])\s+|\n+/)) {
        const s = sentence.replace(/^[-*\s]+/, "").trim();
        if (s.length < 15 || s.length > 600) continue;
        if (!/\b(must|shall|should|required to|needs? to)\b/i.test(s)) continue;
        if (/ignore (all|previous)|system prompt|you are now/i.test(s)) continue;
        reqs.push({
          title: s.length > 90 ? `${s.slice(0, 87)}...` : s,
          description: s,
          type: "functional",
          module: "",
          feature_scope: "",
          actors: [],
          preconditions: [],
          behavior: [s],
          alternate_flows: [],
          validation_rules: [],
          acceptance_criteria: [],
          priority_stated_in_source: /\b(must|shall)\b/i.test(s) ? "" : "",
          evidence_ids: [e.id],
          open_questions: [],
        });
        if (reqs.length >= 20) break;
      }
    }
    return { requirements: reqs, open_questions: [], conflicts: [] };
  }
}
