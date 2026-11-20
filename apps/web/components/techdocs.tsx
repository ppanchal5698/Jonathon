"use client";

import { DOC_CATEGORIES, type DocBlock, type DocSection, type GeneratedDocument } from "@jonathon/contracts";
import { useState } from "react";
import { Modal } from "@/components/review";
import {
  A,
  Badge,
  Button,
  buttonClass,
  Card,
  CardSkeleton,
  ConfirmPhrase,
  cx,
  ErrorBanner,
  Notice,
  Pagination,
  Skeleton,
  TableSkeleton,
  table,
  Textarea,
  Time,
  usePaged,
} from "@/components/ui";
import { type ApiError, api, post } from "@/lib/api";
import { useApi } from "@/lib/use-api";

export interface CatalogueEntry {
  id: string;
  title: string;
  category: string;
  must_have: boolean;
  nature: "client" | "mixed" | "engineering";
  purpose: string;
  generated: boolean;
  revision: number | null;
  generated_at: string | null;
  updated_at: string | null;
  counts: Record<string, number> | null;
  pending_updates: number;
  approved: boolean;
}

export interface Catalogue {
  documents: CatalogueEntry[];
  job: { id: string; status: string; progress: { stage: string; detail?: string } | null; mode: string; run_after: string } | null;
  last_job: { id: string; status: string; finished_at: string | null; error: string | null; result: Record<string, unknown> | null } | null;
}

export const BASIS: Record<DocBlock["basis"], { label: string; tone: string; hint: string }> = {
  client_stated: { label: "client-stated", tone: "success", hint: "The wording is in the client material." },
  evidence_based: { label: "from client material", tone: "info", hint: "Restates the cited client material; checked by the document verifier." },
  knowledge: { label: "knowledge", tone: "primary", hint: "Compiled from Jonathon's requirements, decisions and questions, with their review status." },
  ai_proposed: { label: "AI proposal", tone: "warning", hint: "Not stated by the client. An engineering proposal to review." },
  gap: { label: "gap", tone: "orange", hint: "The material does not answer this yet." },
  human_authored: { label: "edited by a person", tone: "gray", hint: "Written or edited by a person." },
};

const NATURE: Record<CatalogueEntry["nature"], string> = {
  client: "from client material",
  mixed: "client + design",
  engineering: "engineering conventions",
};

function factCount(c: Record<string, number> | null): number {
  return c ? (c.client_stated ?? 0) + (c.evidence_based ?? 0) + (c.knowledge ?? 0) : 0;
}

export function JobLine({ cat }: { cat: Catalogue }) {
  if (cat.job) {
    const waiting = cat.job.status === "queued" && new Date(cat.job.run_after).getTime() > Date.now();
    return (
      <Notice tone="info" title={cat.job.mode === "refresh" ? "Updating documents" : "Writing documents"}>
        {waiting
          ? "Waiting for uploads, drafting and concept mapping to finish, then only the documents whose inputs changed are rebuilt."
          : cat.job.progress
            ? `${cat.job.progress.stage}${cat.job.progress.detail ? `: ${cat.job.progress.detail}` : ""}`
            : "Queued."}
      </Notice>
    );
  }
  const r = cat.last_job?.result as { created?: number; updated?: number; unchanged?: number; failed?: unknown[]; deferred?: boolean } | null;
  if (!cat.last_job || !r || r.deferred) return null;
  if (cat.last_job.status === "failed")
    return (
      <Notice tone="warning" title="The last run failed">
        {cat.last_job.error}
      </Notice>
    );
  return (
    <p className="text-theme-sm text-gray-500 dark:text-gray-400">
      Last run <Time iso={cat.last_job.finished_at} />: {r.created ?? 0} created, {r.updated ?? 0} updated, {r.unchanged ?? 0} unchanged
      {r.failed?.length ? `, ${r.failed.length} failed (retried on the next update)` : ""}.
    </p>
  );
}

