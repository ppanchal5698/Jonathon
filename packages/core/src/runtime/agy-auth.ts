import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { AppError } from "../util";
import { killProcessTree, treeSpawnOptions } from "./process-tree";

/**
 * Google sign-in for the Antigravity CLI inside Jonathon's Docker worker (verified with agy 1.5.13 on linux/amd64):
 *
 *  - Unauthenticated, in print mode, with stdin a terminal, agy prints a Google OAuth URL (PKCE; redirect to
 *    antigravity.google/oauth-callback, which shows an authorization code), then reads the code from the terminal for
 *    60 s. With stdin a pipe it refuses instead ("Run 'antigravity' to log in"). So the sign-in run gets a
 *    pseudo-terminal from util-linux `script`; Jonathon types the code the person pastes into the UI.
 *  - Without a D-Bus session bus agy keeps its tokens in files under $HOME ("Using file-based token storage because no
 *    D-Bus session bus detected"). The worker's $HOME is a dedicated Docker volume, so the sign-in survives restarts and
 *    never sits in the client-data volume or the image.
 *  - The person signs in on Google's own page in their own browser. Jonathon never sees the Google password; it only
 *    relays the one-time code, which is useless without the PKCE verifier held by the agy process.
 */

/** Only Google's OAuth authorization endpoint may be shown to the person as a sign-in link. */
export function extractGoogleAuthUrl(text: string): string | null {
  const m = /https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s"'<>\\]+/.exec(stripAnsi(text));
  if (!m) return null;
  try {
    const u = new URL(m[0]);
    if (u.protocol !== "https:" || u.hostname !== "accounts.google.com" || !u.pathname.startsWith("/o/oauth2/")) return null;
    if (!u.searchParams.get("client_id") || !u.searchParams.get("code_challenge")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

// Terminal escape sequences (CSI and OSC), which is exactly what stripAnsi removes.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the purpose
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the purpose
const OSC = /\x1b\][^\x07]*\x07/g;

export function stripAnsi(s: string): string {
  return s.replace(CSI, "").replace(OSC, "").replace(/\r/g, "");
}

/** Authorization codes from Google's OAuth flow: printable, no whitespace. */
export const AUTH_CODE_RE = /^[A-Za-z0-9/_.~-]{10,512}$/;

/** Quote one argument for the POSIX shell that `script -c` uses. */
function shQuote(a: string): string {
  return `'${a.replace(/'/g, `'\\''`)}'`;
}

export interface SignInOptions {
  executable: string;
  argsPrefix?: string[];
  /** Empty runtime workspace holding only Jonathon's agent files. */
  cwd: string;
  /** Session-only deny settings and the tool-free agent: if sign-in succeeds and the probe prompt starts, it can do nothing. */
  settingsPath: string;
  agentName: string;
  env: NodeJS.ProcessEnv;
  /** Wrap in a pseudo-terminal (util-linux `script`). Off only for the test fixture, which reads the code from a pipe. */
  usePty: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  onUrl: (url: string) => void;
  /** Resolves with the code the person pasted; rejects on cancel/expiry. Called once, after onUrl. */
  waitForCode: (signal: AbortSignal) => Promise<string>;
}

export type SignInOutcome = { ok: true } | { ok: false; code: "REJECTED" | "TIMEOUT" | "NO_URL" | "FAILED" | "CANCELLED"; message: string };

/**
 * Run one sign-in session. Never logs or returns the URL's secrets, the code, or the raw terminal output (the PTY
 * echoes the code). Kills the whole process tree when done: after a successful sign-in agy would go on to run the probe
 * prompt, which is not needed.
 */
export function runAgySignIn(o: SignInOptions): Promise<SignInOutcome> {
  const agyArgs = [
    ...(o.argsPrefix ?? []),
    "-p",
    "Reply with the single word OK.",
    "--output-format",
    "stream-json",
    "--agent",
    o.agentName,
    "--settings",
    o.settingsPath,
    "--sandbox",
    "--disable-slash-commands",
  ];
  const cmd = o.usePty ? "script" : o.executable;
  // `script -c` runs the command line with /bin/sh. Every element is a fixed literal or a configured path, each
  // single-quoted; nothing from the person or the network is placed on the command line (the code goes to the terminal).
  const args = o.usePty ? ["-qfec", [o.executable, ...agyArgs].map(shQuote).join(" "), "/dev/null"] : agyArgs;
  return new Promise((resolvePromise) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd: o.cwd,
        shell: false,
        env: { ...o.env, SHELL: "/bin/sh", TERM: "dumb", COLUMNS: "4096", LINES: "50" },
        stdio: ["pipe", "pipe", "pipe"],
        ...treeSpawnOptions(),
      });
    } catch (e) {
      resolvePromise({ ok: false, code: "FAILED", message: `could not start agy: ${(e as Error).message}` });
      return;
    }
    let settled = false;
    let buf = "";
    let urlSent = false;
    let codeSent = false;
    const codeAbort = new AbortController();
    const finish = (r: SignInOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      codeAbort.abort();
      buf = "";
      void killProcessTree(child).then(() => resolvePromise(r));
    };
    const timer = setTimeout(() => finish({ ok: false, code: "TIMEOUT", message: "sign-in timed out; start again" }), o.timeoutMs);
    const onAbort = () => finish({ ok: false, code: "CANCELLED", message: "sign-in cancelled" });
    o.signal?.addEventListener("abort", onAbort, { once: true });

    const onData = (d: Buffer) => {
      if (settled) return;
      buf = (buf + d.toString("utf8")).slice(-64_000);
      const text = stripAnsi(buf);
      if (!urlSent) {
        const url = extractGoogleAuthUrl(text);
        if (url && /\n/.test(text.slice(text.indexOf("https://accounts.google.com")))) {
          urlSent = true;
          o.onUrl(url);
          o.waitForCode(codeAbort.signal).then(
            (code) => {
              if (settled) return;
              if (!AUTH_CODE_RE.test(code)) return finish({ ok: false, code: "REJECTED", message: "that does not look like an authorization code" });
              codeSent = true;
              child.stdin?.write(`${code}${o.usePty ? "\r" : "\n"}`);
            },
            (e: Error) => finish({ ok: false, code: "CANCELLED", message: e.message || "sign-in cancelled" }),
          );
        }
      }
      if (/"event"\s*:\s*"init"/.test(text) || (codeSent && /authenticat(ion|ed) (succeeded|successful)|successfully (logged|signed) in/i.test(text))) {
        return finish({ ok: true });
      }
      if (/invalid_grant/.test(text))
        return finish({
          ok: false,
          code: "REJECTED",
          message: "Google rejected the code (it expired, was already used, or was copied incompletely). Start again.",
        });
      if (/Run '?antigravity'? to log in/i.test(text))
        return finish({ ok: false, code: "NO_URL", message: "agy did not offer an interactive sign-in (no terminal)" });
      if (/authentication (failed|interrupted)|timed out/i.test(text)) {
        return finish({
          ok: false,
          code: urlSent && !codeSent ? "TIMEOUT" : "FAILED",
          message: urlSent && !codeSent ? "the code was not entered in time; start again" : "agy reported that authentication failed",
        });
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => finish({ ok: false, code: "FAILED", message: `could not start agy: ${e.message}` }));
    child.on("close", () =>
      finish(
        urlSent
          ? { ok: false, code: "FAILED", message: "agy exited before sign-in completed" }
          : { ok: false, code: "NO_URL", message: "agy exited without offering a sign-in link" },
      ),
    );
  });
}

/**
 * Remove agy's stored sign-in from a home directory that Jonathon owns (the worker's dedicated volume). Deletes the
 * credential and account stores; keeps nothing else agy needs to re-authenticate. Callers verify the result with an
 * authentication check (agy must then report "please sign in").
 *
 * thorough=false: credential-looking files and agy's config/secret stores.
 * thorough=true : everything agy keeps under $HOME (.gemini, .config/antigravity, .cache/antigravity), which also
 *                 removes its local conversation transcripts.
 */
export function clearAgySignIn(home: string, thorough: boolean): string[] {
  if (!isAbsolute(home) || resolve(home) === resolve("/") || !existsSync(home)) throw new AppError("VALIDATION_FAILED", "the agy home directory is not usable");
  const root = resolve(home);
  const removed: string[] = [];
  const rm = (p: string) => {
    const abs = resolve(p);
    if (abs === root || !(abs.startsWith(root + sep) || abs.startsWith(`${root}/`))) return;
    if (!existsSync(abs)) return;
    rmSync(abs, { recursive: true, force: true });
    removed.push(relative(root, abs).split(sep).join("/"));
  };
  if (thorough) {
    for (const p of [".gemini", join(".config", "antigravity"), join(".cache", "antigravity"), join(".local", "share", "antigravity")]) rm(join(root, p));
    return removed;
  }
  rm(join(root, ".config", "antigravity"));
  const CRED = /(token|cred|oauth|account|secret|auth|keyring)/i;
  const walk = (dir: string, depth: number) => {
    if (depth > 5) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(dir, name);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (name === "conversations" || name === "brain") continue; // transcripts, not credentials
        walk(p, depth + 1);
      } else if (CRED.test(name)) rm(p);
    }
  };
  walk(root, 0);
  return removed;
}
