/**
 * End-to-end check of a running Docker Compose stack (demo mode), from the HOST, through the published ports only.
 *
 *   pnpm tsx scripts/docker-smoke.ts [--ui http://localhost:3005] [--mcp http://127.0.0.1:4100] [--user smoke-admin]
 *
 * Password: JONATHON_SMOKE_PASSWORD (creates the account on a NEW installation, or signs in to an existing one).
 * Uses only fictional test text. Exits non-zero on the first failed check and prints which one.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1]! : d;
};
const UI = arg("--ui", "http://localhost:3005");
const MCP = arg("--mcp", "http://127.0.0.1:4100");
const USERNAME = arg("--user", "smoke-admin");
const PASSWORD = process.env.JONATHON_SMOKE_PASSWORD;
if (!PASSWORD || PASSWORD.length < 12) {
  console.error("set JONATHON_SMOKE_PASSWORD (12+ characters)");
  process.exit(2);
}

let cookie = "";
let csrf = "";
let passed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) {
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
    process.exit(1);
  }
  passed++;
  console.log(`ok   ${name}`);
}

async function api(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(`${UI}/api/v1${path}`, {
    method,
    headers: {
      origin: UI,
      ...(body !== undefined && !(body instanceof FormData) ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf && method !== "GET" ? { "x-csrf-token": csrf } : {}),
      ...extra,
    },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0]!;
  const json = (await res.json().catch(() => null)) as { data?: any; error?: { code: string; message: string } } | null;
  return { status: res.status, json, headers: res.headers };
}

async function waitIdle(pid: string, ms = 120_000) {
  const end = Date.now() + ms;
  for (;;) {
    const jobs = (await api("GET", `/projects/${pid}/jobs`)).json?.data as { status: string; type: string }[];
    const active = jobs.filter((j) => ["queued", "running", "retrying"].includes(j.status));
    if (!active.length) return jobs;
    if (Date.now() > end) throw new Error(`jobs still active: ${active.map((j) => `${j.type}:${j.status}`).join(",")}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function main() {
  // 1-2. UI reachable; API reachable only through the UI origin's /api/v1 proxy.
  const page = await fetch(`${UI}/`);
  check("UI responds", page.status < 500, `status ${page.status}`);
  const status = await api("GET", "/setup/status");
  check("API proxied through the UI origin", status.status === 200 && typeof status.json?.data?.set_up === "boolean");
  check("demo mode", status.json?.data?.mode === "demo", status.json?.data?.mode);

  // 3. Account, session, CSRF and origin checks.
  const signIn = status.json!.data.set_up
    ? await api("POST", "/auth/login", { username: USERNAME, password: PASSWORD })
    : await api("POST", "/setup/account", { username: USERNAME, password: PASSWORD });
  check("sign in", signIn.status === 200 && !!signIn.json?.data?.csrf_token, JSON.stringify(signIn.json?.error));
  check(
    "session cookie is HttpOnly + SameSite=Strict",
    /HttpOnly/i.test(signIn.headers.get("set-cookie") ?? "") && /SameSite=Strict/i.test(signIn.headers.get("set-cookie") ?? ""),
  );
  csrf = signIn.json!.data.csrf_token;
  const noCsrf = await fetch(`${UI}/api/v1/projects`, { method: "POST", headers: { origin: UI, cookie, "content-type": "application/json" }, body: "{}" });
  check("mutation without CSRF token is rejected", noCsrf.status === 403);
  const evil = await api("POST", "/projects", { name: "x" }, { origin: "http://evil.example" });
  check("cross-origin request is rejected", evil.status === 403 && evil.json?.error?.code === "FORBIDDEN");
  const anon = await fetch(`${UI}/api/v1/projects`);
  check("unauthenticated read is rejected", anon.status === 401);

  // 8. Idempotency keys.
  const key = `smoke-${Date.now()}`;
  const p1 = await api("POST", "/projects", { name: `Smoke ${new Date().toISOString()}`, ai_enabled: true }, { "idempotency-key": key });
  const p2 = await api("POST", "/projects", { name: String(p1.json?.data?.name), ai_enabled: true }, { "idempotency-key": key });
  check(
    "idempotent create replays the same project",
    p1.status === 200 && p2.json?.data?.id === p1.json?.data?.id && p2.headers.get("idempotent-replayed") === "true",
  );
  const p3 = await api("POST", "/projects", { name: "different", ai_enabled: true }, { "idempotency-key": key });
  check("key reuse with a different payload is rejected", p3.status === 422 && p3.json?.error?.code === "IDEMPOTENCY_CONFLICT");
  const pid = p1.json!.data.id as string;

  // 5. Upload → ingestion → draft extraction (demo runtime) → review → graph → documents.
  const form = new FormData();
  const text =
    "# Fictional requirements (smoke test)\n\nCustomers must verify their email address before first sign-in.\n\nInvoices must be downloadable as PDF for 24 months.\n";
  form.append("file", new Blob([text], { type: "text/markdown" }), "smoke-requirements.md");
  const up = await api("POST", `/projects/${pid}/sources`, form);
  check("upload accepted", up.status === 200, JSON.stringify(up.json?.error));
  const dup = await api(
    "POST",
    `/projects/${pid}/sources`,
    (() => {
      const f = new FormData();
      f.append("file", new Blob([text], { type: "text/markdown" }), "smoke-requirements-copy.md");
      return f;
    })(),
  );
  check("identical upload is deduplicated", dup.status === 200);
  const jobs = await waitIdle(pid);
  check(
    "ingest and drafting jobs finished",
    jobs.some((j) => j.type === "ingest" && j.status === "succeeded") && jobs.every((j) => j.status !== "failed"),
    JSON.stringify(jobs.map((j) => `${j.type}:${j.status}`)),
  );
  const sources = (await api("GET", `/projects/${pid}/sources`)).json?.data as unknown[];
  check("one source after duplicate upload", Array.isArray(sources) && sources.length === 1, `got ${sources?.length}`);
  const drafts = ((await api("GET", `/projects/${pid}/entities?type=requirement`)).json?.data ?? []) as {
    human_id: string;
    revision: number;
    status: string;
    approval_valid: boolean;
  }[];
  check("drafts extracted for review", drafts.length > 0 && drafts.every((d) => !d.approval_valid), `${drafts.length} drafts`);
  const req = drafts[0]!;
  const approve = await api("POST", `/projects/${pid}/entities/${req.human_id}/accept`, {
    expected_revision: req.revision,
    confirmation: `approve ${req.human_id}`,
  });
  check("human approval works", approve.status === 200 && approve.json?.data?.entity?.approval_valid === true, JSON.stringify(approve.json?.error));
  const graph = await api("GET", `/projects/${pid}/graph`);
  check("graph overview", graph.status === 200);
  const gen = await api("POST", `/projects/${pid}/documents/generate`, { doc_types: "must_have" });
  check("document generation queued", gen.status === 200, JSON.stringify(gen.json?.error));
  await waitIdle(pid, 180_000);
  const cat = (await api("GET", `/projects/${pid}/documents`)).json?.data as { documents?: unknown[] } | unknown[];
  check("technical documents generated", JSON.stringify(cat).includes("revision"), JSON.stringify(cat).slice(0, 200));

  // 7. Worker heartbeat.
  const health = (await api("GET", "/ops/health")).json?.data as { worker: { alive: boolean } };
  check("worker heartbeat visible", health.worker.alive === true);

  // 4. MCP: scoped bearer token on the loopback MCP port; never through the UI origin; never on REST.
  const tok = (await api("POST", "/mcp/tokens", { name: "smoke", project_ids: [pid], scopes: ["read", "propose"] })).json?.data as {
    token: string;
    id: string;
  };
  check("MCP token created", !!tok?.token);
  const client = new Client({ name: "jonathon-smoke", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${MCP}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tok.token}` } } }));
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check("MCP tools listed", tools.includes("get_requirement") && !tools.some((n) => /approve|accept/.test(n)), tools.join(","));
  const got = (await client.callTool({ name: "get_requirement", arguments: { project_id: pid, requirement_id: req.human_id } })) as { isError?: boolean };
  check("MCP read in scope", !got.isError);
  await client.close();
  // REST lives behind the UI origin; an MCP token is not a REST credential there.
  const restWithBearer = await fetch(`${UI}/api/v1/projects`, { headers: { authorization: `Bearer ${tok.token}` } });
  check("MCP token cannot use the REST API", restWithBearer.status === 401, `status ${restWithBearer.status}`);
  // The published MCP port is the MCP-only listener: it does not serve the REST API at all.
  const restOnMcpPort = await fetch(`${MCP}/api/v1/projects`, { headers: { authorization: `Bearer ${tok.token}` } });
  check("REST API is not served on the MCP port", restOnMcpPort.status === 404, `status ${restOnMcpPort.status}`);
  const mcpViaUi = await fetch(`${UI}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${tok.token}`, "content-type": "application/json" },
    body: "{}",
  });
  check("MCP is not exposed through the UI origin", mcpViaUi.status === 404 || mcpViaUi.status === 405, `status ${mcpViaUi.status}`);
  const noTok = await fetch(`${MCP}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  check("MCP without token is rejected", noTok.status === 401);
  await api("POST", `/mcp/tokens/${tok.id}/revoke`, {});
  const revoked = await fetch(`${MCP}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${tok.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  check("revoked token is rejected", revoked.status === 401);

  console.log(`\n${passed} checks passed. project=${pid}`);
  console.log(`SMOKE_PROJECT_ID=${pid}`);
}

main().catch((e) => {
  console.error(`FAIL unexpected: ${(e as Error).message}`);
  process.exit(1);
});
