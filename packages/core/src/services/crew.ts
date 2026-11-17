import type { ModelDraftVerification, ModelExtraction } from "@jonathon/contracts";
import { normalizeForMatch } from "../util";

/**
 * Pure helpers for the drafting crew (classifier → specialists → draft verifier → code gate).
 * Orchestration lives in ExtractionService; everything here is deterministic and unit-tested.
 */

export type Specialist = "requirements" | "questions" | "conflicts" | "changes";

/** Something the crew proposed but did not keep, with who rejected it and why. Shown to the reviewer. */
export interface Rejection {
  kind: "requirement" | "statement" | "description" | "question" | "conflict" | "change";
  text: string;
  by: "verifier" | "code";
  reason: string;
}

/** Which specialists a document needs. Plans and estimates never produce requirements or requirement changes. */
export function specialistsFor(kind: string, hasExistingRequirements: boolean): Specialist[] {
  const out: Specialist[] = kind === "plan_or_estimate" ? ["questions", "conflicts"] : ["requirements", "questions", "conflicts"];
  if (kind !== "plan_or_estimate" && hasExistingRequirements) out.push("changes");
  return out;
}

const NUM = /\d+(?:[.,]\d+)*/g;

/**
 * Numbers in AI output must appear in the evidence it cites. "under 30%" with evidence saying 30% passes; a
 * statement that says "within 24 hours" when the evidence never says 24 fails. Client IDs (FR-01) count as numbers
 * too, so an invented ID also fails.
 */
export function numbersSupported(text: string, evidence: string[]): boolean {
  // Evidence ids (E3, O2) and Jonathon's own ids (REQ-004) are references, not claims; client IDs (FR-01) are checked.
  const nums = text.replace(/\b[EO]\d{1,3}\b/g, " ").replace(/\b(?:REQ|DEC|QUESTION|CONFLICT|CHANGE)-\d+\b/g, " ").match(NUM) ?? [];
  if (!nums.length) return true;
  // "01" = "1" and "2,000" = "2000"; otherwise numbers must match exactly.
  const canon = (n: string) => n.replace(/,/g, "").replace(/^0+(?=\d)/, "");
  const have = new Set(evidence.flatMap((e) => (normalizeForMatch(e).match(NUM) ?? []).map(canon)));
  return nums.every((n) => have.has(canon(n)));
}

export interface CandidateLine {
  id: string;
  kind: "requirement" | "question" | "conflict" | "change";
  index: number;
  statements: Map<string, { section: string; text: string }>;
}

const REQ_SECTIONS = ["preconditions", "behavior", "alternate_flows", "validation_rules", "acceptance_criteria"] as const;
const ADD_SECTIONS = ["added_behavior", "added_validation_rules", "added_acceptance_criteria"] as const;

/** Render every candidate with stable ids (R1, R1-2, Q1, C1, U1-1 ...) for the verifier. */
export function renderCandidates(x: ModelExtraction): { text: string; lines: CandidateLine[] } {
  const out: string[] = [];
  const lines: CandidateLine[] = [];
  const q = (s: string) => JSON.stringify(s);
  x.requirements.forEach((r, i) => {
    const id = `R${i + 1}`;
    const statements = new Map<string, { section: string; text: string }>();
    out.push(`${id} requirement ${q(r.title)} | description ${q(r.description)} | cites ${r.evidence_ids.join(", ")}`);
    let n = 0;
    for (const sec of REQ_SECTIONS)
      for (const s of r[sec]) {
        const sid = `${id}-${++n}`;
        statements.set(sid, { section: sec, text: s });
        out.push(`  ${sid} [${sec}] ${s}`);
      }
    lines.push({ id, kind: "requirement", index: i, statements });
  });
  x.open_questions.forEach((o, i) => {
    const id = `Q${i + 1}`;
    out.push(`${id} open question ${q(o.question)} | context ${q(o.context)} | cites ${o.evidence_ids.join(", ") || "none"}`);
    lines.push({ id, kind: "question", index: i, statements: new Map() });
  });
  x.conflicts.forEach((c, i) => {
    const id = `C${i + 1}`;
    out.push(`${id} conflict ${q(c.title)} | side A ${q(c.side_a_claim)} cites ${c.side_a_evidence_ids.join(", ")} | side B ${q(c.side_b_claim)} cites ${c.side_b_evidence_ids.join(", ")}`);
    lines.push({ id, kind: "conflict", index: i, statements: new Map() });
  });
  x.requirement_updates.forEach((u, i) => {
    const id = `U${i + 1}`;
    const statements = new Map<string, { section: string; text: string }>();
    out.push(`${id} change to ${u.requirement_id} ${q(u.change_summary)} | new description ${q(u.proposed_description)} | cites ${u.evidence_ids.join(", ")}`);
    let n = 0;
    for (const sec of ADD_SECTIONS)
      for (const s of u[sec]) {
        const sid = `${id}-${++n}`;
        statements.set(sid, { section: sec, text: s });
        out.push(`  ${sid} [${sec.replace("added_", "")}] ${s}`);
      }
    lines.push({ id, kind: "change", index: i, statements });
  });
  return { text: out.join("\n"), lines };
}

