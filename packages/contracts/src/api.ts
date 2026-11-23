import { z } from "zod";
import { EntityTypeSchema, ProjectIdSchema, SearchableTypeSchema, StatementSchema } from "./domain";

export const SetupAccountBodySchema = z.object({
  username: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9._-]+$/),
  password: z.string().min(12).max(256),
});
export const LoginBodySchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

export const CreateProjectBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2_000).default(""),
  ai_enabled: z.boolean().default(false),
});
export const UpdateProjectBodySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2_000).optional(),
  ai_enabled: z.boolean().optional(),
});

export const PasteTextBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  text: z.string().min(1).max(2_000_000),
  /** Add a new revision to an existing source instead of creating a new source. */
  source_id: z.string().optional(),
});

export const AskBodySchema = z.object({
  message: z.string().trim().min(1).max(8_000),
  conversation_id: z.string().optional(),
  feature_scope: z.string().trim().max(120).optional(),
  knowledge_revision: z.number().int().nonnegative().optional(),
  request_id: z.string().min(8).max(100).optional(),
  wait_ms: z.number().int().min(0).max(60_000).optional(),
});
export type AskBody = z.infer<typeof AskBodySchema>;

export const SearchBodySchema = z.object({
  query: z.string().trim().min(1).max(500),
  entity_types: z.array(SearchableTypeSchema).optional(),
  status: z.array(z.string().max(40)).optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

export const EntityDraftBodySchema = z.object({
  title: z.string().trim().min(3).max(200),
  fields: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.number(), z.boolean(), z.null()])).default({}),
  sections: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.array(StatementSchema)])).default({}),
});

export const CreateEntityBodySchema = EntityDraftBodySchema.extend({ entity_type: EntityTypeSchema });

export const UpdateEntityBodySchema = EntityDraftBodySchema.extend({
  expected_revision: z.number().int().positive(),
});

export const TransitionBodySchema = z.object({
  to: z.string().min(1).max(40),
  expected_revision: z.number().int().positive(),
  /** Explicit human confirmation for approvals and rejections: must equal "<verb> <HUMAN-ID>", e.g. "approve REQ-001". */
  confirmation: z.string().max(100).optional(),
  note: z.string().max(2_000).optional(),
});

export const ResolveConflictBodySchema = z.object({
  expected_revision: z.number().int().positive(),
  question: z.string().trim().min(3).max(2_000),
  selected: z.string().trim().min(1).max(4_000),
  rationale: z.string().trim().min(3).max(4_000),
  options: z.array(z.string().max(1_000)).max(10).default([]),
  /** Must equal "resolve CONFLICT-00N". Creates an approved decision and resolves the conflict. */
  confirmation: z.string().max(100),
});

export const AnswerQuestionBodySchema = z.object({
  expected_revision: z.number().int().positive(),
  resolution: z.string().trim().min(1).max(4_000),
  confirmation: z.string().max(100),
});

export const CreateMcpTokenBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  project_ids: z.array(ProjectIdSchema).min(1).max(100),
  scopes: z.array(z.enum(["read", "propose"])).min(1),
  expires_in_days: z.number().int().min(1).max(365).optional(),
});

export const ProposeRequirementChangeSchema = z.object({
  project_id: ProjectIdSchema,
  requirement_id: z.string().min(1).max(40),
  base_revision: z.number().int().positive(),
  proposed_change: z.string().trim().min(3).max(8_000),
  rationale: z.string().trim().min(3).max(4_000),
  request_id: z.string().min(8).max(100),
});

/** Review actions on one knowledge item. confirmation must equal "<verb> <HUMAN-ID>" (approve/accept, reject/dismiss/withdraw, delete). */
export const ReviewActionBodySchema = z.object({
  expected_revision: z.number().int().positive(),
  confirmation: z.string().max(100),
  note: z.string().max(2_000).optional(),
});
export type ReviewActionBody = z.infer<typeof ReviewActionBodySchema>;

/** Import documents from a folder on this computer (human session only). */
export const FolderScanBodySchema = z.object({
  path: z.string().min(3).max(1_000),
  recursive: z.boolean().default(true),
});
export const FolderImportBodySchema = FolderScanBodySchema.extend({
  /** Relative paths from the scan to import. */
  files: z.array(z.string().min(1).max(1_000)).min(1).max(2_000),
});

export const DeleteProjectBodySchema = z.object({
  /** Must equal "delete <project name>". */
  confirmation: z.string().max(300),
});
export const DeleteSourceBodySchema = z.object({
  /** Must equal "delete <source display name>". */
  confirmation: z.string().max(300),
});

/** Every /api/v1 response has { data } on success or { error } (see errors.ts) on failure. */
export type ApiOk<T> = { data: T };
