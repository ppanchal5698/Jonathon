"use client";

import type { Job, KnowledgeEntity, Project, Source } from "@jonathon/contracts";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useRef, useState } from "react";
import { Chat } from "@/components/chat";
import { Shell } from "@/components/shell";
import { A, Badge, Button, Card, cx, Empty, ErrorBanner, Field, Input, Loading, Select, Textarea, Time } from "@/components/ui";
import { type ApiError, api, post } from "@/lib/api";
import { useApi } from "@/lib/use-api";

const TABS = [
  ["overview", "Overview"],
  ["documents", "Documents"],
  ["requirements", "Requirements"],
  ["decisions", "Decisions"],
  ["conflicts", "Conflicts"],
  ["questions", "Open questions"],
  ["proposals", "Proposals"],
  ["chat", "Chat"],
  ["settings", "Settings"],
] as const;

export default function ProjectPage() {
  return (
    <Shell>
      <Suspense fallback={<Loading />}>
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
  if (!project.data) return <Loading />;
  const p = project.data;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{p.name} {p.is_demo && <Badge tone="needs_ocr">demo, fictional</Badge>}</h1>
        <p className="text-sm text-slate-500">Knowledge revision {p.knowledge_revision} · AI processing {p.ai_enabled ? "on" : "off"}</p>
      </div>
      <div role="tablist" aria-label="Project sections" className="flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800">
        {TABS.map(([key, label]) => (
          <button key={key} role="tab" type="button" aria-selected={tab === key} onClick={() => router.replace(`/projects/${pid}?tab=${key}`)}
            className={cx("-mb-px border-b-2 px-3 py-1.5 text-sm", tab === key ? "border-indigo-600 font-medium" : "border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-300")}>
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === "overview" && <Overview project={p} />}
        {tab === "documents" && <Documents pid={pid} aiEnabled={p.ai_enabled} />}
        {tab === "requirements" && <EntityList pid={pid} type="requirement" />}
        {tab === "decisions" && <EntityList pid={pid} type="decision" />}
        {tab === "conflicts" && <EntityList pid={pid} type="conflict" />}
        {tab === "questions" && <EntityList pid={pid} type="open_question" />}
        {tab === "proposals" && <EntityList pid={pid} type="change_proposal" />}
        {tab === "chat" && <Chat pid={pid} />}
        {tab === "settings" && <Settings project={p} onSaved={() => project.reload()} />}
      </div>
    </div>
  );
}

function Overview({ project }: { project: ProjectWithCounts }) {
  const activity = useApi<Array<Record<string, any>>>(`/projects/${project.id}/activity`);
  const c = project.counts;
  const stats: [string, number, string][] = [
    ["Documents", c.sources ?? 0, "documents"],
    ["Requirements", c.requirements ?? 0, "requirements"],
    ["Approved", c.approved ?? 0, "requirements"],
    ["Open conflicts", c.open_conflicts ?? 0, "conflicts"],
    ["Open questions", c.open_questions ?? 0, "questions"],
    ["Active jobs", c.active_jobs ?? 0, "documents"],
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Summary" className="lg:col-span-2">
        <p className="mb-3 whitespace-pre-wrap text-sm">{project.description || "No description."}</p>
        <div className="grid grid-cols-3 gap-3">
          {stats.map(([label, n, tab]) => (
            <A key={label} href={`/projects/${project.id}?tab=${tab}`} className="rounded-md bg-slate-50 p-3 no-underline dark:bg-slate-800">
              <span className="block text-2xl font-semibold text-slate-900 dark:text-slate-100">{n}</span>
              <span className="text-xs">{label}</span>
            </A>
          ))}
        </div>
      </Card>
      <Card title="Recent activity">
        <ul className="space-y-1 text-xs">
          {(activity.data ?? []).slice(0, 15).map((a) => (
            <li key={a.id}><Time iso={a.at} /> · {a.action} {a.entity_id ?? ""}</li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function Documents({ pid, aiEnabled }: { pid: string; aiEnabled: boolean }) {
  const sources = useApi<Source[]>(`/projects/${pid}/sources`, { pollMs: 2_000, pollWhile: (s) => s.some((x) => x.current?.extraction_status === "pending") });
  const jobs = useApi<Job[]>(`/projects/${pid}/jobs`, { pollMs: 2_000, pollWhile: (j) => j.some((x) => ["queued", "running", "retrying"].includes(x.status)) });
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [paste, setPaste] = useState({ title: "", text: "" });

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    for (const f of Array.from(files)) form.append("files", f, f.name);
    try {
      const r = await api<{ duplicate: boolean; source: Source }[]>("POST", `/projects/${pid}/sources`, form);
      const dups = r.filter((x) => x.duplicate).map((x) => x.source.display_name);
      setNotice(dups.length ? `Already in this project (not stored again): ${dups.join(", ")}` : `${r.length} file(s) stored. Extraction is queued.`);
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
      await post(`/projects/${pid}/sources/paste`, paste);
      setPaste({ title: "", text: "" });
      void sources.reload();
    } catch (err) {
      setError(err as ApiError);
    }
  };
  const active = (jobs.data ?? []).filter((j) => ["queued", "running", "retrying"].includes(j.status));

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Card title="Documents">
          <ErrorBanner error={sources.error} />
          {sources.data?.length ? (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr><th className="py-1">Name</th><th>Status</th><th>Chunks</th><th>Rev.</th><th>Added</th></tr>
              </thead>
              <tbody>
                {sources.data.map((s) => (
                  <tr key={s.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="py-1.5"><A href={`/projects/${pid}/sources/${s.id}`}>{s.display_name}</A></td>
                    <td><Badge>{s.current?.extraction_status ?? "pending"}</Badge></td>
                    <td>{s.current?.chunk_count ?? 0}</td>
                    <td>{s.current?.revision_number}</td>
                    <td className="text-xs"><Time iso={s.created_at} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            !sources.loading && <Empty title="No documents yet">Upload requirement documents, PDFs, spreadsheets, emails or notes.</Empty>
          )}
        </Card>
        {active.length > 0 && (
          <Card title="Processing">
            <ul className="space-y-1 text-sm" aria-live="polite">
              {active.map((j) => (
                <li key={j.id}><Badge>{j.status}</Badge> {j.type} {j.progress ? `· ${j.progress.stage}${j.progress.detail ? ` (${j.progress.detail})` : ""}` : ""}</li>
              ))}
            </ul>
          </Card>
        )}
      </div>
      <div className="space-y-4">
        <Card title="Upload">
          <label className="block text-sm">
            <span className="sr-only">Choose files</span>
            <input ref={fileRef} type="file" multiple disabled={busy} onChange={(e) => upload(e.target.files)} className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-indigo-600 file:px-3 file:py-1.5 file:text-white" />
          </label>
          <p className="mt-2 text-xs text-slate-500">TXT, Markdown, PDF (text), DOCX, PPTX, CSV, XLSX, JSON, HTML, EML. Other files are preserved and marked unsupported. Images and scanned PDFs need OCR, which is not configured.</p>
          {!aiEnabled && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">AI processing is off: documents are extracted and searchable, but no draft requirements are proposed.</p>}
          {notice && <p role="status" className="mt-2 text-sm">{notice}</p>}
          <ErrorBanner error={error} />
        </Card>
        <Card title="Paste text">
          <form onSubmit={submitPaste} className="space-y-2">
            <Field label="Title">{(id) => <Input id={id} value={paste.title} onChange={(e) => setPaste({ ...paste, title: e.target.value })} required />}</Field>
            <Field label="Text">{(id) => <Textarea id={id} rows={5} value={paste.text} onChange={(e) => setPaste({ ...paste, text: e.target.value })} required />}</Field>
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

function EntityList({ pid, type }: { pid: string; type: string }) {
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const list = useApi<KnowledgeEntity[]>(`/projects/${pid}/entities?type=${type}${status ? `&status=${status}` : ""}`);
  const [creating, setCreating] = useState(false);
  const shown = (list.data ?? []).filter((e) => !q || `${e.human_id} ${e.title}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Card
      title={type.replace("_", " ").replace(/^./, (c) => c.toUpperCase()) + "s"}
      actions={type !== "change_proposal" && <Button onClick={() => setCreating(!creating)}>{creating ? "Close" : "New draft"}</Button>}
    >
      {creating && <NewEntity pid={pid} type={type} onCreated={() => { setCreating(false); void list.reload(); }} />}
      <div className="mb-3 flex flex-wrap gap-2">
        <Field label="Status">{(id) => (
          <Select id={id} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {STATUS_FILTERS[type]?.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
          </Select>
        )}</Field>
        <Field label="Filter">{(id) => <Input id={id} value={q} onChange={(e) => setQ(e.target.value)} placeholder="ID or title" />}</Field>
      </div>
      <ErrorBanner error={list.error} />
      {shown.length ? (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {shown.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <A href={`/projects/${pid}/entities/${e.human_id}`} className="font-mono">{e.human_id}</A>
              <span className="flex-1">{e.title}</span>
              {e.fields.blocking === true && <Badge tone="failed">blocking</Badge>}
              {e.fields.origin === "ai_proposed" && <Badge tone="pending">AI-proposed</Badge>}
              {e.status === "approved" && !e.approval_valid && <Badge tone="failed">approval not valid</Badge>}
              {e.file_state !== "ok" && <Badge tone="failed">{e.file_state}</Badge>}
              {e.stale && <Badge tone="needs_ocr">stale</Badge>}
              <Badge>{e.status}</Badge>
              <span className="text-xs text-slate-500">rev {e.revision}</span>
            </li>
          ))}
        </ul>
      ) : (
        !list.loading && <Empty title="Nothing here yet" />
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
        fields: { feature_scopes: scope ? scope.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : [] },
        sections: { [textKey]: description },
      });
      onCreated();
    } catch (err) {
      setError(err as ApiError);
    }
  };
  return (
    <form onSubmit={submit} className="mb-4 space-y-2 rounded-md border border-slate-200 p-3 dark:border-slate-700">
      <Field label="Title">{(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} />}</Field>
      <Field label={textKey === "question" ? "Question" : "Description"}>{(id) => <Textarea id={id} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      <Field label="Feature scopes" hint="Comma-separated, e.g. email-verification">{(id) => <Input id={id} value={scope} onChange={(e) => setScope(e.target.value)} />}</Field>
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
      onSaved();
    } catch (err) {
      setError(err as ApiError);
    }
  };
  return (
    <Card title="Project settings">
      <form onSubmit={save} className="max-w-xl space-y-3">
        <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required />}</Field>
        <Field label="Description">{(id) => <Textarea id={id} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        <fieldset className="rounded-md border border-amber-300 p-3 dark:border-amber-700">
          <legend className="px-1 text-sm font-medium">AI processing</legend>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} className="mt-1" />
            <span>
              Allow Jonathon to send this project&apos;s client text to the Antigravity CLI for answers and draft extraction. The CLI forwards it to its configured model
              provider and keeps transcripts locally. Turning this off stops new AI processing; it cannot recall text already sent.
            </span>
          </label>
        </fieldset>
        <ErrorBanner error={error} />
        <Button type="submit">Save</Button>
        {saved && <span role="status" className="ml-2 text-sm text-emerald-700">Saved.</span>}
      </form>
    </Card>
  );
}
