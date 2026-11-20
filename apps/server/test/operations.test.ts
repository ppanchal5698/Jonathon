import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createLogger, DemoExtractiveRuntime, type JonathonApp, loadConfig } from "@jonathon/core";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/server";

const PORT = 49_100 + Math.floor(Math.random() * 800);
const BASE = `http://127.0.0.1:${PORT}`;
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
    const token = app.auth.createMcpToken({ kind: "user", userId: "x", username: "parth" }, { name: "c", projectIds: [pid], scopes: ["read", "propose"] }).token;
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
