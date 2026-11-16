"use client";

import type { Job, Project } from "@jonathon/contracts";
import { useState } from "react";
import { Shell } from "@/components/shell";
import { A, Badge, Button, Card, ErrorBanner, Loading, Time } from "@/components/ui";
import { type ApiError, post } from "@/lib/api";
import { useApi } from "@/lib/use-api";

export default function OperationsPage() {
  return (
    <Shell>
      <OpsBody />
    </Shell>
  );
}

function OpsBody() {
  const jobs = useApi<Job[]>("/jobs", { pollMs: 3_000 });
  const projects = useApi<Project[]>("/projects");
  const health = useApi<Record<string, any>>("/ops/health");
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (path: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    try {
      setResult(await post(path, body));
      void jobs.reload();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  const names = new Map((projects.data ?? []).map((p) => [p.id, p.name]));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Operations</h1>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Maintenance">
          <div className="space-y-2">
            <Button variant="secondary" disabled={busy} onClick={() => run("/ops/reconcile")}>Reconcile files (import external edits)</Button>
            <p className="text-xs text-slate-500">Finds Markdown files edited outside Jonathon. Edited drafts become new revisions; edited approved items go back to review. Nothing is deleted.</p>
            {(projects.data ?? []).map((p) => (
              <div key={p.id} className="flex items-center justify-between text-sm">
                <span className="truncate">{p.name}</span>
                <Button variant="ghost" disabled={busy} onClick={() => run(`/projects/${p.id}/reindex`)}>Rebuild index</Button>
              </div>
            ))}
            <Button variant="secondary" disabled={busy} onClick={() => run("/ops/import-files")}>Import projects found on disk</Button>
            <Button variant="secondary" disabled={busy} onClick={() => run("/ops/backup")}>Create backup now</Button>
          </div>
          <ErrorBanner error={error} />
          {result != null && <pre className="mt-3 max-h-64 overflow-auto rounded bg-slate-100 p-2 text-xs dark:bg-slate-800">{JSON.stringify(result, null, 2)}</pre>}
        </Card>
        <Card title="Health" className="lg:col-span-2">
          {health.data ? <pre className="max-h-64 overflow-auto text-xs">{JSON.stringify(health.data, null, 2)}</pre> : <Loading />}
          <p className="mt-2 text-sm">Runtime details and the authentication check are on <A href="/setup">Setup &amp; runtime</A>.</p>
        </Card>
      </div>
      <Card title="Backup and restore">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li><strong>Back up both</strong> the database (accounts, MCP tokens, conversations, jobs, audit and approval events) and the <code>projects/</code> folder (originals, extractions, knowledge files, history). “Create backup now” writes both under <code>backups/</code> in the data folder.</li>
          <li>Search indexes and knowledge projections can be rebuilt from files; approvals cannot. Without the database, approved items show as not approved until you approve them again.</li>
          <li>To restore: stop Jonathon (API and worker), copy a backup&apos;s <code>jonathon.sqlite</code> and <code>projects/</code> into the data folder, start Jonathon, then run Reconcile. See <code>docs/operations.md</code>.</li>
          <li>Backups are not encrypted. Keep them on encrypted storage.</li>
        </ul>
      </Card>
      <Card title="Jobs">
        <ErrorBanner error={jobs.error} />
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-500"><tr><th>Type</th><th>Status</th><th>Project</th><th>Attempts</th><th>Progress / error</th><th>Updated</th><th /></tr></thead>
          <tbody>
            {(jobs.data ?? []).map((j) => (
              <tr key={j.id} className="border-t border-slate-100 align-top dark:border-slate-800">
                <td className="py-1">{j.type}</td>
                <td><Badge>{j.status}</Badge></td>
                <td className="text-xs">{names.get(j.project_id) ?? j.project_id}</td>
                <td>{j.attempts}/{j.max_attempts}</td>
                <td className="max-w-md truncate text-xs" title={j.error_message ?? ""}>{j.error_code ? `${j.error_code}: ${j.error_message}` : j.progress?.stage ?? ""}</td>
                <td className="text-xs"><Time iso={j.updated_at} /></td>
                <td className="whitespace-nowrap">
                  {["queued", "running", "retrying"].includes(j.status) && <Button variant="ghost" onClick={() => run(`/projects/${j.project_id}/jobs/${j.id}/cancel`)}>Cancel</Button>}
                  {["failed", "cancelled"].includes(j.status) && <Button variant="ghost" onClick={() => run(`/projects/${j.project_id}/jobs/${j.id}/retry`)}>Retry</Button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
