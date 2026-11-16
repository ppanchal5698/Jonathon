import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AntigravityCliRuntime, createApp, createLogger, type JobWorker, type JonathonApp, loadConfig } from "@jonathon/core";
import { FAKE_AGY, seedDemoProject } from "@jonathon/test-fixtures";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/server";

const PORT = 41_000 + Math.floor(Math.random() * 8_000);
const BASE = `http://127.0.0.1:${PORT}`;
let app: JonathonApp;
let server: FastifyInstance;
let worker: JobWorker;
let dataDir: string;
let cookie = "";
let csrf = "";
let demoPid = "";
let otherPid = "";

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(csrf && method !== "GET" ? { "x-csrf-token": csrf } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as { data?: unknown; error?: { code: string } } | null;
  return { status: res.status, json, headers: res.headers };
}

function rawGet(path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: "127.0.0.1", port: PORT, path, method: "GET", headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    r.on("error", reject);
    r.end();
  });
}

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: "jonathon-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return client;
}

function toolJson(r: unknown): { isError?: boolean; body: Record<string, unknown> } {
  const res = r as { isError?: boolean; content: { type: string; text: string }[] };
  return { isError: res.isError, body: JSON.parse(res.content[0]!.text) };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "jon-srv-"));
  const config = loadConfig({ JONATHON_DATA_DIR: dataDir, JONATHON_PORT: String(PORT), JONATHON_LOG_LEVEL: "silent", JONATHON_ASK_WAIT_MS: "0" } as NodeJS.ProcessEnv);
  const runtime = new AntigravityCliRuntime({ dataDir, executable: process.execPath, argsPrefix: [FAKE_AGY, "--scenario", "answer-cite", "--"], timeoutMs: 15_000, maxOutputBytes: 1e6, maxPromptChars: 2e5 });
  app = createApp(config, { runtime, log: createLogger("silent", "t") });
  server = await buildServer(app);
  await server.listen({ host: "127.0.0.1", port: PORT });
  worker = app.startWorker(2);
});

afterAll(async () => {
  await worker?.stop();
  await server?.close();
  app?.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

describe("HTTP API security", () => {
  it("rejects invalid Host headers (DNS rebinding) and cross-site origins", async () => {
    expect(await rawGet("/api/v1/health", "evil.example:80")).toBe(403);
    expect(await rawGet("/api/v1/health", `127.0.0.1:${PORT}`)).toBe(200);
    const r = await api("POST", "/api/v1/auth/login", { username: "x", password: "y" }, { origin: "https://evil.example" });
    expect(r.status).toBe(403);
  });

  it("sets up the single local account, signs in, and requires CSRF for mutations", async () => {
    expect((await api("GET", "/api/v1/setup/status")).json?.data).toMatchObject({ set_up: false });
    const setup = await fetch(`${BASE}/api/v1/setup/account`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "parth", password: "correct horse battery" }) });
    expect(setup.status).toBe(200);
    cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(setup.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Strict/);
    csrf = ((await setup.json()) as { data: { csrf_token: string } }).data.csrf_token;
    expect((await api("POST", "/api/v1/setup/account", { username: "other", password: "another long password" })).json?.error?.code).toBe("ALREADY_SET_UP");
    const noCsrf = await fetch(`${BASE}/api/v1/projects`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "x" }) });
    expect(noCsrf.status).toBe(403);
    expect((await fetch(`${BASE}/api/v1/projects`)).status).toBe(401);
    // After setup, the absolute data path is only shown to the signed-in user.
    const anon = (await (await fetch(`${BASE}/api/v1/setup/status`)).json()) as { data: { data_dir: string | null } };
    expect(anon.data.data_dir).toBeNull();
    expect(((await api("GET", "/api/v1/setup/status")).json!.data as { data_dir: string }).data_dir).toBe(dataDir);
  });

  it("creates projects, uploads multiple files, and serves originals only as downloads", async () => {
    const created = await api("POST", "/api/v1/projects", { name: "Other project", ai_enabled: true });
    otherPid = (created.json!.data as { id: string }).id;
    const form = new FormData();
    form.append("files", new Blob(["Other project secret: codeword KINGFISHER."]), "secret.md");
    form.append("files", new Blob(["<script>alert(1)</script><p>Visible</p>"]), "page.html");
    const up = await fetch(`${BASE}/api/v1/projects/${otherPid}/sources`, { method: "POST", headers: { cookie, "x-csrf-token": csrf }, body: form });
    expect(up.status).toBe(200);
    const results = ((await up.json()) as { data: { revision: { id: string } }[] }).data;
    expect(results).toHaveLength(2);
    const dl = await fetch(`${BASE}/api/v1/projects/${otherPid}/revisions/${results[1]!.revision.id}/original`, { headers: { cookie } });
    expect(dl.headers.get("content-type")).toBe("application/octet-stream");
    expect(dl.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
    const user = { kind: "user" as const, userId: (app.ctx.db.prepare("SELECT id FROM users").get() as { id: string }).id, username: "parth" };
    demoPid = (await seedDemoProject(app, user)).projectId;
  });
});

