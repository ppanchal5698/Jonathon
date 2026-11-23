/**
 * Baseline latency of the reads the UI repeats (dashboard polling, project page, graph, documents, search), in-process,
 * on a temporary demo-mode data directory with synthetic fictional sources. Used to decide whether any new cache is
 * justified (docs/docker.md, "Caching decision").
 *
 *   pnpm tsx scripts/bench-reads.ts [sources=200]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createLogger, DemoExtractiveRuntime, loadConfig } from "@jonathon/core";
import { drainJobs } from "@jonathon/test-fixtures";

const N = Number(process.argv[2] ?? 200);
const dir = mkdtempSync(join(tmpdir(), "jon-bench-"));
const app = createApp(loadConfig({ JONATHON_DATA_DIR: dir, JONATHON_LOG_LEVEL: "silent", JONATHON_MODE: "demo" } as NodeJS.ProcessEnv), {
  runtime: new DemoExtractiveRuntime(),
  log: createLogger("silent", "bench"),
});
const user = { kind: "user" as const, userId: "usr_b", username: "bench" };
app.ctx.db
  .prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (?,?,?,?)")
  .run(user.userId, user.username, "x", new Date().toISOString());

const words = "invoice customer account payment verification report schedule technician portal notification export audit".split(" ");
const para = (i: number, j: number) =>
  Array.from({ length: 40 }, (_, k) => words[(i * 7 + j * 3 + k) % words.length]).join(" ") + `. Customers must handle case ${i}-${j}.`;

async function main() {
  const pid = app.projects.create(user, { name: "Bench", ai_enabled: true }).id;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const text = `# Fictional source ${i}\n\n${Array.from({ length: 12 }, (_, j) => para(i, j)).join("\n\n")}\n`;
    app.sources.ingest(user, pid, { filename: `source-${i}.md`, bytes: new TextEncoder().encode(text) });
  }
  await drainJobs(app, ["ingest", "extract_knowledge", "graph_extract"], N * 4);
  console.log(
    `seeded ${N} sources in ${Date.now() - t0} ms; chunks=${(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n}, entities=${(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM knowledge_entities").get() as { n: number }).n}`,
  );

  const counts = app.ctx.db.prepare(
    `SELECT (SELECT COUNT(*) FROM sources WHERE project_id = ?1 AND deleted_at IS NULL) AS sources,
            (SELECT COUNT(*) FROM knowledge_entities WHERE project_id = ?1 AND entity_type = 'requirement') AS requirements,
            (SELECT COUNT(*) FROM jobs WHERE project_id = ?1 AND status IN ('queued','running','retrying')) AS active_jobs`,
  );
  const cases: [string, () => unknown][] = [
    ["ops.health (dashboard, polled every 10 s)", () => app.ops.health()],
    ["project counts (project page)", () => counts.get(pid)],
    ["knowledge.list (review queue)", () => app.knowledge.list(user, pid, {})],
    ["graph.overview", () => app.graph.overview(user, pid)],
    ["documents.catalogue", () => app.documents.catalogue(user, pid)],
    ["search", () => app.search(user, pid, { query: "invoice verification" })],
  ];
  // Cold graph build (cache miss) separately: clear the in-process graph caches.
  const g = app.graph as unknown as { cache: Map<string, unknown>; passageLayers: Map<string, unknown> };
  g.cache.clear();
  g.passageLayers?.clear?.();
  let s = performance.now();
  app.graph.overview(user, pid);
  console.log(`graph.overview COLD (cache miss): ${(performance.now() - s).toFixed(1)} ms`);
  for (const [name, fn] of cases) {
    fn();
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      s = performance.now();
      fn();
      times.push(performance.now() - s);
    }
    times.sort((a, b) => a - b);
    console.log(`${name}: p50 ${times[10]!.toFixed(2)} ms, p95 ${times[18]!.toFixed(2)} ms`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
