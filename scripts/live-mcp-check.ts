/**
 * LIVE end-to-end check of the Phase 1 slice in a THROWAWAY data directory:
 *   real API + worker processes (live mode, real `agy`) → upload a FICTIONAL document → enable AI →
 *   create an MCP token → official MCP client calls ask_jonathon → poll get_job → print the cited answer.
 * Sends fictional text to the model provider. Leaves your real data directory untouched.
 *
 *   pnpm tsx scripts/live-mcp-check.ts
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRepoRoot, killProcessTree } from "@jonathon/core";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const repo = findRepoRoot();
const data = mkdtempSync(join(tmpdir(), "jon-live-"));
const PORT = 4197;
const env = {
  ...process.env,
  JONATHON_DATA_DIR: data,
  JONATHON_PORT: String(PORT),
  JONATHON_LOG_LEVEL: "warn",
  JONATHON_MODE: "live",
  JONATHON_ASK_WAIT_MS: "5000",
};
const B = `http://127.0.0.1:${PORT}/api/v1`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const kids: ChildProcess[] = [];
const start = (file: string) => {
  const c = spawn(process.execPath, [join(repo, "node_modules/tsx/dist/cli.mjs"), file], {
    cwd: join(repo, "apps/server"),
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  kids.push(c);
};

async function main() {
  start("src/main.ts");
  start("src/worker.ts");
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${B}/health`)).ok) break;
    } catch {}
    await sleep(500);
  }
  const s = await fetch(`${B}/setup/account`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "parth", password: "live check password" }),
  });
  const h = { cookie: s.headers.get("set-cookie")!.split(";")[0]!, "x-csrf-token": ((await s.json()) as any).data.csrf_token };
  const json = { ...h, "content-type": "application/json" };
  const pid = (
    (await (
      await fetch(`${B}/projects`, { method: "POST", headers: json, body: JSON.stringify({ name: "Live check (fictional)", ai_enabled: true }) })
    ).json()) as any
  ).data.id;
  const fd = new FormData();
  fd.append("files", new Blob([readFileSync(join(repo, "packages/test-fixtures/demo/01-initial-requirements.md"))]), "01-initial-requirements.md");
  fd.append("files", new Blob([readFileSync(join(repo, "packages/test-fixtures/demo/02-follow-up-email.eml"))]), "02-follow-up-email.eml");
  await fetch(`${B}/projects/${pid}/sources`, { method: "POST", headers: h, body: fd });
  for (let i = 0; i < 40; i++) {
    const srcs = ((await (await fetch(`${B}/projects/${pid}/sources`, { headers: h })).json()) as any).data;
    if (srcs.every((x: any) => x.current?.extraction_status !== "pending")) break;
    await sleep(500);
  }
  const tok = (
    (await (
      await fetch(`${B}/mcp/tokens`, { method: "POST", headers: json, body: JSON.stringify({ name: "live-check", project_ids: [pid], scopes: ["read"] }) })
    ).json()) as any
  ).data.token;

  const client = new Client({ name: "jonathon-live-check", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tok}` } } }),
  );
  const call = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: args })) as any).content[0].text);
  console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));
  const t0 = Date.now();
  let r = await call("ask_jonathon", {
    project_id: pid,
    message: "How long is the email verification link valid, and must customers verify their email before signing in?",
    feature_scope: "email-verification",
    request_id: "live-check-0001",
  });
  console.log("first response status:", r.status);
  while (r.status === "pending" && Date.now() - t0 < 300_000) {
    await sleep(3_000);
    const j = await call("get_job", { project_id: pid, job_id: r.job_id });
    if (j.answer) r = j.answer;
    else if (["failed", "cancelled"].includes(j.job?.status)) throw new Error(`job ${j.job.status}: ${j.job.error_code} ${j.job.error_message}`);
  }
  console.log(
    JSON.stringify(
      {
        seconds: (Date.now() - t0) / 1000,
        status: r.status,
        provider: r.runtime?.provider,
        runtime_version: r.runtime?.runtime_version,
        answer: r.answer_markdown,
        citations: r.citations?.map((c: any) => ({
          id: c.citation_id,
          doc: c.document_title,
          locator: c.locator,
          check: c.support_check,
          authority: c.authority,
        })),
        unresolved: r.unresolved_questions,
        ready: r.implementation_ready,
        reasons: r.readiness_reasons,
        warnings: r.warnings,
      },
      null,
      2,
    ),
  );
  const f = await call("ask_jonathon", {
    project_id: pid,
    message: "So can we implement link expiry now?",
    conversation_id: r.conversation_id,
    feature_scope: "email-verification",
    request_id: "live-check-0002",
  });
  let f2 = f;
  while (f2.status === "pending" && Date.now() - t0 < 600_000) {
    await sleep(3_000);
    const j = await call("get_job", { project_id: pid, job_id: f.job_id });
    if (j.answer) f2 = j.answer;
    else if (["failed", "cancelled"].includes(j.job?.status)) throw new Error(`follow-up job ${j.job.status}: ${j.job.error_code}`);
  }
  console.log(
    JSON.stringify(
      {
        followup_status: f2.status,
        same_conversation: f2.conversation_id === r.conversation_id,
        context_rebuilt: f2.runtime?.context_rebuilt,
        ready: f2.implementation_ready,
        answer: f2.answer_markdown,
      },
      null,
      2,
    ),
  );
  await client.close();
}

main()
  .catch((e) => {
    console.error("LIVE CHECK FAILED:", (e as Error).message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.all(kids.map((k) => killProcessTree(k)));
    await sleep(500);
    rmSync(data, { recursive: true, force: true, maxRetries: 3 });
  });
