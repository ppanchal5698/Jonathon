import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createLogger, DemoExtractiveRuntime, GoogleSignIn, type JonathonApp, loadConfig, redactUrl } from "@jonathon/core";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/server";

let PORT = 0;
let BASE = "";
/** Ask the OS for a free port (fixed ranges can fall into Windows' reserved port ranges). */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
const CLIENT_ID = "1234-test.apps.googleusercontent.com";
const AUTH_URL = "https://accounts.example.test/auth";
const TOKEN_URL = "https://oauth.example.test/token";

let app: JonathonApp;
let server: FastifyInstance;
let dataDir: string;
/** What the simulated Google returns for the next token request. */
let nextIdentity: Record<string, unknown> = {};
let tokenRequests: URLSearchParams[] = [];

const jwt = (claims: Record<string, unknown>) =>
  `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

const fakeGoogle: typeof fetch = async (url, init) => {
  if (String(url) !== TOKEN_URL) throw new Error(`unexpected fetch ${url}`);
  const body = new URLSearchParams(String(init?.body));
  tokenRequests.push(body);
  if (body.get("code") === "bad-code") return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
  return new Response(JSON.stringify({ access_token: "ya29.x", id_token: jwt(nextIdentity) }), { status: 200, headers: { "content-type": "application/json" } });
};

async function start(): Promise<{ state: string; nonce: string; binder: string; location: URL }> {
  const r = await fetch(`${BASE}/api/v1/auth/google/start`, { redirect: "manual" });
  expect(r.status).toBe(302);
  const location = new URL(r.headers.get("location")!);
  const cookie = r.headers.get("set-cookie")!;
  expect(cookie).toMatch(/^jon_oauth=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600/);
  return { state: location.searchParams.get("state")!, nonce: location.searchParams.get("nonce")!, binder: cookie.split(";")[0]!.split("=")[1]!, location };
}

async function callback(q: Record<string, string>, binder?: string, headers: Record<string, string> = {}) {
  const r = await fetch(`${BASE}/api/v1/auth/google/callback?${new URLSearchParams(q)}`, {
    redirect: "manual",
    headers: { "sec-fetch-site": "cross-site", ...(binder ? { cookie: `jon_oauth=${binder}` } : {}), ...headers },
  });
  const html = await r.text();
  const to = /url=([^"]+)"/.exec(html)?.[1] ?? "";
  const session = (r.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("jon_session="));
  return { status: r.status, to: decodeURIComponent(to), session: session?.split(";")[0], csp: r.headers.get("content-security-policy") };
}

const identity = (nonce: string, over: Record<string, unknown> = {}) => ({
  iss: "https://accounts.google.com",
  aud: CLIENT_ID,
  azp: CLIENT_ID,
  sub: "google-sub-owner",
  email: "Owner@Example.com",
  email_verified: true,
  nonce,
  exp: Math.floor(Date.now() / 1000) + 3600,
  ...over,
});

beforeAll(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  dataDir = mkdtempSync(join(tmpdir(), "jon-google-"));
  const config = loadConfig({
    JONATHON_DATA_DIR: dataDir,
    JONATHON_PORT: String(PORT),
    JONATHON_LOG_LEVEL: "silent",
    JONATHON_MODE: "demo",
    JONATHON_WEB_ORIGINS: "http://localhost:3005,http://127.0.0.1:3005",
    JONATHON_GOOGLE_CLIENT_ID: CLIENT_ID,
    JONATHON_GOOGLE_CLIENT_SECRET: "test-secret-value",
    JONATHON_ALLOW_TEST_HOOKS: "true",
    JONATHON_GOOGLE_AUTH_URL: AUTH_URL,
    JONATHON_GOOGLE_TOKEN_URL: TOKEN_URL,
  } as NodeJS.ProcessEnv);
  app = createApp(config, { runtime: new DemoExtractiveRuntime(), log: createLogger("silent", "t"), fetch: fakeGoogle });
  server = await buildServer(app);
  await server.listen({ host: "127.0.0.1", port: PORT });
});

afterAll(async () => {
  await server?.close();
  app?.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

describe("Sign in with Google as the only way in", () => {
  it("turns the username/password routes off and tells the UI", async () => {
    const st = (await (await fetch(`${BASE}/api/v1/setup/status`)).json()) as { data: { auth: string; set_up: boolean } };
    expect(st.data).toMatchObject({ auth: "google", set_up: false });
    for (const path of ["/api/v1/setup/account", "/api/v1/auth/login"]) {
      const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "parth", password: "correct horse battery" }) });
      expect(r.status).toBe(403);
    }
  });

  it("sends the browser to Google with PKCE, state, nonce and the exact redirect URI", async () => {
    const s = await start();
    expect(`${s.location.origin}${s.location.pathname}`).toBe(AUTH_URL);
    expect(Object.fromEntries(s.location.searchParams)).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: "http://localhost:3005/api/v1/auth/google/callback",
      response_type: "code",
      scope: "openid email",
      code_challenge_method: "S256",
    });
    expect(s.location.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.location.searchParams.has("client_secret")).toBe(false);
  });

  it("rejects a callback from another browser, a replayed state, a wrong audience, a wrong nonce and an unverified email", async () => {
    let s = await start();
    nextIdentity = identity(s.nonce);
    expect((await callback({ state: s.state, code: "c1" }, "someone-elses-binder")).to).toMatch(/^\/login\?error=.*another browser/);
    // The state was consumed by that attempt: even the right browser cannot reuse it.
    expect((await callback({ state: s.state, code: "c1" }, s.binder)).to).toMatch(/expired or was already used/);

    s = await start();
    nextIdentity = identity(s.nonce, { aud: "other.apps.googleusercontent.com", azp: "other.apps.googleusercontent.com" });
    expect((await callback({ state: s.state, code: "c2" }, s.binder)).to).toMatch(/different application/);

    s = await start();
    nextIdentity = identity("not-the-nonce");
    expect((await callback({ state: s.state, code: "c3" }, s.binder)).to).toMatch(/does not belong to this sign-in/);

    s = await start();
    nextIdentity = identity(s.nonce, { email_verified: false });
    expect((await callback({ state: s.state, code: "c4" }, s.binder)).to).toMatch(/not verified/);

    s = await start();
    expect((await callback({ state: s.state, code: "bad-code" }, s.binder)).to).toMatch(/Google rejected the sign-in/);
    expect((await callback({ error: "access_denied" })).to).toMatch(/cancelled/);
    expect(app.auth.isSetUp()).toBe(false);
  });

  it("the first Google sign-in creates the owner; afterwards only that Google account gets in", async () => {
    tokenRequests = [];
    let s = await start();
    nextIdentity = identity(s.nonce);
    const first = await callback({ state: s.state, code: "good-1" }, s.binder);
    expect(first.status).toBe(200);
    expect(first.to).toBe("/setup");
    expect(first.csp).not.toMatch(/sandbox/); // the continue page must navigate as the UI origin
    expect(first.session).toMatch(/^jon_session=/);
    // The token request carried the PKCE verifier and the secret on the back channel only.
    expect(tokenRequests[0]!.get("code_verifier")).toMatch(/.{43,}/);
    expect(tokenRequests[0]!.get("client_secret")).toBe("test-secret-value");

    const me = (await (await fetch(`${BASE}/api/v1/auth/session`, { headers: { cookie: first.session! } })).json()) as { data: { username: string; csrf_token: string } };
    expect(me.data.username).toBe("owner@example.com");
    // A normal mutation with that session + CSRF works.
    const created = await fetch(`${BASE}/api/v1/projects`, {
      method: "POST",
      headers: { cookie: first.session!, "x-csrf-token": me.data.csrf_token, "content-type": "application/json" },
      body: JSON.stringify({ name: "After Google sign-in" }),
    });
    expect(created.status).toBe(200);

    s = await start();
    nextIdentity = identity(s.nonce);
    const again = await callback({ state: s.state, code: "good-2" }, s.binder);
    expect(again.to).toBe("/");

    s = await start();
    nextIdentity = identity(s.nonce, { sub: "google-sub-intruder", email: "intruder@example.com" });
    const other = await callback({ state: s.state, code: "good-3" }, s.binder);
    expect(other.to).toMatch(/belongs to another Google account/);
    expect(other.session).toBeUndefined();

    const users = app.ctx.db.prepare("SELECT username, password_hash, google_sub, email FROM users").all();
    expect(users).toEqual([{ username: "owner@example.com", password_hash: "!", google_sub: "google-sub-owner", email: "owner@example.com" }]);
    const audit = app.ctx.db.prepare("SELECT action, details FROM audit_events WHERE action IN ('account.created','session.login')").all() as { action: string; details: string }[];
    expect(audit.map((a) => a.action)).toEqual(["account.created", "session.login", "session.login"]);
    expect(JSON.stringify(audit)).not.toMatch(/ya29|test-secret|good-/);
  });

  it("only the Google callback is exempt from the cross-site check", async () => {
    const r = await fetch(`${BASE}/api/v1/projects`, { headers: { "sec-fetch-site": "cross-site" } });
    expect(r.status).toBe(403);
    const cb = await fetch(`${BASE}/api/v1/auth/google/callback?error=access_denied`, { headers: { "sec-fetch-site": "cross-site" } });
    expect(cb.status).toBe(200);
    const post = await fetch(`${BASE}/api/v1/auth/google/callback`, { method: "POST", headers: { "sec-fetch-site": "cross-site" } });
    expect(post.status).toBe(403);
  });

  it("never logs the authorization code or state from the callback URL", () => {
    expect(redactUrl("/api/v1/auth/google/callback?state=abc123&iss=https%3A%2F%2Faccounts.google.com&code=4%2F0AUn6Hd8&scope=email")).toBe(
      "/api/v1/auth/google/callback?state=[redacted]&iss=https%3A%2F%2Faccounts.google.com&code=[redacted]&scope=email",
    );
    expect(redactUrl("/api/v1/projects?status=open")).toBe("/api/v1/projects?status=open");
  });

  it("uses the registered redirect path on the public UI origin", () => {
    const c = loadConfig({
      JONATHON_DATA_DIR: tmpdir(),
      JONATHON_WEB_ORIGINS: "http://127.0.0.1:6969,http://localhost:6969",
      JONATHON_PUBLIC_URL: "http://localhost:6969",
      JONATHON_GOOGLE_REDIRECT_PATH: "/oauth2callback",
      JONATHON_GOOGLE_CLIENT_ID: CLIENT_ID,
      JONATHON_GOOGLE_CLIENT_SECRET: "test-secret-value",
    } as NodeJS.ProcessEnv);
    expect(c.google?.redirectUri).toBe("http://localhost:6969/oauth2callback");
    expect(() =>
      loadConfig({
        JONATHON_DATA_DIR: tmpdir(),
        JONATHON_GOOGLE_REDIRECT_PATH: "/somewhere-else",
        JONATHON_GOOGLE_CLIENT_ID: CLIENT_ID,
        JONATHON_GOOGLE_CLIENT_SECRET: "test-secret-value",
      } as NodeJS.ProcessEnv),
    ).toThrow();
  });

  it("JONATHON_GOOGLE_ALLOWED_EMAILS restricts even the first sign-in", () => {
    const config = loadConfig({
      JONATHON_DATA_DIR: mkdtempSync(join(tmpdir(), "jon-google-allow-")),
      JONATHON_LOG_LEVEL: "silent",
      JONATHON_WEB_ORIGINS: "http://localhost:3005",
      JONATHON_GOOGLE_CLIENT_ID: CLIENT_ID,
      JONATHON_GOOGLE_CLIENT_SECRET: "test-secret-value",
      JONATHON_GOOGLE_ALLOWED_EMAILS: "me@example.com",
    } as NodeJS.ProcessEnv);
    const a2 = createApp(config, { runtime: new DemoExtractiveRuntime(), log: createLogger("silent", "t") });
    try {
      const g = new GoogleSignIn(a2.ctx.db, config, a2.auth);
      expect(() => (g as unknown as { bindOwner(i: { sub: string; email: string }): unknown }).bindOwner({ sub: "x", email: "someone@example.com" })).toThrow(/not allowed/);
      expect(a2.auth.isSetUp()).toBe(false);
    } finally {
      a2.close();
    }
    expect(() =>
      loadConfig({
        JONATHON_DATA_DIR: tmpdir(),
        JONATHON_WEB_ORIGINS: "http://localhost:3005",
        JONATHON_GOOGLE_CLIENT_ID: CLIENT_ID,
        JONATHON_GOOGLE_CLIENT_SECRET: "test-secret-value",
        JONATHON_GOOGLE_AUTH_URL: "https://evil.example",
      } as NodeJS.ProcessEnv),
    ).toThrow(/tests only/);
  });
});
