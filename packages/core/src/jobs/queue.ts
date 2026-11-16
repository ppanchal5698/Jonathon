import { type ErrorCode, type Job, type JobStatus, type JobType, RETRYABLE_ERROR_CODES, TERMINAL_JOB_STATUSES } from "@jonathon/contracts";
import { all, type Db, one, run, tx } from "../db";
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

const BACKOFF_MS = [2_000, 10_000, 60_000];

export class JobQueue {
  constructor(private readonly db: Db) {}

  enqueue(input: {
    projectId: string;
    type: JobType;
    payload: Record<string, unknown>;
    createdBy: string;
    idempotencyKey?: string | null;
    serialKey?: string | null;
    maxAttempts?: number;
    correlationId?: string | null;
  }): Job {
    return tx(this.db, () => {
      if (input.idempotencyKey) {
        const existing = one<JobRow>(this.db, "SELECT * FROM jobs WHERE idempotency_key = ?", input.idempotencyKey);
        if (existing) {
          if (existing.project_id !== input.projectId || existing.type !== input.type) {
            throw new AppError("VALIDATION_FAILED", "request_id was already used for a different request");
          }
          return toJob(existing);
        }
      }
      const id = newId("job");
      const now = nowIso();
      run(
        this.db,
        `INSERT INTO jobs (id, project_id, type, status, payload, attempts, max_attempts, run_after, idempotency_key, serial_key, created_by, correlation_id, created_at, updated_at)
         VALUES (?,?,?,'queued',?,0,?,?,?,?,?,?,?,?)`,
        id,
        input.projectId,
        input.type,
        JSON.stringify(input.payload),
        input.maxAttempts ?? 3,
        now,
        input.idempotencyKey ?? null,
        input.serialKey ?? null,
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

  list(filter: { projectId?: string; statuses?: JobStatus[]; limit?: number } = {}): Job[] {
    const rows = filter.projectId
      ? all<JobRow>(this.db, "SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?", filter.projectId, filter.limit ?? 100)
      : all<JobRow>(this.db, "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", filter.limit ?? 100);
    return rows.filter((r) => !filter.statuses || filter.statuses.includes(r.status)).map(toJob);
  }

  /**
   * Atomically claim the oldest runnable job. Jobs sharing a serial_key (one conversation) never run
   * concurrently, which serializes turns within a conversation.
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

  setProgress(jobId: string, stage: string, detail?: string): void {
    run(this.db, "UPDATE jobs SET progress = ?, updated_at = ? WHERE id = ?", JSON.stringify({ stage, detail }), nowIso(), jobId);
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

  complete(jobId: string, workerId: string, status: JobStatus, result: unknown): void {
    if (!TERMINAL_JOB_STATUSES.includes(status) || status === "failed" || status === "cancelled") {
      throw new Error(`complete() needs a success-like terminal status, got ${status}`);
    }
    tx(this.db, () => {
      const now = nowIso();
      run(
        this.db,
        `UPDATE jobs SET status = ?, result = ?, lease_owner = NULL, lease_expires_at = NULL, finished_at = ?, updated_at = ?,
           error_code = NULL, error_message = NULL WHERE id = ? AND lease_owner = ?`,
        status,
        JSON.stringify(result ?? null),
        now,
        now,
        jobId,
        workerId,
      );
      this.finishAttempt(jobId, workerId, status, null, null);
    });
  }

  /** Record a failure; retries retryable errors with backoff until max_attempts. */
  fail(jobId: string, workerId: string, code: ErrorCode, message: string): JobStatus {
    return tx(this.db, () => {
      const row = one<JobRow>(this.db, "SELECT * FROM jobs WHERE id = ?", jobId);
      if (!row) return "failed";
      const now = nowIso();
      let status: JobStatus;
      if (code === "JOB_CANCELLED" || row.cancel_requested === 1) status = "cancelled";
      else if (RETRYABLE_ERROR_CODES.includes(code) && row.attempts < row.max_attempts) status = "retrying";
      else status = "failed";
      const runAfter = status === "retrying" ? new Date(Date.now() + (BACKOFF_MS[row.attempts - 1] ?? 60_000)).toISOString() : row.run_after;
      run(
        this.db,
        `UPDATE jobs SET status = ?, error_code = ?, error_message = ?, run_after = ?, lease_owner = NULL, lease_expires_at = NULL,
           finished_at = CASE WHEN ? IN ('failed','cancelled') THEN ? ELSE NULL END, updated_at = ? WHERE id = ?`,
        status,
        code,
        message.slice(0, 2_000),
        runAfter,
        status,
        now,
        now,
        jobId,
      );
      this.finishAttempt(jobId, workerId, status, code, message.slice(0, 2_000));
      return status;
    });
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

  retry(jobId: string): Job {
    return tx(this.db, () => {
      const row = one<JobRow>(this.db, "SELECT * FROM jobs WHERE id = ?", jobId);
      if (!row) throw new AppError("JOB_NOT_FOUND", "job not found");
      if (!["failed", "cancelled"].includes(row.status)) throw new AppError("INVALID_TRANSITION", `cannot retry a ${row.status} job`);
      run(
        this.db,
        `UPDATE jobs SET status='queued', attempts=0, cancel_requested=0, error_code=NULL, error_message=NULL, run_after=?, finished_at=NULL, updated_at=? WHERE id=?`,
        nowIso(),
        nowIso(),
        jobId,
      );
      return this.get(jobId);
    });
  }

  /** Requeue jobs whose worker died (lease expired). Called by every worker on start and periodically. */
  recoverExpiredLeases(): number {
    return tx(this.db, () => {
      const now = nowIso();
      const rows = all<JobRow>(this.db, "SELECT * FROM jobs WHERE status = 'running' AND lease_expires_at < ?", now);
      for (const r of rows) {
        const status: JobStatus = r.cancel_requested === 1 ? "cancelled" : r.attempts < r.max_attempts ? "retrying" : "failed";
        run(
          this.db,
          `UPDATE jobs SET status = ?, lease_owner = NULL, lease_expires_at = NULL, error_code = 'ANTIGRAVITY_UNAVAILABLE',
             error_message = 'worker stopped while running this job (lease expired)', run_after = ?, updated_at = ?,
             finished_at = CASE WHEN ? IN ('failed','cancelled') THEN ? ELSE NULL END WHERE id = ?`,
          status,
          now,
          now,
          status,
          now,
          r.id,
        );
        run(
          this.db,
          "UPDATE job_attempts SET finished_at = ?, outcome = 'lease_expired' WHERE job_id = ? AND finished_at IS NULL",
          now,
          r.id,
        );
      }
      return rows.length;
    });
  }
}
