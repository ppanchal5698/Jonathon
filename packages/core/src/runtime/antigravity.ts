import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../logger";
import { AppError } from "../util";
import { NdjsonParser } from "./ndjson";
import { AGENTS, EXTRACTION_EFFORT_SCHEMAS, type PolicyPaths, prepareWorkspace, writePolicyFiles } from "./policy";
import { killProcessTree, treeSpawnOptions } from "./process-tree";
import type {
  AuthInfo,
  CapabilityInfo,
  InstallationInfo,
  NormalizedRuntimeResult,
  ReasoningRuntime,
  RuntimeRunRequest,
} from "./types";

export interface AntigravityOptions {
  dataDir: string;
  executable: string;
  argsPrefix?: string[];
  model?: string;
  effort?: string;
  /** Effort for the extraction schema (see config AGY_EXTRACTION_EFFORT). Falls back to `effort`. */
  extractionEffort?: string;
  timeoutMs: number;
  maxOutputBytes: number;
  maxPromptChars: number;
  maxConcurrent?: number;
  /** Extra env for tests only (e.g. fixture scenario). Never used for secrets. */
  extraEnv?: Record<string, string>;
  log?: Logger;
}

/** Flags Jonathon depends on; all verified on agy 1.5.9 (docs/compatibility.md). */
export const REQUIRED_FLAGS = [
  "--input-format",
  "--output-format",
  "--json-schema",
  "--conversation",
  "--settings",
  "--agent",
  "--sandbox",
  "--disable-slash-commands",
] as const;

/** Environment passed to agy: system essentials plus the runtime's own credential variables, nothing of Jonathon's. */
const ENV_ALLOW = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "SystemDrive",
  "windir",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "USERNAME",
  "USERDOMAIN",
  "LANG",
  "LC_ALL",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  // agy's own authentication options (documented): API key or ADC. These belong to the runtime, not Jonathon.
  "GEMINI_API_KEY",
  "AGY_ADC_AUTH",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
];

export function runtimeEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ENV_ALLOW) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra };
}