/**
 * Apply the verifier's verdicts. Fail-closed: a candidate without a verdict is dropped, because nothing reaches the
 * review queue unchecked. Returns the kept extraction and every rejection with its reason.
 */
export function applyVerdicts(x: ModelExtraction, lines: CandidateLine[], v: ModelDraftVerification): { kept: ModelExtraction; rejected: Rejection[] } {
  const byId = new Map(v.verdicts.map((d) => [d.candidate_id.trim().toUpperCase(), d]));
  const rejected: Rejection[] = [];
  const kept: ModelExtraction = { requirements: [], open_questions: [], conflicts: [], requirement_updates: [] };
  for (const line of lines) {
    const d = byId.get(line.id);
    const label = (): string => {
      if (line.kind === "requirement") return x.requirements[line.index]!.title;
      if (line.kind === "question") return x.open_questions[line.index]!.question;
      if (line.kind === "conflict") return x.conflicts[line.index]!.title;
      return x.requirement_updates[line.index]!.change_summary;
    };
    if (!d || d.verdict === "unsupported") {
      rejected.push({ kind: line.kind, text: label(), by: "verifier", reason: d ? d.reason || "not supported by the evidence" : "the verifier gave no verdict" });
      continue;
    }
    const drop = new Set(d.verdict === "partly_supported" ? d.unsupported_statement_ids.map((s) => s.trim().toUpperCase()) : []);
    for (const sid of drop) {
      const st = line.statements.get(sid);
      if (st) rejected.push({ kind: "statement", text: st.text, by: "verifier", reason: d.reason || "not stated by the evidence" });
    }
    const keepText = (sec: string) => (text: string) => ![...drop].some((sid) => line.statements.get(sid)?.section === sec && line.statements.get(sid)?.text === text);
    if (line.kind === "requirement") {
      const r = structuredClone(x.requirements[line.index]!);
      for (const sec of REQ_SECTIONS) r[sec] = r[sec].filter(keepText(sec));
      if (!r.description.trim() && REQ_SECTIONS.every((s) => r[s].length === 0)) {
        rejected.push({ kind: "requirement", text: r.title, by: "verifier", reason: "nothing supported was left" });
        continue;
      }
      kept.requirements.push(r);
    } else if (line.kind === "change") {
      const u = structuredClone(x.requirement_updates[line.index]!);
      for (const sec of ADD_SECTIONS) u[sec] = u[sec].filter(keepText(sec));
      kept.requirement_updates.push(u);
    } else if (line.kind === "question") kept.open_questions.push(x.open_questions[line.index]!);
    else kept.conflicts.push(x.conflicts[line.index]!);
  }
  return { kept, rejected };
}

/**
 * Deterministic checks before (and independent of) the verifier: every number must appear in the evidence the item
 * cites. `evidenceFor(ids)` returns the texts of the cited evidence (E, O or existing-requirement ids).
 */
