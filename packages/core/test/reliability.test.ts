import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AppError,
  backoffDelayMs,
  createApp,
  createLogger,
  DEFAULT_QUEUE_OPTIONS,
  JobQueue,
  JobWorker,
  leaseFence,
  loadConfig,
  openDatabase,
  sanitizeDiagnostic,
  toAppError,
  tx,
} from "@jonathon/core";
import { afterEach, describe, expect, it } from "vitest";
import { fakeRuntime, makeApp, SYSTEM, type TestApp, tempDir, USER } from "./helpers";

const MCP = { kind: "mcp_token" as const, tokenId: "tok_x", name: "claude", projectIds: [] as string[], scopes: ["read", "propose"] as ("read" | "propose")[] };
const silent = createLogger("silent", "t");
let t: TestApp | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

function project(app: TestApp["app"], name = "Reliability") {
  return app.projects.create(USER, { name, ai_enabled: true }).id;
}

const until = async (pred: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("queue: retries, backoff, dead letters", () => {
  it("backoff is exponential, capped and jittered within 50–100 % of each step", () => {
    const o = { backoffBaseMs: 1_000, backoffMaxMs: 10_000 };
    expect(backoffDelayMs(1, o, () => 1)).toBe(1_000);
    expect(backoffDelayMs(2, o, () => 1)).toBe(2_000);
    expect(backoffDelayMs(3, o, () => 1)).toBe(4_000);
    expect(backoffDelayMs(9, o, () => 1)).toBe(10_000);
    expect(backoffDelayMs(3, o, () => 0)).toBe(2_000);
    for (let i = 0; i < 50; i++) {
      const d = backoffDelayMs(2, o);
      expect(d).toBeGreaterThanOrEqual(1_000);
      expect(d).toBeLessThanOrEqual(2_000);
    }
  });

  it("transient failures retry, exhaustion dead-letters with attempt history; permanent failures dead-letter at once", () => {
    t = makeApp();
    const pid = project(t.app);
    const q = t.app.ctx.queue;
    const job = q.enqueue({ projectId: pid, type: "reindex", payload: {}, createdBy: "t", maxAttempts: 2 });
    q.claim("w1", 60_000, ["reindex"]);
    const before = Date.now();
    expect(q.fail(job.id, "w1", "ANTIGRAVITY_TIMEOUT", "provider timed out")).toBe("retrying");
    const runAfter = Date.parse((t.app.ctx.db.prepare("SELECT run_after FROM jobs WHERE id = ?").get(job.id) as { run_after: string }).run_after);
    expect(runAfter - before).toBeGreaterThanOrEqual(DEFAULT_QUEUE_OPTIONS.backoffBaseMs * 0.5 - 50);
    t.app.ctx.db.prepare("UPDATE jobs SET run_after = ? WHERE id = ?").run(new Date(0).toISOString(), job.id);
    q.claim("w2", 60_000, ["reindex"]);
    expect(q.fail(job.id, "w2", "ANTIGRAVITY_TIMEOUT", "provider timed out again at C:\\Users\\parth\\secret.txt")).toBe("failed");
    const [dl] = q.listDeadLetters({ projectId: pid });
    expect(dl).toMatchObject({ job_id: job.id, reason: "attempts_exhausted", error_code: "ANTIGRAVITY_TIMEOUT", attempts: 2, job_status: "failed" });
    expect(dl!.attempt_history.map((a) => a.worker_id)).toEqual(["w1", "w2"]);
    expect(dl!.error_message).not.toContain("parth");

    // Repeatedly malformed model output is permanent: no retry storm, straight to a dead letter.
    const bad = q.enqueue({ projectId: pid, type: "reindex", payload: { n: 2 }, createdBy: "t", maxAttempts: 5 });
    q.claim("w1", 60_000, ["reindex"]);
    expect(q.fail(bad.id, "w1", "INVALID_MODEL_OUTPUT", "schema mismatch after repair")).toBe("failed");
    expect(q.listDeadLetters({ projectId: pid }).find((d) => d.job_id === bad.id)?.reason).toBe("permanent_error");
  });

  it("disk-full and SQLite-full errors are classified as transient storage failures", () => {
    const enospc = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    expect(toAppError(enospc).code).toBe("STORAGE_UNAVAILABLE");
    expect(toAppError(new AppError("INTERNAL", "x", { cause: enospc })).code).toBe("STORAGE_UNAVAILABLE");
    expect(toAppError(new Error("database or disk is full")).code).toBe("STORAGE_UNAVAILABLE");
    expect(toAppError(new Error("boom")).code).toBe("INTERNAL");
    expect(sanitizeDiagnostic("token=abcdef /data/projects/x C:\\Users\\a\\b")).toBe("token <redacted> <path> <path>");
  });

  it("expired leases exhaust into a lease_expired dead letter", () => {
    t = makeApp();
    const pid = project(t.app);
    const q = t.app.ctx.queue;
    const job = q.enqueue({ projectId: pid, type: "reindex", payload: {}, createdBy: "t", maxAttempts: 1 });
    q.claim("crashed", 1, ["reindex"]);
    t.app.ctx.db.prepare("UPDATE jobs SET lease_expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), job.id);
    expect(q.recoverExpiredLeases()).toBe(1);
    expect(q.get(job.id)).toMatchObject({ status: "failed", error_code: "LEASE_LOST" });
    expect(q.listDeadLetters()[0]).toMatchObject({ job_id: job.id, reason: "lease_expired" });
  });

  it("admission limit rejects new work when the queue is full", () => {
    t = makeApp({ env: { JONATHON_MAX_ACTIVE_JOBS: "10" } });
    const pid = project(t.app);
    for (let i = 0; i < 10; i++) t.app.ctx.queue.enqueue({ projectId: pid, type: "reindex", payload: { i }, createdBy: "t" });
    expect(() => t!.app.ctx.queue.enqueue({ projectId: pid, type: "reindex", payload: {}, createdBy: "t" })).toThrow(/queue is full/);
  });
});

describe("replay: authorized, audited, safe", () => {
  it("only the human user can replay; replay is audited and idempotent", () => {
    t = makeApp();
    const pid = project(t.app);
    const q = t.app.ctx.queue;
    const job = q.enqueue({ projectId: pid, type: "reindex", payload: {}, createdBy: "t", maxAttempts: 1 });
    q.claim("w", 60_000, ["reindex"]);
    q.fail(job.id, "w", "EXTRACTION_FAILED", "parser crashed");
    expect(() => q.replay(SYSTEM, job.id)).toThrow(/only the signed-in human/);
    expect(() => q.replay({ ...MCP, projectIds: [pid] }, job.id)).toThrow(/only the signed-in human/);
    expect(() => q.replay(USER, job.id, { projectId: "prj_other" })).toThrow(/job not found/);

    const first = q.replay(USER, job.id, { correlationId: "req_1" });
    expect(first).toMatchObject({ replayed: true, job: { status: "queued", attempts: 0 } });
    const again = q.replay(USER, job.id);
    expect(again.replayed).toBe(false); // already queued: a double click changes nothing
    const audits = t.app.ctx.db
      .prepare("SELECT actor_kind, action, correlation_id FROM audit_events WHERE entity_id = ? AND action = 'job.replayed'")
      .all(job.id);
    expect(audits).toEqual([{ actor_kind: "user", action: "job.replayed", correlation_id: "req_1" }]);
    expect(q.listDeadLetters({ projectId: pid })).toHaveLength(0);
    expect(q.listDeadLetters({ projectId: pid, includeReplayed: true })[0]).toMatchObject({ replay_count: 1, replayed_by: USER.username });
  });

  it("business-level dedupe: one active job per operation key, re-runs allowed after it finishes, replay defers to an active twin", () => {
    t = makeApp();
    const pid = project(t.app);
    const q = t.app.ctx.queue;
    const a = q.enqueue({
      projectId: pid,
      type: "graph_extract",
      payload: { revision_id: "rev_1" },
      createdBy: "t",
      dedupeKey: "graph_extract:rev_1",
      maxAttempts: 1,
    });
    const b = q.enqueue({ projectId: pid, type: "graph_extract", payload: { revision_id: "rev_1" }, createdBy: "t", dedupeKey: "graph_extract:rev_1" });
    expect(b.id).toBe(a.id);
    // The partial unique index enforces it even against a writer that skips the check.
    expect(() =>
      t!.app.ctx.db
        .prepare(
          "INSERT INTO jobs (id, project_id, type, status, payload, run_after, dedupe_key, created_by, created_at, updated_at) VALUES ('job_dup', ?, 'graph_extract', 'queued', '{}', '', 'graph_extract:rev_1', 't', '', '')",
        )
        .run(pid),
    ).toThrow(/UNIQUE/);
    q.claim("w", 60_000, ["graph_extract"]);
    q.fail(a.id, "w", "INVALID_MODEL_OUTPUT", "bad");
    const c = q.enqueue({ projectId: pid, type: "graph_extract", payload: { revision_id: "rev_1" }, createdBy: "t", dedupeKey: "graph_extract:rev_1" });
    expect(c.id).not.toBe(a.id); // a deliberate re-run after the first finished
    const r = q.replay(USER, a.id);
    expect(r).toMatchObject({ replayed: false, duplicate_of: c.id });
  });
});

describe("leases and fencing: no stale commits", () => {
  it("a worker that lost its lease cannot commit, complete or fail the job that another worker now owns", () => {
    t = makeApp();
    const pid = project(t.app);
    const q = t.app.ctx.queue;
    const db = t.app.ctx.db;
    db.exec("CREATE TABLE IF NOT EXISTS effects (job TEXT, worker TEXT)");
    const job = q.enqueue({ projectId: pid, type: "reindex", payload: {}, createdBy: "t" });
    q.claim("A", 1, ["reindex"]);
    db.prepare("UPDATE jobs SET lease_expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), job.id);
    expect(q.recoverExpiredLeases()).toBe(1);
    db.prepare("UPDATE jobs SET run_after = ? WHERE id = ?").run(new Date(0).toISOString(), job.id);
    expect(q.claim("B", 60_000, ["reindex"])?.id).toBe(job.id);

    // A wakes up and tries to commit a business effect inside its (lost) lease fence.
    const write = (worker: string) =>
      leaseFence.run({ jobId: job.id, workerId: worker }, () => tx(db, () => db.prepare("INSERT INTO effects VALUES (?, ?)").run(job.id, worker)));
    expect(() => write("A")).toThrow(/no longer holds/);
    expect(q.complete(job.id, "A", "succeeded", { stale: true })).toBe(false);
    expect(q.fail(job.id, "A", "INTERNAL", "stale")).toBe("running");
    expect(q.get(job.id).status).toBe("running");
    // B, the lease holder, commits normally.
    write("B");
    expect(q.complete(job.id, "B", "succeeded", { ok: true })).toBe(true);
    expect(db.prepare("SELECT worker FROM effects").all()).toEqual([{ worker: "B" }]);
    const outcomes = db.prepare("SELECT worker_id, outcome FROM job_attempts WHERE job_id = ? ORDER BY started_at").all(job.id);
    expect(outcomes).toContainEqual({ worker_id: "A", outcome: "lease_expired" });
    expect(outcomes).toContainEqual({ worker_id: "B", outcome: "succeeded" });
  });

  it("a running JobWorker whose lease is taken mid-job aborts and its knowledge write never reaches disk", async () => {
    t = makeApp();
    const pid = project(t.app);
    const { ctx } = t.app;
    let reachedWrite = false;
    let writeError: unknown = null;
    const handler = async (jc: { job: { id: string }; signal: AbortSignal }) => {
      // Simulate a long AI call during which the lease is lost (e.g. the worker was paused past its lease).
      ctx.db.prepare("UPDATE jobs SET lease_owner = 'other-worker' WHERE id = ?").run(jc.job.id);
      await new Promise((r) => setTimeout(r, 50));
      reachedWrite = true;
      try {
        t!.app.knowledge.createDraft(SYSTEM, pid, "requirement", { title: "Stale result from a lost lease", fields: { type: "functional" } });
      } catch (e) {
        writeError = e;
      }
      return { status: "succeeded" as const, result: {} };
    };
    const job = ctx.queue.enqueue({ projectId: pid, type: "reindex", payload: {}, createdBy: "t" });
    const w = new JobWorker(ctx.db, ctx.queue, { reindex: handler as never }, silent, { concurrency: 1, pollMs: 20, leaseMs: 60_000 });
    w.start();
    await until(() => reachedWrite);
    await w.stop();
    expect((writeError as AppError | null)?.code).toBe("LEASE_LOST");
    expect(t.app.knowledge.list(USER, pid, {}).filter((e) => e.title.includes("Stale result"))).toHaveLength(0);
    expect(existsSync(join(t.dataDir, "projects", pid, "requirements", "REQ-001.md"))).toBe(false);
    // The job itself was not marked succeeded by the stale worker.
    expect(ctx.queue.get(job.id).status).toBe("running");
  });

  it("per-job deadlines abort the handler and retry with JOB_TIMEOUT", async () => {
    t = makeApp();
    const pid = project(t.app);
    const { ctx } = t.app;
    const job = ctx.queue.enqueue({ projectId: pid, type: "reindex", payload: {}, createdBy: "t", maxAttempts: 2 });
    let aborted = false;
    const handler = (jc: { signal: AbortSignal }) =>
      new Promise<never>((_, reject) =>
        jc.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(jc.signal.reason);
          },
          { once: true },
        ),
      );
    const w = new JobWorker(ctx.db, ctx.queue, { reindex: handler as never }, silent, { concurrency: 1, pollMs: 20, deadlinesMs: { reindex: 150 } });
    w.start();
    await until(() => ctx.queue.get(job.id).status === "retrying");
    await w.stop();
    expect(aborted).toBe(true);
    expect(ctx.queue.get(job.id).error_code).toBe("JOB_TIMEOUT");
  });

  it("shutdown during a long job releases it back to the queue without spending an attempt", async () => {
    t = makeApp();
    const pid = project(t.app);
    const { ctx } = t.app;
    const job = ctx.queue.enqueue({ projectId: pid, type: "reindex", payload: {}, createdBy: "t" });
    let started = false;
    const handler = (jc: { signal: AbortSignal }) =>
      new Promise<never>((_, reject) => {
        started = true;
        jc.signal.addEventListener("abort", () => reject(jc.signal.reason), { once: true });
      });
    const w = new JobWorker(ctx.db, ctx.queue, { reindex: handler as never }, silent, { concurrency: 1, pollMs: 20 });
    w.start();
    await until(() => started);
    await w.stop();
    expect(ctx.queue.get(job.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM worker_heartbeats").get()).toEqual({ n: 0 });
  });
});

describe("multi-process concurrency on one SQLite file (API + workers)", () => {
  it("concurrent claimers in separate processes never claim the same job, while a writer keeps committing", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "jonathon.sqlite");
    const db = openDatabase(dbPath);
    db.prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('prj_c', 'c', '', '')").run();
    const q = new JobQueue(db);
    const N = 120;
    for (let i = 0; i < N; i++) q.enqueue({ projectId: "prj_c", type: "reindex", payload: { i }, createdBy: "t" });
    db.close();
    const script = fileURLToPath(new URL("./fixtures/claim-loop.ts", import.meta.url));
    const run = (role: string) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", script, dbPath, role], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${role} exited ${code}: ${err.slice(0, 500)}`))));
      });
    const outs = await Promise.all([run("worker-1"), run("worker-2"), run("worker-3"), run("api-writer")]);
    const claimed = outs.slice(0, 3).flatMap((o) => o.split("\n").filter((l) => l.startsWith("job_")));
    expect(claimed.length).toBe(N);
    expect(new Set(claimed).size).toBe(N);
    expect(outs[3]).toMatch(/writes=\d+/);
    const check = openDatabase(dbPath);
    expect(check.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'succeeded'").get()).toEqual({ n: N });
    expect((check.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
    check.close();
  }, 120_000);
});

describe("data directory and folder-import guards", () => {
  it("refuses to start without the data marker when an existing data mount is required", async () => {
    const { assertDataDirReady, DATA_DIR_MARKER } = await import("@jonathon/core");
    const dir = tempDir();
    const config = loadConfig({ JONATHON_DATA_DIR: dir, JONATHON_REQUIRE_EXISTING_DATA: "true" } as NodeJS.ProcessEnv);
    expect(() => assertDataDirReady(config)).toThrow(/marker/);
    writeFileSync(join(dir, DATA_DIR_MARKER), "x");
    expect(() => assertDataDirReady(config)).not.toThrow();
  });

  it("container listening and extra hosts are only accepted inside a container", () => {
    const dir = tempDir();
    expect(() => loadConfig({ JONATHON_DATA_DIR: dir, JONATHON_HOST: "0.0.0.0" } as NodeJS.ProcessEnv)).toThrow(/not loopback/);
    if (!existsSync("/.dockerenv")) {
      expect(() => loadConfig({ JONATHON_DATA_DIR: dir, JONATHON_HOST: "0.0.0.0", JONATHON_CONTAINER: "true" } as NodeJS.ProcessEnv)).toThrow(
        /only valid inside a container/,
      );
    }
    expect(() => loadConfig({ JONATHON_DATA_DIR: dir, JONATHON_ALLOWED_HOSTS: "evil.com/x" } as NodeJS.ProcessEnv)).toThrow(/host\[:port\]/);
    expect(() => loadConfig({ JONATHON_DATA_DIR: dir, JONATHON_IMPORT_ROOTS: "relative/dir" } as NodeJS.ProcessEnv)).toThrow(/absolute/);
  });

  it("folder import is confined to the configured import roots, including traversal and links", async () => {
    const imports = tempDir("jon-imports-");
    const outside = tempDir("jon-outside-");
    mkdirSync(join(imports, "acme"));
    writeFileSync(join(imports, "acme", "brief.md"), "# Brief\nCustomers must verify email.");
    writeFileSync(join(outside, "secret.md"), "not for import");
    t = makeApp({ env: { JONATHON_IMPORT_ROOTS: imports } });
    const pid = project(t.app);
    const f = t.app.folders;
    expect((await f.scan(USER, pid, { path: join(imports, "acme"), recursive: true })).files.map((x) => x.path)).toEqual(["brief.md"]);
    expect(() => f.scan(USER, pid, { path: outside, recursive: true })).toThrow(/limited to/);
    expect(() => f.scan(USER, pid, { path: join(imports, "acme", "..", "..", outside.split(/[\\/]/).pop()!), recursive: true })).toThrow(
      /limited to|does not exist/,
    );
    // A link inside the allowed root that points outside it is refused (resolved real path is checked).
    let linked = false;
    try {
      const { symlinkSync } = require("node:fs") as typeof import("node:fs");
      symlinkSync(outside, join(imports, "escape"), "junction");
      linked = true;
    } catch {
      /* no permission to create links on this host */
    }
    if (linked) expect(() => f.scan(USER, pid, { path: join(imports, "escape"), recursive: true })).toThrow(/link|limited to/);
    expect(() => f.scan({ ...MCP, projectIds: [pid] }, pid, { path: join(imports, "acme"), recursive: true })).toThrow();
  });
});

describe("restart preserves every kind of record", () => {
  it("accounts, tokens, conversations, jobs, approvals, audit, knowledge revisions and original bytes survive a restart", async () => {
    const { seedDemoProject } = await import("@jonathon/test-fixtures");
    t = makeApp({ scenario: "answer-cite" });
    const { projectId: pid } = await seedDemoProject(t.app, USER);
    const token = t.app.auth.createMcpToken(USER, { name: "claude", projectIds: [pid], scopes: ["read"] });
    await t.app.answers.ask(USER, pid, { message: "verification?", request_id: "rq-persist-1" }, { waitMs: 0 });
    const originals = t.app.ctx.db.prepare("SELECT id, source_id, extension, content_hash FROM source_revisions WHERE project_id = ?").all(pid) as {
      id: string;
      source_id: string;
      extension: string;
      content_hash: string;
    }[];
    const snapshot = () =>
      Object.fromEntries(
        ["users", "mcp_tokens", "conversations", "messages", "jobs", "approval_events", "audit_events", "knowledge_entities"].map((tb) => [
          tb,
          (t!.app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${tb}`).get() as { n: number }).n,
        ]),
      );
    const before = snapshot();
    const req1 = t.app.knowledge.get(USER, pid, "REQ-001");
    t.app.close();
    const app2 = createApp(loadConfig({ JONATHON_DATA_DIR: t.dataDir, JONATHON_LOG_LEVEL: "silent" } as NodeJS.ProcessEnv), {
      runtime: fakeRuntime(t.dataDir, "answer-cite"),
      log: silent,
    });
    t.app = app2;
    expect(snapshot()).toEqual(before);
    expect(app2.auth.resolveMcpToken(token.token)?.tokenId).toBe(token.id);
    const req1b = app2.knowledge.get(USER, pid, "REQ-001");
    expect({ rev: req1b.revision, approved: req1b.approval_valid }).toEqual({ rev: req1.revision, approved: req1.approval_valid });
    const { sha256 } = await import("@jonathon/core");
    for (const o of originals) {
      const bytes = readFileSync(join(t.dataDir, "projects", pid, "sources", o.source_id, o.id, `original.${o.extension}`));
      expect(sha256(bytes)).toBe(o.content_hash);
    }
  });
});
