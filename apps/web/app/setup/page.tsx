"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { AuthLayout } from "@/components/auth-layout";
import { CheckCircleIcon, CpuIcon, KeyIcon, ServerIcon } from "@/components/icons";
import { Shell } from "@/components/shell";
import { Badge, Button, Card, CardSkeleton, ErrorBanner, Field, Input, Notice, PageHeader, SkeletonText } from "@/components/ui";
import { type ApiError, get, post, setCsrf } from "@/lib/api";

interface Status {
  set_up: boolean;
  mode: string;
  data_dir: string | null;
  ai_notice: string;
}

export default function SetupPage() {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    get<Status>("/setup/status")
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);
  if (!status)
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-md">
          <CardSkeleton lines={5} label="setup" />
        </div>
      </main>
    );
  if (!status.set_up) return <CreateAccount status={status} />;
  return (
    <Shell>
      <RuntimeDiagnostics status={status} />
    </Shell>
  );
}

function DataNotice({ status }: { status: Status }) {
  return (
    <Notice tone="warning" title="Data sharing notice">
      <p>{status.ai_notice}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>
          You choose per project whether AI processing is on: the new-project form asks (ticked by default so uploads are drafted into requirements for your
          review), and you can turn it off at any time in that project&apos;s settings.
        </li>
        <li>Stored files are not encrypted by Jonathon. Protect the data folder with your operating system&apos;s disk encryption.</li>
        <li>Deleting a document in Jonathon cannot remove copies the model provider or Antigravity&apos;s own transcript store may keep.</li>
      </ul>
      {status.data_dir && (
        <p className="mt-2">
          Storage location: <code className="rounded bg-white/60 px-1 break-all dark:bg-black/20">{status.data_dir}</code> (set <code>JONATHON_DATA_DIR</code>{" "}
          to change it; it must be outside the source repository).
        </p>
      )}
    </Notice>
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
    <AuthLayout title="Set up Jonathon" subtitle="Create the single local account. It protects the web UI; Claude Code connects with separate scoped tokens.">
      <div className="space-y-6">
        <DataNotice status={status} />
        <form onSubmit={submit} className="space-y-5">
          <Field label="Username">
            {(id) => <Input id={id} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />}
          </Field>
          <Field label="Password" hint="At least 12 characters.">
            {(id) => (
              <Input
                id={id}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                minLength={12}
                required
              />
            )}
          </Field>
          <Field label="Confirm password">
            {(id) => <Input id={id} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />}
          </Field>
          <ErrorBanner error={error} />
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? "Creating…" : "Create account"}
          </Button>
        </form>
      </div>
    </AuthLayout>
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

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-gray-100 py-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-6 dark:border-gray-800">
      <dt className="w-48 shrink-0 text-theme-sm text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="min-w-0 text-theme-sm [overflow-wrap:anywhere] text-gray-800 dark:text-white/90">{children}</dd>
    </div>
  );
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
  const tone = (s: string) => (s === "ok" ? "success" : s === "demo" ? "primary" : "error");
  return (
    <>
      <PageHeader title="Setup and runtime" crumbs={[{ label: "Setup & runtime" }]} />
      <div className="grid grid-cols-12 gap-4 md:gap-6">
        <div className="col-span-12 space-y-4 md:space-y-6 xl:col-span-8">
          <Card
            title="Antigravity CLI"
            desc="Local checks run the CLI's version and help commands only."
            actions={
              <div className="flex flex-wrap gap-3">
                <Button variant="secondary" disabled={busy} onClick={() => run(false)}>
                  Re-check (local only)
                </Button>
                <Button disabled={busy} onClick={() => run(true)} title="Lists models through agy; contacts the provider but sends no client content">
                  Check authentication
                </Button>
              </div>
            }
          >
            <ErrorBanner error={error} />
            {!diag ? (
              <SkeletonText lines={6} label="runtime details" />
            ) : (
              <dl>
                <Row label="Status">
                  <Badge tone={tone(diag.status)}>{diag.status}</Badge>
                </Row>
                <Row label="Provider">{diag.provider}</Row>
                <Row label="Executable">
                  <code>{diag.installation.executable}</code>{" "}
                  {diag.installation.installed
                    ? `version ${diag.installation.version}`
                    : `not available${diag.installation.error ? `: ${diag.installation.error}` : ""}`}
                </Row>
                <Row label="Required flags">
                  {diag.capabilities ? (diag.capabilities.missing.length ? `missing: ${diag.capabilities.missing.join(", ")}` : "all present") : "–"}
                </Row>
                <Row label="Authentication">{diag.auth ? `${diag.auth.status}: ${diag.auth.detail}` : "not checked (press “Check authentication”)"}</Row>
                {diag.capabilities?.globalRuleFiles.length ? (
                  <Row label="Global rule files">
                    <span className="text-amber-700 dark:text-orange-400">
                      {diag.capabilities.globalRuleFiles.join(", ")}: these load into every agy run, including Jonathon&apos;s. Review them.
                    </span>
                  </Row>
                ) : null}
              </dl>
            )}
            {diag?.status === "auth_required" && (
              <div className="mt-4">
                <Notice tone="warning">
                  To authenticate, open a terminal, run <code>agy</code>, and complete the sign-in. Jonathon never handles your Google credentials.
                </Notice>
              </div>
            )}
            {diag?.status === "not_installed" && (
              <div className="mt-4">
                <Notice tone="warning">
                  Install Antigravity CLI from the official documentation, then make sure <code>agy</code> is on PATH (or set <code>AGY_PATH</code>). Jonathon
                  does not download or run installers.
                </Notice>
              </div>
            )}
          </Card>
          <DataNotice status={status} />
        </div>
        <div className="col-span-12 xl:col-span-4">
          <Card title="How Jonathon restricts the runtime">
            <ul className="space-y-4">
              {[
                [CpuIcon, "Every run uses a custom agent whose only tool is the internal finish step: no shell, files, browser, web search or MCP."],
                [KeyIcon, "Session-only settings deny commands, file access, URLs and MCP; your global agy settings are not changed."],
                [ServerIcon, "Runs start in an empty per-project folder. Client files are never placed there; evidence is passed in the message."],
                [CheckCircleIcon, "If the runtime starts any tool anyway, Jonathon stops the process tree and discards the output."],
              ].map(([Icon, text], i) => {
                const I = Icon as typeof CpuIcon;
                return (
                  <li key={i} className="flex gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-400">
                      <I className="size-5" />
                    </span>
                    <span className="text-theme-sm text-gray-600 dark:text-gray-300">{text as string}</span>
                  </li>
                );
              })}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
