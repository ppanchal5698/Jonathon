import { z } from "zod";

// =====================================================================================================================
// Project memory graph
// =====================================================================================================================

/** What a concept in the project memory graph is. Concepts are named things the client material talks about. */
export const CONCEPT_KINDS = [
  "actor", // a person, role or team that uses or runs the system
  "feature", // a capability, module or screen of the product
  "system", // an internal component, service or application of the solution
  "external_system", // a third-party or client system the solution talks to
  "data_entity", // a business object or record (order, price list, vendor)
  "technology", // a language, framework, database, cloud service or tool
  "business_term", // domain vocabulary with a specific meaning
  "environment", // dev, QA, staging, production, a tenant or region
  "metric", // a measurable target or KPI (response time, uptime, volume)
  "organization", // a company, client, vendor or department
  "workflow", // a business process or lifecycle
  "regulation", // a law, standard or policy (GDPR, DPDP, PCI, SOC 2)
] as const;
export const ConceptKindSchema = z.enum(CONCEPT_KINDS);
export type ConceptKind = z.infer<typeof ConceptKindSchema>;

/** Relations an agent may propose between two concepts. Each must be backed by a verbatim quote from the evidence. */
export const CONCEPT_RELATIONS = [
  "uses",
  "integrates_with",
  "depends_on",
  "part_of",
  "owns",
  "performs",
  "approves",
  "creates",
  "reads",
  "updates",
  "stores",
  "sends_to",
  "receives_from",
  "hosted_on",
  "authenticates_with",
  "replaces",
  "constrains",
  "measures",
] as const;
export const ConceptRelationSchema = z.enum(CONCEPT_RELATIONS);

/** Graph extractor output for one batch of evidence. */
export const ModelGraphExtractionSchema = z.object({
  concepts: z
    .array(
      z.object({
        name: z.string().min(2).max(120),
        kind: ConceptKindSchema,
        aliases: z.array(z.string().min(2).max(120)).max(5),
        description: z.string().max(400),
        evidence_ids: z.array(z.string().max(16)).min(1).max(6),
      }),
    )
    .max(60),
  relations: z
    .array(
      z.object({
        from: z.string().min(2).max(120),
        relation: ConceptRelationSchema,
        to: z.string().min(2).max(120),
        quote: z.string().min(3).max(300),
        evidence_ids: z.array(z.string().max(16)).min(1).max(4),
      }),
    )
    .max(80),
});
export type ModelGraphExtraction = z.infer<typeof ModelGraphExtractionSchema>;

/** Stored per source revision under graph/extractions/<revision>.json (derived; rebuildable by re-running the job). */
export const GraphExtractionFileSchema = z.object({
  schema_version: z.literal(1),
  project_id: z.string(),
  source_id: z.string(),
  revision_id: z.string(),
  provider: z.string(),
  created_at: z.string(),
  concepts: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      kind: ConceptKindSchema,
      aliases: z.array(z.string()),
      description: z.string(),
      chunk_ids: z.array(z.string()),
    }),
  ),
  relations: z.array(
    z.object({
      from: z.string(),
      relation: ConceptRelationSchema,
      to: z.string(),
      quote: z.string(),
      chunk_ids: z.array(z.string()),
    }),
  ),
  rejected: z.array(z.object({ text: z.string(), reason: z.string() })).default([]),
});
export type GraphExtractionFile = z.infer<typeof GraphExtractionFileSchema>;

export const GRAPH_NODE_TYPES = [
  "source",
  "passage",
  "requirement",
  "decision",
  "open_question",
  "conflict",
  "change_proposal",
  "concept",
  "document",
] as const;
export type GraphNodeType = (typeof GRAPH_NODE_TYPES)[number];

export interface GraphNode {
  id: string;
  label: string;
  type: GraphNodeType;
  /** Concept kind, entity status, or document category. */
  kind: string | null;
  /** Short description or excerpt. */
  detail: string;
  /** Link target in the UI (entity page, source page, document page), when there is one. */
  href: string | null;
  degree: number;
  community: number | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  /** EXTRACTED: recorded structure or wording found by code. INFERRED: an AI-proposed relation backed by a verified quote. */
  confidence: "EXTRACTED" | "INFERRED";
  quote?: string;
}

// =====================================================================================================================
// Generated technical documents
// =====================================================================================================================

export const DOC_CATEGORIES = [
  ["requirements", "Requirements"],
  ["architecture", "System design & architecture"],
  ["backend", "Backend"],
  ["frontend", "Frontend"],
  ["database", "Database"],
  ["integrations", "Integrations"],
  ["security", "Security"],
  ["devops", "DevOps & infrastructure"],
  ["standards", "Engineering standards"],
  ["testing", "Testing"],
] as const;
export type DocCategory = (typeof DOC_CATEGORIES)[number][0];

/**
 * How a document item is backed. Jonathon decides this, never the model:
 * client_stated  – the wording is in the cited client evidence;
 * evidence_based – a restatement of cited client evidence, confirmed by the verifier;
 * knowledge      – compiled from Jonathon knowledge (requirements, decisions...), labelled with its review status;
 * ai_proposed    – an engineering proposal the client did not state (stays "proposed" until the document is approved);
 * gap            – something the document needs that the material does not answer;
 * human_authored – written or edited by a person.
 */
