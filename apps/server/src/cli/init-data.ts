/**
 * One-shot initialisation (the Compose `init` service, or `pnpm data:init`). Runs before the API and worker start.
 *
 *  1. Refuses to guess about the data directory:
 *     - marker present                      → existing Jonathon data; continue.
 *     - no marker, but Jonathon data exists → adopt it (write the marker); nothing is moved or rewritten.
 *     - empty / unknown directory           → stop with an error UNLESS JONATHON_INIT_NEW_DATA_DIR=true. A missing bind
 *                                              mount therefore fails loudly instead of starting an empty installation.
 *  2. Applies pending forward-only migrations (additive; each in its own transaction). Nothing is deleted or reset.
 *  3. Checks that the directory is writable by this (non-root) user and that SQLite has FTS5.
 */
import { accessSync, constants, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR_MARKER, hasFts5, loadConfig, loadDotEnv, openDatabase } from "@jonathon/core";

function fail(msg: string): never {
  console.error(`init: ${msg}`);
  process.exit(1);
}

loadDotEnv();
const config = loadConfig();
const dir = config.dataDir;
const marker = join(dir, DATA_DIR_MARKER);
const allowNew = ["1", "true", "yes"].includes((process.env.JONATHON_INIT_NEW_DATA_DIR ?? "").toLowerCase());

if (!existsSync(dir)) {
  if (!allowNew)
    fail(`data directory ${dir} does not exist. Mount your data folder there, or set JONATHON_INIT_NEW_DATA_DIR=true to create a NEW, empty installation.`);
  mkdirSync(dir, { recursive: true });
}
try {
  accessSync(dir, constants.R_OK | constants.W_OK);
} catch {
  fail(
    `data directory ${dir} is not readable and writable by uid ${process.getuid?.() ?? "?"}. Fix the owner of the host folder (see docs/docker.md, "Permissions"); do not chmod 777.`,
  );
}

if (!existsSync(marker)) {
  const entries = readdirSync(dir).filter((n) => !n.startsWith("."));
  const looksLikeJonathon = entries.some((n) => n === "projects" || /^jonathon(-demo)?\.sqlite$/.test(n));
  if (looksLikeJonathon) {
    writeFileSync(marker, `adopted existing data ${new Date().toISOString()}\n`);
    console.log(`init: adopted existing Jonathon data in ${dir}`);
  } else if (entries.length === 0 && allowNew) {
    writeFileSync(marker, `initialised ${new Date().toISOString()}\n`);
    console.log(`init: initialised a NEW data directory at ${dir}`);
  } else if (entries.length === 0) {
    fail(
      `data directory ${dir} is empty. If you expected existing data, the mount is wrong (check JONATHON_HOST_DATA_DIR). ` +
        "To start a NEW installation, run once with JONATHON_INIT_NEW_DATA_DIR=true.",
    );
  } else {
    fail(`data directory ${dir} contains files that are not Jonathon's (${entries.slice(0, 5).join(", ")}). Refusing to use it.`);
  }
}

const db = openDatabase(config.dbPath); // applies pending migrations
const migrations = (db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: string }[]).map((r) => r.id);
const journal = (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
const fts = hasFts5(db);
db.close();
if (!fts) fail("this SQLite build has no FTS5; search cannot work");
console.log(`init: ok (mode=${config.mode}, journal=${journal}, migrations=${migrations.join(",")})`);
