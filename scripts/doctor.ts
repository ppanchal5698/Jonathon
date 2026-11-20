/**
 * pnpm run doctor: read-only environment checks. Never prints secrets and never changes project knowledge.
 *
 *   pnpm run doctor               local checks only
 *   pnpm run doctor --provider    also runs `agy models` (contacts the model provider; sends no client content)
 */
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { AntigravityCliRuntime, defaultDataDir, findRepoRoot, loadConfig, loadDotEnv } from "@jonathon/core";

type Status = "ok" | "warn" | "fail" | "skip";
const results: { check: string; status: Status; detail: string }[] = [];
const add = (check: string, status: Status, detail: string) => results.push({ check, status, detail });

async function main() {
  const repo = findRepoRoot();
  loadDotEnv(repo);
  const provider = process.argv.includes("--provider");

  // Node / pnpm
  const [major] = process.versions.node.split(".").map(Number);
  add("Node.js", major! >= 24 ? "ok" : "fail", `v${process.versions.node} (need >= 24 for node:sqlite)`);
  // pnpm sets npm_config_user_agent ("pnpm/12.16.1 ..."); no child process or shell needed.
  const ua = /pnpm\/(\S+)/.exec(process.env.npm_config_user_agent ?? "");
  add("pnpm", ua ? "ok" : "warn", ua ? ua[1]! : "not run through pnpm (use pnpm run doctor)");

  // Config
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
    add("Configuration", "ok", `mode=${config.mode}, bind=${config.host}:${config.port}${config.host === "127.0.0.1" ? " (loopback)" : ""}`);
  } catch (e) {
    add("Configuration", "fail", (e as Error).message);
    return;
  }

  // Storage
  try {
    mkdirSync(config.dataDir, { recursive: true });
    accessSync(config.dataDir, constants.R_OK | constants.W_OK);
    add("Data directory", "ok", `${config.dataDir}${config.dataDir === defaultDataDir() ? " (default)" : ""}`);
  } catch (e) {
    add("Data directory", "fail", `${config.dataDir}: ${(e as Error).message}`);
  }

  // SQLite + FTS5 (in memory; does not open or modify the real database)
  try {
    const db = new DatabaseSync(":memory:");
    const v = (db.prepare("select sqlite_version() v").get() as { v: string }).v;
    db.exec("create virtual table t using fts5(x)");
    db.close();
    add("SQLite / FTS5", "ok", `SQLite ${v}, FTS5 available`);
  } catch (e) {
    add("SQLite / FTS5", "fail", (e as Error).message);
  }
  if (existsSync(config.dbPath)) {
    try {
      const db = new DatabaseSync(config.dbPath, { readOnly: true });
      const m = db.prepare("select count(*) n from schema_migrations").get() as { n: number };
      const users = db.prepare("select count(*) n from users").get() as { n: number };
      db.close();
      add("Database", "ok", `${m.n} migration(s) applied; account ${users.n ? "created" : "not created yet"}`);
    } catch (e) {
      add("Database", "warn", `exists but could not be read: ${(e as Error).message}`);
    }
  } else add("Database", "warn", "not created yet (it is created when the server first starts)");

  // Runtime
  if (config.mode === "demo") {
    add("Antigravity CLI", "skip", "demo mode: no runtime is used");
  } else {
    const rt = new AntigravityCliRuntime({
      dataDir: config.dataDir,
      executable: config.runtime.agyPath,
      timeoutMs: 60_000,
      maxOutputBytes: 1e6,
      maxPromptChars: 1e6,
    });
    const inst = await rt.inspectInstallation();
    add("Antigravity CLI", inst.installed ? "ok" : "fail", inst.installed ? `${inst.executable} ${inst.version}` : (inst.error ?? "not installed"));
    if (inst.installed) {
      const caps = await rt.inspectCapabilities();
      add("Runtime flags", caps.compatible ? "ok" : "fail", caps.compatible ? "all required flags present" : `missing: ${caps.missing.join(", ")}`);
      add("Global agy rule files", caps.globalRuleFiles.length ? "warn" : "ok", caps.globalRuleFiles.length ? `${caps.globalRuleFiles.join(", ")} load into every run` : "none found");
      if (inst.version && inst.version !== "1.5.9") add("Runtime version", "warn", `verified against 1.5.9; installed ${inst.version}. Run pnpm test:live before relying on it.`);
      if (provider) {
        const a = await rt.checkAuthentication();
        add("Antigravity authentication", a.status === "authenticated" ? "ok" : a.status === "auth_required" ? "fail" : "warn", `${a.status}: ${a.detail}`);
      } else add("Antigravity authentication", "skip", "run `pnpm run doctor --provider` (contacts the provider, sends no client content)");
    }
  }

  // Services
  for (const [name, url] of [
    ["API server", `http://127.0.0.1:${config.port}/api/v1/health`],
    ["Web UI", "http://127.0.0.1:3005/login"],
  ] as const) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      add(name, r.ok ? "ok" : "warn", `${url} → HTTP ${r.status}`);
    } catch {
      add(name, "warn", `${url} not reachable (start it with pnpm dev)`);
    }
  }
  if (existsSync(config.dbPath)) {
    try {
      const db = new DatabaseSync(config.dbPath, { readOnly: true });
      const w = db.prepare("select max(last_seen_at) t from worker_heartbeats").get() as { t: string | null };
      db.close();
      const alive = !!w.t && Date.now() - Date.parse(w.t) < 15_000;
      add("Worker", alive ? "ok" : "warn", alive ? "heartbeat is recent" : "no recent heartbeat (start it with pnpm dev)");
    } catch {
      /* reported above */
    }
  }
}

main()
  .catch((e) => add("doctor", "fail", (e as Error).message))
  .finally(() => {
    const icon: Record<Status, string> = { ok: "✔", warn: "!", fail: "✖", skip: "-" };
    for (const r of results) console.log(`${icon[r.status]} ${r.check.padEnd(28)} ${r.detail}`);
    process.exitCode = results.some((r) => r.status === "fail") ? 1 : 0;
  });
