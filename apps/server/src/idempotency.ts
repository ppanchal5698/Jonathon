import { createHash } from "node:crypto";
import { AppError, type JonathonApp, nowIso, tx } from "@jonathon/core";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Idempotency-Key support for retryable REST mutations (POST/PUT/PATCH/DELETE on signed-in routes).
 *
 * - Scope: the signed-in user. Fingerprint: SHA-256 of method, path + query and the JSON body.
 * - First request with a key: a row is inserted as `in_progress` inside BEGIN IMMEDIATE (the primary key makes the
 *   claim atomic across processes), then the handler runs and the response is stored as `completed`.
 * - Same key + same fingerprint after completion: the stored status and body are replayed (header Idempotent-Replayed).
 * - Same key + different fingerprint: 422 IDEMPOTENCY_CONFLICT. Nothing runs.
 * - Same key while the first request is still running: 429 RATE_LIMITED with Retry-After; nothing runs twice.
 *   An `in_progress` row older than STALE_MS (the API crashed mid-request) may be taken over.
 * - 5xx responses are not stored, so the client can retry with the same key; 2xx/4xx are stored.
 * - Records expire after TTL_MS and are purged lazily.
 * - Multipart uploads are excluded: identical files are already deduplicated by content hash (UNIQUE(project_id, content_hash)).
 */
const TTL_MS = 24 * 3_600_000;
const STALE_MS = 120_000;
const MAX_STORED_BYTES = 1024 * 1024;
const KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

declare module "fastify" {
  interface FastifyRequest {
    idempotency?: { scope: string; key: string };
  }
}

export function fingerprint(req: FastifyRequest): string {
  const body = req.body === undefined ? "" : JSON.stringify(req.body);
  return createHash("sha256").update(`${req.method} ${req.url}\n${body}`).digest("hex");
}

/** preHandler step, after authentication. Returns the reply when it already answered (replay). */
export function beginIdempotent(app: JonathonApp, req: FastifyRequest, reply: FastifyReply): FastifyReply | undefined {
  const raw = req.headers["idempotency-key"];
  if (raw === undefined) return undefined;
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return undefined;
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!key || !KEY_RE.test(key)) throw new AppError("VALIDATION_FAILED", "Idempotency-Key must be 8-128 characters of A-Z a-z 0-9 _ . : -");
  if (req.isMultipart()) {
    throw new AppError("VALIDATION_FAILED", "Idempotency-Key is not supported for uploads; identical files are already deduplicated by content");
  }
  const principal = req.principal;
  if (principal?.kind !== "user") return undefined;
  const scope = `user:${principal.userId}`;
  const fp = fingerprint(req);
  const db = app.ctx.db;
  const now = Date.now();
  const outcome = tx(db, () => {
    db.prepare("DELETE FROM http_idempotency WHERE rowid IN (SELECT rowid FROM http_idempotency WHERE expires_at < ? LIMIT 100)").run(nowIso());
    const row = db.prepare("SELECT * FROM http_idempotency WHERE scope = ? AND key = ?").get(scope, key) as
      | { fingerprint: string; state: string; status_code: number | null; response: string | null; created_at: string }
      | undefined;
    if (!row) {
      db.prepare("INSERT INTO http_idempotency (scope, key, fingerprint, state, created_at, expires_at) VALUES (?,?,?,'in_progress',?,?)").run(
        scope,
        key,
        fp,
        new Date(now).toISOString(),
        new Date(now + TTL_MS).toISOString(),
      );
      return { kind: "execute" as const };
    }
    if (row.fingerprint !== fp) return { kind: "conflict" as const };
    if (row.state === "completed") return { kind: "replay" as const, status: row.status_code ?? 200, response: row.response };
    if (now - Date.parse(row.created_at) > STALE_MS) {
      db.prepare("UPDATE http_idempotency SET created_at = ? WHERE scope = ? AND key = ?").run(new Date(now).toISOString(), scope, key);
      return { kind: "execute" as const };
    }
    return { kind: "busy" as const };
  });
  if (outcome.kind === "conflict") throw new AppError("IDEMPOTENCY_CONFLICT", "this Idempotency-Key was already used for a different request");
  if (outcome.kind === "busy") {
    reply.header("Retry-After", "1");
    throw new AppError("RATE_LIMITED", "a request with this Idempotency-Key is still being processed");
  }
  if (outcome.kind === "replay") {
    reply.header("Idempotent-Replayed", "true");
    reply.status(outcome.status).type("application/json; charset=utf-8");
    return reply.send(outcome.response ?? JSON.stringify({ data: null }));
  }
  req.idempotency = { scope, key };
  return undefined;
}

/** onSend hook: store the final response (or forget the key on 5xx so the client may retry). */
export function finishIdempotent(app: JonathonApp, req: FastifyRequest, reply: FastifyReply, payload: unknown): void {
  const idem = req.idempotency;
  if (!idem) return;
  req.idempotency = undefined;
  const db = app.ctx.db;
  try {
    if (reply.statusCode >= 500) {
      db.prepare("DELETE FROM http_idempotency WHERE scope = ? AND key = ? AND state = 'in_progress'").run(idem.scope, idem.key);
      return;
    }
    const text = typeof payload === "string" ? payload : Buffer.isBuffer(payload) ? payload.toString("utf8") : null;
    const stored = text !== null && Buffer.byteLength(text) <= MAX_STORED_BYTES ? text : null;
    db.prepare("UPDATE http_idempotency SET state = 'completed', status_code = ?, response = ? WHERE scope = ? AND key = ?").run(
      reply.statusCode,
      stored,
      idem.scope,
      idem.key,
    );
  } catch (e) {
    req.log.warn({ err: (e as Error).message }, "could not record idempotent response");
  }
}
