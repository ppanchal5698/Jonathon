"use client";

import type { Job, KnowledgeEntity, Project } from "@jonathon/contracts";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Shell } from "@/components/shell";
import { A, Badge, Button, Card, Empty, ErrorBanner, Field, Input, Loading, Textarea, Time } from "@/components/ui";
import { type ApiError, post } from "@/lib/api";
import { useApi } from "@/lib/use-api";

export default function Dashboard() {
  return (
    <Shell>
      <DashboardBody />
    </Shell>
  );
}

function DashboardBody() {
  const projects = useApi<Project[]>("/projects");
  const pending = useApi<KnowledgeEntity[]>("/approvals/pending");
  const failed = useApi<Job[]>("/jobs?status=failed");
  const health = useApi<Record<string, any>>("/ops/health", { pollMs: 10_000 });
  const activity = useApi<Array<Record<string, any>>>("/activity");
  const names = new Map((projects.data ?? []).map((p) => [p.id, p.name]));

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Card title="Projects" actions={<NewProject onCreated={() => projects.reload()} />}>
          <ErrorBanner error={projects.error} />
          {projects.loading ? (
            <Loading />
          ) : projects.data?.length ? (
            <ul className="divide-y divide-slate-200 dark:divide-slate-800">
              {projects.data.map((p) => (
                <li key={p.id} className="flex items-center justify-between py-2">
                  <div>
                    <A href={`/projects/${p.id}`} className="font-medium">{p.name}</A>
                    {p.is_demo && <span className="ml-2"><Badge tone="needs_ocr">demo</Badge></span>}
                    <p className="text-xs text-slate-500">Knowledge revision {p.knowledge_revision} · AI processing {p.ai_enabled ? "on" : "off"}</p>
                  </div>
                  <span className="text-xs text-slate-500"><Time iso={p.updated_at} /></span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No projects yet">Create a project, then upload client documents into it.</Empty>
          )}
        </Card>
        <Card title={`Pending review (${pending.data?.length ?? 0})`}>
          <ErrorBanner error={pending.error} />
          {pending.data?.length ? (
            <ul className="space-y-1 text-sm">
              {pending.data.slice(0, 15).map((e) => (
                <li key={e.id} className="flex items-center gap-2">
                  <Badge>{e.status}</Badge>
                  <A href={`/projects/${e.project_id}/entities/${e.human_id}`}>{e.human_id}</A>
                  <span className="truncate">{e.title}</span>
                  <span className="ml-auto text-xs text-slate-500">{names.get(e.project_id)}</span>
                </li>
              ))}
            </ul>
          ) : (
            !pending.loading && <Empty title="Nothing waiting for review" />
          )}
        </Card>
      </div>
      <div className="space-y-4">
        <Card title="System health">
          {health.data ? (
            <dl className="grid grid-cols-2 gap-y-1 text-sm">
              <dt>Overall</dt><dd><Badge tone={health.data.status === "ok" ? "ok" : "failed"}>{health.data.status}</Badge></dd>
              <dt>Worker</dt><dd>{health.data.worker.alive ? "running" : <span className="text-red-600">not running</span>}</dd>
              <dt>Runtime</dt><dd><A href="/setup">{health.data.runtime.status}</A></dd>
              <dt>Active jobs</dt><dd>{health.data.jobs.active}</dd>
              <dt>Failed jobs</dt><dd>{health.data.jobs.failed}</dd>
            </dl>
          ) : (
            <Loading />
          )}
          {health.data && !health.data.worker.alive && <p className="mt-2 text-xs text-red-700">Start the worker (<code>pnpm dev</code> starts it) or uploads and answers will stay queued.</p>}
        </Card>
        <Card title="Failed jobs">
          {failed.data?.length ? (
            <ul className="space-y-1 text-sm">
              {failed.data.slice(0, 8).map((j) => (
                <li key={j.id}>
                  <Badge tone="failed">{j.type}</Badge> <span className="text-xs">{j.error_code}</span>
                  <p className="truncate text-xs text-slate-500" title={j.error_message ?? ""}>{j.error_message}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">None.</p>
          )}
          <A href="/operations" className="mt-2 inline-block text-sm">All jobs</A>
        </Card>
        <Card title="Recent activity">
          <ul className="space-y-1 text-xs">
            {(activity.data ?? []).slice(0, 12).map((a) => (
              <li key={a.id}>
                <Time iso={a.at} /> · {a.action}{a.entity_id ? ` ${a.entity_id}` : ""}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

function NewProject({ onCreated }: { onCreated: () => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  if (!open) return <Button onClick={() => setOpen(true)}>New project</Button>;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const p = await post<Project>("/projects", { name, description, ai_enabled: false });
      onCreated();
      router.push(`/projects/${p.id}`);
    } catch (err) {
      setError(err as ApiError);
    }
  };
  return (
    <form onSubmit={submit} className="flex w-full max-w-md flex-col gap-2 rounded-md border border-slate-200 p-3 dark:border-slate-700">
      <Field label="Project name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required autoFocus />}</Field>
      <Field label="Description">{(id) => <Textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      <p className="text-xs text-slate-500">AI processing starts off. Enable it per project in Settings after reading the data-sharing notice.</p>
      <ErrorBanner error={error} />
      <div className="flex gap-2">
        <Button type="submit">Create</Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}