/** Project tab: the catalogue of technical documents, grouped by category. */
export function TechDocs({ pid, aiEnabled }: { pid: string; aiEnabled: boolean }) {
  const cat = useApi<Catalogue>(`/projects/${pid}/documents`, { pollMs: 4000, pollWhile: (d) => !!d.job });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  if (cat.error) return <ErrorBanner error={cat.error} />;
  if (!cat.data)
    return (
      <div className="space-y-6">
        <CardSkeleton lines={5} label="technical documentation" />
        {[0, 1].map((i) => (
          <CardSkeleton key={i} label="document category">
            <TableSkeleton rows={4} cols={4} label="documents" />
          </CardSkeleton>
        ))}
      </div>
    );
  const docs = cat.data.documents;
  const mustHave = docs.filter((d) => d.must_have);
  const generated = docs.filter((d) => d.generated);
  const generate = async (doc_types: string[] | "must_have" | "all") => {
    setBusy(true);
    setError(null);
    try {
      await post(`/projects/${pid}/documents/generate`, { doc_types });
      await cat.reload();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  const running = !!cat.data.job;

  return (
    <div className="space-y-6">
      <Card
        title="Technical documentation"
        desc={`${generated.length} of ${docs.length} documents generated · ${generated.filter((d) => d.approved).length} approved`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || running || !aiEnabled} onClick={() => void generate("must_have")}>
              Generate must-haves ({mustHave.length})
            </Button>
            <Button variant="secondary" disabled={busy || running || !aiEnabled} onClick={() => void generate("all")}>
              Generate all {docs.length}
            </Button>
            {generated.length > 0 && (
              <a className={buttonClass("ghost")} href={`/api/v1/projects/${pid}/documents-export`}>
                Download all (Markdown)
              </a>
            )}
          </div>
        }
      >
        <div className="space-y-3 text-theme-sm text-gray-600 dark:text-gray-400">
          <p>
            Jonathon writes each document from this project's client material, its requirements, decisions, open questions and conflicts, and the memory graph.
            Lists such as requirements, acceptance criteria, glossaries and traceability are compiled by code. The rest is drafted by the technical-writer
            agent, then checked by code and by a verifier agent. Every item is labelled: <Badge tone="success">client-stated</Badge>{" "}
            <Badge tone="info">from client material</Badge> <Badge tone="primary">knowledge</Badge> <Badge tone="warning">AI proposal</Badge>{" "}
            <Badge tone="orange">gap</Badge>.
          </p>
          <p>
            When you add or remove a document, or review knowledge, the generated documents are updated automatically. Only documents whose inputs changed are
            rebuilt, and sections you edited are never overwritten.
          </p>
          {!aiEnabled && <Notice tone="warning">AI processing is off for this project. Turn it on in Settings to generate documents.</Notice>}
          {aiEnabled && (
            <p className="text-theme-xs">
              Generating documents sends the relevant client passages and knowledge to the AI model service configured for Antigravity.
            </p>
          )}
          <ErrorBanner error={error} />
          <JobLine cat={cat.data} />
        </div>
      </Card>

      {DOC_CATEGORIES.map(([key, label]) => {
        const list = docs.filter((d) => d.category === key);
        return (
          <Card key={key} title={label} desc={`${list.filter((d) => d.generated).length} of ${list.length} generated`}>
            <div className={table.wrap}>
              <table className={table.table}>
                <thead className={table.thead}>
                  <tr>
                    <th className={table.th}>Document</th>
                    <th className={table.th}>State</th>
                    <th className={table.th}>Facts / proposals / gaps</th>
                    <th className={table.th}>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((d) => (
                    <tr key={d.id} className={table.tr}>
                      <td className={table.td}>
                        <div className="flex flex-wrap items-center gap-2">
                          {d.generated ? (
                            <A href={`/projects/${pid}/docs/${d.id}`}>{d.title}</A>
                          ) : (
                            <span className="font-medium text-gray-800 dark:text-white/90">{d.title}</span>
                          )}
                          {d.must_have && <Badge tone="primary">must-have</Badge>}
                        </div>
                        <p className="mt-1 text-theme-xs text-gray-500 dark:text-gray-400">
                          {d.purpose} <span className="whitespace-nowrap">· {NATURE[d.nature]}</span>
                        </p>
                      </td>
                      <td className={table.td}>
                        {d.generated ? (
                          <div className="flex flex-col gap-1">
                            <span>
                              r{d.revision} · <Time iso={d.updated_at} />
                            </span>
                            <div className="flex flex-wrap gap-1">
                              {d.approved ? <Badge tone="success">approved</Badge> : <Badge tone="warning">not approved</Badge>}
                              {d.pending_updates > 0 && <Badge tone="info">{`${d.pending_updates} update${d.pending_updates > 1 ? "s" : ""} to review`}</Badge>}
                            </div>
                          </div>
                        ) : (
                          <span className="text-gray-500 dark:text-gray-400">not generated</span>
                        )}
                      </td>
                      <td className={cx(table.td, "whitespace-nowrap")}>
                        {d.counts ? `${factCount(d.counts)} / ${d.counts.ai_proposed ?? 0} / ${d.counts.gap ?? 0}` : "—"}
                      </td>
                      <td className={cx(table.td, "text-right")}>
                        <Button size="sm" variant="ghost" disabled={busy || running || !aiEnabled} onClick={() => void generate([d.id])}>
                          {d.generated ? "Regenerate" : "Generate"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// =====================================================================================================================
// One document
// =====================================================================================================================

export interface DocView {
  spec: { id: string; title: string; category: string; must_have: boolean; nature: string; purpose: string };
  document: GeneratedDocument | null;
  approval: { approved_by: string; approved_at: string; revision: number } | null;
  markdown: string | null;
}

function Refs({ pid, block }: { pid: string; block: DocBlock }) {
  if (!block.refs.length) return null;
  return (
    <span className="text-theme-xs text-gray-500 dark:text-gray-400">
      {block.refs.map((r, i) => {
        const href =
          r.kind === "entity"
            ? `/projects/${pid}/entities/${r.id}`
            : r.kind === "chunk"
              ? `/projects/${pid}/sources/${r.source_id}`
              : `/projects/${pid}?tab=graph&node=${encodeURIComponent(`concept:${r.id.replace(/\s+/g, "_")}`)}`;
        return (
          <span key={`${r.kind}${r.id}`}>
            {i > 0 && "; "}
            <a href={href} title={r.excerpt ?? r.status ?? undefined} className="text-brand-600 hover:underline dark:text-brand-400">
              {r.kind === "entity" ? `${r.id}${r.status ? ` (${r.status})` : ""}` : r.label}
            </a>
          </span>
        );
      })}
    </span>
  );
}

function BasisBadge({ b }: { b: DocBlock }) {
  const x = BASIS[b.basis];
  return (
    <span title={b.note ?? x.hint}>
      <Badge tone={x.tone}>{x.label}</Badge>
    </span>
  );
}

export function Blocks({ pid, columns, blocks }: { pid: string; columns: string[]; blocks: DocBlock[] }) {
  const rows = columns.length ? blocks.filter((b) => b.kind === "fact" || b.kind === "proposal") : [];
  const rest = blocks.filter((b) => !rows.includes(b));
  if (!blocks.length) return <p className="text-theme-sm text-gray-500 dark:text-gray-400">Nothing in the material for this section yet.</p>;
  return (
    <div className="space-y-3">
      {rows.length > 0 && (
        <div className={table.wrap}>
          <table className={table.table}>
            <thead className={table.thead}>
              <tr>
                {columns.map((c) => (
                  <th key={c} className={table.th}>
                    {c}
                  </th>
                ))}
                <th className={table.th}>Basis</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id} className={table.tr}>
                  {columns.map((c, i) => (
                    <td key={c} className={cx(table.td, "align-top")}>
                      {b.cells[i]}
                    </td>
                  ))}
                  <td className={cx(table.td, "align-top")}>
                    <div className="flex flex-col gap-1">
                      <BasisBadge b={b} />
                      <Refs pid={pid} block={b} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rest.length > 0 && (
        <ul className="space-y-2">
          {rest.map((b) => (
            <li
              key={b.id}
              className={cx(
                "rounded-lg border-l-4 px-3 py-2 text-theme-sm text-gray-700 dark:text-gray-300",
                b.kind === "gap"
                  ? "border-orange-400 bg-orange-50/60 dark:bg-orange-500/[0.06]"
                  : b.kind === "proposal" || b.kind === "diagram"
                    ? "border-amber-400 bg-amber-50/60 dark:bg-amber-500/[0.06]"
                    : "border-gray-200 dark:border-gray-700",
              )}
            >
              {b.kind === "diagram" ? (
                <>
                  <pre className="custom-scrollbar overflow-x-auto rounded-md bg-gray-50 p-3 text-theme-xs dark:bg-white/[0.03]">{b.text}</pre>
                  <p className="mt-1 text-theme-xs text-gray-500 dark:text-gray-400">
                    Mermaid diagram: it renders in the downloaded Markdown on GitHub, VS Code and most Markdown viewers.
                  </p>
                </>
              ) : b.kind === "human" ? (
                <div className="whitespace-pre-wrap">{b.text}</div>
              ) : (
                <span>
                  {b.kind === "gap" && <strong>Gap: </strong>}
                  {[b.text, ...b.cells].filter(Boolean).join(" · ")}
                </span>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <BasisBadge b={b} />
                <Refs pid={pid} block={b} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function sectionMarkdown(s: DocSection): string {
  return s.blocks
    .map((b) => {
      if (b.kind === "human") return b.text;
      if (b.kind === "diagram") return `\`\`\`mermaid\n${b.text}\n\`\`\``;
      const t = [b.text, ...b.cells].filter(Boolean).join(" | ");
      return `- ${b.kind === "gap" ? "Gap: " : b.kind === "proposal" ? "Proposed: " : ""}${t}`;
    })
    .join("\n");
}

export function DocumentView({ pid, doc }: { pid: string; doc: string }) {
  const view = useApi<DocView>(`/projects/${pid}/documents/${doc}`);
  const cat = useApi<Catalogue>(`/projects/${pid}/documents`, { pollMs: 4000, pollWhile: (d) => !!d.job });
  const [error, setError] = useState<ApiError | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [approving, setApproving] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [showRemoved, setShowRemoved] = useState(false);
  const removedPage = usePaged(view.data?.document?.removed, 20);
  if (view.error) return <ErrorBanner error={view.error} />;
  if (!view.data)
    return (
      <div className="space-y-6">
        <CardSkeleton lines={3} label="document">
          <div className="flex flex-wrap gap-2">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-5 w-24 rounded-full" />
            ))}
          </div>
        </CardSkeleton>
        <CardSkeleton lines={4} label="section" />
        <CardSkeleton label="section">
          <TableSkeleton rows={4} cols={4} label="section table" />
        </CardSkeleton>
      </div>
    );
  const { spec, document: d, approval } = view.data;
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await view.reload();
      await cat.reload();
      return true;
    } catch (e) {
      setError(e as ApiError);
      return false;
    }
  };
  const running = !!cat.data?.job;

  return (
    <div className="space-y-6">
      <Card
        title={spec.title}
        desc={spec.purpose}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={running} onClick={() => void act(() => post(`/projects/${pid}/documents/generate`, { doc_types: [doc] }))}>
              {d ? "Regenerate" : "Generate"}
            </Button>
            {d && (
              <a className={buttonClass("ghost")} href={`/api/v1/projects/${pid}/documents/${doc}/markdown`}>
                Download Markdown
              </a>
            )}
            {d && !approval && (
              <Button
                onClick={() => {
                  setPhrase("");
                  setApproving(true);
                }}
              >
                Approve
              </Button>
            )}
          </div>
        }
      >
        <div className="space-y-3 text-theme-sm text-gray-600 dark:text-gray-400">
          {d ? (
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="gray">{`revision ${d.revision}`}</Badge>
              {approval ? <Badge tone="success">{`approved by ${approval.approved_by}`}</Badge> : <Badge tone="warning">not approved</Badge>}
              <span>
                Generated <Time iso={d.generated_at} />
              </span>
            </div>
          ) : (
            <p>This document has not been generated yet.</p>
          )}
          <div className="flex flex-wrap gap-2">
            {Object.values(BASIS).map((b) => (
              <span key={b.label} title={b.hint}>
                <Badge tone={b.tone}>{b.label}</Badge>
              </span>
            ))}
          </div>
          {cat.data && <JobLine cat={cat.data} />}
          <ErrorBanner error={error} />
        </div>
      </Card>

      {d && d.changes.length > 0 && (
        <Card title="What changed" desc="Each revision records why it was made and what it added or removed.">
          <ul className="space-y-3 text-theme-sm">
            {d.changes.slice(0, 5).map((c) => (
              <li key={c.revision} className="rounded-lg border border-gray-100 p-3 dark:border-gray-800">
                <div className="flex flex-wrap items-center gap-2 text-gray-700 dark:text-gray-300">
                  <Badge tone="gray">{`r${c.revision}`}</Badge>
                  <Time iso={c.at} />
                  <span>{c.reasons.join("; ")}</span>
                </div>
                {c.sections_changed.length > 0 && (
                  <p className="mt-1 text-theme-xs text-gray-500 dark:text-gray-400">Sections: {c.sections_changed.join(", ")}</p>
                )}
                {(c.added.length > 0 || c.removed.length > 0) && (
                  <details className="mt-1 text-theme-xs text-gray-500 dark:text-gray-400">
                    <summary className="cursor-pointer">
                      +{c.added.length} added, −{c.removed.length} removed
                    </summary>
                    <ul className="mt-1 space-y-0.5">
                      {c.added.map((x) => (
                        <li key={`a${x}`} className="text-green-700 dark:text-green-400">
                          + {x}
                        </li>
                      ))}
                      {c.removed.map((x) => (
                        <li key={`r${x}`} className="text-red-700 dark:text-red-400">
                          − {x}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {d?.sections.map((s) => (
        <Card
          key={s.key}
          title={s.title}
          desc={
            s.mode === "compiled"
              ? "Compiled by code from Jonathon's knowledge and memory graph"
              : "Drafted by the technical writer, checked by code and the document verifier"
          }
          actions={
            editing === s.key ? null : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraft(sectionMarkdown(s));
                  setEditing(s.key);
                }}
              >
                Edit
              </Button>
            )
          }
        >
          <div className="space-y-3">
            {s.human_edited && (
              <Notice tone="info">Edited by a person. Regeneration does not overwrite this section; new content waits here for your review.</Notice>
            )}
            {editing === s.key ? (
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(() => api("PUT", `/projects/${pid}/documents/${doc}/sections/${s.key}`, { expected_revision: d.revision, markdown: draft })).then(
                    (ok) => ok && setEditing(null),
                  );
                }}
              >
                <Textarea
                  rows={Math.min(24, Math.max(6, draft.split("\n").length + 2))}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  aria-label={`Edit ${s.title}`}
                />
                <div className="flex gap-2">
                  <Button type="submit" size="sm">
                    Save section
                  </Button>
                  <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <Blocks pid={pid} columns={s.columns} blocks={s.blocks} />
            )}
            {s.pending_update && (
              <div className="rounded-xl border border-brand-200 bg-brand-50/40 p-4 dark:border-brand-500/30 dark:bg-brand-500/[0.05]">
                <p className="mb-3 text-theme-sm font-medium text-gray-800 dark:text-white/90">
                  Regenerated content is waiting (<Time iso={s.pending_update.generated_at} />
                  ). Your edit stays until you choose.
                </p>
                <Blocks pid={pid} columns={s.columns} blocks={s.pending_update.blocks} />
                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    onClick={() =>
                      void act(() => post(`/projects/${pid}/documents/${doc}/sections/${s.key}/update`, { expected_revision: d.revision, action: "accept" }))
                    }
                  >
                    Use regenerated content
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      void act(() => post(`/projects/${pid}/documents/${doc}/sections/${s.key}/update`, { expected_revision: d.revision, action: "keep" }))
                    }
                  >
                    Keep my edit
                  </Button>
                </div>
              </div>
            )}
          </div>
        </Card>
      ))}

      {d && d.removed.length > 0 && (
        <Card title="Removed by the checks" desc={`${d.removed.length} drafted items were not kept, each with the reason.`}>
          <Button size="sm" variant="ghost" onClick={() => setShowRemoved((x) => !x)}>
            {showRemoved ? "Hide" : "Show"} removed items
          </Button>
          {showRemoved && (
            <ul className="mt-3 space-y-1 text-theme-sm text-gray-600 dark:text-gray-400">
              {removedPage.items.map((r, i) => (
                <li key={i}>
                  {r.text.slice(0, 240)} — <em>{r.reason}</em>
                </li>
              ))}
            </ul>
          )}
          {showRemoved && <Pagination paged={removedPage} label="Removed items" />}
        </Card>
      )}

      <Modal
        open={approving}
        onClose={() => setApproving(false)}
        title={`Approve ${spec.title}`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setApproving(false)}>
              Cancel
            </Button>
            <Button
              disabled={phrase.trim() !== `approve ${doc}`}
              onClick={() =>
                void act(() => post(`/projects/${pid}/documents/${doc}/approve`, { expected_revision: d?.revision ?? 0, confirmation: phrase })).then(
                  (ok) => ok && setApproving(false),
                )
              }
            >
              Approve
            </Button>
          </>
        }
      >
        <p className="text-theme-sm text-gray-600 dark:text-gray-400">
          Approving records that you reviewed this revision, including its AI proposals and gaps. Any later change to the document (a regeneration or an edit)
          needs a new approval.
        </p>
        <ConfirmPhrase phrase={`approve ${doc}`} value={phrase} onChange={setPhrase} />
      </Modal>
    </div>
  );
}
