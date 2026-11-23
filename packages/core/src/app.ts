import type { Job, SearchableType } from "@jonathon/contracts";
import type { JonathonConfig } from "./config";
import { type Db, openDatabase } from "./db";
import { JobQueue } from "./jobs/queue";
import { type JobHandler, JobWorker } from "./jobs/worker";
import { createLogger, type Logger } from "./logger";
import { searchProject } from "./retrieval/search";
import { AntigravityCliRuntime } from "./runtime/antigravity";
import { DemoExtractiveRuntime } from "./runtime/demo";
import type { ReasoningRuntime } from "./runtime/types";
import { AuthService } from "./security/auth";
import { GoogleSignIn } from "./security/google-signin";
import type { Principal } from "./security/principal";
import { AnswerService } from "./services/answering";
import { type Ctx, requireProject } from "./services/context";
import { DocumentService, queueDocsRefresh } from "./services/documents";
import { ExtractionService } from "./services/extraction";
import { FolderImportService } from "./services/folder-import";
import { GraphService } from "./services/graph";
import { KnowledgeService } from "./services/knowledge";
import { OpsService } from "./services/ops";
import { ProjectService } from "./services/projects";
import { RuntimeAuthAgent, RuntimeAuthService } from "./services/runtime-auth";
import { SourceService } from "./services/sources";
import { KnowledgeStore } from "./storage/knowledge-store";
import { ProjectFiles } from "./storage/project-files";

export interface JonathonApp {
  ctx: Ctx;
  auth: AuthService;
  /** Sign in with Google for the local account (enabled when JONATHON_GOOGLE_CLIENT_ID is set). */
  google: GoogleSignIn;
  projects: ProjectService;
  sources: SourceService;
  knowledge: KnowledgeService;
  answers: AnswerService;
  extraction: ExtractionService;
  graph: GraphService;
  folders: FolderImportService;
  documents: DocumentService;
  ops: OpsService;
  runtimeAuth: RuntimeAuthService;
  /** Docker worker with a dedicated agy home: performs sign-in / sign-out / check requests. */
  startRuntimeAuthAgent(): RuntimeAuthAgent;
  search(
    principal: Principal,
    projectId: string,
    body: { query: string; entity_types?: SearchableType[]; status?: string[]; limit?: number },
  ): {
    project_id: string;
    knowledge_revision: number;
    hits: ReturnType<typeof searchProject>;
  };
  getJob(principal: Principal, projectId: string, jobId: string): { job: Job; answer?: unknown };
  jobHandlers(): Record<string, JobHandler>;
  startWorker(concurrency?: number): JobWorker;
  close(): void;
}

export function createRuntime(config: JonathonConfig, log: Logger): ReasoningRuntime {
  if (config.mode === "demo") return new DemoExtractiveRuntime();
  return new AntigravityCliRuntime({
    // Policy files and empty working folders: under JONATHON_RUNTIME_DIR (Docker: a tmpfs, outside /data).
    dataDir: config.runtimeDir,
    executable: config.runtime.agyPath,
    argsPrefix: config.runtime.agyArgsPrefix,
    model: config.runtime.model,
    effort: config.runtime.effort,
    extractionEffort: config.runtime.extractionEffort,
    timeoutMs: config.runtime.timeoutMs,
    maxOutputBytes: config.runtime.maxOutputBytes,
    maxPromptChars: config.runtime.maxPromptChars,
    maxConcurrent: config.runtime.maxConcurrent,
    log,
  });
}

/** Composition root shared by the API server, the MCP endpoint, the worker and the tests. */
export function createApp(config: JonathonConfig, opts: { runtime?: ReasoningRuntime; log?: Logger; db?: Db; fetch?: typeof fetch } = {}): JonathonApp {
  const log = opts.log ?? createLogger(config.logLevel, "jonathon");
  const db = opts.db ?? openDatabase(config.dbPath);
  const runtime = opts.runtime ?? createRuntime(config, log);
  const store = new KnowledgeStore(db, config.dataDir, log);
  const files = new ProjectFiles(config.dataDir);
  const queue = new JobQueue(db, {
    defaultMaxAttempts: config.queue.maxAttempts,
    backoffBaseMs: config.queue.backoffBaseMs,
    backoffMaxMs: config.queue.backoffMaxMs,
    maxActiveJobs: config.queue.maxActiveJobs,
  });
  const auth = new AuthService(db, config.sessionTtlHours);
  const ctx: Ctx = { config, db, log, store, files, queue, runtime, auth };
  const projects = new ProjectService(ctx);
  const sources = new SourceService(ctx);
  const knowledge = new KnowledgeService(ctx);
  const answers = new AnswerService(ctx);
  const extraction = new ExtractionService(ctx);
  const graph = new GraphService(ctx);
  const folders = new FolderImportService(ctx, sources);
  const documents = new DocumentService(ctx, graph);
  // Any committed knowledge change (drafting, review, edits, deletion) refreshes the generated documents, debounced.
  store.onChanged = (projectId) => queueDocsRefresh(ctx, projectId, "knowledge changed");
  const ops = new OpsService(ctx, sources);
  const google = new GoogleSignIn(db, config, auth, opts.fetch);
  const runtimeAuth = new RuntimeAuthService(ctx);

  const app: JonathonApp = {
    ctx,
    auth,
    google,
    projects,
    sources,
    knowledge,
    answers,
    extraction,
    graph,
    folders,
    documents,
    ops,
    runtimeAuth,
    startRuntimeAuthAgent() {
      const agent = new RuntimeAuthAgent(ctx, ops, log.child({ component: "runtime-auth" }));
      agent.start();
      return agent;
    },
    search(principal, projectId, body) {
      const p = requireProject(ctx, principal, projectId, "read");
      const hits = searchProject(db, projectId, body.query, { types: body.entity_types, statuses: body.status, limit: body.limit ?? 10 });
      return {
        project_id: projectId,
        knowledge_revision: p.knowledge_revision,
        hits: hits.map(({ text: _text, ...h }) => h) as ReturnType<typeof searchProject>,
      };
    },
    getJob(principal, projectId, jobId) {
      requireProject(ctx, principal, projectId, "read");
      const job = queue.getForProject(projectId, jobId);
      if (principal.kind === "mcp_token" && job.type !== "answer") {
        return { job };
      }
      if (job.type === "answer" && (job.status === "succeeded" || job.status === "partially_succeeded")) {
        return { job, answer: answers.answerFromJob(principal, projectId, job) };
      }
      return { job };
    },
    jobHandlers() {
      return {
        ingest: (jc) => sources.runIngestJob(jc),
        answer: (jc) => answers.runAnswerJob(jc),
        extract_knowledge: (jc) => extraction.runExtractKnowledgeJob(jc),
        reindex: (jc) => ops.runReindexJob(jc),
        reconcile: async (jc) => ({ status: "succeeded", result: ops.reconcile({ kind: "system", name: "worker" }, jc.job.projectId)[0] ?? null }),
        graph_extract: (jc) => graph.runGraphExtractJob(jc),
        generate_documents: (jc) => documents.runGenerateJob(jc),
        import_folder: (jc) => folders.runImportJob(jc),
      };
    },
    startWorker(concurrency = config.workerConcurrency) {
      const w = new JobWorker(db, queue, app.jobHandlers(), log.child({ component: "worker" }), {
        concurrency,
        leaseMs: config.queue.leaseMs,
        maxDeadlineMs: config.queue.maxDeadlineMs,
      });
      w.start();
      return w;
    },
    close() {
      db.close();
    },
  };
  return app;
}
