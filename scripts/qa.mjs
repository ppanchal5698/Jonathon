#!/usr/bin/env node
// Start a THROWAWAY QA instance (fresh temp data folder, UI :3191, API :4191) for manual or agent testing.
// Your real data folder and account are never touched. Uses the real agy runtime unless JONATHON_MODE=demo.
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --reuse-last: continue with the most recent QA data folder (keeps earlier test projects, applies new migrations).
function lastQaFolder() {
  const dirs = readdirSync(tmpdir())
    .filter((n) => n.startsWith("jonathon-qa-"))
    .map((n) => join(tmpdir(), n))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return dirs[0];
}
const reuse = process.argv.includes("--reuse-last") ? lastQaFolder() : undefined;
const data = process.env.JONATHON_QA_DATA_DIR ?? reuse ?? mkdtempSync(join(tmpdir(), "jonathon-qa-"));
Object.assign(process.env, {
  JONATHON_DATA_DIR: data,
  JONATHON_PORT: "4191",
  JONATHON_WEB_PORT: "3191",
  JONATHON_WEB_ORIGINS: "http://127.0.0.1:3191,http://localhost:3191",
  JONATHON_API_URL: "http://127.0.0.1:4191",
  JONATHON_NEXT_DIST_DIR: ".next-qa",
  JONATHON_ASK_WAIT_MS: process.env.JONATHON_ASK_WAIT_MS ?? "5000",
});
console.log(`QA data folder: ${data}`);
await import("./dev.mjs");
