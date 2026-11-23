"use client";

import type { Job, KnowledgeEntity, Project } from "@jonathon/contracts";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { ActivityIcon, AlertIcon, CheckCircleIcon, FolderIcon, PlusIcon, ServerIcon } from "@/components/icons";
import { Shell } from "@/components/shell";
import {
  A,
  Badge,
  Button,
  Card,
  Empty,
  ErrorBanner,
  Field,
  Input,
  ListSkeleton,
  PageHeader,
  Pagination,
  StatCard,
  StatsSkeleton,
  TableSkeleton,
  Textarea,
  Time,
  table,
  usePaged,
} from "@/components/ui";
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
  const [creating, setCreating] = useState(false);
  const projectPage = usePaged(projects.data, 10);
  const pendingPage = usePaged(pending.data, 10);
  const failedPage = usePaged(failed.data, 5);
  const activityPage = usePaged(activity.data, 10);

  return (
    <>
      <PageHeader title="Dashboard" />
      {!projects.data && !pending.data && !failed.data && !health.data ? (
        <StatsSkeleton />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:gap-6 xl:grid-cols-4">
          <StatCard icon={<FolderIcon />} label="Projects" value={projects.data?.length ?? "–"} />
          <StatCard
            icon={<CheckCircleIcon />}
            label="Waiting for review"
            value={pending.data?.length ?? "–"}
            footer={pending.data?.length ? <Badge tone="warning">needs you</Badge> : null}
          />
          <StatCard
            icon={<ServerIcon />}
            label="Worker"
            value={health.data ? (health.data.worker.alive ? "Running" : "Stopped") : "–"}
            footer={health.data && <Badge tone={health.data.worker.alive ? "success" : "error"}>{health.data.jobs.active} active jobs</Badge>}
            href="/operations"
          />
          <StatCard
            icon={<AlertIcon />}
            label="Failed jobs"
            value={failed.data?.length ?? "–"}
            footer={health.data && <Badge tone={health.data.runtime.status === "ok" ? "success" : "warning"}>runtime {health.data.runtime.status}</Badge>}
            href="/operations"
          />
        </div>
      )}
      {health.data && !health.data.worker.alive && (
        <p
          role="alert"
          className="mt-4 rounded-xl border border-red-500 bg-red-50 p-4 text-theme-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-400"
        >
          The background worker is not running, so uploads and questions will stay queued.{" "}
          {health.data.deployment === "docker" ? (
            <>
              Start it with <code>docker compose up -d worker</code> and check <code>docker compose logs worker</code>.
            </>
          ) : (
            <>
              <code>pnpm dev</code> starts it.
            </>
          )}
        </p>
      )}

      <div className="mt-4 grid grid-cols-12 gap-4 md:mt-6 md:gap-6">
        <div className="col-span-12 space-y-4 md:space-y-6 xl:col-span-8">
          <Card
            title="Projects"
            desc="Client projects and their knowledge"
            actions={
              !creating && (
                <Button onClick={() => setCreating(true)}>
                  <PlusIcon /> New project
                </Button>
              )
            }
          >
            {creating && <NewProject onCreated={() => projects.reload()} onCancel={() => setCreating(false)} />}
            <ErrorBanner error={projects.error} />
            {!projects.data && !projects.error ? (
              <TableSkeleton rows={4} cols={4} label="projects" />
            ) : projects.data?.length ? (
              <>
                <div className={table.wrap}>
                  <table className={table.table}>
                    <thead className={table.thead}>
                      <tr>
                        <th className={table.th}>Project</th>
                        <th className={table.th}>AI processing</th>
                        <th className={table.th}>Knowledge rev.</th>
                        <th className={table.th}>Updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {projectPage.items.map((p) => (
                        <tr key={p.id} className={table.tr}>
                          <td className={table.td}>
                            <div className="flex items-center gap-3">
                              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-400">
                                <FolderIcon className="size-5" />
                              </span>
                              <div className="min-w-0">
                                <A href={`/projects/${p.id}`} className="block [overflow-wrap:anywhere] text-gray-800 dark:text-white/90">
                                  {p.name}
                                </A>
                                {p.is_demo && <Badge tone="primary">demo, fictional</Badge>}
                              </div>
                            </div>
                          </td>
                          <td className={table.td}>
                            <Badge tone={p.ai_enabled ? "success" : "gray"}>{p.ai_enabled ? "on" : "off"}</Badge>
                          </td>
                          <td className={`${table.td} tabular-nums`}>{p.knowledge_revision}</td>
                          <td className={`${table.td} text-theme-xs whitespace-nowrap`}>
                            <Time iso={p.updated_at} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pagination paged={projectPage} label="Projects" />
              </>
            ) : (
              <Empty title="No projects yet" icon={<FolderIcon />}>
                Create a project, then upload client documents into it.
              </Empty>
            )}
          </Card>

          <Card
            title={`Pending review${pending.data ? ` (${pending.data.length})` : ""}`}
            desc="Drafts, items in review, open conflicts and questions, proposals"
          >
            <ErrorBanner error={pending.error} />
            {!pending.data && !pending.error ? (
              <ListSkeleton rows={4} label="items waiting for review" />
            ) : pending.data?.length ? (
              <>
                <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                  {pendingPage.items.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                      <Badge>{e.status}</Badge>
                      <A href={`/projects/${e.project_id}/entities/${e.human_id}`} className="font-mono text-theme-sm whitespace-nowrap">
                        {e.human_id}
                      </A>
                      <span className="min-w-0 flex-1 basis-48 truncate text-theme-sm text-gray-700 dark:text-gray-300" title={e.title}>
                        {e.title}
                      </span>
                      <span className="text-theme-xs text-gray-500 dark:text-gray-400">{names.get(e.project_id)}</span>
                    </li>
                  ))}
                </ul>
                <Pagination paged={pendingPage} label="Pending review" />
              </>
            ) : (
              <Empty title="Nothing waiting for review" icon={<CheckCircleIcon />} />
            )}
          </Card>
        </div>

        <div className="col-span-12 space-y-4 md:space-y-6 xl:col-span-4">
          <Card
            title="Failed jobs"
            actions={
              <A href="/operations" className="text-theme-sm">
                All jobs
              </A>
            }
          >
            {!failed.data && !failed.error ? (
              <ListSkeleton rows={2} label="failed jobs" boxed />
            ) : failed.data?.length ? (
              <>
                <ul className="space-y-3">
                  {failedPage.items.map((j) => (
                    <li key={j.id} className="rounded-xl border border-gray-200 p-3 dark:border-gray-800">
                      <div className="flex items-center gap-2">
                        <Badge tone="error">{j.type}</Badge>
                        <span className="text-theme-xs text-gray-500 dark:text-gray-400">{j.error_code}</span>
                      </div>
                      <p className="mt-1 truncate text-theme-xs text-gray-500 dark:text-gray-400" title={j.error_message ?? ""}>
                        {j.error_message}
                      </p>
                    </li>
                  ))}
                </ul>
                <Pagination paged={failedPage} label="Failed jobs" sizes={[5, 10, 20]} />
              </>
            ) : (
              <p className="text-theme-sm text-gray-500 dark:text-gray-400">None.</p>
            )}
          </Card>
          <Card title="Recent activity">
            {!activity.data && !activity.error ? (
              <ListSkeleton rows={5} label="recent activity" />
            ) : (
              <>
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
                  {activity.data?.length === 0 && (
                    <li className="flex items-center gap-2 text-theme-sm text-gray-500 dark:text-gray-400">
                      <ActivityIcon className="size-4" /> No activity yet.
                    </li>
                  )}
                </ol>
                <Pagination paged={activityPage} label="Recent activity" />
              </>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function NewProject({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // No default: sending client text to a model provider is an explicit choice for every project.
  const [ai, setAi] = useState<boolean | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (ai === null) return;
      const p = await post<Project>("/projects", { name, description, ai_enabled: ai });
      onCreated();
      router.push(`/projects/${p.id}`);
    } catch (err) {
      setError(err as ApiError);
    }
  };
  return (
    <form onSubmit={submit} className="mb-6 space-y-4 rounded-xl border border-gray-200 bg-gray-50 p-4 sm:p-5 dark:border-gray-800 dark:bg-white/[0.02]">
      <Field label="Project name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required autoFocus />}</Field>
      <Field label="Description">{(id) => <Textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      <fieldset className="space-y-3 rounded-xl border border-amber-500 bg-amber-50 p-4 text-theme-sm text-gray-700 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-gray-300">
        <legend className="px-1 font-medium text-gray-800 dark:text-white/90">AI processing for this project (choose one)</legend>
        <p>
          With AI, each upload is sent to the Antigravity CLI, which forwards the text to its configured model provider and keeps transcripts locally. Jonathon
          then proposes requirements, open questions, conflicts and changes for you to approve, edit, reject or delete. You can change this later in Settings.
        </p>
        <label className="flex cursor-pointer items-start gap-3">
          <input type="radio" name="ai-processing" checked={ai === true} onChange={() => setAi(true)} className="mt-0.5 size-4" required />
          <span>
            <span className="font-medium text-gray-800 dark:text-white/90">Draft requirements from uploaded documents with AI</span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-3">
          <input type="radio" name="ai-processing" checked={ai === false} onChange={() => setAi(false)} className="mt-0.5 size-4" />
          <span>
            <span className="font-medium text-gray-800 dark:text-white/90">Keep this project local-only (no AI)</span>
          </span>
        </label>
      </fieldset>
      <ErrorBanner error={error} />
      <div className="flex gap-3">
        <Button type="submit" disabled={ai === null} title={ai === null ? "Choose whether AI processing is on" : undefined}>
          Create
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
