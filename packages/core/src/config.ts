import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

const bool = z.union([z.boolean(), z.string()]).transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

/** Docker Compose passes unset variables as "": treat that as not set. */
const emptyAsUnset = z
  .string()
  .optional()
  .transform((v) => (v?.trim() ? v.trim() : undefined));

const EnvSchema = z.object({
  JONATHON_MODE: z.enum(["live", "demo"]).default("live"),
  JONATHON_DATA_DIR: z.string().optional(),
  JONATHON_HOST: z.string().default("127.0.0.1"),
  JONATHON_PORT: z.coerce.number().int().default(4100),
  JONATHON_WEB_ORIGINS: z.string().default("http://127.0.0.1:3005,http://localhost:3005"),
  JONATHON_SESSION_TTL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(12),
  JONATHON_MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(500).default(50),
  JONATHON_ASK_WAIT_MS: z.coerce.number().int().min(0).max(60_000).default(25_000),
  JONATHON_LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  JONATHON_ALLOW_REMOTE: bool.default(false),
  JONATHON_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  JONATHON_PARSER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),
  /** Queue reliability (see docs/operations.md, "Job queue"). */
  JONATHON_JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
  JONATHON_JOB_BACKOFF_BASE_MS: z.coerce.number().int().min(100).max(600_000).default(2_000),
  JONATHON_JOB_BACKOFF_MAX_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(24 * 3_600_000)
    .default(300_000),
  JONATHON_MAX_ACTIVE_JOBS: z.coerce.number().int().min(10).max(1_000_000).default(10_000),
  JONATHON_JOB_LEASE_MS: z.coerce.number().int().min(5_000).max(600_000).default(30_000),
  /** Optional hard cap on every job's deadline (each type has its own default; see jobs/worker.ts). */
  JONATHON_JOB_DEADLINE_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(24 * 3_600_000)
    .optional(),
  /**
   * Container deployments only. The API must listen on 0.0.0.0 inside its container so the web container can reach
   * it; host exposure is decided by the Compose port binding (127.0.0.1 only). Honoured only when a container marker
   * file exists (/.dockerenv or /run/.containerenv), so it cannot open a bare-metal install to the network.
   */
  JONATHON_CONTAINER: bool.default(false),
  /** Extra Host header values the API answers to (e.g. the internal service name "server:4100" used by the web proxy). */
  JONATHON_ALLOWED_HOSTS: z.string().default(""),
  /** MCP URL shown when a token is created (the host-side address when the port is remapped, e.g. in Docker). */
  JONATHON_MCP_PUBLIC_URL: z
    .string()
    .regex(/^https?:\/\/[^\s/]+\/mcp$/)
    .optional(),
  /**
   * Folder import allowlist: comma-separated absolute directories. When set, only folders inside one of them can be
   * scanned or imported. Containers set this to the read-only import mount (/imports).
   */
  JONATHON_IMPORT_ROOTS: z.string().default(""),
  /**
   * Refuse to start unless the data directory already holds Jonathon's marker file (.jonathon-data). Prevents a missing
   * bind mount from silently starting an empty installation. The one-shot init service creates the marker only when
   * JONATHON_INIT_NEW_DATA_DIR=true is given explicitly.
   */
  JONATHON_REQUIRE_EXISTING_DATA: bool.default(false),
  /**
   * Separate MCP listener. When set, the API serves REST on JONATHON_PORT and MCP (plus health) on this port only, so the
   * MCP port can be published to Claude Code without exposing /api/v1. Unset: one listener serves both (native default).
   */
  JONATHON_MCP_PORT: z.preprocess((v) => (typeof v === "string" && !v.trim() ? undefined : v), z.coerce.number().int().min(1).max(65_535).optional()),
  /**
   * Where agy's policy files and empty working folders live (default: the data directory). Docker points this at a
   * tmpfs, so no client-data path appears in agy's working directory or arguments.
   */
  JONATHON_RUNTIME_DIR: emptyAsUnset,
  /** MCP abuse limits per token: AI questions in flight, and tool calls per minute. */
  JONATHON_MCP_MAX_ACTIVE_ASKS: z.coerce.number().int().min(1).max(50).default(3),
  JONATHON_MCP_CALLS_PER_MINUTE: z.coerce.number().int().min(10).max(10_000).default(120),
  /** Docker: the API container has no agy; runtime diagnostics and authentication checks are answered by the worker. */
  JONATHON_RUNTIME_IN_WORKER: bool.default(false),
  /**
   * Docker worker only: agy's $HOME, a volume Jonathon owns. Enables "Sign in with Google" / "Sign out" for agy. Honoured
   * only inside a container, so Jonathon can never sign a person's own desktop agy out.
   */
  JONATHON_AGY_HOME: z.string().optional(),
  /**
   * Sign in with Google (OpenID Connect) for Jonathon itself. When a client id is set, Google is the ONLY way to sign in:
   * the username/password routes are refused. Create a "Web application" OAuth client in Google Cloud Console with the
   * redirect URI <JONATHON_PUBLIC_URL>/api/v1/auth/google/callback.
   */
  JONATHON_GOOGLE_CLIENT_ID: emptyAsUnset.pipe(
    z
      .string()
      .regex(/^[0-9A-Za-z._-]+\.apps\.googleusercontent\.com$/, "must be a Google OAuth client id (…apps.googleusercontent.com)")
      .optional(),
  ),
  JONATHON_GOOGLE_CLIENT_SECRET: emptyAsUnset.pipe(z.string().min(8).max(200).optional()),
  /**
   * Path of the redirect URI registered in Google Cloud Console, on the UI origin. "/oauth2callback" is proxied by the UI
   * to the API's callback (apps/web/next.config.ts).
   */
  JONATHON_GOOGLE_REDIRECT_PATH: emptyAsUnset.pipe(z.enum(["/api/v1/auth/google/callback", "/oauth2callback"]).default("/api/v1/auth/google/callback")),
  /** Required with Sign in with Google: the Google accounts (comma-separated emails) that may sign in. */
  JONATHON_GOOGLE_ALLOWED_EMAILS: z.string().default(""),
  /** The browser-facing UI origin, used for the OAuth redirect URI. Default: the first JONATHON_WEB_ORIGINS entry. */
  JONATHON_PUBLIC_URL: emptyAsUnset.pipe(
    z
      .string()
      .regex(/^https?:\/\/[^\s/]+$/, "must be an origin such as http://localhost:3005")
      .optional(),
  ),
  /** TESTING ONLY (needs JONATHON_ALLOW_TEST_HOOKS): Google endpoints for a simulated provider. */
  JONATHON_GOOGLE_AUTH_URL: z.string().optional(),
  JONATHON_GOOGLE_TOKEN_URL: z.string().optional(),

  AGY_PATH: z.string().default("agy"),
  AGY_MODEL: z
    .string()
    .regex(/^[a-zA-Z0-9._-]{1,80}$/)
    .optional(),
  AGY_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  /** Draft extraction ran for 4+ minutes at the default effort on agy 1.5.9 and finished in ~14 s at "low" (live probe). */
  AGY_EXTRACTION_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max", "default"]).default("low"),
  /** Most agy processes at once (team agents run in parallel; extra runs wait for a slot). */
  AGY_MAX_CONCURRENT: z.coerce.number().int().min(1).max(16).default(4),
  /** Team workflow: specialist agents plus verifiers. Off = the earlier single-agent drafting and unverified answers. */
  JONATHON_AGENT_TEAM: bool.default(true),
  AGY_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(30 * 60_000)
    .default(240_000),
  AGY_MAX_OUTPUT_BYTES: z.coerce
    .number()
    .int()
    .min(64_000)
    .default(4 * 1024 * 1024),
  AGY_MAX_PROMPT_CHARS: z.coerce.number().int().min(10_000).max(2_000_000).default(200_000),
  JONATHON_RETRIEVAL_ITERATIONS: z.coerce.number().int().min(0).max(3).default(2),
  JONATHON_REPAIR_ATTEMPTS: z.coerce.number().int().min(0).max(2).default(1),
  /** Evidence chunks given to the model per question. */
  JONATHON_CONTEXT_CHUNKS: z.coerce.number().int().min(1).max(60).default(16),
  JONATHON_CONTEXT_MAX_CHARS: z.coerce.number().int().min(2_000).max(400_000).default(60_000),
  JONATHON_HISTORY_TURNS: z.coerce.number().int().min(0).max(20).default(6),
  /** TESTING ONLY: lets e2e tests run the fixture CLI through `node`. Ignored unless JONATHON_ALLOW_TEST_HOOKS=true. */
  AGY_ARGS_PREFIX_JSON: z.string().optional(),
  JONATHON_ALLOW_TEST_HOOKS: bool.default(false),
});

