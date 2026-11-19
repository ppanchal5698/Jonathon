import { EntityTypeSchema, SearchableTypeSchema } from "@jonathon/contracts";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { JonathonApp } from "../app";
import type { Principal } from "../security/principal";
import { toAppError } from "../util";

type McpPrincipal = Extract<Principal, { kind: "mcp_token" }>;

const ProjectId = z.string().describe("Jonathon project ID (prj_...). Call list_projects first.");

/**
 * Build a per-request MCP server bound to one authenticated token. Stateless Streamable HTTP: MCP transport
 * sessions are NOT business conversations; conversation_id is Jonathon's own concept.
 * There is deliberately no approval tool, no write tool beyond proposals, and no shell tool.
 */
export function createMcpServer(app: JonathonApp, principal: McpPrincipal, correlationId: string): McpServer {
  const server = new McpServer(
    { name: "jonathon", version: "0.1.0" },
    {
      instructions:
        "Jonathon is the requirements service for this repository. Confirm the project ID with list_projects. " +
        "Fetch approved requirements and decisions (get_feature_spec, get_requirement) before implementing. " +
        "Drafts and AI suggestions are unapproved. Never invent missing business rules; report blockers to Parth. " +
        "Propose changes with propose_requirement_change; you cannot approve anything.",
    },
  );

  const wrap =
    <A>(tool: string, fn: (args: A) => Promise<unknown> | unknown) =>
    async (args: A) => {
      const projectId = (args as { project_id?: string })?.project_id ?? null;
      try {
        const result = await fn(args);
        app.auth.logMcpAccess(principal.tokenId, tool, projectId, "ok", null, correlationId);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], structuredContent: result as Record<string, unknown> };
      } catch (e) {
        const err = toAppError(e);
        app.auth.logMcpAccess(principal.tokenId, tool, projectId, "error", err.code, correlationId);
        if (err.code === "INTERNAL") app.ctx.log.error({ err: err.message, tool, correlation_id: correlationId }, "mcp tool failed");
        const safe = {
          error: {
            code: err.code,
            message: err.code === "INTERNAL" ? "internal error" : err.message,
            correlation_id: correlationId,
            details: err.code === "INTERNAL" ? undefined : err.details,
          },
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(safe) }], isError: true };
      }
    };

  server.registerTool(
    "list_projects",
    { description: "List the Jonathon projects this credential can access.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    wrap("list_projects", () => ({
      projects: app.projects
        .list(principal)
        .map((p) => ({ id: p.id, name: p.name, description: p.description, knowledge_revision: p.knowledge_revision, is_demo: p.is_demo })),
    })),
  );

  server.registerTool(
    "ask_jonathon",
    {
      description:
        "Ask a question about the project's requirements. Answers cite evidence and label approved vs draft knowledge. " +
        "Pass conversation_id for follow-ups. If the result has status 'pending', poll get_job with the job_id. " +
        "This polling is Jonathon's tool contract, not an MCP protocol feature.",
      inputSchema: z.object({
        project_id: ProjectId,
        message: z.string().min(1).max(8_000),
        conversation_id: z.string().max(40).optional(),
        feature_scope: z.string().max(120).optional().describe("Feature name, e.g. email-verification. Readiness is only assessed for a feature."),
        knowledge_revision: z.number().int().nonnegative().optional().describe("Knowledge revision you last saw; you get a warning if it changed."),
        request_id: z.string().min(8).max(100).optional().describe("Idempotency key: retries with the same request_id return the same turn."),
      }),
    },
    wrap(
      "ask_jonathon",
      async (a: { project_id: string; message: string; conversation_id?: string; feature_scope?: string; knowledge_revision?: number; request_id?: string }) =>
        app.answers.ask(principal, a.project_id, a, { waitMs: app.ctx.config.askWaitMs, correlationId }),
    ),
  );

  server.registerTool(
    "search_knowledge",
    {
      description: "Search project evidence and knowledge (requirements, decisions, open questions, conflicts, proposals).",
      inputSchema: z.object({
        project_id: ProjectId,
        query: z.string().min(1).max(500),
        entity_types: z.array(SearchableTypeSchema).optional(),
        status: z.array(z.string().max(40)).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      }),
      annotations: { readOnlyHint: true },
    },
    wrap(
      "search_knowledge",
      (a: { project_id: string; query: string; entity_types?: z.infer<typeof SearchableTypeSchema>[]; status?: string[]; limit?: number }) =>
        app.search(principal, a.project_id, { query: a.query, entity_types: a.entity_types, status: a.status, limit: a.limit ?? 10 }),
    ),
  );

  server.registerTool(
    "get_requirement",
    {
      description: "Get one requirement (or decision/question/conflict) by its ID, e.g. REQ-001. approval_valid tells you whether it is approved.",
      inputSchema: z.object({ project_id: ProjectId, requirement_id: z.string().min(1).max(40), revision: z.number().int().positive().optional() }),
      annotations: { readOnlyHint: true },
    },
    wrap("get_requirement", (a: { project_id: string; requirement_id: string; revision?: number }) => {
      const e = app.knowledge.get(principal, a.project_id, a.requirement_id.toUpperCase(), a.revision);
      return { entity: e, knowledge_revision: app.projects.get(principal, a.project_id).knowledge_revision };
    }),
  );

  server.registerTool(
    "get_feature_spec",
    {
      description:
        "Get the specification for a feature assembled from knowledge. By default only approved requirements and decisions. " +
        "implementation_ready and readiness_reasons are computed by Jonathon, not by a model.",
      inputSchema: z.object({
        project_id: ProjectId,
        feature: z.string().min(1).max(120),
        approved_only: z.boolean().default(true),
        knowledge_revision: z.number().int().nonnegative().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    wrap("get_feature_spec", (a: { project_id: string; feature: string; approved_only?: boolean; knowledge_revision?: number }) =>
      app.knowledge.featureSpec(principal, a.project_id, a.feature, { approvedOnly: a.approved_only ?? true, knowledgeRevision: a.knowledge_revision }),
    ),
  );

  server.registerTool(
    "get_job",
    {
      description: "Poll a long-running job (e.g. a pending ask_jonathon). Returns the answer when finished.",
      inputSchema: z.object({ project_id: ProjectId, job_id: z.string().min(1).max(40) }),
      annotations: { readOnlyHint: true },
    },
    wrap("get_job", (a: { project_id: string; job_id: string }) => app.getJob(principal, a.project_id, a.job_id)),
  );

  server.registerTool(
    "propose_requirement_change",
    {
      description:
        "Propose a change to a requirement for Parth to review. Requires the 'propose' scope. Nothing is applied automatically. " +
        "base_revision must equal the requirement's current revision.",
      inputSchema: z.object({
        project_id: ProjectId,
        requirement_id: z.string().min(1).max(40),
        base_revision: z.number().int().positive(),
        proposed_change: z.string().min(3).max(8_000),
        rationale: z.string().min(3).max(4_000),
        request_id: z.string().min(8).max(100),
      }),
    },
    wrap(
      "propose_requirement_change",
      (a: { project_id: string; requirement_id: string; base_revision: number; proposed_change: string; rationale: string; request_id: string }) => {
        const r = app.knowledge.proposeChange(principal, { ...a, requirement_id: a.requirement_id.toUpperCase() });
        return {
          proposal_id: r.proposal.human_id,
          status: r.proposal.status,
          idempotent_replay: r.idempotent_replay,
          note: "Recorded for review by Parth. Not applied.",
        };
      },
    ),
  );

  server.registerTool(
    "list_documents",
    {
      description:
        "List the technical documents Jonathon can generate for a project (SRS, HLD, ADRs, API contract, test strategy ...) and which are generated, " +
        "with their revision and approval state.",
      inputSchema: z.object({ project_id: ProjectId }),
      annotations: { readOnlyHint: true },
    },
    wrap("list_documents", (a: { project_id: string }) => {
      const c = app.documents.catalogue(principal, a.project_id);
      return {
        documents: c.documents.map((d) => ({
          id: d.id,
          title: d.title,
          category: d.category,
          generated: d.generated,
          revision: d.revision,
          approved: d.approved,
          counts: d.counts,
        })),
      };
    }),
  );

  server.registerTool(
    "get_document",
    {
      description:
        "Get one generated technical document as Markdown. Every item carries its basis: client-stated, from client material, Jonathon knowledge " +
        "(with review status), AI proposal (not stated by the client) or gap. Only 'approved' documents were accepted by a person.",
      inputSchema: z.object({ project_id: ProjectId, doc_type: z.string().min(2).max(60) }),
      annotations: { readOnlyHint: true },
    },
    wrap("get_document", (a: { project_id: string; doc_type: string }) => {
      const d = app.documents.get(principal, a.project_id, a.doc_type);
      return { doc_type: a.doc_type, title: d.spec.title, revision: d.document?.revision ?? null, approved: d.approval !== null, markdown: d.markdown };
    }),
  );

  server.registerTool(
    "search_memory_graph",
    {
      description:
        "Search the project memory graph: concepts (roles, systems, integrations, data objects, technologies, terms), requirements and other knowledge, " +
        "client documents and passages. Returns node ids for explore_memory_graph.",
      inputSchema: z.object({ project_id: ProjectId, query: z.string().min(1).max(200), limit: z.number().int().min(1).max(50).default(15) }),
      annotations: { readOnlyHint: true },
    },
    wrap("search_memory_graph", (a: { project_id: string; query: string; limit?: number }) => ({
      nodes: app.graph.search(principal, a.project_id, a.query, a.limit ?? 15),
    })),
  );

  server.registerTool(
    "explore_memory_graph",
    {
      description:
        "Show what one memory-graph node connects to: the passages that mention it, the requirements and questions about it, related concepts " +
        "(with the verbatim quote behind each AI-labelled relation) and the documents built from it.",
      inputSchema: z.object({ project_id: ProjectId, node_id: z.string().min(3).max(200) }),
      annotations: { readOnlyHint: true },
    },
    wrap("explore_memory_graph", (a: { project_id: string; node_id: string }) => app.graph.node(principal, a.project_id, a.node_id)),
  );

  void EntityTypeSchema;
  return server;
}
