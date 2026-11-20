"use client";

import type { Job, KnowledgeEntity, Project, Source } from "@jonathon/contracts";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useRef, useState } from "react";
import { Chat } from "@/components/chat";
import { FolderImport } from "@/components/folder-import";
import { MemoryGraph } from "@/components/memory-graph";
import { Shell } from "@/components/shell";
import {
  ActivityIcon,
  AlertIcon,
  ChatIcon,
  ChecklistIcon,
  DocumentIcon,
  InboxIcon,
  ProposalIcon,
  QuestionIcon,
  SparkleIcon,
  UploadIcon,
} from "@/components/icons";
import { ReviewButtons, ReviewQueue, useReviewAction } from "@/components/review";
import { TechDocs } from "@/components/techdocs";
import { PROJECT_SECTIONS } from "@/components/shell";
import {
  A,
  Badge,
  Button,
  buttonClass,
  Card,
  Checkbox,
  ConfirmPhrase,
  Empty,
  ErrorBanner,
  Field,
  Input,
  ListSkeleton,
  Notice,
  PageHeader,
  PageSkeleton,
  Pagination,
  Select,
  StatCard,
  Tabs,
  TableSkeleton,
  tabId,
  Textarea,
  Time,
  table,
  usePaged,
} from "@/components/ui";
import { type ApiError, api, post } from "@/lib/api";
import { useApi } from "@/lib/use-api";

const TABS = PROJECT_SECTIONS.map(([key, label]) => [key, label] as const);
const JOB_LABEL: Record<string, string> = {
  ingest: "extracting text",
  extract_knowledge: "AI drafting requirements",
  graph_extract: "mapping concepts into the memory graph",
  generate_documents: "writing technical documents",
  import_folder: "importing a folder",
};

export default function ProjectPage() {
  return (
    <Shell>
      <Suspense fallback={<PageSkeleton label="project" tabs={8} />}>
        <ProjectBody />
      </Suspense>
    </Shell>
  );
}

type ProjectWithCounts = Project & { counts: Record<string, number> };

