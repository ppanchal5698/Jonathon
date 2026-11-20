import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AntigravityCliRuntime, clearAgySignIn, createApp, createLogger, extractGoogleAuthUrl, type JonathonApp, loadConfig, type RuntimeAuthAgent } from "@jonathon/core";
import { afterEach, describe, expect, it } from "vitest";
import { FAKE_AGY } from "../../test-fixtures/src/index";
import { SYSTEM, tempDir, USER } from "./helpers";

const MCP = { kind: "mcp_token" as const, tokenId: "tok_x", name: "claude", projectIds: [] as string[], scopes: ["read", "propose"] as ("read" | "propose")[] };

let app: JonathonApp | undefined;
let agent: RuntimeAuthAgent | undefined;
afterEach(async () => {
  await agent?.stop();
  agent = undefined;
  app?.close();
  app = undefined;
});

/** A "Docker" app: live mode, runtime in the worker, a dedicated agy home, and the fixture CLI as agy. */
function dockerLike(scenario = "signin", opts: { managed?: boolean } = {}) {
  const dataDir = tempDir();
  const home = tempDir("jon-agy-home-");
  const config = loadConfig({ JONATHON_DATA_DIR: dataDir, JONATHON_LOG_LEVEL: "silent", JONATHON_MODE: "live" } as NodeJS.ProcessEnv);
  config.runtimeInWorker = opts.managed ?? true;
  config.agyHome = opts.managed === false ? null : home;
  const runtime = new AntigravityCliRuntime({
    dataDir,
    executable: process.execPath,
    argsPrefix: [FAKE_AGY, "--scenario", scenario, "--"],
    timeoutMs: 15_000,
    maxOutputBytes: 1e6,
    maxPromptChars: 2e5,
    extraEnv: { HOME: home, USERPROFILE: home },
    signInPty: false,
  });
  app = createApp(config, { runtime, log: createLogger("silent", "t") });
  app.ctx.db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, created_at) VALUES (?,?,?,?)").run(USER.userId, USER.username, "x", new Date().toISOString());
  return { app, home, runtime };
}

async function until<T>(fn: () => T | undefined | false, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
}
const settled = (a: JonathonApp, id: string) => until(() => {
  const r = a.runtimeAuth.get(USER, id);
  return ["succeeded", "failed", "cancelled", "expired"].includes(r.status) ? r : undefined;
});
const storedCode = (a: JonathonApp, id: string) => (a.ctx.db.prepare("SELECT code FROM runtime_auth_requests WHERE id = ?").get(id) as { code: string | null }).code;

