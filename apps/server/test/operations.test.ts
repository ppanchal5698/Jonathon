import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createLogger, DemoExtractiveRuntime, type JonathonApp, loadConfig } from "@jonathon/core";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/server";
import { freePort } from "./free-port";

let PORT = 0;
let BASE = "";
let app: JonathonApp;
let server: FastifyInstance;
let dataDir: string;
let cookie = "";
let csrf = "";

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf && method !== "GET" ? { "x-csrf-token": csrf } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as { data?: any; error?: { code: string; message: string } } | null;
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

beforeAll(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  dataDir = mkdtempSync(join(tmpdir(), "jon-ops-"));
  const config = loadConfig({
    JONATHON_DATA_DIR: dataDir,
    JONATHON_PORT: String(PORT),
    JONATHON_LOG_LEVEL: "silent",
    JONATHON_MODE: "demo",
    JONATHON_ALLOWED_HOSTS: "server:4100",
  } as NodeJS.ProcessEnv);
  app = createApp(config, { runtime: new DemoExtractiveRuntime(), log: createLogger("silent", "t") });
  server = await buildServer(app);
  await server.listen({ host: "127.0.0.1", port: PORT });
  const setup = await fetch(`${BASE}/api/v1/setup/account`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "parth", password: "correct horse battery" }),
  });
  cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0]!;
  csrf = ((await setup.json()) as { data: { csrf_token: string } }).data.csrf_token;
});