export type JonathonConfig = {
  mode: "live" | "demo";
  repoRoot: string;
  dataDir: string;
  dbPath: string;
  host: string;
  port: number;
  webOrigins: string[];
  allowRemote: boolean;
  sessionTtlHours: number;
  maxUploadBytes: number;
  askWaitMs: number;
  logLevel: z.infer<typeof EnvSchema>["JONATHON_LOG_LEVEL"];
  workerConcurrency: number;
  parserTimeoutMs: number;
  queue: { maxAttempts: number; backoffBaseMs: number; backoffMaxMs: number; maxActiveJobs: number; leaseMs: number; maxDeadlineMs: number | undefined };
  container: boolean;
  allowedHosts: string[];
  mcpPublicUrl: string;
  importRoots: string[];
  requireExistingData: boolean;
  runtimeInWorker: boolean;
  /** Separate MCP listener port, or null for one listener serving REST and MCP. */
  mcpPort: number | null;
  /** Root for runtime-policy/ and runtime-workspaces/ (defaults to dataDir). */
  runtimeDir: string;
  mcpLimits: { maxActiveAsks: number; callsPerMinute: number };
  /** Set only inside a container: the dedicated agy home whose sign-in Jonathon manages. */
  agyHome: string | null;
  /** Set when Sign in with Google is configured; then it is the only sign-in method. */
  google: { clientId: string; clientSecret: string; allowedEmails: string[]; redirectUri: string; authUrl: string; tokenUrl: string } | null;
  runtime: {
    agyPath: string;
    /** Extra leading args; used by tests to run a fixture script through `node`. */
    agyArgsPrefix: string[];
    model: string | undefined;
    effort: string | undefined;
    extractionEffort: string | undefined;
    timeoutMs: number;
    maxConcurrent: number;
    agentTeam: boolean;
    maxOutputBytes: number;
    maxPromptChars: number;
    retrievalIterations: number;
    repairAttempts: number;
  };
  retrieval: { contextChunks: number; contextMaxChars: number; historyTurns: number };
};

