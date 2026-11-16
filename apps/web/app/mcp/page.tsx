"use client";

import type { Project } from "@jonathon/contracts";
import { type FormEvent, useState } from "react";
import { Shell } from "@/components/shell";
import { Badge, Button, Card, Empty, ErrorBanner, Field, Input, Time } from "@/components/ui";
import { type ApiError, get, post } from "@/lib/api";
import { useApi } from "@/lib/use-api";

interface Token {
  id: string;
  name: string;
  token_prefix: string;
  scopes: string[];
  project_ids: string[];
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

export default function McpPage() {
  return (
    <Shell>
      <McpBody />
    </Shell>
  );
}

function McpBody() {
  const tokens = useApi<Token[]>("/mcp/tokens");
  const projects = useApi<Project[]>("/projects");
  const [created, setCreated] = useState<{ token: string; mcp_url: string } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [name, setName] = useState("claude-code");
  const [selected, setSelected] = useState<string[]>([]);
  const [propose, setPropose] = useState(false);
  const [expires, setExpires] = useState("90");
  const [log, setLog] = useState<{ id: string; rows: Array<Record<string, string>> } | null>(null);
  const names = new Map((projects.data ?? []).map((p) => [p.id, p.name]));

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await post<{ token: string; mcp_url: string }>("/mcp/tokens", {
        name,
        project_ids: selected,
        scopes: propose ? ["read", "propose"] : ["read"],
        expires_in_days: expires ? Number(expires) : undefined,
      });
      setCreated(r);
      void tokens.reload();
    } catch (err) {
      setError(err as ApiError);
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">MCP access for Claude Code</h1>
      {created && (
        <Card title="New credential (shown once)" className="ring-2 ring-amber-400">
          <p className="text-sm">Copy it now. Jonathon stores only a hash and cannot show it again. Keep it out of Git; put it in your shell environment.</p>
          <pre className="mt-2 overflow-x-auto rounded bg-slate-100 p-2 text-xs dark:bg-slate-800">{`# 1. In your shell (PowerShell: $env:JONATHON_MCP_TOKEN = "...")\nexport JONATHON_MCP_TOKEN="${created.token}"\n\n# 2. Register the server with Claude Code (user scope keeps the token out of the repo)\nclaude mcp add --transport http --scope user jonathon ${created.mcp_url} --header "Authorization: Bearer \${JONATHON_MCP_TOKEN}"`}</pre>
          <div className="mt-2 flex gap-2">
            <Button variant="secondary" onClick={() => navigator.clipboard.writeText(created.token)}>Copy token</Button>
            <Button variant="ghost" onClick={() => setCreated(null)}>I stored it</Button>
          </div>
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Create a scoped credential">
          <form onSubmit={create} className="space-y-3">
            <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required />}</Field>
            <fieldset>
              <legend className="text-sm font-medium">Projects</legend>
              {(projects.data ?? []).map((p) => (
                <label key={p.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={selected.includes(p.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, p.id] : selected.filter((x) => x !== p.id))} />
                  {p.name}
                </label>
              ))}
              {!projects.data?.length && <p className="text-sm text-slate-500">Create a project first.</p>}
            </fieldset>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={propose} onChange={(e) => setPropose(e.target.checked)} className="mt-1" />
              <span>Allow proposing requirement changes (never approval). Reading is always included.</span>
            </label>
            <Field label="Expires after (days)">{(id) => <Input id={id} type="number" min={1} max={365} value={expires} onChange={(e) => setExpires(e.target.value)} />}</Field>
            <ErrorBanner error={error} />
            <Button type="submit" disabled={!selected.length}>Create credential</Button>
          </form>
        </Card>
        <Card title="Credentials" className="lg:col-span-2">
          {tokens.data?.length ? (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500"><tr><th>Name</th><th>Scopes</th><th>Projects</th><th>Expires</th><th>Last used</th><th /></tr></thead>
              <tbody>
                {tokens.data.map((t) => (
                  <tr key={t.id} className="border-t border-slate-100 align-top dark:border-slate-800">
                    <td className="py-1.5">{t.name} <code className="text-xs text-slate-500">{t.token_prefix}…</code>{t.revoked_at && <> <Badge tone="failed">revoked</Badge></>}</td>
                    <td>{t.scopes.join(", ")}</td>
                    <td className="text-xs">{t.project_ids.map((p) => names.get(p) ?? p).join(", ")}</td>
                    <td className="text-xs">{t.expires_at ? <Time iso={t.expires_at} /> : "never"}</td>
                    <td className="text-xs"><Time iso={t.last_used_at} /></td>
                    <td className="space-x-1 whitespace-nowrap text-right">
                      <Button variant="ghost" onClick={async () => setLog({ id: t.id, rows: await get(`/mcp/tokens/${t.id}/access`) })}>Access log</Button>
                      {!t.revoked_at && (
                        <>
                          <Button variant="ghost" onClick={async () => { try { setCreated(await post(`/mcp/tokens/${t.id}/rotate`)); void tokens.reload(); } catch (e) { setError(e as ApiError); } }}>Rotate</Button>
                          <Button variant="danger" onClick={async () => { if (confirm(`Revoke ${t.name}? Clients using it stop working immediately.`)) { await post(`/mcp/tokens/${t.id}/revoke`); void tokens.reload(); } }}>Revoke</Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty title="No credentials" />
          )}
          {log && (
            <div className="mt-4">
              <h3 className="text-sm font-semibold">Access history</h3>
              <ul className="mt-1 max-h-72 overflow-auto text-xs">
                {log.rows.map((r, i) => (
                  <li key={i}><Time iso={r.at} /> · {r.tool} · {r.outcome}{r.error_code ? ` (${r.error_code})` : ""}</li>
                ))}
                {!log.rows.length && <li>No calls yet.</li>}
              </ul>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