afterAll(async () => {
  await server?.close();
  app?.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

describe("container networking", () => {
  it("answers to the configured internal service host and still rejects unknown hosts", async () => {
    expect(await rawGet("/api/v1/health", "server:4100")).toBe(200);
    expect(await rawGet("/api/v1/health", "server:9999")).toBe(403);
    expect(await rawGet("/api/v1/health", "evil.example")).toBe(403);
  });

  it("readiness reports database and storage without leaking paths", async () => {
    const r = await api("GET", "/api/v1/ready");
    expect(r.status).toBe(200);
    expect(r.json?.data).toEqual({ ready: true, database: true, storage: true });
  });
});

describe("Idempotency-Key on REST mutations", () => {
  it("replays the stored response for the same key and payload, and rejects reuse with another payload", async () => {
    const key = "test-key-0001";
    const a = await api("POST", "/api/v1/projects", { name: "Idem A" }, { "idempotency-key": key });
    const b = await api("POST", "/api/v1/projects", { name: "Idem A" }, { "idempotency-key": key });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.json?.data?.id).toBe(a.json?.data?.id);
    expect(b.headers.get("idempotent-replayed")).toBe("true");
    expect((await api("GET", "/api/v1/projects")).json?.data.filter((p: { name: string }) => p.name === "Idem A")).toHaveLength(1);
    const c = await api("POST", "/api/v1/projects", { name: "Idem B" }, { "idempotency-key": key });
    expect(c.status).toBe(422);
    expect(c.json?.error?.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("stores 4xx outcomes, forgets nothing silently, validates keys, and needs the session + CSRF like any mutation", async () => {
    const bad = await api("POST", "/api/v1/projects", { name: "" }, { "idempotency-key": "test-key-0002" });
    const again = await api("POST", "/api/v1/projects", { name: "" }, { "idempotency-key": "test-key-0002" });
    expect(bad.status).toBe(400);
    expect(again.status).toBe(400);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect((await api("POST", "/api/v1/projects", { name: "x" }, { "idempotency-key": "short" })).status).toBe(400);
    const noCsrf = await fetch(`${BASE}/api/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "idempotency-key": "test-key-0003" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(noCsrf.status).toBe(403);
  });

  it("concurrent duplicates execute once: the second sees in-progress or the replay", async () => {
    const key = "test-key-concurrent";
    const results = await Promise.all(
      Array.from({ length: 5 }, () => api("POST", "/api/v1/projects", { name: "Idem Concurrent" }, { "idempotency-key": key })),
    );
    const created = new Set(results.filter((r) => r.status === 200).map((r) => r.json?.data?.id));
    expect(created.size).toBe(1);
    for (const r of results) expect([200, 429]).toContain(r.status);
    expect((await api("GET", "/api/v1/projects")).json?.data.filter((p: { name: string }) => p.name === "Idem Concurrent")).toHaveLength(1);
  });

  it("is refused on multipart uploads (uploads deduplicate by content hash instead)", async () => {
    const pid = (await api("POST", "/api/v1/projects", { name: "Idem Upload" })).json?.data.id;
    const form = new FormData();
    form.append("file", new Blob(["Fictional."], { type: "text/plain" }), "a.txt");
    const r = await fetch(`${BASE}/api/v1/projects/${pid}/sources`, {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "idempotency-key": "upload-key-1" },
      body: form,
    });
    expect(r.status).toBe(400);
  });
});

describe("dead letters and replay over HTTP", () => {
  it("lists dead letters and replays them for the signed-in user only; MCP bearer tokens cannot reach these routes", async () => {
    const pid = (await api("POST", "/api/v1/projects", { name: "DLQ" })).json?.data.id as string;
    const q = app.ctx.queue;
    const job = q.enqueue({ projectId: pid, type: "reindex", payload: {}, createdBy: "t", maxAttempts: 1 });
    q.claim("w", 60_000, ["reindex"]);
    q.fail(job.id, "w", "EXTRACTION_FAILED", "parser crashed on /data/projects/secret.pdf");
    const list = await api("GET", `/api/v1/ops/dead-letters?project_id=${pid}`);
    expect(list.json?.data).toHaveLength(1);
    expect(list.json?.data[0]).toMatchObject({ job_id: job.id, reason: "permanent_error", error_code: "EXTRACTION_FAILED" });
    expect(list.json?.data[0].error_message).not.toContain("secret.pdf");

    const token = app.auth.createMcpToken(
      { kind: "user", userId: "x", username: "parth" },
      { name: "c", projectIds: [pid], scopes: ["read", "propose"] },
    ).token;
    const viaBearer = await fetch(`${BASE}/api/v1/projects/${pid}/jobs/${job.id}/replay`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect(viaBearer.status).toBe(401);
    const noCsrf = await fetch(`${BASE}/api/v1/projects/${pid}/jobs/${job.id}/replay`, { method: "POST", headers: { cookie } });
    expect(noCsrf.status).toBe(403);

    const r1 = await api("POST", `/api/v1/projects/${pid}/jobs/${job.id}/replay`, {});
    expect(r1.json?.data).toMatchObject({ replayed: true, job: { status: "queued" } });
    const r2 = await api("POST", `/api/v1/projects/${pid}/jobs/${job.id}/replay`, {});
    expect(r2.json?.data).toMatchObject({ replayed: false });
    const audits = app.ctx.db.prepare("SELECT actor_kind FROM audit_events WHERE action = 'job.replayed' AND entity_id = ?").all(job.id);
    expect(audits).toEqual([{ actor_kind: "user" }]);
    expect((await api("GET", `/api/v1/ops/dead-letters?project_id=${pid}`)).json?.data).toHaveLength(0);
    const other = (await api("POST", "/api/v1/projects", { name: "DLQ other" })).json?.data.id as string;
    expect((await api("POST", `/api/v1/projects/${other}/jobs/${job.id}/replay`, {})).status).toBe(404);
  });
});

describe("project deletion over HTTP", () => {
  it("needs the session, the CSRF token and the exact phrase; MCP bearer tokens cannot reach it", async () => {
    const pid = (await api("POST", "/api/v1/projects", { name: "Delete Me" })).json?.data.id as string;
    const token = app.auth.createMcpToken(
      { kind: "user", userId: "x", username: "parth" },
      { name: "c", projectIds: [pid], scopes: ["read", "propose"] },
    ).token;
    const viaBearer = await fetch(`${BASE}/api/v1/projects/${pid}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "delete Delete Me" }),
    });
    expect(viaBearer.status).toBe(401);
    const noCsrf = await fetch(`${BASE}/api/v1/projects/${pid}`, {
      method: "DELETE",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "delete Delete Me" }),
    });
    expect(noCsrf.status).toBe(403);
    const wrong = await api("DELETE", `/api/v1/projects/${pid}`, { confirmation: "delete delete me" });
    expect(wrong.json?.error?.code).toBe("CONFIRMATION_REQUIRED");
    const ok = await api("DELETE", `/api/v1/projects/${pid}`, { confirmation: "delete Delete Me" });
    expect(ok.status).toBe(200);
    expect(ok.json?.data).toMatchObject({ deleted: pid, name: "Delete Me" });
    expect((await api("GET", `/api/v1/projects/${pid}`)).status).toBe(404);
    expect((await api("DELETE", `/api/v1/projects/${pid}`, { confirmation: "delete Delete Me" })).status).toBe(404);
  });
});