/** Walk upward from `start` to the directory holding pnpm-workspace.yaml. */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

/** Load `<repo>/.env` into process.env (does not override values already set). */
export function loadDotEnv(repoRoot = findRepoRoot()): void {
  const p = join(repoRoot, ".env");
  if (existsSync(p)) process.loadEnvFile(p);
}

export function defaultDataDir(): string {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(base, "Jonathon");
  }
  const xdg = process.env.XDG_DATA_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "share"), "jonathon");
}

function googleConfig(e: z.infer<typeof EnvSchema>, env: NodeJS.ProcessEnv): JonathonConfig["google"] {
  if (!e.JONATHON_GOOGLE_CLIENT_ID) {
    if (e.JONATHON_GOOGLE_CLIENT_SECRET) throw new Error("JONATHON_GOOGLE_CLIENT_SECRET is set but JONATHON_GOOGLE_CLIENT_ID is not");
    return null;
  }
  if (!e.JONATHON_GOOGLE_CLIENT_SECRET) throw new Error("JONATHON_GOOGLE_CLIENT_ID is set but JONATHON_GOOGLE_CLIENT_SECRET is missing");
  const origins = e.JONATHON_WEB_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const publicUrl = e.JONATHON_PUBLIC_URL ?? origins.find((o) => o.includes("localhost")) ?? origins[0];
  if (!publicUrl) throw new Error("set JONATHON_PUBLIC_URL for the Google redirect URI");
  if (!origins.includes(publicUrl)) throw new Error(`JONATHON_PUBLIC_URL (${publicUrl}) must be one of JONATHON_WEB_ORIGINS`);
  const allowedEmails = e.JONATHON_GOOGLE_ALLOWED_EMAILS.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  // Without a list, whoever signs in first would own the install. Make the owner explicit.
  if (!allowedEmails.length)
    throw new Error("JONATHON_GOOGLE_ALLOWED_EMAILS is required with Sign in with Google: list the Google account(s) that may sign in");
  for (const a of allowedEmails)
    if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(a)) throw new Error(`JONATHON_GOOGLE_ALLOWED_EMAILS entry "${a}" is not an email address`);
  const testHooks = e.JONATHON_ALLOW_TEST_HOOKS;
  if (!testHooks && (env.JONATHON_GOOGLE_AUTH_URL || env.JONATHON_GOOGLE_TOKEN_URL)) throw new Error("Google endpoint overrides are for tests only");
  return {
    clientId: e.JONATHON_GOOGLE_CLIENT_ID,
    clientSecret: e.JONATHON_GOOGLE_CLIENT_SECRET,
    allowedEmails,
    redirectUri: `${publicUrl}${e.JONATHON_GOOGLE_REDIRECT_PATH}`,
    authUrl: (testHooks && e.JONATHON_GOOGLE_AUTH_URL) || "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: (testHooks && e.JONATHON_GOOGLE_TOKEN_URL) || "https://oauth2.googleapis.com/token",
  };
}

