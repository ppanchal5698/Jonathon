import type { JobStatus, JobType } from "@jonathon/contracts";
import { type Db, leaseFence, run } from "../db";
import type { Logger } from "../logger";
import { AppError, isAppError, newId, nowIso, sleep, toAppError } from "../util";
import type { ClaimedJob, JobQueue } from "./queue";

export interface JobContext {
  job: ClaimedJob;
  signal: AbortSignal;
  progress: (stage: string, detail?: string) => void;
  log: Logger;
}

export type JobOutcome = { status: Exclude<JobStatus, "queued" | "running" | "retrying" | "failed" | "cancelled">; result: unknown };
export type JobHandler = (ctx: JobContext) => Promise<JobOutcome>;

/**
 * Wall-clock deadline per job attempt. When it passes, the handler's AbortSignal fires (the AI runtime kills its
 * process tree), and the attempt fails with JOB_TIMEOUT, which is retryable with backoff.
 */
export const DEFAULT_JOB_DEADLINES_MS: Record<JobType, number> = {
  ingest: 10 * 60_000,
  answer: 15 * 60_000,
  extract_knowledge: 45 * 60_000,
  reindex: 30 * 60_000,
  reconcile: 30 * 60_000,
  graph_extract: 45 * 60_000,
  generate_documents: 60 * 60_000,
  import_folder: 3 * 60 * 60_000,
};

export interface WorkerOptions {
  concurrency: number;
  leaseMs?: number;
  pollMs?: number;
  types?: JobType[];
  /** Per-type deadlines (merged over DEFAULT_JOB_DEADLINES_MS). */
  deadlinesMs?: Partial<Record<JobType, number>>;
  /** Hard cap applied to every type (JONATHON_JOB_DEADLINE_MS). */
  maxDeadlineMs?: number;
}

/**
 * Polls the durable queue, runs handlers with an AbortSignal, renews leases, honours cancellation and deadlines,
 * and releases jobs on shutdown. Each handler runs inside the lease fence (db.leaseFence), so its transactions are
 * refused once this worker no longer holds the job's lease.
 */
export class JobWorker {
  readonly workerId = newId("wrk");
  private running = new Map<string, AbortController>();
  private stopping = false;
  private loop: Promise<void> | null = null;
  private readonly leaseMs: number;
  private readonly pollMs: number;

  constructor(
    private readonly db: Db,
    private readonly queue: JobQueue,
    private readonly handlers: Partial<Record<JobType, JobHandler>>,
    private readonly log: Logger,
    private readonly opts: WorkerOptions,
  ) {
    this.leaseMs = opts.leaseMs ?? 30_000;
    this.pollMs = opts.pollMs ?? 500;
  }

  deadlineFor(type: JobType): number {
    const d = this.opts.deadlinesMs?.[type] ?? DEFAULT_JOB_DEADLINES_MS[type] ?? 30 * 60_000;
    return this.opts.maxDeadlineMs ? Math.min(d, this.opts.maxDeadlineMs) : d;
  }

  start(): void {
    const recovered = this.queue.recoverExpiredLeases();
    if (recovered) this.log.warn({ recovered }, "requeued jobs from a worker that stopped");
    run(
      this.db,
      "INSERT INTO worker_heartbeats (worker_id, pid, started_at, last_seen_at) VALUES (?,?,?,?) ON CONFLICT(worker_id) DO UPDATE SET last_seen_at = excluded.last_seen_at",
      this.workerId,
      process.pid,
      nowIso(),
      nowIso(),
    );
    this.loop = this.mainLoop();
  }