function ProjectBody() {
  const { pid } = useParams<{ pid: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const tab = params.get("tab") ?? "overview";
  const project = useApi<ProjectWithCounts>(`/projects/${pid}`);
  if (project.error) return <ErrorBanner error={project.error} />;
  if (!project.data) return <PageSkeleton label="project" tabs={8} />;
  const p = project.data;
  const tabLabel = TABS.find(([k]) => k === tab)?.[1] ?? "Overview";
  const toReview = p.counts.to_review ?? 0;
  const tabs = TABS.map(([k, l]) => [k, k === "review" && toReview ? `Review (${toReview})` : l] as const);
  return (
    <>
      <PageHeader title={p.name} crumbs={[{ label: p.name, href: `/projects/${pid}` }, { label: tabLabel }]}>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {p.is_demo && <Badge tone="primary">demo, fictional</Badge>}
          <Badge tone={p.ai_enabled ? "success" : "gray"}>{p.ai_enabled ? "AI processing on" : "AI processing off"}</Badge>
          <span className="text-theme-sm text-gray-500 dark:text-gray-400">Knowledge revision {p.knowledge_revision}</span>
        </div>
      </PageHeader>
      <div className="mb-6">
        <Tabs label="Project sections" panelId="project-panel" tabs={tabs} active={tab} onChange={(key) => router.replace(`/projects/${pid}?tab=${key}`)} />
      </div>
      <div role="tabpanel" id="project-panel" aria-labelledby={tabId("project-panel", tab)}>
        {tab === "overview" && <Overview project={p} />}
        {tab === "review" && <ReviewQueue pid={pid} onChanged={() => void project.reload()} />}
        {tab === "documents" && <Documents pid={pid} aiEnabled={p.ai_enabled} onProcessed={() => void project.reload()} />}
        {tab === "requirements" && <EntityList key="requirement" pid={pid} type="requirement" onChanged={() => void project.reload()} />}
        {tab === "decisions" && <EntityList key="decision" pid={pid} type="decision" onChanged={() => void project.reload()} />}
        {tab === "conflicts" && <EntityList key="conflict" pid={pid} type="conflict" onChanged={() => void project.reload()} />}
        {tab === "questions" && <EntityList key="open_question" pid={pid} type="open_question" onChanged={() => void project.reload()} />}
        {tab === "proposals" && <EntityList key="change_proposal" pid={pid} type="change_proposal" onChanged={() => void project.reload()} />}
        {tab === "techdocs" && <TechDocs pid={pid} aiEnabled={p.ai_enabled} />}
        {tab === "graph" && <MemoryGraph key={params.get("node") ?? "graph"} pid={pid} aiEnabled={p.ai_enabled} initialNode={params.get("node")} />}
        {tab === "chat" && <Chat pid={pid} />}
        {tab === "settings" && <Settings project={p} onSaved={() => project.reload()} />}
      </div>
    </>
  );
}

function Overview({ project }: { project: ProjectWithCounts }) {
  const activity = useApi<Array<Record<string, any>>>(`/projects/${project.id}/activity`);
  const activityPage = usePaged(activity.data, 10);
  const c = project.counts;
  const base = `/projects/${project.id}?tab=`;
  return (
    <div className="space-y-4 md:space-y-6">
      {(c.to_review ?? 0) > 0 && (
        <Notice tone="info" title={`${c.to_review} item${c.to_review === 1 ? "" : "s"} waiting for your review`}>
          Jonathon proposed these from your documents. Approve, edit, reject or delete them in <A href={`${base}review`}>Review</A>.
        </Notice>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:gap-6 xl:grid-cols-3">
        <StatCard
          icon={<InboxIcon />}
          label="Waiting for review"
          value={c.to_review ?? 0}
          href={`${base}review`}
          footer={c.to_review ? <Badge tone="primary">review now</Badge> : <Badge tone="success">all reviewed</Badge>}
        />
        <StatCard icon={<DocumentIcon />} label="Documents" value={c.sources ?? 0} href={`${base}documents`} />
        <StatCard
          icon={<ChecklistIcon />}
          label="Requirements"
          value={c.requirements ?? 0}
          href={`${base}requirements`}
          footer={<Badge tone="success">{`${c.approved ?? 0} approved`}</Badge>}
        />
        <StatCard icon={<ActivityIcon />} label="Active jobs" value={c.active_jobs ?? 0} href={`${base}documents`} />
        <StatCard
          icon={<AlertIcon />}
          label="Open conflicts"
          value={c.open_conflicts ?? 0}
          href={`${base}conflicts`}
          footer={c.open_conflicts ? <Badge tone="orange">needs a decision</Badge> : null}
        />
        <StatCard icon={<QuestionIcon />} label="Open questions" value={c.open_questions ?? 0} href={`${base}questions`} />
        <StatCard icon={<ProposalIcon />} label="Open change proposals" value={c.open_proposals ?? 0} href={`${base}proposals`} />
        <StatCard icon={<ChatIcon />} label="Ask about this project" value="Chat" href={`${base}chat`} />
      </div>
      <div className="grid grid-cols-12 gap-4 md:gap-6">
        <Card title="Summary" className="col-span-12 xl:col-span-7">
          <p className="text-theme-sm whitespace-pre-wrap text-gray-600 dark:text-gray-300">{project.description || "No description."}</p>
        </Card>
        <Card title="Recent activity" className="col-span-12 xl:col-span-5">
          {!activity.data && !activity.error && <ListSkeleton rows={5} label="recent activity" />}
          {activity.data?.length === 0 && <p className="text-theme-sm text-gray-500 dark:text-gray-400">No activity yet.</p>}
          {activityPage.items.length > 0 && (
            <ol className="relative space-y-4 border-l border-gray-200 pl-5 dark:border-gray-800">
              {activityPage.items.map((a) => (
                <li key={a.id} className="relative">
                  <span
                    className="absolute top-1.5 -left-[25px] size-2.5 rounded-full border-2 border-white bg-brand-500 dark:border-gray-900"
                    aria-hidden="true"
                  />
                  <p className="text-theme-sm text-gray-800 dark:text-white/90">
                    {a.action.replace(/[._]/g, " ")}
                    {a.entity_id ? <span className="font-mono text-gray-500 dark:text-gray-400"> {a.entity_id}</span> : null}
                  </p>
                  <p className="text-theme-xs text-gray-500 dark:text-gray-400">
                    <Time iso={a.at} />
                  </p>
                </li>
              ))}
            </ol>
          )}
          <Pagination paged={activityPage} label="Recent activity" />
        </Card>
      </div>
    </div>
  );
}

function Documents({ pid, aiEnabled, onProcessed }: { pid: string; aiEnabled: boolean; onProcessed: () => void }) {
  const sources = useApi<Source[]>(`/projects/${pid}/sources`, { pollMs: 2_000, pollWhile: (s) => s.some((x) => x.current?.extraction_status === "pending") });
  const wasActive = useRef(false);
  const jobs = useApi<Job[]>(`/projects/${pid}/jobs`, {
    pollMs: 2_000,
    pollWhile: (j) => {
      const busy = j.some((x) => ["queued", "running", "retrying"].includes(x.status));
      // When processing finishes, refresh the project counts (review badge) once.
      if (wasActive.current && !busy) onProcessed();
      wasActive.current = busy;
      return busy;
    },
  });
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [paste, setPaste] = useState({ title: "", text: "" });

  const upload = async (files: FileList | File[] | null) => {
    const list = files ? Array.from(files) : [];
    if (!list.length) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    for (const f of list) form.append("files", f, f.name);
    try {
      const r = await api<{ duplicate: boolean; source: Source }[]>("POST", `/projects/${pid}/sources`, form);
      const dups = r.filter((x) => x.duplicate).map((x) => x.source.display_name);
      setNotice(
        dups.length
          ? `Already in this project (not stored again): ${dups.join(", ")}`
          : `${r.length} file(s) stored. ${aiEnabled ? "Jonathon will extract the text, then propose requirements, open questions, conflicts and changes for you to review." : "Text extraction is queued."}`,
      );
      void sources.reload();
      void jobs.reload();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };
  const submitPaste = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await post<{ duplicate: boolean }>(`/projects/${pid}/sources/paste`, paste);
      setNotice(
        r.duplicate
          ? `"${paste.title}" has the same text as an existing source; not stored again.`
          : `"${paste.title}" stored. ${aiEnabled ? "Proposals will appear in Review." : "Extraction is queued."}`,
      );
      setError(null);
      setPaste({ title: "", text: "" });
      void sources.reload();
      void jobs.reload();
    } catch (err) {
      setError(err as ApiError);
    }
  };
  const sourcePage = usePaged(sources.data, 20);
  const active = (jobs.data ?? []).filter((j) => ["queued", "running", "retrying"].includes(j.status));
  const interpreted = (jobs.data ?? []).filter((j) => j.type === "extract_knowledge" && !["queued", "running", "retrying"].includes(j.status)).slice(0, 5);

  return (
    <div className="grid grid-cols-12 gap-4 md:gap-6">
      <div className="col-span-12 space-y-4 md:space-y-6 xl:col-span-8">
        <FolderImport
          pid={pid}
          aiEnabled={aiEnabled}
          onQueued={() => {
            void sources.reload();
            void jobs.reload();
          }}
        />
        <Card title="Documents" desc="Originals are kept byte-for-byte; each upload of changed content becomes a new revision.">
          <ErrorBanner error={sources.error} />
          {!sources.data && !sources.error ? (
            <TableSkeleton rows={5} cols={5} label="documents" />
          ) : sources.data?.length ? (
            <>
              <div className={table.wrap}>
                <table className={table.table}>
                  <thead className={table.thead}>
                    <tr>
                      <th className={table.th}>Name</th>
                      <th className={table.th}>Status</th>
                      <th className={table.th}>Chunks</th>
                      <th className={table.th}>Rev.</th>
                      <th className={table.th}>Added</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sourcePage.items.map((s) => (
                      <tr key={s.id} className={table.tr}>
                        <td className={`${table.td} min-w-[16rem]`}>
                          <div className="flex items-center gap-3">
                            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                              <DocumentIcon className="size-5" />
                            </span>
                            {/* Long file paths wrap instead of stretching the table. */}
                            <A href={`/projects/${pid}/sources/${s.id}`} className="min-w-0 [overflow-wrap:anywhere] text-gray-800 dark:text-white/90">
                              {s.display_name}
                            </A>
                          </div>
                        </td>
                        <td className={table.td}>
                          <Badge>{s.current?.extraction_status ?? "pending"}</Badge>
                        </td>
                        <td className={table.td}>{s.current?.chunk_count ?? 0}</td>
                        <td className={table.td}>{s.current?.revision_number}</td>
                        <td className={`${table.td} text-theme-xs whitespace-nowrap`}>
                          <Time iso={s.created_at} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination paged={sourcePage} label="Documents" />
            </>
          ) : (
            !sources.loading && (
              <Empty title="No documents yet" icon={<DocumentIcon />}>
                Upload requirement documents, PDFs, spreadsheets, emails or notes.
              </Empty>
            )
          )}
        </Card>
        {active.length > 0 && (
          <Card title="Processing">
            <ul className="space-y-3" aria-live="polite">
              {active.map((j) => (
                <li key={j.id} className="flex items-center gap-3 text-theme-sm">
                  <span className="size-4 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" aria-hidden="true" />
                  <Badge>{j.status}</Badge>
                  <span className="text-gray-700 dark:text-gray-300">
                    {JOB_LABEL[j.type] ?? j.type.replace(/_/g, " ")}
                    {j.progress ? ` · ${j.progress.stage}${j.progress.detail ? ` (${j.progress.detail})` : ""}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
        {interpreted.length > 0 && (
          <Card title="AI drafts from documents" desc="What Jonathon proposed from each processed document. Nothing is approved until you review it.">
            <ul className="space-y-3">
              {interpreted.map((j) => {
                const r = (j.result ?? {}) as {
                  document?: string;
                  counts?: Record<string, number>;
                  skipped_duplicates?: number;
                  team?: {
                    document_kind: string | null;
                    agents: Record<string, { runs: number; ms: number }>;
                    checked: number;
                    rejected_count: number;
                    rejected: { kind: string; text: string; by: string; reason: string }[];
                  };
                };
                const c = r.counts ?? {};
                return (
                  <li key={j.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 p-3 text-theme-sm dark:border-gray-800">
                    <SparkleIcon className="size-5 shrink-0 text-brand-500" />
                    <span className="min-w-0 flex-1 text-gray-700 dark:text-gray-300">
                      <span className="font-medium text-gray-800 dark:text-white/90">{r.document ?? "Document"}</span>
                      {j.status === "succeeded" ? (
                        <span className="block text-theme-xs text-gray-500 dark:text-gray-400">
                          {[
                            ["requirements", "requirement"],
                            ["questions", "question"],
                            ["conflicts", "conflict"],
                            ["proposals", "change proposal"],
                          ]
                            .map(([k, w]) => `${c[k!] ?? 0} ${w}${(c[k!] ?? 0) === 1 ? "" : "s"}`)
                            .join(" · ")}
                          {r.skipped_duplicates ? ` · ${r.skipped_duplicates} duplicate${r.skipped_duplicates === 1 ? "" : "s"} skipped` : ""}
                        </span>
                      ) : (
                        <span className="block text-theme-xs text-red-600 dark:text-red-400">{j.error_message ?? j.status}</span>
                      )}
                      {r.team && <TeamSummary team={r.team} />}
                    </span>
                    <Badge>{j.status}</Badge>
                    <span className="text-theme-xs text-gray-500 dark:text-gray-400">
                      <Time iso={j.finished_at ?? j.updated_at} />
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="mt-4">
              <A href={`/projects/${pid}?tab=review`}>Open the review queue</A>
            </div>
          </Card>
        )}
      </div>
      <div className="col-span-12 space-y-4 md:space-y-6 xl:col-span-4">
        <Card title="Upload">
          {/* biome-ignore lint/a11y/noStaticElementInteractions: drop target; the file input inside is the accessible control */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void upload(e.dataTransfer.files);
            }}
            className={`rounded-xl border border-dashed p-6 text-center transition-colors ${dragging ? "border-brand-500 bg-brand-50 dark:bg-brand-500/[0.12]" : "border-gray-300 bg-gray-50 dark:border-gray-700 dark:bg-gray-900"}`}
          >
            <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-400">
              <UploadIcon className="size-7" />
            </div>
            <p className="mb-1 font-semibold text-gray-800 dark:text-white/90">{busy ? "Uploading…" : "Drop files here"}</p>
            <p className="mb-4 text-theme-sm text-gray-500 dark:text-gray-400">or choose several at once</p>
            <label className="inline-flex cursor-pointer">
              <input
                ref={fileRef}
                type="file"
                multiple
                disabled={busy}
                aria-label="Choose files to upload"
                onChange={(e) => upload(e.target.files)}
                className="peer sr-only"
              />
              <span
                className={buttonClass(
                  "primary",
                  "md",
                  "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand-500 peer-disabled:cursor-not-allowed peer-disabled:bg-brand-300 dark:peer-disabled:bg-brand-800",
                )}
              >
                Browse files
              </span>
            </label>
          </div>
          <p className="mt-3 text-theme-xs text-gray-500 dark:text-gray-400">
            TXT, Markdown, PDF (text), DOCX, PPTX, CSV, XLSX, JSON, HTML, EML. Other files are preserved and marked unsupported. Images and scanned PDFs need
            OCR, which is not configured.
          </p>
          {!aiEnabled && (
            <div className="mt-3">
              <Notice tone="warning">
                AI processing is off: documents are extracted and searchable, but nothing is proposed for review. Turn it on in{" "}
                <A href={`/projects/${pid}?tab=settings`}>Settings</A>.
              </Notice>
            </div>
          )}
          {notice && (
            <p role="status" className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-theme-sm text-green-700 dark:bg-green-500/15 dark:text-green-400">
              {notice}
            </p>
          )}
          <div className="mt-3">
            <ErrorBanner error={error} />
          </div>
        </Card>
        <Card title="Paste text">
          <form onSubmit={submitPaste} className="space-y-4">
            <Field label="Title">
              {(id) => <Input id={id} value={paste.title} onChange={(e) => setPaste({ ...paste, title: e.target.value })} required />}
            </Field>
            <Field label="Text">
              {(id) => <Textarea id={id} rows={5} value={paste.text} onChange={(e) => setPaste({ ...paste, text: e.target.value })} required />}
            </Field>
            <Button type="submit">Add as source</Button>
          </form>
        </Card>
      </div>
    </div>
  );
}

const STATUS_FILTERS: Record<string, string[]> = {
  requirement: ["draft", "in_review", "approved", "superseded", "rejected"],
  decision: ["draft", "in_review", "approved", "superseded", "rejected"],
  conflict: ["open", "resolved", "dismissed"],
  open_question: ["open", "answered", "withdrawn"],
  change_proposal: ["open", "accepted", "rejected", "stale"],
};

const TYPE_TITLE: Record<string, string> = {
  requirement: "Requirements",
  decision: "Decisions",
  conflict: "Conflicts",
  open_question: "Open questions",
  change_proposal: "Change proposals",
};

function EntityList({ pid, type, onChanged }: { pid: string; type: string; onChanged: () => void }) {
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const list = useApi<KnowledgeEntity[]>(`/projects/${pid}/entities?type=${type}${status ? `&status=${status}` : ""}`);
  const { ask, modal } = useReviewAction(pid, () => {
    void list.reload();
    onChanged();
  });
  const [creating, setCreating] = useState(false);
  const shown = (list.data ?? []).filter((e) => !q || `${e.human_id} ${e.title}`.toLowerCase().includes(q.toLowerCase()));
  const paged = usePaged(shown, 20, `${status}|${q}`);
  return (
    <Card
      title={TYPE_TITLE[type] ?? type}
      desc={
        type === "change_proposal"
          ? "Changes to existing requirements, proposed by AI extraction from new documents, by developers or by Claude Code. Nothing is applied until you accept it."
          : "Only items with a valid human approval are treated as approved."
      }
      actions={
        type !== "change_proposal" && (
          <Button variant={creating ? "secondary" : "primary"} onClick={() => setCreating(!creating)}>
            {creating ? "Close" : "New draft"}
          </Button>
        )
      }
    >
      {modal}
      {creating && (
        <NewEntity
          pid={pid}
          type={type}
          onCreated={() => {
            setCreating(false);
            void list.reload();
          }}
        />
      )}
      <div className="mb-5 grid gap-4 sm:grid-cols-[14rem_1fr]">
        <Field label="Status">
          {(id) => (
            <Select id={id} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              {STATUS_FILTERS[type]?.map((s) => (
                <option key={s} value={s}>
                  {s.replace("_", " ")}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Filter">{(id) => <Input id={id} value={q} onChange={(e) => setQ(e.target.value)} placeholder="ID or title" />}</Field>
      </div>
      <ErrorBanner error={list.error} />
      {!list.data && !list.error ? (
        <TableSkeleton rows={6} cols={6} label={(TYPE_TITLE[type] ?? type).toLowerCase()} />
      ) : shown.length ? (
        <>
          <div className={table.wrap}>
            <table className={table.table}>
              <thead className={table.thead}>
                <tr>
                  <th className={table.th}>ID</th>
                  <th className={table.th}>Title</th>
                  <th className={table.th}>Flags</th>
                  <th className={table.th}>Status</th>
                  <th className={table.th}>Rev.</th>
                  <th className={table.th}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {paged.items.map((e) => (
                  <tr key={e.id} className={table.tr}>
                    <td className={`${table.td} whitespace-nowrap`}>
                      <A href={`/projects/${pid}/entities/${e.human_id}`} className="font-mono">
                        {e.human_id}
                      </A>
                    </td>
                    <td className={`${table.td} text-gray-800 dark:text-white/90`}>{e.title}</td>
                    <td className={table.td}>
                      <div className="flex flex-wrap gap-1">
                        {e.fields.blocking === true && <Badge tone="error">blocking</Badge>}
                        {e.fields.origin === "ai_proposed" && <Badge tone="primary">AI-proposed</Badge>}
                        {e.fields.reviewed === true && e.status === "open" && <Badge tone="success">reviewed</Badge>}
                        {e.status === "approved" && !e.approval_valid && <Badge tone="error">approval not valid</Badge>}
                        {e.file_state !== "ok" && <Badge tone="error">{e.file_state}</Badge>}
                        {e.stale && <Badge tone="gray">stale</Badge>}
                      </div>
                    </td>
                    <td className={table.td}>
                      <Badge>{e.status}</Badge>
                    </td>
                    <td className={`${table.td} text-theme-xs text-gray-500 tabular-nums dark:text-gray-400`}>{e.revision}</td>
                    <td className={`${table.td} text-right`}>
                      <div className="flex justify-end">
                        <ReviewButtons pid={pid} ent={e} onAsk={ask} size="sm" />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination paged={paged} label={TYPE_TITLE[type] ?? type} />
        </>
      ) : (
        <Empty title={q || status ? "Nothing matches the filter" : "Nothing here yet"} icon={<ChecklistIcon />} />
      )}
    </Card>
  );
}

function NewEntity({ pid, type, onCreated }: { pid: string; type: string; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const textKey = { requirement: "description", decision: "question", conflict: "description", open_question: "question" }[type] ?? "description";
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await post(`/projects/${pid}/entities`, {
        entity_type: type,
        title,
        fields: {
          feature_scopes: scope
            ? scope
                .split(",")
                .map((s) => s.trim().toLowerCase())
                .filter(Boolean)
            : [],
        },
        sections: { [textKey]: description },
      });
      onCreated();
    } catch (err) {
      setError(err as ApiError);
    }
  };
  return (
    <form onSubmit={submit} className="mb-6 space-y-4 rounded-xl border border-gray-200 bg-gray-50 p-4 sm:p-5 dark:border-gray-800 dark:bg-white/[0.02]">
      <Field label="Title">{(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} />}</Field>
      <Field label={textKey === "question" ? "Question" : "Description"}>
        {(id) => <Textarea id={id} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />}
      </Field>
      <Field label="Feature scopes" hint="Comma-separated, e.g. email-verification">
        {(id) => <Input id={id} value={scope} onChange={(e) => setScope(e.target.value)} />}
      </Field>
      <ErrorBanner error={error} />
      <Button type="submit">Create draft</Button>
    </form>
  );
}

function Settings({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [ai, setAi] = useState(project.ai_enabled);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api("PATCH", `/projects/${project.id}`, { name, description, ai_enabled: ai });
      setSaved(true);
      setError(null);
      onSaved();
    } catch (err) {
      setError(err as ApiError);
    }
  };
  return (
    <div className="space-y-6">
      <ProjectSettingsForm
        name={name}
        setName={setName}
        description={description}
        setDescription={setDescription}
        ai={ai}
        setAi={setAi}
        error={error}
        saved={saved}
        save={save}
      />
      <DeleteProject project={project} />
    </div>
  );
}

/** Permanently delete the project, its files and its records (DELETE /projects/:pid with the typed phrase). */
function DeleteProject({ project }: { project: Project }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const phrase = `delete ${project.name}`;
  return (
    <Card title="Delete project" desc="Remove this project and everything Jonathon stores for it.">
      {!open ? (
        <Button variant="danger" onClick={() => setOpen(true)}>
          Delete this project…
        </Button>
      ) : (
        <div className="max-w-2xl space-y-4">
          <Notice tone="warning">
            This permanently removes every uploaded original, extraction, requirement, decision, question, conflict, proposal and its history, approvals,
            conversations and answers, generated documents, the memory graph, search index and jobs for <strong>{project.name}</strong>. MCP credentials lose
            access to it (a credential limited to this project is revoked). It cannot be undone. The activity log keeps a record that the project was
            deleted. Backups made earlier still contain it, and Jonathon cannot delete copies the model provider or Antigravity may hold.
          </Notice>
          <ConfirmPhrase phrase={phrase} value={confirm} onChange={setConfirm} />
          <ErrorBanner error={error} />
          <div className="flex gap-3">
            <Button
              variant="danger"
              disabled={busy || confirm.trim() !== phrase}
              onClick={async () => {
                setBusy(true);
                try {
                  await api("DELETE", `/projects/${project.id}`, { confirmation: confirm });
                  router.replace("/");
                } catch (e) {
                  setError(e as ApiError);
                  setBusy(false);
                }
              }}
            >
              {busy ? "Deleting…" : "Delete permanently"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setOpen(false);
                setConfirm("");
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function ProjectSettingsForm({
  name,
  setName,
  description,
  setDescription,
  ai,
  setAi,
  error,
  saved,
  save,
}: {
  name: string;
  setName: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  ai: boolean;
  setAi: (v: boolean) => void;
  error: ApiError | null;
  saved: boolean;
  save: (e: FormEvent) => void;
}) {
  return (
    <Card title="Project settings" desc="Name, description and AI-processing consent for this project.">
      <form onSubmit={save} className="max-w-2xl space-y-5">
        <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required />}</Field>
        <Field label="Description">{(id) => <Textarea id={id} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        <fieldset className="rounded-xl border border-amber-500 bg-amber-50 p-4 dark:border-amber-500/30 dark:bg-amber-500/15">
          <legend className="px-1 text-theme-sm font-semibold text-gray-800 dark:text-white/90">AI processing</legend>
          <label className="flex cursor-pointer items-start gap-3 text-theme-sm text-gray-700 dark:text-gray-300">
            <Checkbox checked={ai} onChange={(e) => setAi(e.target.checked)} className="mt-0.5 size-5" />
            <span>
              Allow Jonathon to send this project&apos;s client text to the Antigravity CLI for answers and draft extraction. The CLI forwards it to its
              configured model provider and keeps transcripts locally. Turning this off stops new AI processing; it cannot recall text already sent.
            </span>
          </label>
        </fieldset>
        <ErrorBanner error={error} />
        <div className="flex items-center gap-3">
          <Button type="submit">Save</Button>
          {saved && (
            <span role="status" className="text-theme-sm font-medium text-green-700 dark:text-green-400">
              Saved.
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}

const AGENT_NAMES: Record<string, string> = {
  classify: "Classifier",
  requirements: "Requirements",
  questions: "Questions",
  conflicts: "Conflicts",
  changes: "Changes",
  verify_draft: "Verifier",
};
const KIND_LABEL: Record<string, string> = {
  requirements_spec: "requirements document",
  brief_or_proposal: "brief or proposal",
  setup_or_runbook: "setup guide",
  plan_or_estimate: "plan or estimate",
  meeting_notes_or_email: "notes or email",
  other: "other document",
};

/** What the agent team did for one document: who ran, and what the verifier and code checks removed (with reasons). */
function TeamSummary({
  team,
}: {
  team: {
    document_kind: string | null;
    agents: Record<string, { runs: number; ms: number }>;
    checked: number;
    rejected_count: number;
    rejected: { kind: string; text: string; by: string; reason: string }[];
  };
}) {
  const agents = Object.entries(team.agents).filter(([k]) => AGENT_NAMES[k]);
  return (
    <span className="mt-1.5 block text-theme-xs text-gray-500 dark:text-gray-400">
      <span className="flex flex-wrap items-center gap-1">
        {team.document_kind && <Badge tone="gray">{KIND_LABEL[team.document_kind] ?? team.document_kind}</Badge>}
        {agents.map(([k, v]) => (
          <Badge key={k} tone={k === "verify_draft" ? "success" : "primary"}>{`${AGENT_NAMES[k]}${v.runs > 1 ? ` ×${v.runs}` : ""}`}</Badge>
        ))}
      </span>
      <span className="mt-1 block">
        Verifier checked {team.checked} item{team.checked === 1 ? "" : "s"}
        {team.rejected_count ? `; ${team.rejected_count} removed as not supported by the document` : "; nothing removed"}.
      </span>
      {team.rejected.length > 0 && (
        <details className="mt-1">
          <summary className="w-fit font-medium text-brand-600 dark:text-brand-400">Show what was removed and why</summary>
          <ul className="mt-1 space-y-1">
            {team.rejected.map((x, i) => (
              <li key={i} className="rounded-lg bg-gray-50 px-2 py-1 dark:bg-white/[0.03]">
                <span className="text-gray-700 dark:text-gray-300">{x.text}</span>{" "}
                <span className="text-gray-500 dark:text-gray-400">
                  ({x.kind}, removed by {x.by === "code" ? "code check" : "verifier"}: {x.reason})
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </span>
  );
}
