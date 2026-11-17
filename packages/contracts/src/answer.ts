import { z } from "zod";
import { ConversationIdSchema, JobIdSchema, LocatorSchema, ProjectIdSchema } from "./domain";

export const ANSWER_STATUSES = [
  "answered",
  "partially_answered",
  "needs_clarification",
  "conflicting_sources",
  "insufficient_evidence",
] as const;
export const AnswerStatusSchema = z.enum(ANSWER_STATUSES);
export type AnswerStatus = z.infer<typeof AnswerStatusSchema>;

export const CITATION_AUTHORITIES = [
  "source_evidence",
  "approved_requirement",
  "unapproved_requirement",
  "approved_decision",
  "unapproved_decision",
  "open_conflict",
  "open_question",
  "other_knowledge",
] as const;

export const CitationSchema = z.object({
  citation_id: z.string(),
  /** Source evidence: source/revision. Knowledge: entity human id, with source_id null. */
  source_id: z.string().nullable(),
  source_revision: z.string().nullable(),
  entity_id: z.string().nullable(),
  document_title: z.string(),
  locator: LocatorSchema,
  excerpt: z.string(),
  content_hash: z.string(),
  /** What authority this evidence carries. Original evidence is never "approved". */
  authority: z.enum(CITATION_AUTHORITIES),
  /**
   * quote_verified: the model's quote was found (whitespace/case-normalized) in the cited chunk.
   * quote_not_found: the quote was not found; the excerpt shown is the stored chunk text instead.
   * This checks provenance only. It does NOT prove that the evidence supports the claim.
   */
  support_check: z.enum(["quote_verified", "quote_not_found"]),
});
export type Citation = z.infer<typeof CitationSchema>;

export const AnswerConflictSchema = z.object({
  summary: z.string(),
  citation_ids: z.array(z.string()),
  conflict_id: z.string().nullable(),
});

export const RuntimeInfoSchema = z.object({
  provider: z.enum(["antigravity-cli", "demo-extractive", "none"]),
  runtime_version: z.string().nullable(),
  model: z.string().nullable(),
  duration_ms: z.number(),
  context_rebuilt: z.boolean(),
  retrieval_iterations: z.number().int(),
  usage: z.record(z.string(), z.number()).nullable(),
});

export const AnswerSchema = z.object({
  conversation_id: ConversationIdSchema,
  message_id: z.string(),
  project_id: ProjectIdSchema,
  status: AnswerStatusSchema,
  answer_markdown: z.string(),
  citations: z.array(CitationSchema),
  requirement_ids: z.array(z.string()),
  decision_ids: z.array(z.string()),
  /** Statements that go beyond the evidence. Always shown separately. */
  inferences: z.array(z.string()),
  unresolved_questions: z.array(z.string()),
  conflicts: z.array(AnswerConflictSchema),
  implementation_ready: z.boolean(),
  readiness_scope: z.string().nullable(),
  readiness_reasons: z.array(z.string()),
  knowledge_revision: z.number().int(),
  warnings: z.array(z.string()),
  runtime: RuntimeInfoSchema,
});
export type Answer = z.infer<typeof AnswerSchema>;

export const PendingAnswerSchema = z.object({
  status: z.literal("pending"),
  job_id: JobIdSchema,
  conversation_id: ConversationIdSchema,
  project_id: ProjectIdSchema,
  message: z.string(),
});
export type PendingAnswer = z.infer<typeof PendingAnswerSchema>;

export type AskResult = Answer | PendingAnswer;

// ---------- what the model must return (validated independently of the CLI envelope) ----------

/**
 * Flat object (no oneOf) because it is also handed to `agy --json-schema`.
 * action = "request_more_evidence" means: "run these read-only searches in the same project and ask me again".
 */
export const ModelTurnSchema = z.object({
  action: z.enum(["answer", "request_more_evidence"]),
  evidence_queries: z.array(z.string().min(2).max(200)).max(3),
  status: AnswerStatusSchema,
  answer_markdown: z.string().max(20_000),
  /** Only evidence IDs that were provided in the prompt (E1, E2, ...). */
  citations: z.array(z.object({ evidence_id: z.string().max(16), quote: z.string().max(2_000) })).max(30),
  requirement_ids: z.array(z.string().max(32)).max(50),
  decision_ids: z.array(z.string().max(32)).max(50),
  inferences: z.array(z.string().max(2_000)).max(20),
  unresolved_questions: z.array(z.string().max(2_000)).max(20),
  conflicts: z.array(z.object({ summary: z.string().max(2_000), evidence_ids: z.array(z.string().max(16)).max(10) })).max(10),
  claims_implementation_ready: z.boolean(),
});
export type ModelTurn = z.infer<typeof ModelTurnSchema>;

// ---------- knowledge extraction output ----------

export const STATEMENT_KINDS = ["preconditions", "behavior", "alternate_flows", "validation_rules", "acceptance_criteria"] as const;

/**
 * Kept shallow on purpose: agy 1.5.9 stalled (no output for minutes) on a deeper nested schema in live tests.
 * Statement basis is NOT taken from the model: the server marks a statement "source_stated" only when its text
 * is found verbatim in the cited evidence, otherwise "ai_inferred". Every statement starts as "proposed".
 */
const statementList = (max: number) => z.array(z.string().min(1).max(1_000)).max(max);
export const ModelExtractionSchema = z.object({
  requirements: z
    .array(
      z.object({
        title: z.string().min(3).max(200),
        description: z.string().max(4_000),
        type: z.enum(["functional", "nonfunctional", "constraint", "integration", "data", "ux", "business_rule"]),
        module: z.string().max(80),
        feature_scope: z.string().max(80),
        actors: z.array(z.string().max(80)).max(10),
        preconditions: statementList(10),
        behavior: statementList(15),
        alternate_flows: statementList(10),
        validation_rules: statementList(10),
        acceptance_criteria: statementList(15),
        priority_stated_in_source: z.string().max(40),
        evidence_ids: z.array(z.string().max(16)).min(1).max(10),
        open_questions: z.array(z.string().max(500)).max(10),
      }),
    )
    .max(40),
  open_questions: z
    .array(
      z.object({
        question: z.string().min(3).max(500),
        context: z.string().max(1_000),
        blocking: z.boolean(),
        feature_scope: z.string().max(80),
        evidence_ids: z.array(z.string().max(16)).max(10),
      }),
    )
    .max(30),
  conflicts: z
    .array(
      z.object({
        title: z.string().min(3).max(200),
        description: z.string().max(2_000),
        feature_scope: z.string().max(80),
        side_a_claim: z.string().max(1_000),
        side_a_evidence_ids: z.array(z.string().max(16)).min(1).max(5),
        side_b_claim: z.string().max(1_000),
        side_b_evidence_ids: z.array(z.string().max(16)).min(1).max(5),
        blocking: z.boolean(),
      }),
    )
    .max(20),
  /** Changes to requirements that already exist (listed in the prompt by id). Applied only when a human accepts. */
  requirement_updates: z
    .array(
      z.object({
        requirement_id: z.string().max(32),
        change_summary: z.string().min(3).max(500),
        proposed_description: z.string().max(4_000),
        added_behavior: statementList(10),
        added_validation_rules: statementList(10),
        added_acceptance_criteria: statementList(10),
        rationale: z.string().max(1_000),
        evidence_ids: z.array(z.string().max(16)).min(1).max(10),
      }),
    )
    .max(20),
});
export type ModelExtraction = z.infer<typeof ModelExtractionSchema>;