/** Remove paths, tokens and long blobs from stderr before it is logged or shown. */
export function sanitizeStderr(s: string): string {
  return s
    .replace(/[A-Za-z]:\\[^\s"']+/g, "<path>")
    .replace(/\/(?:Users|home|tmp|var)\/[^\s"']+/g, "<path>")
    .replace(/(api[_-]?key|token|authorization|bearer)\s*[:=]?\s*\S+/gi, "$1 <redacted>")
    .replace(/[A-Za-z0-9_-]{40,}/g, "<redacted>")
    .slice(0, 2_000);
}

interface Running {
  child: ChildProcess;
  projectId: string;
}

export class AntigravityCliRuntime implements ReasoningRuntime {
  readonly provider = "antigravity-cli" as const;
  private policy: PolicyPaths;
  private running = new Set<Running>();
  /** Runs waiting for a free process slot (team agents run in parallel; the slot count caps agy processes). */
  private slotsInUse = 0;
  private waiters: Array<() => void> = [];
  private version: string | null = null;

  constructor(private readonly o: AntigravityOptions) {
    this.policy = writePolicyFiles(o.dataDir);
  }

  configHash(): string {
    return `${this.version ?? "unknown"}:${this.policy.configHash}:${this.o.model ?? "default"}:${this.o.effort ?? "default"}`;
  }

  private exec(args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; error?: NodeJS.ErrnoException }> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(this.o.executable, [...(this.o.argsPrefix ?? []), ...args], {
          shell: false,
          env: runtimeEnv(this.o.extraEnv),
          stdio: ["ignore", "pipe", "pipe"],
          ...treeSpawnOptions(),
        });
      } catch (e) {
        resolve({ code: null, stdout: "", stderr: "", error: e as NodeJS.ErrnoException });
        return;
      }
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d) => {
        if (stdout.length < 200_000) stdout += d;
      });
      child.stderr?.on("data", (d) => {
        if (stderr.length < 50_000) stderr += d;
      });
      const t = setTimeout(() => void killProcessTree(child), timeoutMs);
      child.on("error", (e) => {
        clearTimeout(t);
        resolve({ code: null, stdout, stderr, error: e as NodeJS.ErrnoException });
      });
      child.on("close", (code) => {
        clearTimeout(t);
        resolve({ code, stdout, stderr });
      });
    });
  }

  async inspectInstallation(): Promise<InstallationInfo> {
    const r = await this.exec(["--version"], 15_000);
    if (r.error) {
      return {
        installed: false,
        executable: this.o.executable,
        version: null,
        error: r.error.code === "ENOENT" ? "agy executable not found on PATH" : sanitizeStderr(r.error.message),
      };
    }
    const version = /(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1] ?? null;
    this.version = version;
    return { installed: r.code === 0 && !!version, executable: this.o.executable, version, error: r.code === 0 ? null : sanitizeStderr(r.stderr) };
  }

  async inspectCapabilities(): Promise<CapabilityInfo> {
    const r = await this.exec(["--help"], 15_000);
    const help = `${r.stdout}\n${r.stderr}`;
    const flags: Record<string, boolean> = {};
    for (const f of REQUIRED_FLAGS) flags[f] = new RegExp(`(^|\\s)${f.replace(/-/g, "\\-")}(\\s|$)`, "m").test(help);
    const missing = REQUIRED_FLAGS.filter((f) => !flags[f]);
    const home = homedir();
    const globalRuleFiles = [
      join(home, ".gemini", "GEMINI.md"),
      join(home, ".gemini", "AGENTS.md"),
      join(home, ".gemini", "config", "GEMINI.md"),
      join(home, ".gemini", "config", "AGENTS.md"),
      join(home, ".gemini", "config", "rules"),
    ]
      .filter((p) => existsSync(p))
      .map((p) => p.replace(home, "~"));
    const notes: string[] = [];
    if (globalRuleFiles.length) notes.push("Global agy rule files exist and are loaded into every run, including Jonathon's. Review them.");
    if (help.includes("--dangerously-skip-permissions")) notes.push("Jonathon never passes --dangerously-skip-permissions.");
    return { compatible: missing.length === 0, flags, missing, globalRuleFiles, notes };
  }

  async checkAuthentication(): Promise<AuthInfo> {
    const r = await this.exec(["models"], 30_000);
    const out = `${r.stdout}\n${r.stderr}`;
    if (r.error) return { status: "unknown", detail: "agy could not be started", contactsProvider: true };
    if (/auth|log ?in|sign ?in|credential/i.test(r.stderr) && r.code !== 0) {
      return { status: "auth_required", detail: "agy reports that authentication is required. Run `agy` once interactively and sign in.", contactsProvider: true };
    }
    const models = out.split("\n").filter((l) => /^[a-z0-9][a-z0-9._-]+\t/i.test(l.trim()) || /^[a-z0-9.-]+-[a-z0-9.-]+\s{1,}\S/.test(l));
    if (r.code === 0 && models.length > 0) return { status: "authenticated", detail: `${models.length} models available`, contactsProvider: true };
    return { status: "unknown", detail: sanitizeStderr(r.stderr) || "could not determine authentication state", contactsProvider: true };
  }

  async cancel(projectId?: string): Promise<number> {
    const targets = [...this.running].filter((r) => !projectId || r.projectId === projectId);
    await Promise.all(targets.map((r) => killProcessTree(r.child)));
    return targets.length;
  }

  resume(conversationId: string, req: RuntimeRunRequest): Promise<NormalizedRuntimeResult> {
    return this.run({ ...req, resumeConversationId: conversationId });
  }

  /** Wait for a process slot instead of refusing: several team agents may ask at once. */
  private async acquireSlot(signal?: AbortSignal): Promise<void> {
    const max = this.o.maxConcurrent ?? Number.POSITIVE_INFINITY;
    while (this.slotsInUse >= max) {
      if (signal?.aborted) throw new AppError("JOB_CANCELLED", "cancelled while waiting for the runtime");
      await new Promise<void>((resolve) => {
        const wake = () => {
          signal?.removeEventListener("abort", wake);
          resolve();
        };
        this.waiters.push(wake);
        signal?.addEventListener("abort", wake, { once: true });
      });
    }
    this.slotsInUse++;
  }

  private releaseSlot(): void {
    this.slotsInUse--;
    this.waiters.shift()?.();
  }

  async run(req: RuntimeRunRequest): Promise<NormalizedRuntimeResult> {
    if (req.prompt.length > this.o.maxPromptChars) {
      throw new AppError("VALIDATION_FAILED", `prompt exceeds the configured limit of ${this.o.maxPromptChars} characters`);
    }
    if (req.signal?.aborted) throw new AppError("JOB_CANCELLED", "cancelled before start");
    req.onProgress?.("waiting for a runtime slot");
    await this.acquireSlot(req.signal);
    try {
      return await this.runInSlot(req);
    } finally {
      this.releaseSlot();
    }
  }

  private async runInSlot(req: RuntimeRunRequest): Promise<NormalizedRuntimeResult> {
    if (req.resumeConversationId && !/^[0-9a-f-]{36}$/i.test(req.resumeConversationId)) {
      throw new AppError("INTERNAL", "invalid stored runtime conversation id");
    }
    this.policy = writePolicyFiles(this.o.dataDir);
    if (!this.version) await this.inspectInstallation();
    const ws = prepareWorkspace(this.o.dataDir, req.projectId);
    const warnings: string[] = [];
    if (ws.removed.length) warnings.push("unexpected files were removed from the runtime workspace before this run");

    const args = [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--agent",
      AGENTS[req.schema].name,
      "--settings",
      this.policy.settingsPath,
      "--json-schema",
      this.policy.schemaPath(req.schema),
      "--sandbox",
      "--disable-slash-commands",
    ];
    if (this.o.model) args.push("--model", this.o.model);
    const effort = EXTRACTION_EFFORT_SCHEMAS.has(req.schema) ? (this.o.extractionEffort ?? this.o.effort) : this.o.effort;
    if (effort) args.push("--effort", effort);
    if (req.resumeConversationId) args.push("--conversation", req.resumeConversationId);

    const started = Date.now();
    const timeoutMs = req.timeoutMs ?? this.o.timeoutMs;
    req.onProgress?.("starting runtime");

    return await new Promise<NormalizedRuntimeResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(this.o.executable, [...(this.o.argsPrefix ?? []), ...args], {
          cwd: ws.cwd,
          shell: false,
          env: runtimeEnv(this.o.extraEnv),
          stdio: ["pipe", "pipe", "pipe"],
          ...treeSpawnOptions(),
        });
      } catch (e) {
        reject(new AppError("ANTIGRAVITY_NOT_INSTALLED", "could not start agy", { cause: e }));
        return;
      }
      const entry: Running = { child, projectId: req.projectId };
      this.running.add(entry);

      let settled = false;
      let stdoutBytes = 0;
      let stderr = "";
      let initSeen = false;
      let conversationId: string | null = null;
      let model: string | null = null;
      let resultEvent: Record<string, unknown> | null = null;
      let textDeltas = "";
      const denials: string[] = [];
      let abortReason: { code: "JOB_CANCELLED" | "ANTIGRAVITY_TIMEOUT" | "ANTIGRAVITY_POLICY_VIOLATION" | "INVALID_RUNTIME_OUTPUT"; message: string } | null = null;

      const stop = (reason: NonNullable<typeof abortReason>) => {
        if (abortReason) return;
        abortReason = reason;
        void killProcessTree(child);
      };

      const timer = setTimeout(() => stop({ code: "ANTIGRAVITY_TIMEOUT", message: `runtime exceeded ${timeoutMs} ms` }), timeoutMs);
      const onAbort = () => stop({ code: "JOB_CANCELLED", message: "cancelled" });
      req.signal?.addEventListener("abort", onAbort, { once: true });

      const parser = new NdjsonParser(
        (rec) => {
          if (!rec || typeof rec !== "object") return;
          const ev = rec as Record<string, unknown>;
          if (ev.event === "init") {
            initSeen = true;
            const init = (ev.init ?? {}) as Record<string, unknown>;
            conversationId = typeof ev.conversation_id === "string" ? ev.conversation_id : null;
            model = typeof init.model === "string" ? init.model : null;
            // Stream guard (containment backstop; prevention is the agent tool list + session deny rules).
            if (init.agent !== AGENTS[req.schema].name) {
              stop({ code: "ANTIGRAVITY_POLICY_VIOLATION", message: `runtime did not start the restricted agent (got ${String(init.agent)})` });
            } else if (init.permission_mode !== "strict") {
              stop({ code: "ANTIGRAVITY_POLICY_VIOLATION", message: `unexpected permission mode ${String(init.permission_mode)}` });
            }
            req.onProgress?.("runtime started");
          } else if (ev.event === "step_update") {
            const st = (ev.step_update ?? {}) as Record<string, unknown>;
            if (st.step_type === "tool") {
              const info = (st.tool_info ?? {}) as Record<string, unknown>;
              const err = (info.error ?? {}) as Record<string, unknown>;
              if (typeof err.message === "string" && /denied|deny rule/i.test(err.message)) denials.push(String(st.tool_name ?? "tool"));
              stop({ code: "ANTIGRAVITY_POLICY_VIOLATION", message: `runtime attempted a tool (${String(st.tool_name ?? "unknown")}); Jonathon runs are tool-free` });
            } else if (st.step_type === "agent_response") {
              if (typeof st.text_delta === "string" && textDeltas.length < 200_000) textDeltas += st.text_delta;
              if (st.state === "ACTIVE") req.onProgress?.("model responding");
            }
          } else if (ev.event === "result") {
            resultEvent = (ev.result ?? {}) as Record<string, unknown>;
          }
        },
        () => stop({ code: "INVALID_RUNTIME_OUTPUT", message: "runtime emitted a non-JSON line on stdout" }),
      );

      child.stdout?.on("data", (d: Buffer) => {
        stdoutBytes += d.length;
        if (stdoutBytes > this.o.maxOutputBytes) {
          stop({ code: "INVALID_RUNTIME_OUTPUT", message: "runtime output exceeded the configured byte limit" });
          return;
        }
        parser.push(d);
      });
      child.stderr?.on("data", (d: Buffer) => {
        if (stderr.length < 20_000) stderr += d.toString("utf8");
      });
      child.stdin?.on("error", () => {
        /* EPIPE if the process exits early; handled via exit status */
      });

      child.on("error", (e: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.running.delete(entry);
        reject(
          e.code === "ENOENT"
            ? new AppError("ANTIGRAVITY_NOT_INSTALLED", "agy executable not found. Install Antigravity CLI and make sure `agy` is on PATH.")
            : new AppError("ANTIGRAVITY_UNAVAILABLE", "agy failed to start", { cause: e, retryable: true }),
        );
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
        this.running.delete(entry);
        parser.end();
        const cleanErr = sanitizeStderr(stderr);
        const durationMs = Date.now() - started;
        if (abortReason) {
          reject(new AppError(abortReason.code, abortReason.message, { retryable: abortReason.code === "ANTIGRAVITY_TIMEOUT" }));
          return;
        }
        if (/authentication required|not authenticated|please (log|sign) ?in/i.test(stderr)) {
          reject(new AppError("ANTIGRAVITY_AUTH_REQUIRED", "Antigravity CLI needs authentication. Run `agy` in a terminal and sign in."));
          return;
        }
        if (!initSeen || !resultEvent) {
          reject(
            new AppError(code === 0 ? "INVALID_RUNTIME_OUTPUT" : "ANTIGRAVITY_UNAVAILABLE", `runtime ended without a result (exit ${code})`, {
              details: { stderr: cleanErr },
              retryable: true,
            }),
          );
          return;
        }
        const normalized = this.normalizeResult({
          resultEvent,
          exitCode: code,
          stderr,
          conversationId,
          requestedConversationId: req.resumeConversationId ?? null,
          model,
          textDeltas,
          denials,
          durationMs,
          warnings,
        });
        resolve(normalized);
      });

      // One NDJSON user message on stdin, then close stdin (documented: ends the session after this turn).
      const line = `${JSON.stringify({ event: "user", message: { content: req.prompt } })}\n`;
      child.stdin?.end(line, "utf8");
    });
  }

  /** Map the CLI envelope to Jonathon's normalized result. Pure; unit-tested with recorded fixtures. */
  normalizeResult(input: {
    resultEvent: Record<string, unknown>;
    exitCode: number | null;
    stderr: string;
    conversationId: string | null;
    requestedConversationId: string | null;
    model: string | null;
    textDeltas: string;
    denials: string[];
    durationMs: number;
    warnings: string[];
  }): NormalizedRuntimeResult {
    const r = input.resultEvent;
    const warnings = [...input.warnings];
    const denials = [...input.denials];
    const denied = Array.isArray(r.denied_actions) ? r.denied_actions : [];
    for (const d of denied) {
      const o = (d ?? {}) as Record<string, unknown>;
      denials.push(String(o.display_name ?? o.action ?? "tool"));
    }
    if (/auto-denied|permission denied/i.test(input.stderr)) {
      if (!denials.length) denials.push("unspecified");
    }
    const status = typeof r.status === "string" ? r.status : null;
    const finishedReason = typeof r.finished_reason === "string" ? r.finished_reason : null;
    const convId = (typeof r.conversation_id === "string" && r.conversation_id) || input.conversationId;
    const contextRebuilt = !!input.requestedConversationId && convId !== input.requestedConversationId;
    if (contextRebuilt) warnings.push("runtime_context_rebuilt: the stored runtime conversation was not found; a new one was started with history rebuilt by Jonathon");
    if (/warning:/i.test(input.stderr)) warnings.push(`runtime warning: ${sanitizeStderr(input.stderr.split("\n").find((l) => /warning:/i.test(l)) ?? "")}`);

    let completion: NormalizedRuntimeResult["completion"] = "success";
    if (denials.length) completion = "permission_denied";
    else if (status === "CANCELED" || status === "INTERRUPTED" || finishedReason === "interrupted") completion = "cancelled";
    else if (finishedReason === "print_timeout") completion = "timeout";
    else if (status !== "SUCCESS" || input.exitCode !== 0 || finishedReason === "error") completion = "error";

    const usageRaw = (r.usage ?? null) as Record<string, unknown> | null;
    const usage = usageRaw
      ? Object.fromEntries(Object.entries(usageRaw).filter(([, v]) => typeof v === "number")) as Record<string, number>
      : null;
    return {
      provider: "antigravity-cli",
      runtimeVersion: this.version,
      model: input.model,
      conversationId: convId ?? null,
      requestedConversationId: input.requestedConversationId,
      contextRebuilt,
      completion,
      envelopeStatus: status,
      finishedReason,
      text: typeof r.response === "string" ? r.response : input.textDeltas,
      structured: r.structured_output ?? null,
      usage,
      warnings,
      permissionDenials: denials,
      durationMs: typeof r.duration_seconds === "number" ? Math.round(r.duration_seconds * 1000) : input.durationMs,
      exitCode: input.exitCode,
    };
  }

  async prepare(): Promise<void> {
    if (!this.version) await this.inspectInstallation();
  }
}
