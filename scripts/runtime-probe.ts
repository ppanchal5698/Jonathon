/**
 * Operator diagnostic: run ONE real Antigravity turn with Jonathon's exact flags and print the event sequence
 * (types, timings, tool attempts) without printing model text. Sends FICTIONAL text to the model provider.
 *
 *   pnpm tsx scripts/runtime-probe.ts [answer|extraction]
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS, killProcessTree, NdjsonParser, prepareWorkspace, runtimeEnv, writePolicyFiles } from "@jonathon/core";

const schema = (process.argv[2] ?? "answer") as "answer" | "extraction";
const dir = mkdtempSync(join(tmpdir(), "jon-probe-"));
const policy = writePolicyFiles(dir);
if (process.env.PROBE_STRIP) {
  // Experiment: strip count/length keywords from the schema file to see if they stall the CLI.
  const fs = await import("node:fs");
  const p = policy.schemaPath(schema);
  const strip = (v: any): any => (Array.isArray(v) ? v.map(strip) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => !/^(min|max)(Items|Length)$/.test(k)).map(([k, x]) => [k, strip(x)])) : v);
  fs.writeFileSync(p, JSON.stringify(strip(JSON.parse(fs.readFileSync(p, "utf8"))), null, 2));
  console.log("schema stripped of min/max keywords");
}
if (process.env.PROBE_DROP) {
  const fs = await import("node:fs");
  const p = policy.schemaPath(schema);
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  for (const k of process.env.PROBE_DROP.split(",")) {
    delete j.properties[k];
    j.required = j.required.filter((r: string) => r !== k);
  }
  fs.writeFileSync(p, JSON.stringify(j, null, 2));
  console.log("schema without", process.env.PROBE_DROP);
}
const ws = prepareWorkspace(dir, "prj_00000000000000000000probe");
const promptKind = (process.argv[3] ?? schema) as "answer" | "extraction";
const prompt =
  promptKind === "extraction"
    ? `<instructions>\nPropose DRAFT requirements, open questions and conflicts from the evidence. Use empty strings for unknown module, feature_scope or priority.\n</instructions>\n\n<evidence id="E1" authority="source_evidence" title="reqs.md" locator="line 3">\nPasswords must be at least 8 characters long.\n</evidence>\n\n<evidence id="E2" authority="source_evidence" title="rules.xlsx" locator="sheet Business rules, range A2:D2">\nRow 2: Rule = Minimum password length; Value = 12 characters\n</evidence>`
    : `<instructions>\nAnswer from evidence.\n</instructions>\n\n<evidence id="E1" authority="source_evidence" title="doc" locator="line 1">\nCustomers must verify their email.\n</evidence>\n\n<question>\nMust customers verify email?\n</question>`;
const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--agent", AGENTS[schema].name, "--settings", policy.settingsPath, "--json-schema", policy.schemaPath(schema), "--sandbox", "--disable-slash-commands"];
if (process.env.PROBE_EFFORT) args.push("--effort", process.env.PROBE_EFFORT);
if (process.env.PROBE_MODEL) args.push("--model", process.env.PROBE_MODEL);
const started = Date.now();
const t = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const child = spawn(process.env.AGY_PATH ?? "agy", args, { cwd: ws.cwd, env: runtimeEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
const parser = new NdjsonParser(
  (r) => {
    const ev = r as Record<string, any>;
    if (ev.event === "init") console.log(t(), "init", { agent: ev.init?.agent, permission_mode: ev.init?.permission_mode });
    else if (ev.event === "step_update") {
      const s = ev.step_update;
      console.log(t(), "step", s.step_index, s.step_type, s.state, s.tool_name ?? "", s.tool_info?.error?.message?.slice(0, 160) ?? "", s.text_delta ? `(${s.text_delta.length} chars)` : "");
    } else if (ev.event === "result") {
      const res = ev.result;
      console.log(t(), "result", { status: res.status, finished_reason: res.finished_reason, has_structured: res.structured_output != null, num_turns: res.num_turns, denied: res.denied_actions, error: res.error });
      if (res.structured_output) console.log(JSON.stringify(res.structured_output).slice(0, 1500));
    }
  },
  (l) => console.log(t(), "invalid line", l.slice(0, 120)),
);
child.stdout.on("data", (d) => parser.push(d));
child.stderr.on("data", (d) => process.stderr.write(`[stderr] ${String(d).slice(0, 400)}`));
child.on("close", (code) => console.log(t(), "exit", code));
child.stdin.end(`${JSON.stringify({ event: "user", message: { content: prompt } })}\n`);
setTimeout(() => {
  console.log(t(), "probe timeout: killing process tree");
  void killProcessTree(child);
}, Number(process.env.PROBE_TIMEOUT_MS ?? 180_000)).unref();
