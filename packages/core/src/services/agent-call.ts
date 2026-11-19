import type { z } from "zod";
import type { JobContext } from "../jobs/worker";
import type { SchemaName } from "../runtime/policy";
import { AppError } from "../util";
import type { Ctx } from "./context";

/** Per-job record of which agents ran and how long they took. */
export type AgentLog = Partial<Record<SchemaName, { runs: number; ms: number }>>;

export const AGENT_LABELS: Partial<Record<SchemaName, string>> = {
  graph: "graph extractor",
  doc_writer: "technical writer",
  doc_verifier: "document verifier",
};

/**
 * Run one tool-free agent and validate its output against its own schema. Any failure throws a typed error:
 * nothing unvalidated reaches storage.
 */
export async function callAgent<T>(
  ctx: Ctx,
  jc: JobContext,
  projectId: string,
  schema: SchemaName,
  parser: z.ZodType<T>,
  prompt: string,
  log: AgentLog,
  label?: string,
  timeoutMs?: number,
): Promise<T> {
  const name = label ?? AGENT_LABELS[schema] ?? schema;
  const started = Date.now();
  const rt = await ctx.runtime.run({ projectId, prompt, schema, signal: jc.signal, timeoutMs, onProgress: (s) => jc.progress(`${name}: ${s}`) });
  const prev = log[schema] ?? { runs: 0, ms: 0 };
  log[schema] = { runs: prev.runs + 1, ms: prev.ms + (Date.now() - started) };
  if (rt.completion === "permission_denied") throw new AppError("ANTIGRAVITY_PERMISSION_DENIED", `${name} attempted denied actions; output discarded`);
  if (rt.completion === "cancelled") throw new AppError("JOB_CANCELLED", "cancelled");
  if (rt.completion !== "success") throw new AppError("ANTIGRAVITY_UNAVAILABLE", `${name} returned ${rt.envelopeStatus ?? "an error"}`, { retryable: true });
  const parsed = parser.safeParse(rt.structured);
  if (!parsed.success) {
    throw new AppError("INVALID_MODEL_OUTPUT", `${name} output did not match its schema`, { details: parsed.error.issues.slice(0, 5), retryable: true });
  }
  return parsed.data;
}
