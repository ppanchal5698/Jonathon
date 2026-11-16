/** Apply pending SQLite migrations to the configured database (the server also does this on start). */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, loadDotEnv, migrate } from "@jonathon/core";

loadDotEnv();
const config = loadConfig();
mkdirSync(dirname(config.dbPath), { recursive: true });
const db = new DatabaseSync(config.dbPath, { enableForeignKeyConstraints: true });
const applied = migrate(db);
console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database schema is up to date.");
db.close();