export function codeGate(x: ModelExtraction, evidenceFor: (ids: string[]) => string[]): { kept: ModelExtraction; rejected: Rejection[] } {
  const rejected: Rejection[] = [];
  const reason = "contains a number that is not in the cited evidence";
  const keepStatements = <T extends Record<string, unknown>>(obj: T, secs: readonly string[], ev: string[]) => {
    for (const sec of secs) {
      const list = obj[sec] as string[];
      (obj as Record<string, unknown>)[sec] = list.filter((s) => {
        if (numbersSupported(s, ev)) return true;
        rejected.push({ kind: "statement", text: s, by: "code", reason });
        return false;
      });
    }
  };
  const requirements = x.requirements
    .map((r0) => {
      const r = structuredClone(r0);
      const ev = evidenceFor(r.evidence_ids);
      if (!numbersSupported(r.title, ev)) {
        rejected.push({ kind: "requirement", text: r.title, by: "code", reason: "its title has a number or ID that is not in the cited evidence" });
        return null;
      }
      if (!numbersSupported(r.description, ev)) {
        rejected.push({ kind: "description", text: r.description, by: "code", reason });
        r.description = "";
      }
      keepStatements(r, REQ_SECTIONS, ev);
      return r;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  const open_questions = x.open_questions.filter((q) => {
    if (numbersSupported(q.question, evidenceFor(q.evidence_ids))) return true;
    rejected.push({ kind: "question", text: q.question, by: "code", reason });
    return false;
  });
  const conflicts = x.conflicts.filter((c) => {
    if (numbersSupported(c.side_a_claim, evidenceFor(c.side_a_evidence_ids)) && numbersSupported(c.side_b_claim, evidenceFor(c.side_b_evidence_ids))) return true;
    rejected.push({ kind: "conflict", text: c.title, by: "code", reason: "a side claims a number that its cited evidence does not contain" });
    return false;
  });
  const requirement_updates = x.requirement_updates.map((u0) => {
    const u = structuredClone(u0);
    const ev = evidenceFor(u.evidence_ids);
    if (!numbersSupported(u.proposed_description, ev)) {
      rejected.push({ kind: "description", text: u.proposed_description, by: "code", reason });
      u.proposed_description = "";
    }
    keepStatements(u, ADD_SECTIONS, ev);
    return u;
  });
  return { kept: { requirements, open_questions, conflicts, requirement_updates }, rejected };
}

/** Evidence ids a set of candidates cites (for showing the verifier only what it needs). */
export function citedIds(x: ModelExtraction): Set<string> {
  const ids = [
    ...x.requirements.flatMap((r) => r.evidence_ids),
    ...x.open_questions.flatMap((q) => q.evidence_ids),
    ...x.conflicts.flatMap((c) => [...c.side_a_evidence_ids, ...c.side_b_evidence_ids]),
    ...x.requirement_updates.flatMap((u) => [...u.evidence_ids, u.requirement_id]),
  ];
  return new Set(ids.map((i) => i.trim().toUpperCase()));
}

export function isEmpty(x: ModelExtraction): boolean {
  return !x.requirements.length && !x.open_questions.length && !x.conflicts.length && !x.requirement_updates.length;
}

// ---------- answer crew: claim splitting for the answer verifier ----------

export interface Claim {
  id: string;
  line: number;
  text: string;
}

/**
 * Split a Markdown answer into checkable claims (S1, S2 ...): one per sentence of each paragraph, list item or
 * quote line. Headings, rules, table separators and fragments too short to state anything are skipped.
 */
export function splitClaims(md: string, max = 120): Claim[] {
  const out: Claim[] = [];
  md.split("\n").forEach((raw, line) => {
    const t = raw.trim();
    if (!t || /^#{1,6}\s/.test(t) || /^[-*_]{3,}$/.test(t) || /^\|?\s*:?-{3,}/.test(t)) return;
    const body = t.replace(/^([-*+]|\d+[.)])\s+/, "").replace(/^>\s?/, "");
    for (const s of body.split(/(?<=[.!?])\s+(?=[A-Z*_["(])/)) {
      if (out.length >= max) return;
      if (s.replace(/[*_`[\]()]/g, "").trim().length < 12) continue;
      out.push({ id: `S${out.length + 1}`, line, text: s });
    }
  });
  return out;
}

/** Remove the given claims from the answer; list items and quote lines left empty are dropped. */
export function removeClaims(md: string, claims: Claim[]): string {
  const lines = md.split("\n");
  const touched = new Set<number>();
  for (const c of claims) {
    lines[c.line] = (lines[c.line] ?? "").replace(c.text, "").replace(/[ \t]{2,}/g, " ").replace(/\s+$/, "");
    touched.add(c.line);
  }
  return lines
    .filter((l, i) => !(touched.has(i) && /^\s*(?:[-*+]|\d+[.)]|>)?\s*$/.test(l)))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
