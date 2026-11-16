import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { AppError } from "../util";
import type { DocKind } from "./detect";
import { type ExtractionOutcome, extractDocument } from "./extract";

export interface ExtractionLimits {
  timeoutMs: number;
  maxHeapMb?: number;
  /** Tests may disable the worker thread; production always isolates parsers. */
  inline?: boolean;
}

/**
 * Run a parser in a worker thread with a wall-clock timeout and a heap limit.
 * Cancellation via AbortSignal terminates the worker.
 */
export async function runExtraction(bytes: Uint8Array, kind: DocKind, limits: ExtractionLimits, signal?: AbortSignal): Promise<ExtractionOutcome> {
  if (["text", "markdown", "json", "image", "unsupported"].includes(kind) || limits.inline) {
    return withTimeout(extractDocument(bytes, kind), limits.timeoutMs, signal);
  }
  const url = new URL("./extract-worker.mjs", import.meta.url);
  const copy = new Uint8Array(bytes); // transfer a copy
  const worker = new Worker(fileURLToPath(url), {
    workerData: { bytes: copy.buffer, kind },
    transferList: [copy.buffer],
    resourceLimits: { maxOldGenerationSizeMb: limits.maxHeapMb ?? 768, maxYoungGenerationSizeMb: 64 },
    stdout: true,
    stderr: true,
  });
  return await new Promise<ExtractionOutcome>((resolve, reject) => {
    let finished = false;
    const end = (fn: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(
      () => end(() => reject(new AppError("EXTRACTION_FAILED", `parser exceeded ${limits.timeoutMs} ms and was stopped`))),
      limits.timeoutMs,
    );
    const onAbort = () => end(() => reject(new AppError("JOB_CANCELLED", "cancelled")));
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.on("message", (m: { ok: boolean; result?: ExtractionOutcome; error?: string }) =>
      end(() => (m.ok ? resolve(m.result!) : reject(new AppError("EXTRACTION_FAILED", m.error ?? "parser failed")))),
    );
    worker.on("error", (e) => end(() => reject(new AppError("EXTRACTION_FAILED", `parser crashed: ${e.message.slice(0, 200)}`))));
    worker.on("exit", (code) => end(() => reject(new AppError("EXTRACTION_FAILED", `parser exited (${code}), possibly over the memory limit`))));
  });
}

async function withTimeout<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, rej) => {
        t = setTimeout(() => rej(new AppError("EXTRACTION_FAILED", `parser exceeded ${ms} ms`)), ms);
        signal?.addEventListener("abort", () => rej(new AppError("JOB_CANCELLED", "cancelled")), { once: true });
      }),
    ]);
  } finally {
    clearTimeout(t);
  }
}
