import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const EnvSchema = z.object({
  JONATHON_MODE: z.enum(["live", "demo"]).default("live"),
  JONATHON_DATA_DIR: z.string().optional(),
  JONATHON_HOST: z.string().default("127.0.0.1"),
  JONATHON_PORT: z.coerce.number().int().default(4100),
  JONATHON_WEB_ORIGINS: z.string().default("http://127.0.0.1:3000,http://localhost:3000"),
  JONATHON_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(12),
  JONATHON_MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(500).default(50),
  JONATHON_ASK_WAIT_MS: z.coerce.number().int().min(0).max(60_000).default(25_000),
  JONATHON_LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  JONATHON_ALLOW_REMOTE: bool.default(false),
  JONATHON_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  JONATHON_PARSER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),

  AGY_PATH: z.string().default("agy"),
  AGY_MODEL: z
    .string()
    .regex(/^[a-zA-Z0-9._-]{1,80}$/)
    .optional(),
  AGY_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  /** Draft extraction ran for 4+ minutes at the default effort on agy 1.5.9 and finished in ~14 s at "low" (live probe). */
  AGY_EXTRACTION_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max", "default"]).default("low"),
  AGY_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(30 * 60_000).default(240_000),
  AGY_MAX_OUTPUT_BYTES: z.coerce.number().int().min(64_000).default(4 * 1024 * 1024),
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
  runtime: {
    agyPath: string;
    /** Extra leading args; used by tests to run a fixture script through `node`. */
    agyArgsPrefix: string[];
    model: string | undefined;
    effort: string | undefined;
    extractionEffort: string | undefined;
    timeoutMs: number;
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
  if (!e.JONATHON_ALLOW_REMOTE && !["127.0.0.1", "localhost", "::1"].includes(e.JONATHON_HOST)) {
    throw new Error(
      `JONATHON_HOST=${e.JONATHON_HOST} is not loopback. Set JONATHON_ALLOW_REMOTE=true only behind a TLS reverse proxy.`,
    );
  }
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
    runtime: {
      agyPath: e.AGY_PATH,
      agyArgsPrefix: e.JONATHON_ALLOW_TEST_HOOKS && e.AGY_ARGS_PREFIX_JSON ? z.array(z.string()).parse(JSON.parse(e.AGY_ARGS_PREFIX_JSON)) : [],
      model: e.AGY_MODEL,
      effort: e.AGY_EFFORT,
      extractionEffort: e.AGY_EXTRACTION_EFFORT === "default" ? undefined : e.AGY_EXTRACTION_EFFORT,
      timeoutMs: e.AGY_TIMEOUT_MS,
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
