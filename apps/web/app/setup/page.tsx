"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { Shell } from "@/components/shell";
import { Badge, Button, Card, ErrorBanner, Field, Input, Loading } from "@/components/ui";
import { type ApiError, get, post, setCsrf } from "@/lib/api";

interface Status {
  set_up: boolean;
  mode: string;
  data_dir: string;
  ai_notice: string;
}

export default function SetupPage() {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    get<Status>("/setup/status").then(setStatus).catch(() => setStatus(null));
  }, []);
  if (!status) return <main className="p-8"><Loading /></main>;
  if (!status.set_up) return <CreateAccount status={status} />;
  return (
    <Shell>
      <RuntimeDiagnostics status={status} />
    </Shell>
  );
}

function Notice({ status }: { status: Status }) {
  return (
    <Card title="Data sharing notice">
      <p className="text-sm">{status.ai_notice}</p>
      <ul className="mt-2 list-disc pl-5 text-sm text-slate-600 dark:text-slate-300">
        <li>AI processing is <strong>off</strong> for every new project until you enable it in that project&apos;s settings.</li>
        <li>Stored files are not encrypted by Jonathon. Protect the data folder with your operating system&apos;s disk encryption.</li>
        <li>Deleting a document in Jonathon cannot remove copies the model provider or Antigravity&apos;s own transcript store may keep.</li>
      </ul>
      <p className="mt-3 text-sm">
        Storage location: <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">{status.data_dir}</code> (set <code>JONATHON_DATA_DIR</code> to change it; it must be outside the source repository).
      </p>
    </Card>
  );
}

function CreateAccount({ status }: { status: Status }) {
  const router = useRouter();
  const [username, setUsername] = useState("parth");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError(new Error("Passwords do not match."));
    setBusy(true);
    try {
      const r = await post<{ csrf_token: string }>("/setup/account", { username, password });
      setCsrf(r.csrf_token);
      router.replace("/");
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="mx-auto max-w-xl space-y-4 p-6">
      <h1 className="text-2xl font-bold">Set up Jonathon</h1>
      <Notice status={status} />
      <Card title="Create the local account">
        <form onSubmit={submit} className="space-y-3">
          <Field label="Username">{(id) => <Input id={id} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />}</Field>
          <Field label="Password" hint="At least 12 characters.">{(id) => <Input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={12} required />}</Field>
          <Field label="Confirm password">{(id) => <Input id={id} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />}</Field>
          <ErrorBanner error={error} />
          <Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create account"}</Button>
        </form>
      </Card>
    </main>
  );
}

interface Diag {
  status: string;
  provider: string;
  installation: { installed: boolean; executable: string; version: string | null; error: string | null };
  capabilities: { compatible: boolean; flags: Record<string, boolean>; missing: string[]; globalRuleFiles: string[]; notes: string[] } | null;
  auth: { status: string; detail: string } | null;
  auth_checked: boolean;
}

function RuntimeDiagnostics({ status }: { status: Status }) {
  const [diag, setDiag] = useState<Diag | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (auth: boolean) => {
    setBusy(true);
    try {
      setDiag(await get<Diag>(`/ops/runtime${auth ? "?auth=1" : ""}`));
      setError(null);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void run(false);
  }, []);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Setup and runtime</h1>
      <Notice status={status} />
      <Card
        title="Antigravity CLI"
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => run(false)}>Re-check (local only)</Button>
            <Button variant="secondary" disabled={busy} onClick={() => run(true)} title="Lists models through agy; contacts the provider but sends no client content">Check authentication</Button>
          </div>
        }
      >
        <ErrorBanner error={error} />
        {!diag ? (
          <Loading label="Inspecting runtime" />
        ) : (
          <dl className="grid grid-cols-[12rem_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-slate-500">Status</dt>
            <dd><Badge tone={diag.status === "ok" ? "ok" : "failed"}>{diag.status}</Badge></dd>
            <dt className="text-slate-500">Provider</dt>
            <dd>{diag.provider}</dd>
            <dt className="text-slate-500">Executable</dt>
            <dd><code>{diag.installation.executable}</code> {diag.installation.installed ? `version ${diag.installation.version}` : `not available${diag.installation.error ? `: ${diag.installation.error}` : ""}`}</dd>
            <dt className="text-slate-500">Required flags</dt>
            <dd>{diag.capabilities ? (diag.capabilities.missing.length ? `missing: ${diag.capabilities.missing.join(", ")}` : "all present") : "–"}</dd>
            <dt className="text-slate-500">Authentication</dt>
            <dd>{diag.auth ? `${diag.auth.status}: ${diag.auth.detail}` : "not checked (press “Check authentication”)"}</dd>
            {diag.capabilities?.globalRuleFiles.length ? (
              <>
                <dt className="text-slate-500">Global rule files</dt>
                <dd className="text-amber-700 dark:text-amber-300">{diag.capabilities.globalRuleFiles.join(", ")}: these load into every agy run, including Jonathon&apos;s. Review them.</dd>
              </>
            ) : null}
          </dl>
        )}
        {diag?.status === "auth_required" && (
          <p className="mt-3 text-sm">To authenticate, open a terminal, run <code>agy</code>, and complete the sign-in. Jonathon never handles your Google credentials.</p>
        )}
        {diag?.status === "not_installed" && (
          <p className="mt-3 text-sm">Install Antigravity CLI from the official documentation, then make sure <code>agy</code> is on PATH (or set <code>AGY_PATH</code>). Jonathon does not download or run installers.</p>
        )}
      </Card>
      <Card title="How Jonathon restricts the runtime">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>Every run uses a custom agent whose only tool is the internal <code>finish</code> step: no shell, files, browser, web search or MCP.</li>
          <li>Session-only settings deny commands, file access, URLs and MCP; your global agy settings are not changed.</li>
          <li>Runs start in an empty per-project folder. Client files are never placed there; evidence is passed in the message.</li>
          <li>If the runtime starts any tool anyway, Jonathon stops the process tree and discards the output.</li>
        </ul>
      </Card>
    </div>
  );
}