describe("hardening from the code review", () => {
  it("a malformed session cookie is treated as signed out (401), never a server error", async () => {
    const r = await fetch(`${BASE}/api/v1/projects`, { headers: { cookie: "jon_session=%E0%A4%A" } });
    expect(r.status).toBe(401);
  });

  it("the job status filter is validated and applied before the limit", async () => {
    expect((await api("GET", "/api/v1/jobs?status=not-a-status")).status).toBe(400);
    const pid = (await api("POST", "/api/v1/projects", { name: "Filter" })).json?.data.id as string;
    const q = app.ctx.queue;
    const old = q.enqueue({ projectId: pid, type: "reindex", payload: { n: 0 }, createdBy: "t" });
    app.ctx.db.prepare("UPDATE jobs SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(old.id);
    for (let i = 0; i < 205; i++) {
      const j = q.enqueue({ projectId: pid, type: "reindex", payload: { n: i + 1 }, createdBy: "t" });
      app.ctx.db.prepare("UPDATE jobs SET status = 'succeeded' WHERE id = ?").run(j.id);
    }
    const queued = (await api("GET", "/api/v1/jobs?status=queued")).json?.data as { id: string }[];
    expect(queued.map((j) => j.id)).toContain(old.id);
  });

  it("an MCP token is limited in AI questions in flight and in calls per minute", async () => {
    const pid = (await api("POST", "/api/v1/projects", { name: "MCP limits" })).json?.data.id as string;
    const t = app.auth.createMcpToken({ kind: "user", userId: "x", username: "parth" }, { name: "limits", projectIds: [pid], scopes: ["read"] });
    const mcp = { kind: "mcp_token" as const, tokenId: t.id, name: "limits", projectIds: [pid], scopes: ["read" as const] };
    for (let i = 0; i < app.ctx.config.mcpLimits.maxActiveAsks; i++) await app.answers.ask(mcp, pid, { message: `question ${i}` }, { waitMs: 0 });
    await expect(app.answers.ask(mcp, pid, { message: "one too many" }, { waitMs: 0 })).rejects.toThrow(/questions in progress/);
    // The signed-in person is not limited by MCP quotas.
    await app.answers.ask({ kind: "user", userId: "x", username: "parth" }, pid, { message: "human question" }, { waitMs: 0 });

    const now = new Date().toISOString();
    const ins = app.ctx.db.prepare("INSERT INTO mcp_access_log (id, token_id, at, tool, project_id, outcome) VALUES (?,?,?,?,?, 'ok')");
    for (let i = 0; i < app.ctx.config.mcpLimits.callsPerMinute; i++) ins.run(`mal_t${i}`, t.id, now, "list_projects", null);
    const r = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_projects", arguments: {} } }),
    });
    expect(JSON.stringify(await r.json())).toMatch(/RATE_LIMITED/);
  });

  it("expired sessions, OAuth states and old finished sign-in requests are swept; jobs and audit are kept", () => {
    const db = app.ctx.db;
    const past = "2000-01-01T00:00:00.000Z";
    const user = db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string };
    db.prepare(
      "INSERT INTO sessions (id, user_id, token_hash, csrf_token, created_at, expires_at, last_seen_at) VALUES ('ses_old', ?, 'h_old', 'c', ?, ?, ?)",
    ).run(user.id, past, past, past);
    db.prepare("INSERT INTO oauth_states (state, binder_hash, code_verifier, nonce, created_at, expires_at) VALUES ('s_old','b','v','n',?,?)").run(past, past);
    db.prepare(
      "INSERT INTO runtime_auth_requests (id, action, status, requested_by_id, requested_by_name, created_at, updated_at) VALUES ('rta_old','check','succeeded','x','parth',?,?)",
    ).run(past, past);
    const jobsBefore = (db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n;
    const auditBefore = (db.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number }).n;
    const n = app.ops.sweepExpired();
    expect(n).toMatchObject({ sessions: 1, oauth_states: 1, runtime_auth_requests: 1 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n).toBe(jobsBefore);
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number }).n).toBe(auditBefore);
    expect((db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id <> 'ses_old'").get() as { n: number }).n).toBeGreaterThan(0); // the live session stays
  });
});
