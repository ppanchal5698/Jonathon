import { createHash, randomBytes } from "node:crypto";
import { type ErrorCode, ERROR_HTTP_STATUS } from "@jonathon/contracts";

// ---------- ids ----------
const B32 = "0123456789abcdefghjkmnpqrstvwxyz";

function encodeTime(ms: number, len: number): string {
  let out = "";
  let n = ms;
  for (let i = 0; i < len; i++) {
    out = B32[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

/** Time-sortable opaque ID: <prefix>_<10 time chars><16 random chars>. */
export function newId(prefix: string): string {
  const rnd = randomBytes(16);
  let r = "";
  for (let i = 0; i < 16; i++) r += B32[(rnd[i] ?? 0) % 32];
  return `${prefix}_${encodeTime(Date.now(), 10)}${r}`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function nowIso(): string {
  return new Date().toISOString();
}

// ---------- errors ----------
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;
  readonly retryable: boolean;
  constructor(code: ErrorCode, message: string, opts: { details?: unknown; retryable?: boolean; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.status = ERROR_HTTP_STATUS[code];
    this.details = opts.details;
    this.retryable = opts.retryable ?? false;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export function toAppError(e: unknown): AppError {
  if (isAppError(e)) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new AppError("INTERNAL", msg, { cause: e });
}

// ---------- misc ----------
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AppError("JOB_CANCELLED", "cancelled"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new AppError("JOB_CANCELLED", "cancelled"));
      },
      { once: true },
    );
  });
}

export function parseJson<T = unknown>(s: string | null | undefined, fallback: T): T {
  if (s == null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** Collapse whitespace and lowercase for tolerant excerpt matching. */
export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Simple async mutex keyed by string (in-process coordination only). */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => next);
    this.tails.set(key, tail);
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
