"use client";

import type { Project } from "@jonathon/contracts";
import { type FormEvent, useState } from "react";
import { Shell } from "@/components/shell";
import { Badge, Button, Card, Checkbox, Empty, ErrorBanner, Field, Input, PageHeader, Pagination, TableSkeleton, Time, table, usePaged } from "@/components/ui";
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
  const [copied, setCopied] = useState(false);
  const names = new Map((projects.data ?? []).map((p) => [p.id, p.name]));
  const tokenPage = usePaged(tokens.data, 10);
  const logPage = usePaged(log?.rows, 20, log?.id ?? null);

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
    <div className="space-y-4 md:space-y-6">
      <PageHeader title="MCP access for Claude Code" crumbs={[{ label: "MCP access" }]} />
      {created && (
        <Card title="New credential (shown once)" className="border-amber-500 dark:border-amber-500/40">
          <p className="text-theme-sm text-gray-700 dark:text-gray-300">
            Copy it now. Jonathon stores only a hash and cannot show it again. Keep it out of Git; put it in your shell environment.
          </p>
          <pre className="custom-scrollbar mt-3 overflow-x-auto rounded-xl bg-gray-900 p-4 text-theme-xs text-gray-100 dark:bg-black/40">{`# 1. In your shell (PowerShell: $env:JONATHON_MCP_TOKEN = "...")\nexport JONATHON_MCP_TOKEN="${created.token}"\n\n# 2. Register the server with Claude Code (user scope keeps the token out of the repo)\nclaude mcp add --transport http --scope user jonathon ${created.mcp_url} --header "Authorization: Bearer \${JONATHON_MCP_TOKEN}"`}</pre>
          <div className="mt-4 flex gap-3">
            <Button
              variant="secondary"
              onClick={() =>
                void navigator.clipboard.writeText(created.token).then(
                  () => setCopied(true),
                  () => setCopied(false),
                )
              }
            >
              {copied ? "Copied" : "Copy token"}
            </Button>
            <span className="sr-only" aria-live="polite">
              {copied ? "Token copied to the clipboard." : ""}
            </span>
            <Button
              variant="ghost"
              onClick={() => {
                setCreated(null);
                setCopied(false);
              }}
            >
              I stored it
            </Button>
          </div>
        </Card>
      )}
      <div className="grid grid-cols-12 gap-4 md:gap-6">
        <Card title="Create a scoped credential" className="col-span-12 lg:col-span-6 xl:col-span-5">
          <form onSubmit={create} className="space-y-5">
            <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required />}</Field>
            <fieldset>
              <legend className="mb-2 text-theme-sm font-medium text-gray-700 dark:text-gray-400">Projects</legend>
              <div className="space-y-1">
                {(projects.data ?? []).map((p) => (
                  <label key={p.id} className="flex w-fit cursor-pointer items-center gap-2 py-1 text-theme-sm text-gray-700 dark:text-gray-300">
                    <Checkbox
                      checked={selected.includes(p.id)}
                      onChange={(e) => setSelected(e.target.checked ? [...selected, p.id] : selected.filter((x) => x !== p.id))}
                    />
                    {p.name}
                  </label>
                ))}
              </div>
              {!projects.data?.length && <p className="text-theme-sm text-gray-500 dark:text-gray-400">Create a project first.</p>}
            </fieldset>
            <label className="flex cursor-pointer items-start gap-2 text-theme-sm text-gray-700 dark:text-gray-300">
              <Checkbox checked={propose} onChange={(e) => setPropose(e.target.checked)} className="mt-0.5" />
              <span>Allow proposing requirement changes (never approval). Reading is always included.</span>
            </label>
            <Field label="Expires after (days)">
              {(id) => <Input id={id} type="number" min={1} max={365} value={expires} onChange={(e) => setExpires(e.target.value)} />}
            </Field>
            <ErrorBanner error={error} />
            <Button type="submit" disabled={!selected.length}>
              Create credential
            </Button>
          </form>
        </Card>
        <Card
          title="Connect Claude Code"
          desc="Jonathon serves MCP over Streamable HTTP on this machine only."
          className="col-span-12 lg:col-span-6 xl:col-span-7"
        >
          <ol className="space-y-4">
            {[
              ["Create a credential", "Pick only the projects this repository needs. Leave proposing off unless Claude Code should file change proposals."],
              ["Store the token outside Git", "Put it in your shell environment (JONATHON_MCP_TOKEN). It is shown once; Jonathon keeps only a hash."],
              ["Register the server", "Run the claude mcp add command shown after creation, with user scope."],
              ["Add repository instructions", "Copy docs/sample-CLAUDE.md into the client repository as CLAUDE.md and set the project ID."],
            ].map(([t, d], i) => (
              <li key={t} className="flex gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-theme-sm font-semibold text-brand-600 dark:bg-brand-500/15 dark:text-brand-400">
                  {i + 1}
                </span>
                <span>
                  <span className="block text-theme-sm font-medium text-gray-800 dark:text-white/90">{t}</span>
                  <span className="text-theme-sm text-gray-500 dark:text-gray-400">{d}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className="mt-5 text-theme-xs text-gray-500 dark:text-gray-400">
            Tools: list_projects, ask_jonathon, search_knowledge, get_requirement, get_feature_spec, get_job, list_documents, get_document, search_memory_graph,
            explore_memory_graph, propose_requirement_change. There is no approval or editing tool.
          </p>
        </Card>
        <Card title="Credentials" className="col-span-12">
          {!tokens.data && !tokens.error ? (
            <TableSkeleton rows={3} cols={6} label="credentials" />
          ) : tokens.data?.length ? (
            <>
              <div className={table.wrap}>
                <table className={table.table}>
                  <thead className={table.thead}>
                    <tr>
                      <th className={table.th}>Name</th>
                      <th className={table.th}>Scopes</th>
                      <th className={table.th}>Projects</th>
                      <th className={table.th}>Expires</th>
                      <th className={table.th}>Last used</th>
                      <th className={table.th}>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {tokenPage.items.map((t) => (
                      <tr key={t.id} className={`${table.tr} align-top`}>
                        <td className={table.td}>
                          <span className="font-medium text-gray-800 dark:text-white/90">{t.name}</span>{" "}
                          <code className="text-theme-xs text-gray-500 dark:text-gray-400">{t.token_prefix}…</code>
                          {t.revoked_at && (
                            <>
                              {" "}
                              <Badge tone="error">revoked</Badge>
                            </>
                          )}
                        </td>
                        <td className={table.td}>
                          <div className="flex flex-wrap gap-1">
                            {t.scopes.map((sc) => (
                              <Badge key={sc} tone={sc === "propose" ? "warning" : "primary"}>
                                {sc}
                              </Badge>
                            ))}
                          </div>
                        </td>
                        <td className={`${table.td} text-theme-xs`}>{t.project_ids.map((p) => names.get(p) ?? p).join(", ")}</td>
                        <td className={`${table.td} text-theme-xs`}>{t.expires_at ? <Time iso={t.expires_at} /> : "never"}</td>
                        <td className={`${table.td} text-theme-xs`}>
                          <Time iso={t.last_used_at} />
                        </td>
                        <td className={`${table.td} space-x-1 text-right whitespace-nowrap`}>
                          <Button
                            variant="ghost"
                            onClick={async () => {
                              try {
                                setLog({ id: t.id, rows: await get(`/mcp/tokens/${t.id}/access`) });
                              } catch (e) {
                                setError(e as ApiError);
                              }
                            }}
                          >
                            Access log
                          </Button>
                          {!t.revoked_at && (
                            <>
                              <Button
                                variant="ghost"
                                onClick={async () => {
                                  try {
                                    setCreated(await post(`/mcp/tokens/${t.id}/rotate`));
                                    void tokens.reload();
                                  } catch (e) {
                                    setError(e as ApiError);
                                  }
                                }}
                              >
                                Rotate
                              </Button>
                              <Button
                                variant="danger"
                                onClick={async () => {
                                  if (confirm(`Revoke ${t.name}? Clients using it stop working immediately.`)) {
                                    try {
                                      await post(`/mcp/tokens/${t.id}/revoke`);
                                      void tokens.reload();
                                    } catch (e) {
                                      setError(e as ApiError);
                                    }
                                  }
                                }}
                              >
                                Revoke
                              </Button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination paged={tokenPage} label="Credentials" />
            </>
          ) : (
            <Empty title="No credentials" />
          )}
          {log && (
            <div className="mt-6">
              <h3 className="text-theme-sm font-semibold text-gray-800 dark:text-white/90">Access history</h3>
              <ul className="mt-2 space-y-1 text-theme-xs text-gray-600 dark:text-gray-300">
                {logPage.items.map((r, i) => (
                  <li key={i}>
                    <Time iso={r.at} /> · {r.tool} · {r.outcome}
                    {r.error_code ? ` (${r.error_code})` : ""}
                  </li>
                ))}
                {!log.rows.length && <li>No calls yet.</li>}
              </ul>
              <Pagination paged={logPage} label="Access history" />
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
