import { type ErrorCode, type Job, type JobStatus, type JobType, RETRYABLE_ERROR_CODES, TERMINAL_JOB_STATUSES } from "@jonathon/contracts";
import { audit } from "../audit";
import { all, type Db, one, run, tx } from "../db";
import { assertHuman, type Principal } from "../security/principal";
import { AppError, newId, nowIso, parseJson } from "../util";

interface JobRow {
  id: string;
  project_id: string;
  type: JobType;
  status: JobStatus;
  payload: string;
  result: string | null;
  progress: string | null;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  max_attempts: number;
  run_after: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  cancel_requested: number;
  idempotency_key: string | null;
  serial_key: string | null;
  dedupe_key: string | null;
  created_by: string;
  correlation_id: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface ClaimedJob {
  id: string;
  projectId: string;
  type: JobType;
  payload: Record<string, unknown>;
  attempt: number;
  maxAttempts: number;
  createdBy: string;
  correlationId: string | null;
}

export function toJob(r: JobRow): Job {
  return {
    id: r.id,
    project_id: r.project_id,
    type: r.type,
    status: r.status,
    attempts: r.attempts,
    max_attempts: r.max_attempts,
    progress: parseJson(r.progress, null),
    error_code: r.error_code,
    error_message: r.error_message,
    result: parseJson(r.result, null),
    cancel_requested: r.cancel_requested === 1,
    created_at: r.created_at,
    updated_at: r.updated_at,
    started_at: r.started_at,
    finished_at: r.finished_at,
  };
}

export interface QueueOptions {
  /** Attempts for jobs that do not set their own max_attempts. */
  defaultMaxAttempts: number;
  /** Exponential backoff: base * 2^(attempt-1), capped, with jitter (50–100 % of the step). */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Admission limit: queued + retrying + running jobs across all projects. Enqueue beyond it is RATE_LIMITED. */
  maxActiveJobs: number;
}

export const DEFAULT_QUEUE_OPTIONS: QueueOptions = { defaultMaxAttempts: 3, backoffBaseMs: 2_000, backoffMaxMs: 5 * 60_000, maxActiveJobs: 10_000 };

/** Delay before the next try after `attempt` attempts (1-based). Exported for tests. */
export function backoffDelayMs(attempt: number, o: Pick<QueueOptions, "backoffBaseMs" | "backoffMaxMs">, random: () => number = Math.random): number {
  const step = Math.min(o.backoffMaxMs, o.backoffBaseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(step * (0.5 + 0.5 * random()));
}

/** Strip paths and long token-like strings from diagnostics kept in job and dead-letter records. */
export function sanitizeDiagnostic(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/[A-Za-z]:\\[^\s"']+/g, "<path>")
    .replace(/\/(?:Users|home|tmp|var|data|imports|app)\/[^\s"']+/g, "<path>")
    .replace(/(api[_-]?key|token|authorization|bearer|password)\s*[:=]?\s*\S+/gi, "$1 <redacted>")
    .replace(/[A-Za-z0-9_-]{40,}/g, "<redacted>")
    .slice(0, 2_000);
}

export interface DeadLetter {
  id: string;
  job_id: string;
  project_id: string;
  job_type: string;
  reason: "attempts_exhausted" | "permanent_error" | "lease_expired";
  error_code: string;
  error_message: string;
  attempts: number;
  attempt_history: {
    attempt: number;
    worker_id: string;
    started_at: string;
    finished_at: string | null;
    outcome: string | null;
    error_code: string | null;
    error_message: string | null;
  }[];
  dead_at: string;
  replay_count: number;
  replayed_at: string | null;
  replayed_by: string | null;
  job_status: JobStatus;
}

export class JobQueue {
  readonly options: QueueOptions;

  constructor(
    private readonly db: Db,
    options: Partial<QueueOptions> = {},
  ) {
    this.options = { ...DEFAULT_QUEUE_OPTIONS, ...options };
  }

  enqueue(input: {
    projectId: string;
    type: JobType;
    payload: Record<string, unknown>;
    createdBy: string;
    idempotencyKey?: string | null;
    serialKey?: string | null;
    maxAttempts?: number;
    correlationId?: string | null;
    /** Earliest time the job may run (ISO). Defaults to now. */
    runAfter?: string;
    /**
     * Business-operation key (operation + input revision + configuration). While a job with the same key is queued,
     * retrying or running, enqueue returns that job instead of creating a duplicate. Once it finishes, the same
     * operation may run again on purpose. Enforced atomically by a partial unique index (migration 003).
     */
    dedupeKey?: string | null;
  }): Job {
    return tx(this.db, () => {
      if (input.dedupeKey) {
        const active = one<JobRow>(this.db, "SELECT * FROM jobs WHERE dedupe_key = ? AND status IN ('queued','running','retrying')", input.dedupeKey);
        if (active) return toJob(active);
      }
      if (input.idempotencyKey) {
        const existing = one<JobRow>(this.db, "SELECT * FROM jobs WHERE idempotency_key = ?", input.idempotencyKey);
        if (existing) {
          if (existing.project_id !== input.projectId || existing.type !== input.type) {
            throw new AppError("VALIDATION_FAILED", "request_id was already used for a different request");
          }
          return toJob(existing);
        }
      }
      const active = one<{ n: number }>(this.db, "SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running','retrying')")!.n;
      if (active >= this.options.maxActiveJobs) {
        throw new AppError("RATE_LIMITED", `the job queue is full (${active} active jobs); wait for running work to finish`);
      }
      const id = newId("job");
      const now = nowIso();
      run(
        this.db,
        `INSERT INTO jobs (id, project_id, type, status, payload, attempts, max_attempts, run_after, idempotency_key, serial_key, dedupe_key, created_by, correlation_id, created_at, updated_at)
         VALUES (?,?,?,'queued',?,0,?,?,?,?,?,?,?,?,?)`,
        id,
        input.projectId,
        input.type,
        JSON.stringify(input.payload),
        input.maxAttempts ?? this.options.defaultMaxAttempts,
        input.runAfter ?? now,
        input.idempotencyKey ?? null,
        input.serialKey ?? null,
        input.dedupeKey ?? null,
        input.createdBy,
        input.correlationId ?? null,
        now,
        now,
      );
      return this.get(id);
    });
  }

  get(id: string): Job {
    const r = one<JobRow>(this.db, "SELECT * FROM jobs WHERE id = ?", id);
    if (!r) throw new AppError("JOB_NOT_FOUND", "job not found");
    return toJob(r);
  }

  getForProject(projectId: string, id: string): Job {
    const r = one<JobRow>(this.db, "SELECT * FROM jobs WHERE id = ? AND project_id = ?", id, projectId);
    if (!r) throw new AppError("JOB_NOT_FOUND", "job not found");
    return toJob(r);
  }

  /** Newest first. The status filter is applied in SQL, before the limit, so older matching jobs are not cut off. */
  list(filter: { projectId?: string; statuses?: JobStatus[]; limit?: number } = {}): Job[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.projectId) {
      where.push("project_id = ?");
      params.push(filter.projectId);
    }
    if (filter.statuses?.length) {
      where.push(`status IN (${filter.statuses.map(() => "?").join(",")})`);
      params.push(...filter.statuses);
    }
    const rows = all<JobRow>(
      this.db,
      `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`,
      ...params,
      Math.min(Math.max(filter.limit ?? 100, 1), 1000),
    );
    return rows.map(toJob);
  }

  /**
   * Atomically claim the oldest runnable job (SELECT + UPDATE inside one BEGIN IMMEDIATE, so two workers can never
   * claim the same row). Jobs sharing a serial_key (one conversation) never run concurrently.
   */
  claim(workerId: string, leaseMs: number, types?: JobType[]): ClaimedJob | null {
    return tx(this.db, () => {
      const now = nowIso();
      const typeFilter = types?.length ? `AND type IN (${types.map(() => "?").join(",")})` : "";
      const row = one<JobRow>(
        this.db,
        `SELECT * FROM jobs j WHERE status IN ('queued','retrying') AND run_after <= ? AND cancel_requested = 0 ${typeFilter}
           AND (serial_key IS NULL OR NOT EXISTS (SELECT 1 FROM jobs r WHERE r.serial_key = j.serial_key AND r.status = 'running'))
           AND (serial_key IS NULL OR NOT EXISTS (SELECT 1 FROM jobs e WHERE e.serial_key = j.serial_key AND e.status IN ('queued','retrying') AND e.created_at < j.created_at))
         ORDER BY created_at LIMIT 1`,
        now,
        ...(types ?? []),
      );
      if (!row) return null;
      const lease = new Date(Date.now() + leaseMs).toISOString();
      run(
        this.db,
        `UPDATE jobs SET status='running', attempts = attempts + 1, lease_owner = ?, lease_expires_at = ?, started_at = COALESCE(started_at, ?), updated_at = ?
         WHERE id = ?`,
        workerId,
        lease,
        now,
        now,
        row.id,
      );
      run(
        this.db,
        "INSERT INTO job_attempts (id, job_id, attempt, worker_id, started_at) VALUES (?,?,?,?,?)",
        newId("att"),
        row.id,
        row.attempts + 1,
        workerId,
        now,
      );
      return {
        id: row.id,
        projectId: row.project_id,
        type: row.type,
        payload: parseJson(row.payload, {}),
        attempt: row.attempts + 1,
        maxAttempts: row.max_attempts,
        createdBy: row.created_by,
        correlationId: row.correlation_id,
      };
    });
  }

  /** Extend the lease. Returns false if the job is no longer ours; cancelRequested tells the runner to abort. */
  heartbeat(jobId: string, workerId: string, leaseMs: number): { owned: boolean; cancelRequested: boolean } {
    const lease = new Date(Date.now() + leaseMs).toISOString();
    const r = run(
      this.db,
      "UPDATE jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND lease_owner = ? AND status = 'running'",
      lease,
      nowIso(),
      jobId,
      workerId,
    );
    const row = one<{ cancel_requested: number }>(this.db, "SELECT cancel_requested FROM jobs WHERE id = ?", jobId);
    return { owned: r.changes === 1, cancelRequested: row?.cancel_requested === 1 };
  }

  /** Progress from the lease holder only; a worker that lost its lease cannot overwrite the new holder's progress. */
  setProgress(jobId: string, stage: string, detail?: string, workerId?: string): void {
    const progress = JSON.stringify({ stage, detail });
    if (workerId) {
      run(this.db, "UPDATE jobs SET progress = ?, updated_at = ? WHERE id = ? AND lease_owner = ? AND status = 'running'", progress, nowIso(), jobId, workerId);
    } else {
      run(this.db, "UPDATE jobs SET progress = ?, updated_at = ? WHERE id = ?", progress, nowIso(), jobId);
    }
  }

  private finishAttempt(jobId: string, workerId: string, outcome: string, code: string | null, message: string | null): void {
    run(
      this.db,
      `UPDATE job_attempts SET finished_at = ?, outcome = ?, error_code = ?, error_message = ?
       WHERE job_id = ? AND worker_id = ? AND finished_at IS NULL`,
      nowIso(),
      outcome,
      code,
      message,
      jobId,
      workerId,
    );
  }

  /** Record success from the lease holder. Returns false (and changes nothing) when this worker lost the lease. */
  complete(jobId: string, workerId: string, status: JobStatus, result: unknown): boolean {
    if (!TERMINAL_JOB_STATUSES.includes(status) || status === "failed" || status === "cancelled") {
      throw new Error(`complete() needs a success-like terminal status, got ${status}`);
    }
    return tx(this.db, () => {
      const now = nowIso();
      const r = run(
        this.db,
        `UPDATE jobs SET status = ?, result = ?, lease_owner = NULL, lease_expires_at = NULL, finished_at = ?, updated_at = ?,
           error_code = NULL, error_message = NULL WHERE id = ? AND lease_owner = ? AND status = 'running'`,
        status,
        JSON.stringify(result ?? null),
        now,
        now,
        jobId,
        workerId,
      );
      if (r.changes !== 1) {
        this.finishAttempt(jobId, workerId, "stale_result_discarded", "LEASE_LOST", "lease lost before completion");
        return false;
      }
      this.finishAttempt(jobId, workerId, status, null, null);
      return true;
    });
  }

  /**
   * Record a failure from the lease holder. Transient (retryable) codes retry with exponential backoff and jitter
   * until max_attempts; permanent codes and exhausted retries fail the job and write a durable dead-letter record.
   * A worker that no longer holds the lease changes nothing and gets the job's current status back.
   */
  fail(jobId: string, workerId: string, code: ErrorCode, message: string): JobStatus {
    return tx(this.db, () => {
      const row = one<JobRow>(this.db, "SELECT * FROM jobs WHERE id = ?", jobId);
      if (!row) return "failed";
      const msg = sanitizeDiagnostic(message);
      if (row.status !== "running" || row.lease_owner !== workerId) {
        this.finishAttempt(jobId, workerId, "stale_failure_discarded", code, msg);
        return row.status;
      }
      const now = nowIso();
      const retryable = RETRYABLE_ERROR_CODES.includes(code);
      let status: JobStatus;
      if (code === "JOB_CANCELLED" || row.cancel_requested === 1) status = "cancelled";
      else if (retryable && row.attempts < row.max_attempts) status = "retrying";
      else status = "failed";
      const runAfter = status === "retrying" ? new Date(Date.now() + backoffDelayMs(row.attempts, this.options)).toISOString() : row.run_after;
      run(
        this.db,
        `UPDATE jobs SET status = ?, error_code = ?, error_message = ?, run_after = ?, lease_owner = NULL, lease_expires_at = NULL,
           finished_at = CASE WHEN ? IN ('failed','cancelled') THEN ? ELSE NULL END, updated_at = ? WHERE id = ?`,
        status,
        code,
        msg,
        runAfter,
        status,
        now,
        now,
        jobId,
      );
      this.finishAttempt(jobId, workerId, status, code, msg);
      if (status === "failed") this.deadLetter(row, retryable ? "attempts_exhausted" : "permanent_error", code, msg);
      return status;
    });
  }

  /** Must run inside tx(). One record per job; a replayed job that fails again refreshes it. */
  private deadLetter(row: JobRow, reason: DeadLetter["reason"], code: string, message: string): void {
    const history = all(
      this.db,
      "SELECT attempt, worker_id, started_at, finished_at, outcome, error_code, error_message FROM job_attempts WHERE job_id = ? ORDER BY started_at, attempt",
      row.id,
    );
    run(
      this.db,
      `INSERT INTO dead_letters (id, job_id, project_id, job_type, reason, error_code, error_message, attempts, attempt_history, dead_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(job_id) DO UPDATE SET reason = excluded.reason, error_code = excluded.error_code, error_message = excluded.error_message,
         attempts = excluded.attempts, attempt_history = excluded.attempt_history, dead_at = excluded.dead_at, replayed_at = NULL, replayed_by = NULL`,
      newId("dlq"),
      row.id,
      row.project_id,
      row.type,
      reason,
      code,
      message,
      row.attempts,
      JSON.stringify(history),
      nowIso(),
    );
  }

  /** Worker shutting down: put the job back without counting it as a failure. */
  release(jobId: string, workerId: string): void {
    tx(this.db, () => {
      run(
        this.db,
        `UPDATE jobs SET status = CASE WHEN cancel_requested = 1 THEN 'cancelled' ELSE 'queued' END,
           attempts = CASE WHEN cancel_requested = 1 THEN attempts ELSE MAX(attempts - 1, 0) END,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = ?,
           finished_at = CASE WHEN cancel_requested = 1 THEN ? ELSE NULL END
         WHERE id = ? AND lease_owner = ? AND status = 'running'`,
        nowIso(),
        nowIso(),
        jobId,
        workerId,
      );
      this.finishAttempt(jobId, workerId, "released", null, "worker shutdown");
    });
  }

  requestCancel(jobId: string): Job {
    return tx(this.db, () => {
      const row = one<JobRow>(this.db, "SELECT * FROM jobs WHERE id = ?", jobId);
      if (!row) throw new AppError("JOB_NOT_FOUND", "job not found");
      if (TERMINAL_JOB_STATUSES.includes(row.status)) return toJob(row);
      const now = nowIso();
      if (row.status === "running") {
        run(this.db, "UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?", now, jobId);
      } else {
        run(
          this.db,
          "UPDATE jobs SET cancel_requested = 1, status = 'cancelled', error_code = 'JOB_CANCELLED', error_message = 'cancelled before start', finished_at = ?, updated_at = ? WHERE id = ?",
          now,
          now,
          jobId,
        );
      }
      return this.get(jobId);
    });
  }

  /**
   * Operator replay of a failed (dead-lettered) or cancelled job: human only, audited, safe to repeat.
   * The same job row is re-queued, so its idempotency key, dedupe key and payload (input revision) are unchanged and
   * the handlers' business-level deduplication applies. If another active job already performs the same operation,
   * that job is returned and nothing is re-queued. Replaying a job that is already queued, retrying or running returns
   * it unchanged, so a double click or a retried request has no extra effect.
   */
  replay(
    principal: Principal,
    jobId: string,
    opts: { projectId?: string; correlationId?: string } = {},
  ): { job: Job; replayed: boolean; duplicate_of?: string } {
    assertHuman(principal);
    return tx(this.db, () => {
      const row = one<JobRow>(this.db, "SELECT * FROM jobs WHERE id = ?", jobId);
      if (!row || (opts.projectId && row.project_id !== opts.projectId)) throw new AppError("JOB_NOT_FOUND", "job not found");
      if (["queued", "running", "retrying"].includes(row.status)) return { job: toJob(row), replayed: false };
      if (!["failed", "cancelled"].includes(row.status)) throw new AppError("INVALID_TRANSITION", `cannot replay a ${row.status} job`);
      if (row.dedupe_key) {
        const active = one<JobRow>(this.db, "SELECT * FROM jobs WHERE dedupe_key = ? AND status IN ('queued','running','retrying')", row.dedupe_key);
        if (active) return { job: toJob(active), replayed: false, duplicate_of: active.id };
      }
      const now = nowIso();
      run(
        this.db,
        "UPDATE jobs SET status='queued', attempts=0, cancel_requested=0, error_code=NULL, error_message=NULL, run_after=?, finished_at=NULL, updated_at=? WHERE id=?",
        now,
        now,
        jobId,
      );
      run(
        this.db,
        "UPDATE dead_letters SET replay_count = replay_count + 1, replayed_at = ?, replayed_by = ? WHERE job_id = ?",
        now,
        principal.username,
        jobId,
      );
      audit(this.db, {
        principal,
        projectId: row.project_id,
        action: "job.replayed",
        entityType: "job",
        entityId: jobId,
        details: { job_type: row.type, previous_status: row.status, previous_error: row.error_code },
        correlationId: opts.correlationId ?? null,
      });
      return { job: this.get(jobId), replayed: true };
    });
  }

  /** Backwards-compatible alias used by the REST retry route; same rules as replay(). */
  retry(principal: Principal, jobId: string, opts: { projectId?: string; correlationId?: string } = {}): Job {
    return this.replay(principal, jobId, opts).job;
  }

  listDeadLetters(filter: { projectId?: string; includeReplayed?: boolean; limit?: number } = {}): DeadLetter[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.projectId) {
      where.push("d.project_id = ?");
      params.push(filter.projectId);
    }
    if (!filter.includeReplayed) where.push("d.replayed_at IS NULL");
    const rows = all<Record<string, unknown>>(
      this.db,
      `SELECT d.*, j.status AS job_status FROM dead_letters d JOIN jobs j ON j.id = d.job_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY d.dead_at DESC LIMIT ?`,
      ...params,
      Math.min(Math.max(filter.limit ?? 100, 1), 500),
    );
    return rows.map((r) => ({ ...(r as unknown as DeadLetter), attempt_history: parseJson(r.attempt_history as string, []) }));
  }

  /** Requeue jobs whose worker died or stalled (lease expired). Called by every worker on start and periodically. */
  recoverExpiredLeases(): number {
    return tx(this.db, () => {
      const now = nowIso();
      const rows = all<JobRow>(this.db, "SELECT * FROM jobs WHERE status = 'running' AND lease_expires_at < ?", now);
      for (const r of rows) {
        const status: JobStatus = r.cancel_requested === 1 ? "cancelled" : r.attempts < r.max_attempts ? "retrying" : "failed";
        const runAfter = status === "retrying" ? new Date(Date.now() + backoffDelayMs(r.attempts, this.options)).toISOString() : now;
        const msg = "worker stopped or stalled while running this job (lease expired)";
        run(
          this.db,
          `UPDATE jobs SET status = ?, lease_owner = NULL, lease_expires_at = NULL, error_code = 'LEASE_LOST', error_message = ?, run_after = ?,
             updated_at = ?, finished_at = CASE WHEN ? IN ('failed','cancelled') THEN ? ELSE NULL END WHERE id = ?`,
          status,
          msg,
          runAfter,
          now,
          status,
          now,
          r.id,
        );
        run(
          this.db,
          "UPDATE job_attempts SET finished_at = ?, outcome = 'lease_expired', error_code = 'LEASE_LOST' WHERE job_id = ? AND finished_at IS NULL",
          now,
          r.id,
        );
        if (status === "failed") this.deadLetter(r, "lease_expired", "LEASE_LOST", msg);
      }
      return rows.length;
    });
  }
}
