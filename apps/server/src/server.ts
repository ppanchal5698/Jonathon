import { randomUUID } from "node:crypto";
import multipart from "@fastify/multipart";
import {
  AnswerQuestionBodySchema,
  AskBodySchema,
  CreateEntityBodySchema,
  CreateMcpTokenBodySchema,
  CreateProjectBodySchema,
  DeleteProjectBodySchema,
  DeleteSourceBodySchema,
  DocReviewBodySchema,
  DocSectionUpdateBodySchema,
  EditDocSectionBodySchema,
  FolderImportBodySchema,
  FolderScanBodySchema,
  type EntityType,
  EntityTypeSchema,
  ERROR_HTTP_STATUS,
  GenerateDocumentsBodySchema,
  LoginBodySchema,
  PasteTextBodySchema,
  ResolveConflictBodySchema,
  ReviewActionBodySchema,
  SearchBodySchema,
  SetupAccountBodySchema,
  TransitionBodySchema,
  UpdateEntityBodySchema,
  UpdateProjectBodySchema,
} from "@jonathon/contracts";
import { AppError, createMcpServer, type JonathonApp, requireProject, toAppError } from "@jonathon/core";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { beginIdempotent, finishIdempotent } from "./idempotency";
import { allowedHosts, checkHostAndOrigin, clearSessionCookie, readCookie, requireUser, SESSION_COOKIE, securityHeaders, sessionCookie } from "./security";