function mcpPort(e: z.infer<typeof EnvSchema>): number | null {
  if (e.JONATHON_MCP_PORT === undefined) return null;
  if (e.JONATHON_MCP_PORT === e.JONATHON_PORT) throw new Error("JONATHON_MCP_PORT must differ from JONATHON_PORT");
  return e.JONATHON_MCP_PORT;
}

function runtimeDir(raw: string | undefined, dataDir: string): string {
  if (!raw) return dataDir;
  if (!isAbsolute(raw) || resolve(raw) === resolve("/")) throw new Error("JONATHON_RUNTIME_DIR must be an absolute directory");
  return resolve(raw);
}

function agyHome(raw: string | undefined, container: boolean): string | null {
  const v = raw?.trim();
  if (!v) return null;
  if (!container) throw new Error("JONATHON_AGY_HOME is only valid inside a container (it lets Jonathon sign agy in and out).");
  if (!isAbsolute(v) || resolve(v) === resolve("/")) throw new Error("JONATHON_AGY_HOME must be an absolute directory");
  return resolve(v);
}

/** True inside a Docker or Podman container. */
export function isContainer(): boolean {
  return existsSync("/.dockerenv") || existsSync("/run/.containerenv");
}

/** Marker written into a data directory that Jonathon initialised on purpose (see JONATHON_REQUIRE_EXISTING_DATA). */
export const DATA_DIR_MARKER = ".jonathon-data";

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, repoRoot = findRepoRoot()): JonathonConfig {
  const e = EnvSchema.parse(env);
  const rawDir = e.JONATHON_DATA_DIR?.trim();
  const dataDir = rawDir ? (isAbsolute(rawDir) ? rawDir : resolve(repoRoot, rawDir)) : defaultDataDir();
  if (isInside(resolve(dataDir), resolve(repoRoot)) && env.JONATHON_ALLOW_DATA_IN_REPO !== "true") {
    throw new Error(
      `JONATHON_DATA_DIR (${dataDir}) is inside the source repository. Client material must live outside it. ` +
        "Choose another directory (the default is your user data folder).",
    );
  }
  const container = e.JONATHON_CONTAINER && isContainer();
  if (e.JONATHON_CONTAINER && !container) {
    throw new Error("JONATHON_CONTAINER=true is only valid inside a container (no /.dockerenv or /run/.containerenv found).");
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(e.JONATHON_HOST);
  const containerBind = container && ["0.0.0.0", "::"].includes(e.JONATHON_HOST);
  if (!e.JONATHON_ALLOW_REMOTE && !loopback && !containerBind) {
    throw new Error(`JONATHON_HOST=${e.JONATHON_HOST} is not loopback. Set JONATHON_ALLOW_REMOTE=true only behind a TLS reverse proxy.`);
  }
  const importRoots = e.JONATHON_IMPORT_ROOTS.split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  for (const r of importRoots) if (!isAbsolute(r)) throw new Error(`JONATHON_IMPORT_ROOTS entry "${r}" must be an absolute path`);
  const allowedHosts = e.JONATHON_ALLOWED_HOSTS.split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  for (const h of allowedHosts)
    if (!/^[a-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-f:]+\](:\d{1,5})?$/.test(h)) throw new Error(`JONATHON_ALLOWED_HOSTS entry "${h}" is not a host[:port]`);
  return {
    mode: e.JONATHON_MODE,
    repoRoot,
    dataDir,
    dbPath: join(dataDir, e.JONATHON_MODE === "demo" ? "jonathon-demo.sqlite" : "jonathon.sqlite"),
    host: e.JONATHON_HOST,
    port: e.JONATHON_PORT,
    webOrigins: e.JONATHON_WEB_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    allowRemote: e.JONATHON_ALLOW_REMOTE,
    sessionTtlHours: e.JONATHON_SESSION_TTL_HOURS,
    maxUploadBytes: e.JONATHON_MAX_UPLOAD_MB * 1024 * 1024,
    askWaitMs: e.JONATHON_ASK_WAIT_MS,
    logLevel: e.JONATHON_LOG_LEVEL,
    workerConcurrency: e.JONATHON_WORKER_CONCURRENCY,
    parserTimeoutMs: e.JONATHON_PARSER_TIMEOUT_MS,
    queue: {
      maxAttempts: e.JONATHON_JOB_MAX_ATTEMPTS,
      backoffBaseMs: e.JONATHON_JOB_BACKOFF_BASE_MS,
      backoffMaxMs: Math.max(e.JONATHON_JOB_BACKOFF_MAX_MS, e.JONATHON_JOB_BACKOFF_BASE_MS),
      maxActiveJobs: e.JONATHON_MAX_ACTIVE_JOBS,
      leaseMs: e.JONATHON_JOB_LEASE_MS,
      maxDeadlineMs: e.JONATHON_JOB_DEADLINE_MS,
    },
    container,
    allowedHosts,
    mcpPublicUrl: e.JONATHON_MCP_PUBLIC_URL ?? `http://127.0.0.1:${e.JONATHON_MCP_PORT ?? e.JONATHON_PORT}/mcp`,
    importRoots: importRoots.map((r) => resolve(r)),
    requireExistingData: e.JONATHON_REQUIRE_EXISTING_DATA,
    runtimeInWorker: e.JONATHON_RUNTIME_IN_WORKER,
    mcpPort: mcpPort(e),
    runtimeDir: runtimeDir(e.JONATHON_RUNTIME_DIR, dataDir),
    mcpLimits: { maxActiveAsks: e.JONATHON_MCP_MAX_ACTIVE_ASKS, callsPerMinute: e.JONATHON_MCP_CALLS_PER_MINUTE },
    agyHome: agyHome(e.JONATHON_AGY_HOME, container),
    google: googleConfig(e, env),
    runtime: {
      agyPath: e.AGY_PATH,
      agyArgsPrefix: e.JONATHON_ALLOW_TEST_HOOKS && e.AGY_ARGS_PREFIX_JSON ? z.array(z.string()).parse(JSON.parse(e.AGY_ARGS_PREFIX_JSON)) : [],
      model: e.AGY_MODEL,
      effort: e.AGY_EFFORT,
      extractionEffort: e.AGY_EXTRACTION_EFFORT === "default" ? undefined : e.AGY_EXTRACTION_EFFORT,
      timeoutMs: e.AGY_TIMEOUT_MS,
      maxConcurrent: e.AGY_MAX_CONCURRENT,
      agentTeam: e.JONATHON_AGENT_TEAM,
      maxOutputBytes: e.AGY_MAX_OUTPUT_BYTES,
      maxPromptChars: e.AGY_MAX_PROMPT_CHARS,
      retrievalIterations: e.JONATHON_RETRIEVAL_ITERATIONS,
      repairAttempts: e.JONATHON_REPAIR_ATTEMPTS,
    },
    retrieval: {
      contextChunks: e.JONATHON_CONTEXT_CHUNKS,
      contextMaxChars: e.JONATHON_CONTEXT_MAX_CHARS,
      historyTurns: e.JONATHON_HISTORY_TURNS,
    },
  };
}

/**
 * Startup guard for deployments where the data directory is a mount (Docker). When JONATHON_REQUIRE_EXISTING_DATA is
 * on, refuse to run against a directory that does not carry the marker: an unmounted or mistyped volume would
 * otherwise start an empty installation silently, and the user would believe their data was gone.
 */
export function assertDataDirReady(config: JonathonConfig): void {
  if (!config.requireExistingData) return;
  if (!existsSync(join(config.dataDir, DATA_DIR_MARKER))) {
    throw new Error(
      `Data directory ${config.dataDir} has no ${DATA_DIR_MARKER} marker. The data mount is missing or points to the wrong folder. ` +
        "Check JONATHON_HOST_DATA_DIR, or initialise a NEW data directory once with the init service and JONATHON_INIT_NEW_DATA_DIR=true.",
    );
  }
}