describe("Sign in with Google for agy in the Docker worker", () => {
  it("signs in with the pasted code, rejects a wrong code, and signs out again", async () => {
    const { app: a, home } = dockerLike();
    agent = a.startRuntimeAuthAgent();
    const tokenFile = join(home, ".fake-agy", "oauth_tokens.json");

    // A wrong code: Google answers invalid_grant; nothing is stored.
    const bad = a.runtimeAuth.request(USER, "sign_in");
    const waiting = await until(() => {
      const r = a.runtimeAuth.get(USER, bad.id);
      return r.status === "awaiting_code" ? r : undefined;
    });
    expect(new URL(waiting.auth_url!).hostname).toBe("accounts.google.com");
    expect(Date.parse(waiting.expires_at!) - Date.now()).toBeGreaterThan(40_000);
    expect(() => a.runtimeAuth.submitCode(USER, bad.id, "not a code")).toThrow(/whole authorization code/);
    a.runtimeAuth.submitCode(USER, bad.id, "4/0Awrong-fixture-code");
    expect(() => a.runtimeAuth.submitCode(USER, bad.id, "4/0Asecond-attempt-code")).toThrow(/not waiting/);
    const r1 = await settled(a, bad.id);
    expect(r1).toMatchObject({ status: "failed", error_code: "REJECTED", auth_url: null });
    expect(storedCode(a, bad.id)).toBeNull();
    expect(existsSync(tokenFile)).toBe(false);

    // The right code: agy stores its tokens in the dedicated home; the runtime reports a sign-in.
    const good = a.runtimeAuth.request(USER, "sign_in");
    await until(() => a.runtimeAuth.get(USER, good.id).status === "awaiting_code");
    a.runtimeAuth.submitCode(USER, good.id, "4/0Agood-fixture-code");
    const r2 = await settled(a, good.id);
    expect(r2.status).toBe("succeeded");
    expect(storedCode(a, good.id)).toBeNull();
    expect(existsSync(tokenFile)).toBe(true);
    expect(a.runtimeAuth.status(USER).runtime?.auth).toMatchObject({ status: "authenticated" });

    // Sign out: the stored sign-in is removed and agy reports "please sign in" again.
    const out = a.runtimeAuth.request(USER, "sign_out");
    const r3 = await settled(a, out.id);
    expect(r3).toMatchObject({ status: "succeeded", detail: "signed out" });
    expect(existsSync(tokenFile)).toBe(false);
    expect(a.runtimeAuth.status(USER).runtime?.auth).toMatchObject({ status: "auth_required" });

    const actions = (a.ctx.db.prepare("SELECT action, actor_kind FROM audit_events WHERE action LIKE 'runtime.%' ORDER BY at").all() as { action: string; actor_kind: string }[]).map((x) => x.action);
    expect(actions).toEqual(["runtime.sign_in_requested", "runtime.sign_in_failed", "runtime.sign_in_requested", "runtime.signed_in", "runtime.sign_out_requested", "runtime.signed_out"]);
    // The code and the link never reach the audit log.
    expect(JSON.stringify(a.ctx.db.prepare("SELECT details FROM audit_events").all())).not.toMatch(/fixture-code|accounts\.google/);
  });

  it("only the signed-in human can start, answer or cancel a sign-in; one request at a time", () => {
    const { app: a } = dockerLike();
    expect(() => a.runtimeAuth.request(SYSTEM, "sign_in")).toThrow(/only the signed-in human/);
    expect(() => a.runtimeAuth.request({ ...MCP }, "sign_out")).toThrow(/only the signed-in human/);
    const r = a.runtimeAuth.request(USER, "sign_in");
    expect(a.runtimeAuth.request(USER, "sign_out").id).toBe(r.id); // the active request is returned, not a second one
    expect(() => a.runtimeAuth.submitCode(SYSTEM, r.id, "4/0Agood-fixture-code")).toThrow(/only the signed-in human/);
    expect(() => a.runtimeAuth.cancel({ ...MCP }, r.id)).toThrow(/only the signed-in human/);
    expect(() => a.runtimeAuth.status({ ...MCP })).toThrow(/only the signed-in human/);
    expect(a.runtimeAuth.cancel(USER, r.id).status).toBe("cancelled");
  });

  it("an unanswered link expires, the agy process is stopped, and the request is closed", async () => {
    const { app: a } = dockerLike();
    agent = a.startRuntimeAuthAgent();
    const r = a.runtimeAuth.request(USER, "sign_in");
    await until(() => a.runtimeAuth.get(USER, r.id).status === "awaiting_code");
    a.ctx.db.prepare("UPDATE runtime_auth_requests SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), r.id);
    const done = await settled(a, r.id);
    expect(done.status).toBe("expired");
    expect(done.auth_url).toBeNull();
    expect(() => a.runtimeAuth.submitCode(USER, r.id, "4/0Agood-fixture-code")).toThrow(/not waiting/);
  });

  it("is refused where Jonathon does not own agy's home (native install, demo mode)", () => {
    const { app: a } = dockerLike("signin", { managed: false });
    expect(a.runtimeAuth.status(USER).available).toBe(false);
    expect(() => a.runtimeAuth.request(USER, "sign_in")).toThrow(/Docker worker/);
    expect(() => a.runtimeAuth.request(USER, "sign_out")).toThrow(/Docker worker/);
    expect(() => loadConfig({ JONATHON_DATA_DIR: tempDir(), JONATHON_AGY_HOME: "/home/agy" } as NodeJS.ProcessEnv)).toThrow(/only valid inside a container/);
  });

  it("only Google's OAuth endpoint is ever shown as the sign-in link", async () => {
    expect(extractGoogleAuthUrl("visit https://evil.example/o/oauth2/auth?client_id=x&code_challenge=y\n")).toBeNull();
    expect(extractGoogleAuthUrl("visit https://accounts.google.com.evil.example/o/oauth2/auth?client_id=x&code_challenge=y\n")).toBeNull();
    expect(extractGoogleAuthUrl("https://accounts.google.com/o/oauth2/auth?client_id=x\n")).toBeNull(); // no PKCE challenge
    expect(extractGoogleAuthUrl("\x1b[1mhttps://accounts.google.com/o/oauth2/auth?client_id=x&code_challenge=y\x1b[0m\r\n")).toBe(
      "https://accounts.google.com/o/oauth2/auth?client_id=x&code_challenge=y",
    );
    const { runtime } = dockerLike("signin-evil-url");
    let shown = false;
    const out = await runtime.signIn({ onUrl: () => (shown = true), waitForCode: () => new Promise(() => {}), timeoutMs: 1500 });
    expect(shown).toBe(false);
    expect(out.ok).toBe(false);
  });

  it("sign-out only touches agy's own files inside the dedicated home", () => {
    const home = tempDir("jon-agy-home-");
    mkdirSync(join(home, ".gemini", "antigravity-cli", "conversations"), { recursive: true });
    writeFileSync(join(home, ".gemini", "antigravity-cli", "conversations", "c1.pb"), "transcript");
    mkdirSync(join(home, ".config", "antigravity"), { recursive: true });
    writeFileSync(join(home, ".config", "antigravity", "plugin-secrets.json"), "{}");
    writeFileSync(join(home, ".gemini", "antigravity-cli", "oauth_tokens.json"), "{}");
    writeFileSync(join(home, "notes.txt"), "unrelated");
    const removed = clearAgySignIn(home, false).sort();
    expect(removed).toEqual([".config/antigravity", ".gemini/antigravity-cli/oauth_tokens.json"]);
    expect(existsSync(join(home, ".gemini", "antigravity-cli", "conversations", "c1.pb"))).toBe(true);
    expect(existsSync(join(home, "notes.txt"))).toBe(true);
    expect(clearAgySignIn(home, true)).toEqual([".gemini"]);
    expect(existsSync(join(home, "notes.txt"))).toBe(true);
    expect(() => clearAgySignIn("/", true)).toThrow();
    expect(() => clearAgySignIn("relative/dir", true)).toThrow();
  });
});