describe("MCP server (real MCP SDK client over Streamable HTTP)", () => {
  let readToken = "";
  let readTokenId = "";

  it("rejects requests without a valid bearer token", async () => {
    const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(r.status).toBe(401);
  });

  it("issues a project-scoped token shown once and stored only as a hash", async () => {
    const r = await api("POST", "/api/v1/mcp/tokens", { name: "claude-code", project_ids: [demoPid], scopes: ["read"] });
    const d = r.json?.data as { token: string; id: string };
    readToken = d.token;
    readTokenId = d.id;
    expect(readToken).toMatch(/^jon_/);
    const row = app.ctx.db.prepare("SELECT token_hash FROM mcp_tokens WHERE id = ?").get(readTokenId) as { token_hash: string };
    expect(row.token_hash).not.toContain(readToken.slice(4));
    expect(JSON.stringify((await api("GET", "/api/v1/mcp/tokens")).json)).not.toContain(readToken);
  });

  it("lists tools; there is no approval, write or shell tool", async () => {
    const c = await mcpClient(readToken);
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["ask_jonathon", "get_feature_spec", "get_job", "get_requirement", "list_projects", "propose_requirement_change", "search_knowledge"]);
    await c.close();
  });

  it("only exposes authorized projects and isolates others", async () => {
    const c = await mcpClient(readToken);
    const list = toolJson(await c.callTool({ name: "list_projects", arguments: {} }));
    expect((list.body.projects as { id: string }[]).map((p) => p.id)).toEqual([demoPid]);
    const other = toolJson(await c.callTool({ name: "search_knowledge", arguments: { project_id: otherPid, query: "KINGFISHER" } }));
    expect(other.isError).toBe(true);
    expect((other.body.error as { code: string }).code).toBe("PROJECT_NOT_FOUND");
    await c.close();
  });

  it("returns approved requirements and a feature spec with server-side readiness", async () => {
    const c = await mcpClient(readToken);
    const req = toolJson(await c.callTool({ name: "get_requirement", arguments: { project_id: demoPid, requirement_id: "REQ-001" } }));
    expect((req.body.entity as { approval_valid: boolean }).approval_valid).toBe(true);
    const spec = toolJson(await c.callTool({ name: "get_feature_spec", arguments: { project_id: demoPid, feature: "email-verification" } }));
    expect(spec.body.implementation_ready).toBe(false);
    expect(JSON.stringify(spec.body.readiness_reasons)).toContain("QUESTION-001");
    await c.close();
  });

  it("ask_jonathon returns a pending job that get_job resolves (application-level polling), with follow-ups", async () => {
    const c = await mcpClient(readToken);
    const first = toolJson(await c.callTool({ name: "ask_jonathon", arguments: { project_id: demoPid, message: "Must customers verify their email before signing in?", feature_scope: "email-verification", request_id: "mcp-req-0001" } }));
    expect(first.body.status).toBe("pending");
    let answer: Record<string, unknown> | undefined;
    for (let i = 0; i < 60 && !answer; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const j = toolJson(await c.callTool({ name: "get_job", arguments: { project_id: demoPid, job_id: first.body.job_id } }));
      answer = j.body.answer as Record<string, unknown> | undefined;
    }
    expect(answer).toBeDefined();
    expect(answer!.citations).not.toEqual([]);
    expect(answer!.implementation_ready).toBe(false);
    // Idempotent: same request_id → same job, no duplicate turn.
    const replay = toolJson(await c.callTool({ name: "ask_jonathon", arguments: { project_id: demoPid, message: "Must customers verify their email before signing in?", request_id: "mcp-req-0001" } }));
    expect(replay.body.conversation_id).toBe(answer!.conversation_id);
    const convs = app.answers.listConversations({ kind: "user", userId: "x", username: "x" }, demoPid);
    expect(convs.filter((cv) => cv.owner_kind === "mcp_token")).toHaveLength(1);
    await c.close();
  });

  it("read-only tokens cannot propose; propose-scoped tokens can, idempotently", async () => {
    const c = await mcpClient(readToken);
    const denied = toolJson(await c.callTool({ name: "propose_requirement_change", arguments: { project_id: demoPid, requirement_id: "REQ-001", base_revision: 2, proposed_change: "Add rate limit.", rationale: "Abuse.", request_id: "prop-0001" } }));
    expect((denied.body.error as { code: string }).code).toBe("FORBIDDEN");
    await c.close();
    const t2 = (await api("POST", "/api/v1/mcp/tokens", { name: "claude-propose", project_ids: [demoPid], scopes: ["read", "propose"] })).json?.data as { token: string };
    const c2 = await mcpClient(t2.token);
    const rev = (toolJson(await c2.callTool({ name: "get_requirement", arguments: { project_id: demoPid, requirement_id: "REQ-001" } })).body.entity as { revision: number }).revision;
    const ok = toolJson(await c2.callTool({ name: "propose_requirement_change", arguments: { project_id: demoPid, requirement_id: "REQ-001", base_revision: rev, proposed_change: "Add rate limit.", rationale: "Abuse.", request_id: "prop-0002" } }));
    expect(ok.body.proposal_id).toMatch(/^CHANGE-\d{3}$/);
    await c2.close();
  });

  it("revoked tokens stop working immediately and access is logged", async () => {
    expect((await api("POST", `/api/v1/mcp/tokens/${readTokenId}/revoke`, {})).status).toBe(200);
    await expect(mcpClient(readToken).then((c) => c.listTools())).rejects.toThrow();
    const log = (await api("GET", `/api/v1/mcp/tokens/${readTokenId}/access`)).json?.data as { tool: string; outcome: string }[];
    expect(log.some((l) => l.tool === "search_knowledge" && l.outcome === "error")).toBe(true);
  });
});
