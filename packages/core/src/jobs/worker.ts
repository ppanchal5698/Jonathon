import type { JobStatus, JobType } from "@jonathon/contracts";
import { type Db, run } from "../db";
import type { Logger } from "../logger";
import { AppError, newId, nowIso, sleep, toAppError } from "../util";
import type { ClaimedJob, JobQueue } from "./queue";

export interface JobContext {
  job: ClaimedJob;
  signal: AbortSignal;
  progress: (stage: string, detail?: string) => void;
  log: Logger;
}

export type JobOutcome = { status: Exclude<JobStatus, "queued" | "running" | "retrying" | "failed" | "cancelled">; result: unknown };
export type JobHandler = (ctx: JobContext) => Promise<JobOutcome>;

export interface WorkerOptions {
  concurrency: number;
  leaseMs?: number;
  pollMs?: number;
  types?: JobType[];
}

/**
 * Polls the durable queue, runs handlers with an AbortSignal, renews leases, honours cancellation
 * and releases jobs on shutdown.
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
    const beat = setInterval(() => {
      try {
        const hb = this.queue.heartbeat(job.id, this.workerId, this.leaseMs);
        if (hb.cancelRequested && !controller.signal.aborted) controller.abort(new AppError("JOB_CANCELLED", "cancelled by request"));
        if (!hb.owned && !controller.signal.aborted) controller.abort(new AppError("JOB_CANCELLED", "lease lost"));
      } catch (e) {
        log.warn({ err: (e as Error).message }, "heartbeat failed");
      }
    }, Math.min(1_000, this.leaseMs / 3));
    const started = Date.now();
    try {
      const handler = this.handlers[job.type];
      if (!handler) throw new AppError("INTERNAL", `no handler for ${job.type}`);
      log.info("job started");
      const outcome = await handler({
        job,
        signal: controller.signal,
        progress: (stage, detail) => this.queue.setProgress(job.id, stage, detail),
        log,
      });
      if (controller.signal.aborted) throw new AppError("JOB_CANCELLED", "cancelled");
      this.queue.complete(job.id, this.workerId, outcome.status, outcome.result);
      log.info({ status: outcome.status, duration_ms: Date.now() - started }, "job finished");
    } catch (e) {
      if (this.stopping && !(e instanceof AppError && e.code !== "JOB_CANCELLED")) {
        this.queue.release(job.id, this.workerId);
        log.warn("job released on shutdown");
      } else {
        const err = controller.signal.aborted ? new AppError("JOB_CANCELLED", "cancelled") : toAppError(e);
        const status = this.queue.fail(job.id, this.workerId, err.code, err.message);
        log[status === "retrying" ? "warn" : "error"]({ code: err.code, err: err.message, status, duration_ms: Date.now() - started }, "job did not succeed");
      }
    } finally {
      clearInterval(beat);
      this.running.delete(job.id);
    }
  }

  /** Abort running jobs, wait for them to settle, and stop polling. */
  async stop(timeoutMs = 10_000): Promise<void> {
    this.stopping = true;
    for (const c of this.running.values()) c.abort(new AppError("JOB_CANCELLED", "worker shutdown"));
    const deadline = Date.now() + timeoutMs;
    while (this.running.size > 0 && Date.now() < deadline) await sleep(50);
    await this.loop;
    run(this.db, "DELETE FROM worker_heartbeats WHERE worker_id = ?", this.workerId);
  }
}
