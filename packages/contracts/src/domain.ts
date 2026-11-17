import { z } from "zod";

// ---------- identifiers ----------
// Opaque IDs: <prefix>_<26 lowercase base32 chars>. Human IDs (REQ-001) are separate and stable per project.
const opaque = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9a-z]{26}$`), `expected ${prefix}_ id`);

export const ProjectIdSchema = opaque("prj");
export const SourceIdSchema = opaque("src");
export const RevisionIdSchema = opaque("rev");
export const JobIdSchema = opaque("job");
export const ConversationIdSchema = opaque("conv");
export const MessageIdSchema = opaque("msg");
export const ApprovalEventIdSchema = opaque("apv");
export const SnapshotIdSchema = opaque("spec");

// ---------- projects ----------
export const ProjectSchema = z.object({
  id: ProjectIdSchema,
  name: z.string(),
  description: z.string(),
  ai_enabled: z.boolean(),
  knowledge_revision: z.number().int().nonnegative(),
  is_demo: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

// ---------- sources ----------
export const EXTRACTION_STATUSES = [
  "pending",
  "succeeded",
  "partially_succeeded",
  "failed",
  "unsupported",
  "needs_ocr",
] as const;
export const ExtractionStatusSchema = z.enum(EXTRACTION_STATUSES);
export type ExtractionStatus = z.infer<typeof ExtractionStatusSchema>;

export const SourceRevisionSchema = z.object({
  id: RevisionIdSchema,
  source_id: SourceIdSchema,
  project_id: ProjectIdSchema,
  revision_number: z.number().int().positive(),
  content_hash: z.string(),
  size_bytes: z.number().int().nonnegative(),
  media_type: z.string(),
  extension: z.string(),
  original_filename: z.string(),
  extraction_status: ExtractionStatusSchema,
  extraction_warnings: z.array(z.string()),
  extractor: z.string().nullable(),
  chunk_count: z.number().int().nonnegative(),
  created_at: z.string(),
});
export type SourceRevision = z.infer<typeof SourceRevisionSchema>;

export const SourceSchema = z.object({
  id: SourceIdSchema,
  project_id: ProjectIdSchema,
  display_name: z.string(),
  kind: z.enum(["file", "pasted_text"]),
  current_revision_id: RevisionIdSchema.nullable(),
  current: SourceRevisionSchema.nullable(),
  revisions: z.array(SourceRevisionSchema).optional(),
  created_at: z.string(),
});
export type Source = z.infer<typeof SourceSchema>;

export const LocatorSchema = z.record(z.string(), z.union([z.string(), z.number()]));
export type Locator = z.infer<typeof LocatorSchema>;

export const ChunkViewSchema = z.object({
  chunk_id: z.string(),
  ordinal: z.number().int(),
  heading: z.string().nullable(),
  locator: LocatorSchema,
  text: z.string(),
});

// ---------- jobs ----------
export const JOB_STATUSES = [
  "queued",
  "running",
  "retrying",
  "succeeded",
  "partially_succeeded",
  "failed",
  "cancelled",
  "unsupported",
  "needs_ocr",
] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatusSchema>;
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  "succeeded",
  "partially_succeeded",
  "failed",
  "cancelled",
  "unsupported",
  "needs_ocr",
];

export const JOB_TYPES = ["ingest", "answer", "extract_knowledge", "reindex", "reconcile"] as const;
export const JobTypeSchema = z.enum(JOB_TYPES);
export type JobType = z.infer<typeof JobTypeSchema>;

export const JobSchema = z.object({
  id: JobIdSchema,
  project_id: ProjectIdSchema,
  type: JobTypeSchema,
  status: JobStatusSchema,
  attempts: z.number().int(),
  max_attempts: z.number().int(),
  progress: z.object({ stage: z.string(), detail: z.string().optional() }).nullable(),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  result: z.unknown().nullable(),
  cancel_requested: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
});
export type Job = z.infer<typeof JobSchema>;

// ---------- knowledge ----------

/** A pointer from knowledge back to preserved evidence. */
export const SourceRefSchema = z.object({
  source_id: SourceIdSchema,
  revision_id: RevisionIdSchema,
  chunk_id: z.string().max(80).optional(),
  locator: LocatorSchema.default({}),
  excerpt: z.string().max(2_000).default(""),
  content_hash: z.string().max(80).default(""),
  /** Optional label, e.g. which side of a conflict this evidence supports. */
  label: z.string().max(80).optional(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const STATEMENT_BASES = ["source_stated", "ai_inferred", "human_authored"] as const;
export const StatementSchema = z.object({
  text: z.string().min(1).max(2_000),
  /** source_stated: wording appears in evidence. ai_inferred: suggestion, not client-stated. */
  basis: z.enum(STATEMENT_BASES),
  /** AI proposals stay "proposed" until a human reviews them. */
  review_state: z.enum(["proposed", "accepted"]),
});
export type Statement = z.infer<typeof StatementSchema>;

export const ENTITY_TYPES = ["requirement", "decision", "open_question", "conflict", "change_proposal"] as const;
export const EntityTypeSchema = z.enum(ENTITY_TYPES);
export type EntityType = z.infer<typeof EntityTypeSchema>;

export type SectionKind = "text" | "list" | "statements";
export type FieldKind = "string" | "string_list" | "number" | "boolean";

export interface EntitySpec {
  /** Human ID prefix, e.g. REQ → REQ-001. */
  prefix: string;
  /** Opaque ID prefix. */
  idPrefix: string;
  /** Directory under the project folder. */
  dir: string;
  statuses: readonly string[];
  initialStatus: string;
  /** Statuses that require a recorded human approval event. */
  approvalStatuses: readonly string[];
  sections: Record<string, SectionKind>;
  fields: Record<string, FieldKind>;
}

export const ENTITY_SPECS: Record<EntityType, EntitySpec> = {
  requirement: {
    prefix: "REQ",
    idPrefix: "req",
    dir: "requirements",
    statuses: ["draft", "in_review", "approved", "superseded", "rejected"],
    initialStatus: "draft",
    approvalStatuses: ["approved"],
    sections: {
      description: "text",
      preconditions: "statements",
      behavior: "statements",
      alternate_flows: "statements",
      validation_rules: "statements",
      acceptance_criteria: "statements",
      open_questions: "list",
    },
    fields: {
      type: "string",
      module: "string",
      actors: "string_list",
      priority: "string",
      dependencies: "string_list",
      related_decisions: "string_list",
      feature_scopes: "string_list",
      origin: "string",
    },
  },
  decision: {
    prefix: "DEC",
    idPrefix: "dec",
    dir: "decisions",
    statuses: ["draft", "in_review", "approved", "superseded", "rejected"],
    initialStatus: "draft",
    approvalStatuses: ["approved"],
    sections: { question: "text", options: "list", selected: "text", rationale: "text" },
    fields: {
      affected_requirements: "string_list",
      feature_scopes: "string_list",
      resolves_conflict: "string",
      origin: "string",
    },
  },
  open_question: {
    prefix: "QUESTION",
    idPrefix: "qst",
    dir: "open-questions",
    statuses: ["open", "answered", "withdrawn"],
    initialStatus: "open",
    approvalStatuses: [],
    sections: { question: "text", context: "text", resolution: "text" },
    fields: {
      blocking: "boolean",
      feature_scopes: "string_list",
      related_requirements: "string_list",
      origin: "string",
      /** A human confirmed that this AI-proposed question is worth tracking (it stays open until answered). */
      reviewed: "boolean",
    },
  },
  conflict: {
    prefix: "CONFLICT",
    idPrefix: "cfl",
    dir: "conflicts",
    statuses: ["open", "resolved", "dismissed"],
    initialStatus: "open",
    approvalStatuses: [],
    sections: { description: "text", sides: "list", resolution: "text" },
    fields: {
      blocking: "boolean",
      feature_scopes: "string_list",
      related_requirements: "string_list",
      resolution_decision: "string",
      origin: "string",
      /** A human confirmed that this AI-proposed conflict is real (it stays open until resolved). */
      reviewed: "boolean",
    },
  },
  change_proposal: {
    prefix: "CHANGE",
    idPrefix: "chg",
    dir: "proposals",
    statuses: ["open", "accepted", "rejected", "stale"],
    initialStatus: "open",
    approvalStatuses: [],
    /**
     * proposed_change/rationale: free text (developer agents, humans).
     * proposed_description / proposed_additions: structured edits proposed by AI extraction from a new document.
     * Each addition is "[<section> · <basis>] <statement>"; accepting the proposal applies them to the requirement.
     */
    sections: { proposed_change: "text", rationale: "text", proposed_description: "text", proposed_additions: "list" },
    fields: {
      requirement_id: "string",
      base_revision: "number",
      proposed_by: "string",
      origin: "string",
    },
  },
};

export const HumanIdSchema = z.string().regex(/^(REQ|DEC|QUESTION|CONFLICT|CHANGE)-\d{3,6}$/);

export const FieldValueSchema = z.union([z.string(), z.array(z.string()), z.number(), z.boolean(), z.null()]);
export const SectionValueSchema = z.union([z.string(), z.array(z.string()), z.array(StatementSchema)]);

export const FILE_STATES = ["ok", "external_edit", "missing", "invalid_file"] as const;

export const ApprovalViewSchema = z.object({
  event_id: z.string(),
  approved_by: z.string(),
  approved_at: z.string(),
  revision: z.number().int(),
  note: z.string().nullable(),
});

export const KnowledgeEntitySchema = z.object({
  id: z.string(),
  human_id: HumanIdSchema,
  project_id: ProjectIdSchema,
  entity_type: EntityTypeSchema,
  schema_version: z.number().int(),
  revision: z.number().int().positive(),
  status: z.string(),
  title: z.string(),
  fields: z.record(z.string(), FieldValueSchema),
  sections: z.record(z.string(), SectionValueSchema),
  source_refs: z.array(SourceRefSchema),
  supersedes: z.string().nullable(),
  approval_event_id: z.string().nullable(),
  /** Server-computed: approved status backed by a matching human approval event for this exact content. */
  approval_valid: z.boolean(),
  approval: ApprovalViewSchema.nullable(),
  semantic_hash: z.string(),
  stale: z.boolean(),
  file_state: z.enum(FILE_STATES),
  created_at: z.string(),
  updated_at: z.string(),
  storage_path: z.string(),
});
export type KnowledgeEntity = z.infer<typeof KnowledgeEntitySchema>;

export const SEARCHABLE_TYPES = ["source", ...ENTITY_TYPES] as const;
export const SearchableTypeSchema = z.enum(SEARCHABLE_TYPES);
export type SearchableType = z.infer<typeof SearchableTypeSchema>;

export const SearchHitSchema = z.object({
  kind: z.enum(["evidence", "knowledge"]),
  entity_type: SearchableTypeSchema,
  chunk_id: z.string(),
  source_id: z.string().nullable(),
  revision_id: z.string().nullable(),
  entity_id: z.string().nullable(),
  human_id: z.string().nullable(),
  status: z.string().nullable(),
  approval_valid: z.boolean().nullable(),
  title: z.string(),
  heading: z.string().nullable(),
  locator: LocatorSchema,
  snippet: z.string(),
  score: z.number(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const AuditEventSchema = z.object({
  id: z.string(),
  at: z.string(),
  actor_kind: z.string(),
  actor_id: z.string(),
  project_id: z.string().nullable(),
  action: z.string(),
  entity_type: z.string().nullable(),
  entity_id: z.string().nullable(),
  details: z.unknown(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;
