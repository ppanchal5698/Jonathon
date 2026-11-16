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
  const [result, setResult] = useState<string[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (path: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(summarize(path, await post(path, body), names));
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
          {result && (
            <ul role="status" className="mt-3 list-disc space-y-1 rounded bg-slate-100 p-2 pl-6 text-sm dark:bg-slate-800">
              {result.map((line, i) => <li key={i}>{line}</li>)}
            </ul>
          )}
        </Card>
        <Card title="Health" className="lg:col-span-2">
          {health.data ? (
            <dl className="grid grid-cols-[10rem_1fr] gap-y-1 text-sm">
              <dt className="text-slate-500">Overall</dt><dd><Badge tone={health.data.status === "ok" ? "ok" : "failed"}>{health.data.status}</Badge></dd>
              <dt className="text-slate-500">Mode</dt><dd>{health.data.mode}</dd>
              <dt className="text-slate-500">Database</dt><dd>{health.data.database.ok ? "ok" : "unavailable"}{health.data.database.fts5 ? ", full-text search available" : ", FTS5 missing"}</dd>
              <dt className="text-slate-500">Storage</dt><dd>{health.data.storage.ok ? "writable" : "NOT writable"}{health.data.storage.free_bytes != null ? `, ${(health.data.storage.free_bytes / 1e9).toFixed(1)} GB free` : ""}</dd>
              <dt className="text-slate-500">Worker</dt><dd>{health.data.worker.alive ? "running" : <span className="text-red-600">not running</span>}</dd>
              <dt className="text-slate-500">Runtime</dt><dd>{health.data.runtime.status}{health.data.runtime.installation?.version ? ` (agy ${health.data.runtime.installation.version})` : ""}</dd>
              <dt className="text-slate-500">Jobs</dt><dd>{health.data.jobs.active} active, {health.data.jobs.failed} failed</dd>
            </dl>
          ) : (
            <Loading />
          )}
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
                <td className="max-w-md truncate text-xs" title={j.error_message ?? ""}>{j.error_code ? `${j.error_code}: ${j.error_message}` : ["queued", "running", "retrying"].includes(j.status) ? (j.progress?.stage ?? "") : ""}</td>
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

type Report = {
  project_id: string;
  intents_completed: string[];
  imported_new: string[];
  reimported: string[];
  external_edits: { human_id: string; from_revision: number; to_revision: number; approval_revoked: boolean }[];
  invalid_files: { path: string; reason: string }[];
  missing: string[];
  unchanged: number;
};

/** Turn maintenance results into sentences a person can act on. */
function summarize(path: string, data: unknown, names: Map<string, string>): string[] {
  const reportLines = (r: Report): string[] => {
    const name = names.get(r.project_id) ?? r.project_id;
    const out: string[] = [];
    for (const e of r.external_edits) {
      out.push(`${name}: ${e.human_id} was edited outside Jonathon and imported as revision ${e.to_revision}${e.approval_revoked ? "; its approval no longer applies and it is back in review" : ""}.`);
    }
    for (const id of r.imported_new) out.push(`${name}: new file ${id} imported (not approved).`);
    for (const f of r.invalid_files) out.push(`${name}: ${f.path} could not be read (${f.reason}). Fix the file, then reconcile again.`);
    for (const id of r.missing) out.push(`${name}: ${id} is missing on disk. Restore the file from a backup or history.`);
    if (r.intents_completed.length) out.push(`${name}: finished ${r.intents_completed.length} interrupted write(s).`);
    if (r.reimported.length) out.push(`${name}: re-imported ${r.reimported.length} file(s) written by Jonathon.`);
    if (!out.length) out.push(`${name}: no changes (${r.unchanged} file(s) checked).`);
    return out;
  };
  if (path === "/ops/reconcile") return (data as Report[]).flatMap(reportLines);
  if (path.endsWith("/reindex")) {
    const d = data as { entities: number; chunks: number; report: Report };
    return [`Index rebuilt from files: ${d.entities} knowledge item(s), ${d.chunks} search chunk(s).`, ...reportLines(d.report).filter((l) => !l.includes("no changes"))];
  }
  if (path === "/ops/backup") return [`Backup created: ${(data as { path: string }).path}`, "It contains the database and the projects folder. It is not encrypted."];
  if (path === "/ops/import-files") {
    const d = data as { projects: number; source_revisions: number };
    return [`Imported ${d.projects} project(s) and ${d.source_revisions} source revision(s) found on disk.`];
  }
  if (path.endsWith("/cancel")) return ["Cancellation requested."];
  if (path.endsWith("/retry")) return ["Job queued again."];
  return ["Done."];
}
