import {
  ENTITY_SPECS,
  type EntityType,
  EntityTypeSchema,
  HumanIdSchema,
  ProjectIdSchema,
  type SourceRef,
  SourceRefSchema,
  type Statement,
} from "@jonathon/contracts";
import YAML from "yaml";
import { z } from "zod";
import { sha256 } from "../util";

export const ENTITY_SCHEMA_VERSION = 1;

export type FieldValue = string | string[] | number | boolean | null;
export type SectionValue = string | string[] | Statement[];

/** In-memory form of one knowledge entity file. */
export interface EntityDoc {
  id: string;
  human_id: string;
  project_id: string;
  entity_type: EntityType;
  schema_version: number;
  revision: number;
  status: string;
  title: string;
  created_at: string;
  updated_at: string;
  supersedes: string | null;
  approval_event_id: string | null;
  fields: Record<string, FieldValue>;
  sections: Record<string, SectionValue>;
  source_refs: SourceRef[];
}

/** Unrecognized `## headings` are preserved verbatim here so manual edits are never dropped. */
export const EXTRA_SECTION = "_extra";

export function sectionLabel(key: string): string {
  const s = key.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function emptySection(kind: string): SectionValue {
  return kind === "text" ? "" : [];
}

export function normalizeFields(type: EntityType, input: Record<string, unknown>): Record<string, FieldValue> {
  const spec = ENTITY_SPECS[type];
  const out: Record<string, FieldValue> = {};
  for (const [key, kind] of Object.entries(spec.fields)) {
    const v = input[key];
    if (kind === "string_list") {
      out[key] = Array.isArray(v)
        ? v
            .map((x) => String(x).trim())
            .filter(Boolean)
            .slice(0, 100)
        : [];
    } else if (kind === "boolean") {
      out[key] = v === true || v === "true";
    } else if (kind === "number") {
      out[key] = typeof v === "number" && Number.isFinite(v) ? v : v == null || v === "" ? null : Number(v);
      if (typeof out[key] === "number" && !Number.isFinite(out[key] as number)) out[key] = null;
    } else {
      out[key] = v == null || v === "" ? null : String(v).slice(0, 2_000);
    }
  }
  return out;
}

const StatementInput = z.object({
  text: z.string().min(1).max(2_000),
  basis: z.enum(["source_stated", "ai_inferred", "human_authored"]).default("human_authored"),
  review_state: z.enum(["proposed", "accepted"]).default("accepted"),
});

export function normalizeSections(type: EntityType, input: Record<string, unknown>): Record<string, SectionValue> {
  const spec = ENTITY_SPECS[type];
  const out: Record<string, SectionValue> = {};
  for (const [key, kind] of Object.entries(spec.sections)) {
    const v = input[key];
    if (kind === "text") out[key] = typeof v === "string" ? v.trim() : "";
    else if (kind === "list") out[key] = Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
    else
      out[key] = Array.isArray(v)
        ? v
            .map((x) => (typeof x === "string" ? { text: x } : x))
            .map((x) => StatementInput.safeParse(x))
            .filter((r) => r.success)
            .map((r) => r.data as Statement)
        : [];
  }
  if (typeof input[EXTRA_SECTION] === "string" && (input[EXTRA_SECTION] as string).trim()) {
    out[EXTRA_SECTION] = (input[EXTRA_SECTION] as string).trim();
  }
  return out;
}

function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " ").trim();
}

