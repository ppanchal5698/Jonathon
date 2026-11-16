#!/usr/bin/env node
// Start the API server, the background worker and the Next.js UI together.
//   pnpm dev          → watch mode
//   pnpm start        → production mode (run `pnpm build` first)
import { spawn } from "node:child_process";

const prod = process.argv.includes("--prod");
const isWin = process.platform === "win32";
const pnpm = isWin ? "pnpm.cmd" : "pnpm";

const WEB_PORT = /^\d{2,5}$/.test(process.env.JONATHON_WEB_PORT ?? "") ? process.env.JONATHON_WEB_PORT : "3000";
const API_PORT = /^\d{2,5}$/.test(process.env.JONATHON_PORT ?? "") ? process.env.JONATHON_PORT : "4100";

const procs = [
  { name: "api", color: 36, args: ["--filter", "@jonathon/server", prod ? "start" : "dev"] },
  { name: "worker", color: 35, args: ["--filter", "@jonathon/server", prod ? "start:worker" : "dev:worker"] },
  { name: "web", color: 33, args: ["--filter", "@jonathon/web", "exec", "next", prod ? "start" : "dev", "--hostname", "127.0.0.1", "--port", WEB_PORT] },
];

const children = procs.map((p) => {
  // shell is required on Windows to launch the pnpm .cmd shim; arguments here are fixed literals, never user input.
  const child = spawn(pnpm, p.args, { stdio: ["ignore", "pipe", "pipe"], shell: isWin, detached: !isWin, env: process.env });
  const prefix = `\x1b[${p.color}m[${p.name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) out.write(prefix + l + "\n");
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => {
    process.stdout.write(`${prefix}exited with code ${code}\n`);
    if (!stopping) shutdown(code ?? 1);
  });
  return child;
});

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (!c.pid || c.exitCode !== null) continue;
    if (isWin) spawn("taskkill", ["/PID", String(c.pid), "/T", "/F"], { stdio: "ignore" });
    else {
      try {
        process.kill(-c.pid, "SIGTERM");
      } catch {}
    }
  }
  setTimeout(() => process.exit(code), 1500);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
console.log(`Jonathon ${prod ? "production" : "development"}: UI http://127.0.0.1:${WEB_PORT}  API/MCP http://127.0.0.1:${API_PORT}`);