  get activeJobs(): number {
    return this.running.size;
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  private async mainLoop(): Promise<void> {
    let lastRecovery = Date.now();
    while (!this.stopping) {
      try {
        run(this.db, "UPDATE worker_heartbeats SET last_seen_at = ? WHERE worker_id = ?", nowIso(), this.workerId);
        if (Date.now() - lastRecovery > 15_000) {
          this.queue.recoverExpiredLeases();
          lastRecovery = Date.now();
        }
        while (this.running.size < this.opts.concurrency && !this.stopping) {
          const types = (this.opts.types ?? (Object.keys(this.handlers) as JobType[])).filter((t) => this.handlers[t]);
          const job = this.queue.claim(this.workerId, this.leaseMs, types);
          if (!job) break;
          void this.execute(job);
        }
      } catch (e) {
        this.log.error({ err: (e as Error).message }, "worker loop error");
      }
      await sleep(this.pollMs).catch(() => undefined);
    }
  }

  private async execute(job: ClaimedJob): Promise<void> {
    const controller = new AbortController();
    this.running.set(job.id, controller);
    const log = this.log.child({ job_id: job.id, job_type: job.type, attempt: job.attempt, correlation_id: job.correlationId });
    const abort = (code: "JOB_CANCELLED" | "LEASE_LOST" | "JOB_TIMEOUT", message: string) => {
      if (!controller.signal.aborted) controller.abort(new AppError(code, message));
    };
    const beat = setInterval(
      () => {
        try {
          const hb = this.queue.heartbeat(job.id, this.workerId, this.leaseMs);
          if (hb.cancelRequested) abort("JOB_CANCELLED", "cancelled by request");
          if (!hb.owned) abort("LEASE_LOST", "lease lost; another worker may own this job now");
        } catch (e) {
          log.warn({ err: (e as Error).message }, "heartbeat failed");
        }
      },
      Math.min(1_000, this.leaseMs / 3),
    );
    const deadlineMs = this.deadlineFor(job.type);
    const deadline = setTimeout(() => abort("JOB_TIMEOUT", `job exceeded its ${Math.round(deadlineMs / 1000)} s deadline`), deadlineMs);
    const started = Date.now();
    try {
      const handler = this.handlers[job.type];
      if (!handler) throw new AppError("INTERNAL", `no handler for ${job.type}`);
      log.info("job started");
      const outcome = await leaseFence.run({ jobId: job.id, workerId: this.workerId }, () =>
        handler({
          job,
          signal: controller.signal,
          progress: (stage, detail) => this.queue.setProgress(job.id, stage, detail, this.workerId),
          log,
        }),
      );
      if (controller.signal.aborted) throw controller.signal.reason;
      if (this.queue.complete(job.id, this.workerId, outcome.status, outcome.result)) {
        log.info({ status: outcome.status, duration_ms: Date.now() - started }, "job finished");
      } else {
        log.warn({ duration_ms: Date.now() - started }, "lease lost before completion; result discarded");
      }
    } catch (e) {
      const reason = controller.signal.aborted ? controller.signal.reason : undefined;
      const err = isAppError(reason) ? reason : controller.signal.aborted ? new AppError("JOB_CANCELLED", "cancelled") : toAppError(e);
      if (this.stopping && err.code === "JOB_CANCELLED") {
        this.queue.release(job.id, this.workerId);
        log.warn("job released on shutdown");
      } else if (err.code === "LEASE_LOST") {
        // Another worker (or lease recovery) owns the job now; fail() would be refused anyway. Record nothing more.
        this.queue.fail(job.id, this.workerId, err.code, err.message);
        log.warn({ duration_ms: Date.now() - started }, "lease lost; this worker's results were not committed");
      } else {
        const status = this.queue.fail(job.id, this.workerId, err.code, err.message);
        log[status === "retrying" ? "warn" : "error"]({ code: err.code, err: err.message, status, duration_ms: Date.now() - started }, "job did not succeed");
      }
    } finally {
      clearInterval(beat);
      clearTimeout(deadline);
      this.running.delete(job.id);
    }
  }

  /**
   * Stop claiming, abort running jobs (their runtimes kill their process trees), wait for them to settle and release
   * them back to the queue, then remove this worker's heartbeat row so the UI shows "worker not running" at once.
   */
  async stop(timeoutMs = 10_000): Promise<void> {
    this.stopping = true;
    for (const c of this.running.values()) if (!c.signal.aborted) c.abort(new AppError("JOB_CANCELLED", "worker shutdown"));
    const deadline = Date.now() + timeoutMs;
    while (this.running.size > 0 && Date.now() < deadline) await sleep(50);
    await this.loop;
    run(this.db, "DELETE FROM worker_heartbeats WHERE worker_id = ?", this.workerId);
  }
}
