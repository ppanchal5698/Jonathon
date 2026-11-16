import type { SchemaName } from "./policy";

export interface RuntimeRunRequest {
  projectId: string;
  /** Full user-message text (instructions + fenced evidence). Sent on stdin, never on the command line. */
  prompt: string;
  schema: SchemaName;
  /** Provider conversation to resume (from Jonathon's explicit mapping). Never "most recent". */
  resumeConversationId?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Progress callback with sanitized, real stream events only. */
  onProgress?: (stage: string) => void;
}

export type RuntimeCompletion = "success" | "error" | "cancelled" | "timeout" | "permission_denied" | "policy_violation";

/** Application-level view of one runtime turn (three layers kept apart: envelope, model payload, app schema). */
export interface NormalizedRuntimeResult {
  provider: "antigravity-cli" | "demo-extractive";
  runtimeVersion: string | null;
  model: string | null;
  /** Provider conversation ID. Internal: stored in runtime_sessions, never returned to clients. */
  conversationId: string | null;
  requestedConversationId: string | null;
  /** True when a resume was requested but the provider started a different conversation. */
  contextRebuilt: boolean;
  completion: RuntimeCompletion;
  envelopeStatus: string | null;
  finishedReason: string | null;
  text: string;
  /** Model payload (envelope `structured_output`). NOT yet validated against the application schema. */
  structured: unknown;
  usage: Record<string, number> | null;
  warnings: string[];
  permissionDenials: string[];
  durationMs: number;
  exitCode: number | null;
}

export interface InstallationInfo {
  installed: boolean;
  executable: string;
  version: string | null;
  error: string | null;
}

export interface CapabilityInfo {
  compatible: boolean;
  flags: Record<string, boolean>;
  missing: string[];
  globalRuleFiles: string[];
  notes: string[];
}

export interface AuthInfo {
  status: "authenticated" | "auth_required" | "unknown";
  detail: string;
  /** This check contacts the model provider (lists models). It sends no client content. */
  contactsProvider: true;
}

export interface ReasoningRuntime {
  readonly provider: NormalizedRuntimeResult["provider"];
  inspectInstallation(): Promise<InstallationInfo>;
  checkAuthentication(): Promise<AuthInfo>;
  inspectCapabilities(): Promise<CapabilityInfo>;
  run(req: RuntimeRunRequest): Promise<NormalizedRuntimeResult>;
  resume(conversationId: string, req: RuntimeRunRequest): Promise<NormalizedRuntimeResult>;
  /** Cancel every in-flight run for a project (or all). Kills process trees. */
  cancel(projectId?: string): Promise<number>;
  /** Resolve lazily-discovered facts (CLI version) so configHash() is stable. Cheap after the first call. */
  prepare(): Promise<void>;
  /** Identifies config (CLI version, model, policy files) that, if changed, requires a new provider conversation. */
  configHash(): string;
}
