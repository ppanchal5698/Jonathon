// Worker-thread entry for document parsing. Runs parsers off the main thread so a hostile or huge
// document can be time-limited (terminate) and memory-limited (resourceLimits) without affecting the process.
import { parentPort, workerData } from "node:worker_threads";

try {
  const { register } = await import("tsx/esm/api");
  register();
} catch {
  // Already running under a TypeScript-aware loader (e.g. Vitest).
}

const { extractDocument } = await import("./extract.ts");
try {
  const result = await extractDocument(new Uint8Array(workerData.bytes), workerData.kind);
  parentPort.postMessage({ ok: true, result });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String(e?.message ?? e).slice(0, 500) });
}