export function serializeEntity(doc: EntityDoc): string {
  const spec = ENTITY_SPECS[doc.entity_type];
  const fm: Record<string, unknown> = {
    id: doc.id,
    human_id: doc.human_id,
    project_id: doc.project_id,
    entity_type: doc.entity_type,
    schema_version: doc.schema_version,
    revision: doc.revision,
    status: doc.status,
    title: doc.title,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
    supersedes: doc.supersedes,
    approval_event_id: doc.approval_event_id,
  };
  for (const key of Object.keys(spec.fields)) fm[key] = doc.fields[key] ?? null;
  fm.source_refs = doc.source_refs;
  const yaml = YAML.stringify(fm, { lineWidth: 0, defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN" });
  const lines: string[] = ["---", yaml.trimEnd(), "---", "", `# ${doc.human_id}: ${oneLine(doc.title)}`, ""];
  for (const [key, kind] of Object.entries(spec.sections)) {
    lines.push(`## ${sectionLabel(key)}`, "");
    const v = doc.sections[key] ?? emptySection(kind);
    if (kind === "text") {
      lines.push((v as string).trim() || "_(none)_");
    } else if (kind === "list") {
      const items = v as string[];
      if (items.length === 0) lines.push("_(none)_");
      for (const item of items) lines.push(`- ${oneLine(item)}`);
    } else {
      const items = v as Statement[];
      if (items.length === 0) lines.push("_(none)_");
      for (const st of items) lines.push(`- (${st.basis}, ${st.review_state}) ${oneLine(st.text)}`);
    }
    lines.push("");
  }
  const extra = doc.sections[EXTRA_SECTION];
  if (typeof extra === "string" && extra.trim()) lines.push(extra.trim(), "");
  return `${lines.join("\n").trimEnd()}\n`;
}

const FrontmatterSchema = z
  .object({
    id: z.string().regex(/^[a-z]{3}_[0-9a-z]{26}$/),
    human_id: HumanIdSchema,
    project_id: ProjectIdSchema,
    entity_type: EntityTypeSchema,
    schema_version: z.number().int().positive(),
    revision: z.number().int().positive(),
    status: z.string().min(1).max(40),
    title: z.string().min(1).max(500),
    created_at: z.string(),
    updated_at: z.string(),
    supersedes: z.string().nullable().optional(),
    approval_event_id: z.string().nullable().optional(),
    source_refs: z.array(SourceRefSchema).nullable().optional(),
  })
  .passthrough();

export class EntityParseError extends Error {}

const STATEMENT_LINE = /^\((source_stated|ai_inferred|human_authored)(?:,\s*(proposed|accepted))?\)\s+(.+)$/;

/** Parse an entity file. Throws EntityParseError with a reason on malformed input. */
export function parseEntity(text: string): EntityDoc {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new EntityParseError("missing YAML frontmatter");
  let raw: unknown;
  try {
    raw = YAML.parse(m[1]!, { uniqueKeys: true, maxAliasCount: 0, prettyErrors: false });
  } catch (e) {
    throw new EntityParseError(`invalid YAML frontmatter: ${(e as Error).message.split("\n")[0]}`);
  }
  const fmr = FrontmatterSchema.safeParse(raw);
  if (!fmr.success) throw new EntityParseError(`invalid frontmatter: ${fmr.error.issues[0]?.path.join(".")} ${fmr.error.issues[0]?.message}`);
  const fm = fmr.data as z.infer<typeof FrontmatterSchema> & Record<string, unknown>;
  const spec = ENTITY_SPECS[fm.entity_type];
  if (!spec.statuses.includes(fm.status)) throw new EntityParseError(`status "${fm.status}" is not valid for ${fm.entity_type}`);

  const body = m[2]!.replace(/\r\n/g, "\n");
  const labelToKey = new Map(Object.keys(spec.sections).map((k) => [sectionLabel(k).toLowerCase(), k]));
  const sections: Record<string, SectionValue> = {};
  const extra: string[] = [];
  const parts = body.split(/^## +/m);
  for (const part of parts.slice(1)) {
    const nl = part.indexOf("\n");
    const heading = (nl === -1 ? part : part.slice(0, nl)).trim();
    const content = nl === -1 ? "" : part.slice(nl + 1);
    const key = labelToKey.get(heading.toLowerCase());
    if (!key) {
      extra.push(`## ${heading}\n${content.trimEnd()}`);
      continue;
    }
    const kind = spec.sections[key]!;
    const cleaned = content.replace(/^_\(none\)_\s*$/m, "").trim();
    if (kind === "text") {
      sections[key] = cleaned;
      continue;
    }
    const items: string[] = [];
    for (const line of cleaned.split("\n")) {
      const li = /^\s*[-*]\s+(.*)$/.exec(line);
      if (li) items.push(li[1]!.trim());
      else if (line.trim() && items.length > 0) items[items.length - 1] += ` ${line.trim()}`;
      else if (line.trim()) items.push(line.trim());
    }
    if (kind === "list") sections[key] = items.filter(Boolean);
    else
      sections[key] = items.filter(Boolean).map((item): Statement => {
        const sm = STATEMENT_LINE.exec(item);
        if (sm) return { basis: sm[1] as Statement["basis"], review_state: (sm[2] ?? "accepted") as Statement["review_state"], text: sm[3]!.trim() };
        // A bare bullet was written by a human editor.
        return { basis: "human_authored", review_state: "accepted", text: item };
      });
  }
  if (extra.length) sections[EXTRA_SECTION] = extra.join("\n\n");

  return {
    id: fm.id,
    human_id: fm.human_id,
    project_id: fm.project_id,
    entity_type: fm.entity_type,
    schema_version: fm.schema_version,
    revision: fm.revision,
    status: fm.status,
    title: fm.title,
    created_at: fm.created_at,
    updated_at: fm.updated_at,
    supersedes: fm.supersedes ?? null,
    approval_event_id: fm.approval_event_id ?? null,
    fields: normalizeFields(fm.entity_type, fm),
    sections: normalizeSections(fm.entity_type, sections),
    source_refs: fm.source_refs ?? [],
  };
}

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
    );
  return v;
}

/**
 * Hash of the entity's meaning: title, fields, sections and evidence pointers.
 * Excludes status, revision, timestamps and approval metadata, so an approval stays bound to content.
 */
export function semanticHash(doc: Pick<EntityDoc, "entity_type" | "human_id" | "title" | "fields" | "sections" | "source_refs">): string {
  return sha256(
    JSON.stringify(
      stable({
        entity_type: doc.entity_type,
        human_id: doc.human_id,
        title: doc.title.trim(),
        fields: doc.fields,
        sections: doc.sections,
        source_refs: doc.source_refs.map((r) => ({ s: r.source_id, r: r.revision_id, c: r.chunk_id ?? null, l: r.label ?? null })),
      }),
    ),
  );
}

/** Plain-text rendering of an entity for retrieval and model context. */
export function entityPlainText(doc: EntityDoc): string {
  const spec = ENTITY_SPECS[doc.entity_type];
  const out: string[] = [`${doc.human_id}: ${doc.title}`];
  for (const [key, val] of Object.entries(doc.fields)) {
    if (val == null || (Array.isArray(val) && val.length === 0) || key === "origin") continue;
    out.push(`${sectionLabel(key)}: ${Array.isArray(val) ? val.join(", ") : String(val)}`);
  }
  for (const [key, kind] of Object.entries(spec.sections)) {
    const v = doc.sections[key];
    if (!v || (Array.isArray(v) && v.length === 0) || v === "") continue;
    if (kind === "text") out.push(`${sectionLabel(key)}: ${v as string}`);
    else if (kind === "list") out.push(`${sectionLabel(key)}:\n${(v as string[]).map((x) => `- ${x}`).join("\n")}`);
    else
      out.push(
        `${sectionLabel(key)}:\n${(v as Statement[])
          .map((s) => `- ${s.text}${s.basis === "ai_inferred" ? " [AI-inferred]" : ""}${s.review_state === "proposed" ? " [proposed, not reviewed]" : ""}`)
          .join("\n")}`,
      );
  }
  return out.join("\n");
}