const ok = <T>(data: T) => ({ data });

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new AppError("VALIDATION_FAILED", "request validation failed", {
      details: r.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return r.data;
}

type P = { pid: string };

export async function buildServer(app: JonathonApp): Promise<FastifyInstance> {
  const { config, log } = app.ctx;
  const hosts = allowedHosts(config.port, config.webOrigins);
  // Container deployments: the web container's proxy reaches the API by service name (e.g. server:4100).
  for (const h of config.allowedHosts) hosts.add(h);
  const origins = new Set(config.webOrigins);

  const f = Fastify({
    loggerInstance: log.child({ component: "http" }) as unknown as FastifyBaseLogger,
    genReqId: () => `req_${randomUUID().slice(0, 12)}`,
    bodyLimit: 4 * 1024 * 1024,
    // Never trust X-Forwarded-*: nothing in Jonathon's security decisions uses the client IP, and the only proxy (the
    // Next.js frontend) is reached over an internal network. Origin, Host, session and CSRF checks use the real headers.
    trustProxy: false,
  });
  await f.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 20, fields: 10, parts: 30 } });

  f.addHook("onRequest", async (req, reply) => {
    reply.header("X-Correlation-Id", req.id);
    securityHeaders(reply);
    checkHostAndOrigin(req, hosts, origins);
  });
  f.addHook("onSend", async (req, reply, payload) => {
    finishIdempotent(app, req, reply, payload);
    return payload;
  });

  f.setErrorHandler((err, req, reply) => {
    let e = toAppError(err);
    const fe = err as { statusCode?: number; code?: string; message?: string };
    if (!(err instanceof AppError)) {
      if (fe.code === "FST_REQ_FILE_TOO_LARGE" || fe.code === "FST_FILES_LIMIT") e = new AppError("FILE_TOO_LARGE", "upload is too large");
      else if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) e = new AppError("VALIDATION_FAILED", fe.message ?? "bad request");
    }
    if (e.code === "INTERNAL") req.log.error({ err: (err as Error).message, stack: (err as Error).stack }, "unhandled error");
    else req.log.info({ code: e.code }, "request failed");
    reply.status(ERROR_HTTP_STATUS[e.code]).send({
      error: {
        code: e.code,
        message: e.code === "INTERNAL" ? "internal error" : e.message,
        correlation_id: req.id,
        details: e.code === "INTERNAL" ? undefined : e.details,
      },
    });
  });

  // ---------- public ----------
  f.get("/api/v1/health", async () => ok({ status: "ok" }));
  // Readiness (container health checks): the database answers and the data directory is writable. No paths or details.
  f.get("/api/v1/ready", async (_req, reply) => {
    const r = app.ops.readiness();
    if (!r.ready) reply.status(503);
    return ok(r);
  });
  f.get("/api/v1/setup/status", async (req) =>
    ok({
      set_up: app.auth.isSetUp(),
      mode: config.mode,
      // "google": Sign in with Google is the only way in (no username/password).
      auth: app.google.enabled ? "google" : "password",
      // The absolute data path is shown only before setup or to the signed-in user.
      data_dir: !app.auth.isSetUp() || app.auth.resolveSession(readCookie(req, SESSION_COOKIE)) ? config.dataDir : null,
      ai_notice:
        "When AI processing is enabled for a project, Jonathon sends the relevant client text to the Antigravity CLI, which forwards it to its configured model provider (Google or a third party, depending on the model). Antigravity also keeps conversation transcripts on this computer. Jonathon orchestrates locally; it does not run the model locally.",
    }),
  );

  const passwordClosed = () => {
    if (app.google.enabled) throw new AppError("FORBIDDEN", "this Jonathon uses Sign in with Google; passwords are turned off");
  };

  // ----- Sign in with Google (OpenID Connect). Start: same-origin navigation from the sign-in page. -----
  const OAUTH_COOKIE = "jon_oauth";
  const oauthCookie = (value: string, maxAge: number) =>
    // Path=/ so the cookie also reaches a redirect URI outside /api/v1 (e.g. /oauth2callback on the UI origin).
    `${OAUTH_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
  /** A tiny same-origin page that moves the browser on. A server redirect would keep the navigation "cross-site"
   *  (it started at Google), and browsers then withhold the SameSite=Strict session cookie on the next page. */
  const continuePage = (reply: FastifyReply, to: string) => {
    reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    reply.header("Content-Type", "text/html; charset=utf-8");
    const href = to.replace(/[^\w\-./?=&%]/g, "");
    return reply.send(
      `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${href}"><title>Jonathon</title></head>` +
        `<body><p>Continuing to <a href="${href}">Jonathon</a>…</p></body></html>`,
    );
  };
  f.get("/api/v1/auth/google/start", async (_req, reply) => {
    const { url, binder } = app.google.start();
    reply.header("Set-Cookie", oauthCookie(binder, 600));
    return reply.redirect(url, 302);
  });
  f.get<{ Querystring: { state?: string; code?: string; error?: string } }>("/api/v1/auth/google/callback", async (req, reply) => {
    try {
      const { token, created } = await app.google.callback(req.query, readCookie(req, OAUTH_COOKIE));
      reply.header("Set-Cookie", [sessionCookie(token, config.sessionTtlHours * 3600), oauthCookie("", 0)]);
      return continuePage(reply, created ? "/setup" : "/");
    } catch (e) {
      const err = toAppError(e);
      req.log.info({ code: err.code }, "google sign-in failed");
      reply.header("Set-Cookie", oauthCookie("", 0));
      const msg = err.code === "INTERNAL" ? "sign-in failed" : err.message;
      return continuePage(reply, `/login?error=${encodeURIComponent(msg.slice(0, 200))}`);
    }
  });

  f.post("/api/v1/setup/account", async (req, reply) => {
    passwordClosed();
    const body = parse(SetupAccountBodySchema, req.body);
    await app.auth.createAccount(body.username, body.password);
    const { token, session } = await app.auth.login(body.username, body.password);
    reply.header("Set-Cookie", sessionCookie(token, config.sessionTtlHours * 3600));
    return ok({ username: session.username, csrf_token: session.csrfToken });
  });

  f.post("/api/v1/auth/login", async (req, reply) => {
    passwordClosed();
    const body = parse(LoginBodySchema, req.body);
    if (!app.auth.isSetUp()) throw new AppError("SETUP_REQUIRED", "create the local account first");
    const { token, session } = await app.auth.login(body.username, body.password);
    reply.header("Set-Cookie", sessionCookie(token, config.sessionTtlHours * 3600));
    return ok({ username: session.username, csrf_token: session.csrfToken });
  });

  f.post("/api/v1/auth/logout", async (req, reply) => {
    const s = app.auth.resolveSession(readCookie(req, SESSION_COOKIE));
    if (s) {
      requireUser(app, req);
      app.auth.logout(s.sessionId);
    }
    reply.header("Set-Cookie", clearSessionCookie());
    return ok({ signed_out: true });
  });

  f.get("/api/v1/auth/session", async (req) => {
    const user = requireUser(app, req);
    return ok({ username: user.username, csrf_token: req.session!.csrfToken, mode: config.mode });
  });

  // ---------- authenticated (cookie) ----------
  const authed = async (req: FastifyRequest, reply: FastifyReply) => {
    requireUser(app, req);
    return beginIdempotent(app, req, reply);
  };

  f.get("/api/v1/projects", { preHandler: authed }, async (req) => ok(app.projects.list(req.principal!)));
  f.post("/api/v1/projects", { preHandler: authed }, async (req) => ok(app.projects.create(req.principal!, parse(CreateProjectBodySchema, req.body))));
  f.get<{ Params: P }>("/api/v1/projects/:pid", { preHandler: authed }, async (req) => {
    const p = app.projects.get(req.principal!, req.params.pid);
    const counts = app.ctx.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM sources WHERE project_id = ? AND deleted_at IS NULL) AS sources,
                (SELECT COUNT(*) FROM knowledge_entities WHERE project_id = ? AND entity_type = 'requirement') AS requirements,
                (SELECT COUNT(*) FROM knowledge_entities WHERE project_id = ? AND entity_type = 'requirement' AND approval_valid = 1) AS approved,
                (SELECT COUNT(*) FROM knowledge_entities WHERE project_id = ? AND entity_type = 'conflict' AND status = 'open') AS open_conflicts,
                (SELECT COUNT(*) FROM knowledge_entities WHERE project_id = ? AND entity_type = 'open_question' AND status = 'open') AS open_questions,
                (SELECT COUNT(*) FROM knowledge_entities WHERE project_id = ? AND entity_type = 'change_proposal' AND status = 'open') AS open_proposals,
                (SELECT COUNT(*) FROM knowledge_entities WHERE project_id = ? AND (
                   (entity_type IN ('requirement','decision') AND status IN ('draft','in_review')) OR
                   (entity_type IN ('open_question','conflict') AND status = 'open' AND COALESCE(json_extract(data, '$.fields.reviewed'), 0) = 0) OR
                   (entity_type = 'change_proposal' AND status = 'open'))) AS to_review,
                (SELECT COUNT(*) FROM jobs WHERE project_id = ? AND status IN ('queued','running','retrying')) AS active_jobs`,
      )
      .get(p.id, p.id, p.id, p.id, p.id, p.id, p.id, p.id);
    return ok({ ...p, counts });
  });
  f.patch<{ Params: P }>("/api/v1/projects/:pid", { preHandler: authed }, async (req) =>
    ok(app.projects.update(req.principal!, req.params.pid, parse(UpdateProjectBodySchema, req.body))),
  );
  // Permanent: the whole project, its files and its rows (ProjectService.delete). Session + CSRF + typed phrase.
  f.delete<{ Params: P }>("/api/v1/projects/:pid", { preHandler: authed }, async (req) =>
    ok(app.projects.delete(req.principal!, req.params.pid, parse(DeleteProjectBodySchema, req.body).confirmation)),
  );
  f.get<{ Params: P }>("/api/v1/projects/:pid/activity", { preHandler: authed }, async (req) => ok(app.projects.activity(req.principal!, req.params.pid)));
  f.get("/api/v1/activity", { preHandler: authed }, async (req) => ok(app.projects.activity(req.principal!, null, 30)));

  // ----- sources -----
  f.get<{ Params: P }>("/api/v1/projects/:pid/sources", { preHandler: authed }, async (req) => ok(app.sources.list(req.principal!, req.params.pid)));
  f.post<{ Params: P }>("/api/v1/projects/:pid/sources", { preHandler: authed }, async (req) => {
    requireProject(app.ctx, req.principal!, req.params.pid, "write");
    if (!req.isMultipart()) throw new AppError("VALIDATION_FAILED", "expected multipart/form-data");
    const results = [];
    let sourceId: string | undefined;
    for await (const part of req.parts()) {
      if (part.type === "field") {
        if (part.fieldname === "source_id" && typeof part.value === "string" && part.value) sourceId = part.value;
        continue;
      }
      const bytes = new Uint8Array(await part.toBuffer());
      if (part.file.truncated) throw new AppError("FILE_TOO_LARGE", `${part.filename} exceeds the upload limit`);
      results.push(app.sources.ingest(req.principal!, req.params.pid, { filename: part.filename, bytes, sourceId, correlationId: req.id }));
    }
    if (results.length === 0) throw new AppError("VALIDATION_FAILED", "no files were uploaded");
    return ok(results);
  });
  // Folder import: scan shows what would be imported; import queues a background job. Human session only.
  f.post<{ Params: P }>("/api/v1/projects/:pid/sources/folder/scan", { preHandler: authed }, async (req) =>
    ok(app.folders.scan(req.principal!, req.params.pid, parse(FolderScanBodySchema, req.body))),
  );
  f.post<{ Params: P }>("/api/v1/projects/:pid/sources/folder/import", { preHandler: authed }, async (req) =>
    ok(app.folders.queueImport(req.principal!, req.params.pid, parse(FolderImportBodySchema, req.body))),
  );
  f.post<{ Params: P }>("/api/v1/projects/:pid/sources/paste", { preHandler: authed }, async (req) => {
    const b = parse(PasteTextBodySchema, req.body);
    return ok(
      app.sources.ingest(req.principal!, req.params.pid, {
        filename: `${b.title}.md`,
        bytes: new TextEncoder().encode(b.text),
        kind: "pasted_text",
        sourceId: b.source_id,
        correlationId: req.id,
      }),
    );
  });
  f.get<{ Params: P & { sid: string } }>("/api/v1/projects/:pid/sources/:sid", { preHandler: authed }, async (req) =>
    ok(app.sources.get(req.principal!, req.params.pid, req.params.sid)),
  );
  f.delete<{ Params: P & { sid: string } }>("/api/v1/projects/:pid/sources/:sid", { preHandler: authed }, async (req) =>
    ok(app.sources.delete(req.principal!, req.params.pid, req.params.sid, parse(DeleteSourceBodySchema, req.body).confirmation)),
  );
  f.get<{ Params: P & { rid: string } }>("/api/v1/projects/:pid/revisions/:rid/chunks", { preHandler: authed }, async (req) =>
    ok(app.sources.chunks(req.principal!, req.params.pid, req.params.rid)),
  );
  f.get<{ Params: P & { rid: string } }>("/api/v1/projects/:pid/revisions/:rid/original", { preHandler: authed }, async (req, reply) => {
    const o = app.sources.original(req.principal!, req.params.pid, req.params.rid);
    // Always a download, never rendered: client files are untrusted.
    reply.header("Content-Type", "application/octet-stream");
    reply.header("Content-Disposition", `attachment; filename="${o.filename.replace(/[^\w.\- ]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(o.filename)}`);
    return reply.send(o.bytes);
  });
  f.post<{ Params: P & { rid: string } }>("/api/v1/projects/:pid/revisions/:rid/interpret", { preHandler: authed }, async (req) => {
    const p = requireProject(app.ctx, req.principal!, req.params.pid, "write");
    if (!p.ai_enabled && config.mode !== "demo") throw new AppError("AI_DISABLED", "enable AI processing for this project first");
    app.sources.revision(p.id, req.params.rid);
    return ok(
      app.ctx.queue.enqueue({
        projectId: p.id,
        type: "extract_knowledge",
        payload: { revision_id: req.params.rid },
        serialKey: `extract:${p.id}`,
        // A second click while the same draft extraction is still queued or running returns that job.
        dedupeKey: `extract_knowledge:${req.params.rid}:${app.ctx.runtime.provider}`,
        createdBy: req.principal!.kind === "user" ? req.principal!.username : "user",
        correlationId: req.id,
      }),
    );
  });

  // ----- knowledge -----
  f.get<{ Params: P; Querystring: { type?: string; status?: string } }>("/api/v1/projects/:pid/entities", { preHandler: authed }, async (req) => {
    const types = req.query.type ? (req.query.type.split(",").map((t) => parse(EntityTypeSchema, t)) as EntityType[]) : undefined;
    const statuses = req.query.status ? req.query.status.split(",") : undefined;
    return ok(app.knowledge.list(req.principal!, req.params.pid, { types, statuses }));
  });
  f.post<{ Params: P }>("/api/v1/projects/:pid/entities", { preHandler: authed }, async (req) => {
    const b = parse(CreateEntityBodySchema, req.body);
    return ok(app.knowledge.createDraft(req.principal!, req.params.pid, b.entity_type, b));
  });
  f.get<{ Params: P & { hid: string }; Querystring: { revision?: string } }>("/api/v1/projects/:pid/entities/:hid", { preHandler: authed }, async (req) =>
    ok(app.knowledge.get(req.principal!, req.params.pid, req.params.hid, req.query.revision ? Number(req.query.revision) : undefined)),
  );
  f.put<{ Params: P & { hid: string } }>("/api/v1/projects/:pid/entities/:hid", { preHandler: authed }, async (req) => {
    const b = parse(UpdateEntityBodySchema, req.body);
    return ok(app.knowledge.updateDraft(req.principal!, req.params.pid, req.params.hid, b.expected_revision, b));
  });
  f.post<{ Params: P & { hid: string } }>("/api/v1/projects/:pid/entities/:hid/transition", { preHandler: authed }, async (req) =>
    ok(app.knowledge.transition(req.principal!, req.params.pid, req.params.hid, parse(TransitionBodySchema, req.body))),
  );
  f.post<{ Params: P & { hid: string } }>("/api/v1/projects/:pid/entities/:hid/accept-proposed", { preHandler: authed }, async (req) =>
    ok(
      app.knowledge.acceptProposedStatements(
        req.principal!,
        req.params.pid,
        req.params.hid,
        parse(z.object({ expected_revision: z.number().int().positive() }), req.body).expected_revision,
      ),
    ),
  );
  // Human review of AI-proposed items (UI only: MCP tokens and the worker are rejected by assertHuman).
  f.post<{ Params: P & { hid: string } }>("/api/v1/projects/:pid/entities/:hid/accept", { preHandler: authed }, async (req) =>
    ok(app.knowledge.accept(req.principal!, req.params.pid, req.params.hid, parse(ReviewActionBodySchema, req.body))),
  );
  f.post<{ Params: P & { hid: string } }>("/api/v1/projects/:pid/entities/:hid/reject", { preHandler: authed }, async (req) =>
    ok(app.knowledge.reject(req.principal!, req.params.pid, req.params.hid, parse(ReviewActionBodySchema, req.body))),
  );
  f.delete<{ Params: P & { hid: string } }>("/api/v1/projects/:pid/entities/:hid", { preHandler: authed }, async (req) =>
    ok(app.knowledge.remove(req.principal!, req.params.pid, req.params.hid, parse(ReviewActionBodySchema, req.body))),
  );
  f.get<{ Params: P & { hid: string } }>("/api/v1/projects/:pid/entities/:hid/history", { preHandler: authed }, async (req) =>
    ok(app.knowledge.history(req.principal!, req.params.pid, req.params.hid)),
  );
  f.get<{ Params: P & { hid: string }; Querystring: { from: string; to: string } }>(
    "/api/v1/projects/:pid/entities/:hid/diff",
    { preHandler: authed },
    async (req) => ok(app.knowledge.diff(req.principal!, req.params.pid, req.params.hid, Number(req.query.from), Number(req.query.to))),
  );
  f.post<{ Params: P & { hid: string } }>("/api/v1/projects/:pid/conflicts/:hid/resolve", { preHandler: authed }, async (req) =>
    ok(app.knowledge.resolveConflict(req.principal!, req.params.pid, req.params.hid, parse(ResolveConflictBodySchema, req.body))),
  );
  f.post<{ Params: P & { hid: string } }>("/api/v1/projects/:pid/questions/:hid/answer", { preHandler: authed }, async (req) =>
    ok(app.knowledge.answerQuestion(req.principal!, req.params.pid, req.params.hid, parse(AnswerQuestionBodySchema, req.body))),
  );
  f.get<{ Params: P; Querystring: { feature: string; approved_only?: string } }>("/api/v1/projects/:pid/spec", { preHandler: authed }, async (req) =>
    ok(app.knowledge.featureSpec(req.principal!, req.params.pid, String(req.query.feature ?? ""), { approvedOnly: req.query.approved_only !== "false" })),
  );
  // ----- generated technical documents -----
  type D = P & { doc: string };
  const download = (reply: FastifyReply, filename: string, text: string, type = "text/markdown; charset=utf-8") => {
    reply.header("Content-Type", type);
    reply.header("Content-Disposition", `attachment; filename="${filename.replace(/[^\w.\- ]/g, "_")}"`);
    return reply.send(text);
  };
  f.get<{ Params: P }>("/api/v1/projects/:pid/documents", { preHandler: authed }, async (req) => ok(app.documents.catalogue(req.principal!, req.params.pid)));
  f.post<{ Params: P }>("/api/v1/projects/:pid/documents/generate", { preHandler: authed }, async (req) =>
    ok(app.documents.queueGenerate(req.principal!, req.params.pid, parse(GenerateDocumentsBodySchema, req.body).doc_types)),
  );
  f.get<{ Params: P }>("/api/v1/projects/:pid/documents-export", { preHandler: authed }, async (req, reply) => {
    const b = app.documents.bundle(req.principal!, req.params.pid);
    return download(reply, b.filename, b.text);
  });
  f.get<{ Params: D }>("/api/v1/projects/:pid/documents/:doc", { preHandler: authed }, async (req) =>
    ok(app.documents.get(req.principal!, req.params.pid, req.params.doc)),
  );
  f.get<{ Params: D }>("/api/v1/projects/:pid/documents/:doc/markdown", { preHandler: authed }, async (req, reply) => {
    const m = app.documents.markdown(req.principal!, req.params.pid, req.params.doc);
    return download(reply, m.filename, m.text);
  });
  f.put<{ Params: D & { key: string } }>("/api/v1/projects/:pid/documents/:doc/sections/:key", { preHandler: authed }, async (req) =>
    ok(app.documents.editSection(req.principal!, req.params.pid, req.params.doc, req.params.key, parse(EditDocSectionBodySchema, req.body))),
  );
  f.post<{ Params: D & { key: string } }>("/api/v1/projects/:pid/documents/:doc/sections/:key/update", { preHandler: authed }, async (req) =>
    ok(app.documents.resolveSectionUpdate(req.principal!, req.params.pid, req.params.doc, req.params.key, parse(DocSectionUpdateBodySchema, req.body))),
  );
  f.post<{ Params: D }>("/api/v1/projects/:pid/documents/:doc/approve", { preHandler: authed }, async (req) =>
    ok(app.documents.approve(req.principal!, req.params.pid, req.params.doc, parse(DocReviewBodySchema, req.body))),
  );

  // ----- project memory graph -----
  const nodeId = z.string().min(3).max(200);
  f.get<{ Params: P }>("/api/v1/projects/:pid/graph", { preHandler: authed }, async (req) => ok(app.graph.overview(req.principal!, req.params.pid)));
  f.get<{ Params: P; Querystring: { q?: string; limit?: string } }>("/api/v1/projects/:pid/graph/search", { preHandler: authed }, async (req) =>
    ok(app.graph.search(req.principal!, req.params.pid, parse(z.string().max(200), req.query.q ?? ""), Number(req.query.limit ?? 20))),
  );
  f.get<{ Params: P; Querystring: { id?: string } }>("/api/v1/projects/:pid/graph/node", { preHandler: authed }, async (req) =>
    ok(app.graph.node(req.principal!, req.params.pid, parse(nodeId, req.query.id))),
  );
  f.get<{ Params: P; Querystring: { id?: string; depth?: string; limit?: string } }>(
    "/api/v1/projects/:pid/graph/neighborhood",
    { preHandler: authed },
    async (req) =>
      ok(
        app.graph.neighborhood(
          req.principal!,
          req.params.pid,
          parse(nodeId, req.query.id),
          parse(z.coerce.number().int().min(1).max(3).default(1), req.query.depth),
          parse(z.coerce.number().int().min(10).max(400).default(120), req.query.limit),
        ),
      ),
  );
  f.get<{ Params: P; Querystring: { from?: string; to?: string } }>("/api/v1/projects/:pid/graph/path", { preHandler: authed }, async (req) =>
    ok(app.graph.path(req.principal!, req.params.pid, parse(nodeId, req.query.from), parse(nodeId, req.query.to))),
  );
  f.get<{ Params: P }>("/api/v1/projects/:pid/graph/export", { preHandler: authed }, async (req, reply) => {
    requireProject(app.ctx, req.principal!, req.params.pid, "read");
    return download(reply, "graph.json", `${JSON.stringify(app.graph.graphifyJson(req.params.pid), null, 1)}\n`, "application/json; charset=utf-8");
  });
  f.post<{ Params: P }>("/api/v1/projects/:pid/graph/map", { preHandler: authed }, async (req) =>
    ok(app.graph.queueExtraction(req.principal!, req.params.pid, parse(z.object({ force: z.boolean().default(false) }), req.body ?? {}).force)),
  );

  f.get("/api/v1/approvals/pending", { preHandler: authed }, async (req) => ok(app.knowledge.pending(req.principal!)));
  f.post<{ Params: P }>("/api/v1/projects/:pid/search", { preHandler: authed }, async (req) => {
    const b = parse(SearchBodySchema, req.body);
    return ok(app.search(req.principal!, req.params.pid, { query: b.query, entity_types: b.entity_types, status: b.status, limit: b.limit }));
  });

  // ----- conversations -----
  f.get<{ Params: P }>("/api/v1/projects/:pid/conversations", { preHandler: authed }, async (req) =>
    ok(app.answers.listConversations(req.principal!, req.params.pid)),
  );
  f.get<{ Params: P & { cid: string } }>("/api/v1/projects/:pid/conversations/:cid", { preHandler: authed }, async (req) =>
    ok(app.answers.messages(req.principal!, req.params.pid, req.params.cid)),
  );
  f.post<{ Params: P }>("/api/v1/projects/:pid/ask", { preHandler: authed }, async (req) => {
    const b = parse(AskBodySchema, req.body);
    return ok(await app.answers.ask(req.principal!, req.params.pid, b, { waitMs: b.wait_ms ?? 2_000, correlationId: req.id }));
  });

  // ----- jobs -----
  f.get<{ Params: P }>("/api/v1/projects/:pid/jobs", { preHandler: authed }, async (req) => {
    requireProject(app.ctx, req.principal!, req.params.pid, "read");
    return ok(app.ctx.queue.list({ projectId: req.params.pid, limit: 100 }));
  });
  f.get<{ Querystring: { status?: string } }>("/api/v1/jobs", { preHandler: authed }, async (req) =>
    ok(app.ctx.queue.list({ statuses: req.query.status ? (req.query.status.split(",") as never) : undefined, limit: 200 })),
  );
  f.get<{ Params: P & { jid: string } }>("/api/v1/projects/:pid/jobs/:jid", { preHandler: authed }, async (req) => {
    try {
      return ok(app.getJob(req.principal!, req.params.pid, req.params.jid));
    } catch (e) {
      // A failed answer job: return the job with its typed error rather than a 5xx for the poll itself.
      const err = toAppError(e);
      if (err.code === "JOB_NOT_FOUND" || err.code === "PROJECT_NOT_FOUND" || err.code === "CONVERSATION_NOT_FOUND") throw e;
      return ok({ job: app.ctx.queue.getForProject(req.params.pid, req.params.jid) });
    }
  });
  f.post<{ Params: P & { jid: string } }>("/api/v1/projects/:pid/jobs/:jid/cancel", { preHandler: authed }, async (req) => {
    requireProject(app.ctx, req.principal!, req.params.pid, "write");
    app.ctx.queue.getForProject(req.params.pid, req.params.jid);
    return ok(app.ctx.queue.requestCancel(req.params.jid));
  });
  // Retry and replay share one path: human only, audited (job.replayed), safe to repeat.
  f.post<{ Params: P & { jid: string } }>("/api/v1/projects/:pid/jobs/:jid/retry", { preHandler: authed }, async (req) => {
    requireProject(app.ctx, req.principal!, req.params.pid, "write");
    return ok(app.ctx.queue.retry(req.principal!, req.params.jid, { projectId: req.params.pid, correlationId: req.id }));
  });
  f.post<{ Params: P & { jid: string } }>("/api/v1/projects/:pid/jobs/:jid/replay", { preHandler: authed }, async (req) => {
    requireProject(app.ctx, req.principal!, req.params.pid, "write");
    return ok(app.ctx.queue.replay(req.principal!, req.params.jid, { projectId: req.params.pid, correlationId: req.id }));
  });
  f.get<{ Querystring: { project_id?: string; include_replayed?: string; limit?: string } }>(
    "/api/v1/ops/dead-letters",
    { preHandler: authed },
    async (req) => {
      if (req.query.project_id) requireProject(app.ctx, req.principal!, req.query.project_id, "read");
      return ok(
        app.ctx.queue.listDeadLetters({
          projectId: req.query.project_id,
          includeReplayed: req.query.include_replayed === "1",
          limit: parse(z.coerce.number().int().min(1).max(500).default(100), req.query.limit),
        }),
      );
    },
  );

  // ----- MCP credentials -----
  f.get("/api/v1/mcp/tokens", { preHandler: authed }, async () => ok(app.auth.listMcpTokens()));
  f.post("/api/v1/mcp/tokens", { preHandler: authed }, async (req) => {
    const b = parse(CreateMcpTokenBodySchema, req.body);
    const t = app.auth.createMcpToken(req.principal!, { name: b.name, projectIds: b.project_ids, scopes: b.scopes, expiresInDays: b.expires_in_days });
    return ok({ ...t, mcp_url: config.mcpPublicUrl, shown_once: true });
  });
  f.post<{ Params: { id: string } }>("/api/v1/mcp/tokens/:id/revoke", { preHandler: authed }, async (req) => {
    app.auth.revokeMcpToken(req.principal!, req.params.id);
    return ok({ revoked: true });
  });
  f.post<{ Params: { id: string } }>("/api/v1/mcp/tokens/:id/rotate", { preHandler: authed }, async (req) => {
    const t = app.auth.rotateMcpToken(req.principal!, req.params.id);
    return ok({ ...t, mcp_url: config.mcpPublicUrl, shown_once: true });
  });
  f.get<{ Params: { id: string } }>("/api/v1/mcp/tokens/:id/access", { preHandler: authed }, async (req) => ok(app.auth.mcpAccessLog(req.params.id)));

  // ----- operations -----
  f.get("/api/v1/ops/health", { preHandler: authed }, async () => ok(app.ops.health()));
  f.get<{ Querystring: { auth?: string } }>("/api/v1/ops/runtime", { preHandler: authed }, async (req) =>
    // Docker: the API container has no agy; the worker answers (and runs the authentication check when asked).
    ok(config.runtimeInWorker ? await app.runtimeAuth.diagnostics(req.principal!, req.query.auth === "1") : await app.ops.runtimeDiagnostics(req.query.auth === "1")),
  );

  // ----- Antigravity sign-in (Docker worker). Human session + CSRF only; MCP tokens never reach these routes. -----
  f.get("/api/v1/runtime/auth", { preHandler: authed }, async (req) => ok(app.runtimeAuth.status(req.principal!)));
  f.post("/api/v1/runtime/auth/sign-in", { preHandler: authed }, async (req) => ok(app.runtimeAuth.request(req.principal!, "sign_in", req.id)));
  f.post("/api/v1/runtime/auth/sign-out", { preHandler: authed }, async (req) => ok(app.runtimeAuth.request(req.principal!, "sign_out", req.id)));
  f.get<{ Params: { id: string } }>("/api/v1/runtime/auth/requests/:id", { preHandler: authed }, async (req) =>
    ok(app.runtimeAuth.get(req.principal!, req.params.id)),
  );
  f.post<{ Params: { id: string } }>("/api/v1/runtime/auth/requests/:id/code", { preHandler: authed }, async (req) =>
    ok(app.runtimeAuth.submitCode(req.principal!, req.params.id, parse(z.object({ code: z.string().min(1).max(600) }), req.body).code)),
  );
  f.post<{ Params: { id: string } }>("/api/v1/runtime/auth/requests/:id/cancel", { preHandler: authed }, async (req) =>
    ok(app.runtimeAuth.cancel(req.principal!, req.params.id)),
  );
  f.post<{ Body: { project_id?: string } }>("/api/v1/ops/reconcile", { preHandler: authed }, async (req) =>
    ok(app.ops.reconcile(req.principal!, (req.body as { project_id?: string } | undefined)?.project_id)),
  );
  f.post<{ Params: P }>("/api/v1/projects/:pid/reindex", { preHandler: authed }, async (req) => ok(app.ops.rebuildIndex(req.principal!, req.params.pid)));
  f.post("/api/v1/ops/import-files", { preHandler: authed }, async (req) => ok(app.ops.importFromFiles(req.principal!)));
  f.post("/api/v1/ops/backup", { preHandler: authed }, async (req) => ok(app.ops.backup(req.principal!)));

  // ---------- MCP (Streamable HTTP, stateless; bearer token) ----------
  const mcpHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = req.headers.authorization ?? "";
    const bearer = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
    const principal = app.auth.resolveMcpToken(bearer);
    if (!principal) {
      reply.header("WWW-Authenticate", 'Bearer realm="jonathon"');
      throw new AppError("UNAUTHENTICATED", "valid Jonathon MCP token required");
    }
    reply.hijack();
    const server = createMcpServer(app, principal, req.id);
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };
  f.post("/mcp", mcpHandler);
  f.get("/mcp", async (_req, reply) =>
    reply
      .status(405)
      .header("Allow", "POST")
      .send({ error: { code: "VALIDATION_FAILED", message: "stateless server: use POST" } }),
  );
  f.delete("/mcp", async (_req, reply) =>
    reply
      .status(405)
      .header("Allow", "POST")
      .send({ error: { code: "VALIDATION_FAILED", message: "stateless server: no sessions to delete" } }),
  );

  return f;
}