export const DOC_BASES = ["client_stated", "evidence_based", "knowledge", "ai_proposed", "gap", "human_authored"] as const;
export type DocBasis = (typeof DOC_BASES)[number];

export const DocRefSchema = z.object({
  /** "E" chunk evidence or "K" knowledge item. */
  kind: z.enum(["chunk", "entity", "concept"]),
  id: z.string(),
  label: z.string(),
  source_id: z.string().optional(),
  revision_id: z.string().optional(),
  excerpt: z.string().optional(),
  status: z.string().optional(),
});
export type DocRef = z.infer<typeof DocRefSchema>;

export const DocBlockSchema = z.object({
  id: z.string(),
  kind: z.enum(["fact", "proposal", "gap", "diagram", "human"]),
  text: z.string(),
  /** Table rows: one cell per column of the section. Empty for plain blocks. */
  cells: z.array(z.string()).default([]),
  basis: z.enum(DOC_BASES),
  refs: z.array(DocRefSchema).default([]),
  review_state: z.enum(["proposed", "accepted"]),
  note: z.string().optional(),
});
export type DocBlock = z.infer<typeof DocBlockSchema>;

export const DocSectionSchema = z.object({
  key: z.string(),
  title: z.string(),
  mode: z.enum(["written", "compiled"]),
  columns: z.array(z.string()).default([]),
  blocks: z.array(DocBlockSchema),
  /** Hash of everything this section was built from. A refresh rebuilds the section only when it changes. */
  input_fingerprint: z.string(),
  /** A person edited this section. Regeneration never overwrites it; new content waits in pending_update. */
  human_edited: z.boolean().default(false),
  pending_update: z
    .object({ blocks: z.array(DocBlockSchema), input_fingerprint: z.string(), generated_at: z.string() })
    .nullable()
    .default(null),
});
export type DocSection = z.infer<typeof DocSectionSchema>;

export const DocChangeSchema = z.object({
  revision: z.number().int(),
  at: z.string(),
  reasons: z.array(z.string()),
  added: z.array(z.string()),
  removed: z.array(z.string()),
  sections_changed: z.array(z.string()),
});
export type DocChange = z.infer<typeof DocChangeSchema>;

/** documents/<doc_type>.json – the authoritative generated document. The .md file next to it is a rendering. */
export const GeneratedDocumentSchema = z.object({
  schema_version: z.literal(1),
  project_id: z.string(),
  doc_type: z.string(),
  title: z.string(),
  category: z.string(),
  revision: z.number().int().positive(),
  generated_at: z.string(),
  provider: z.string(),
  sections: z.array(DocSectionSchema),
  /** Items the code gate or the verifier removed, with the reason. */
  removed: z.array(z.object({ text: z.string(), reason: z.string() })).default([]),
  changes: z.array(DocChangeSchema).default([]),
  content_hash: z.string(),
  rendered_hash: z.string().default(""),
});
export type GeneratedDocument = z.infer<typeof GeneratedDocumentSchema>;

// ---------- model output: the technical writer and the document verifier ----------

export const ModelDocWriterSchema = z.object({
  sections: z
    .array(
      z.object({
        key: z.string().max(60),
        blocks: z
          .array(
            z.object({
              kind: z.enum(["fact", "proposal", "gap", "diagram"]),
              /** fact/proposal/gap: one sentence or short paragraph. diagram: Mermaid code. */
              text: z.string().max(4_000),
              /** For table sections: one cell per column, in order. Otherwise empty. */
              cells: z.array(z.string().max(600)).max(10),
              /** E ids (client evidence) and knowledge ids (REQ-001, DEC-002, QUESTION-003, CONFLICT-004). */
              cites: z.array(z.string().max(20)).max(8),
            }),
          )
          .max(40),
      }),
    )
    .max(14),
});
export type ModelDocWriter = z.infer<typeof ModelDocWriterSchema>;

export const ModelDocVerificationSchema = z.object({
  verdicts: z
    .array(
      z.object({
        item_id: z.string().max(16),
        verdict: z.enum(["supported", "unsupported"]),
        reason: z.string().max(400),
      }),
    )
    .max(300),
});
export type ModelDocVerification = z.infer<typeof ModelDocVerificationSchema>;

// ---------- API ----------

export const GenerateDocumentsBodySchema = z.object({
  /** Catalogue ids, or "must_have" / "all". */
  doc_types: z.union([z.array(z.string().max(60)).min(1).max(100), z.enum(["must_have", "all"])]),
});

export const EditDocSectionBodySchema = z.object({
  expected_revision: z.number().int().positive(),
  /** Markdown written by a person. Replaces the section's content and protects it from regeneration. */
  markdown: z.string().max(60_000),
});

export const DocSectionUpdateBodySchema = z.object({
  expected_revision: z.number().int().positive(),
  /** accept: replace the human-edited content with the regenerated content. keep: discard the regenerated content. */
  action: z.enum(["accept", "keep"]),
});

export const DocReviewBodySchema = z.object({
  expected_revision: z.number().int().positive(),
  /** Must equal "approve <doc_type>". */
  confirmation: z.string().max(120),
  note: z.string().max(2_000).optional(),
});
