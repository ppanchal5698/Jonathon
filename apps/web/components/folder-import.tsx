"use client";

import { type FormEvent, useMemo, useState } from "react";
import { Badge, Button, Card, Checkbox, ErrorBanner, Field, Input, Notice, Pagination, usePaged } from "@/components/ui";
import { type ApiError, post } from "@/lib/api";

type Status = "new" | "changed" | "unchanged" | "duplicate" | "skipped";

interface ScanFile {
  path: string;
  size: number;
  status: Status;
  reason: string | null;
}

interface Scan {
  root: string;
  recursive: boolean;
  files: ScanFile[];
  groups: { folder: string; importable: number; bytes: number }[];
  counts: Record<Status, number>;
  truncated: string | null;
}

const STATUS_TONE: Record<Status, string> = { new: "success", changed: "info", unchanged: "gray", duplicate: "gray", skipped: "warning" };
const importable = (f: ScanFile) => f.status === "new" || f.status === "changed";
const topOf = (p: string) => (p.includes("/") ? p.slice(0, p.indexOf("/")) : ".");
const mb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * Import a whole folder from this computer: scan first (nothing is read into Jonathon yet), choose sub-folders or files,
 * then import. Re-importing the same folder later adds only new files and new revisions of changed ones.
 */
export function FolderImport({ pid, aiEnabled, onQueued }: { pid: string; aiEnabled: boolean; onQueued: () => void }) {
  const [path, setPath] = useState("");
  const [recursive, setRecursive] = useState(true);
  const [scan, setScan] = useState<Scan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const byGroup = useMemo(() => {
    const m = new Map<string, ScanFile[]>();
    for (const f of scan?.files ?? []) if (importable(f)) m.set(topOf(f.path), [...(m.get(topOf(f.path)) ?? []), f]);
    return m;
  }, [scan]);

  const doScan = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const s = await post<Scan>(`/projects/${pid}/sources/folder/scan`, { path, recursive });
      setScan(s);
      setSelected(new Set(s.files.filter(importable).map((f) => f.path)));
    } catch (err) {
      setError(err as ApiError);
      setScan(null);
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    if (!scan) return;
    setBusy(true);
    setError(null);
    try {
      await post(`/projects/${pid}/sources/folder/import`, { path: scan.root, recursive: scan.recursive, files: [...selected] });
      setNotice(
        `Importing ${selected.size} file${selected.size === 1 ? "" : "s"} in the background. They appear under Documents as they are stored${
          aiEnabled ? "; each one is then drafted for review and mapped into the memory graph, one document at a time" : ""
        }.`,
      );
      setScan(null);
      onQueued();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (paths: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of paths) on ? next.add(p) : next.delete(p);
      return next;
    });

  const skipped = scan?.files.filter((f) => !importable(f)) ?? [];
  const bytes = (scan?.files ?? []).filter((f) => selected.has(f.path)).reduce((n, f) => n + f.size, 0);

  return (
    <Card title="Import a folder" desc="Give the path of a folder on this computer instead of uploading files one by one.">
      <form onSubmit={doScan} className="space-y-3">
        <Field
          label="Folder path"
          hint="For example C:\Clients\Acme\Requirements. Supported: PDF, Word, Excel, PowerPoint, CSV, text, Markdown, JSON, HTML, email."
        >
          {(id) => <Input id={id} value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\..." spellCheck={false} autoComplete="off" required />}
        </Field>
        <label className="flex w-fit cursor-pointer items-center gap-2 py-1 text-theme-sm text-gray-700 dark:text-gray-300">
          <Checkbox checked={recursive} onChange={(e) => setRecursive(e.target.checked)} />
          Include sub-folders
        </label>
        <Button type="submit" variant="secondary" disabled={busy || !path.trim()}>
          {busy && !scan ? "Scanning…" : "Scan folder"}
        </Button>
      </form>
      <div className="mt-3 space-y-3">
        <ErrorBanner error={error} />
        {notice && <Notice tone="success">{notice}</Notice>}
        {scan && (
          <div className="space-y-4">
            <p className="text-theme-sm text-gray-600 dark:text-gray-400">
              <span className="font-medium [overflow-wrap:anywhere] text-gray-800 dark:text-white/90">{scan.root}</span>: {scan.counts.new} new,{" "}
              {scan.counts.changed} changed (imported as a new revision), {scan.counts.unchanged} already imported, {scan.counts.duplicate} duplicate content,{" "}
              {scan.counts.skipped} skipped.
            </p>
            {scan.truncated && <Notice tone="warning">{scan.truncated}</Notice>}
            {byGroup.size === 0 ? (
              <Notice tone="info">Nothing new to import from this folder.</Notice>
            ) : (
              <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
                {[...byGroup.entries()].map(([group, files]) => {
                  const on = files.filter((f) => selected.has(f.path)).length;
                  return (
                    <li key={group} className="p-3">
                      <div className="flex flex-wrap items-center gap-3">
                        <Checkbox
                          aria-label={`Import ${group === "." ? "files in the folder itself" : group}`}
                          checked={on === files.length}
                          ref={(el) => {
                            if (el) el.indeterminate = on > 0 && on < files.length;
                          }}
                          onChange={(e) =>
                            toggle(
                              files.map((f) => f.path),
                              e.target.checked,
                            )
                          }
                        />
                        <span className="min-w-0 font-medium [overflow-wrap:anywhere] text-gray-800 dark:text-white/90">
                          {group === "." ? "(files in the folder itself)" : `${group}/`}
                        </span>
                        <span className="text-theme-xs text-gray-500 tabular-nums dark:text-gray-400">
                          {on} of {files.length} selected · {mb(files.reduce((n, f) => n + f.size, 0))}
                        </span>
                      </div>
                      <details className="mt-2 ml-7">
                        <summary className="w-fit py-1 text-theme-xs font-medium text-brand-600 dark:text-brand-400">Choose files</summary>
                        <FileList files={files} selected={selected} onToggle={toggle} />
                      </details>
                    </li>
                  );
                })}
              </ul>
            )}
            {skipped.length > 0 && (
              <details className="text-theme-xs text-gray-500 dark:text-gray-400">
                <summary className="w-fit py-1 font-medium">Not imported ({skipped.length})</summary>
                <SkippedList files={skipped} />
              </details>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => void doImport()} disabled={busy || selected.size === 0}>
                Import {selected.size} file{selected.size === 1 ? "" : "s"} ({mb(bytes)})
              </Button>
              <Button variant="ghost" onClick={() => setScan(null)}>
                Cancel
              </Button>
            </div>
            {aiEnabled && selected.size > 0 && (
              <p className="text-theme-xs text-gray-500 dark:text-gray-400">
                AI processing is on: each document's text is sent through Antigravity to its model service to draft requirements and map concepts. Large folders
                take a while; documents are processed one at a time.
              </p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

/** Files of one sub-folder, paginated (a code or knowledge-base folder can hold hundreds). */
function FileList({ files, selected, onToggle }: { files: ScanFile[]; selected: Set<string>; onToggle: (paths: string[], on: boolean) => void }) {
  const paged = usePaged(files, 50);
  return (
    <>
      <ul className="mt-2 space-y-1">
        {paged.items.map((f) => (
          <li key={f.path} className="flex items-center gap-2 py-0.5 text-theme-xs text-gray-700 dark:text-gray-300">
            <Checkbox checked={selected.has(f.path)} onChange={(e) => onToggle([f.path], e.target.checked)} aria-label={`Import ${f.path}`} />
            <span className="min-w-0 flex-1 truncate" title={f.path}>
              {f.path}
            </span>
            <Badge tone={STATUS_TONE[f.status]}>{f.status}</Badge>
            <span className="w-16 shrink-0 text-right text-gray-500 tabular-nums dark:text-gray-400">{mb(f.size)}</span>
          </li>
        ))}
      </ul>
      <Pagination paged={paged} label="Files" sizes={[50, 100, 200]} />
    </>
  );
}

function SkippedList({ files }: { files: ScanFile[] }) {
  const paged = usePaged(files, 50);
  return (
    <>
      <ul className="mt-2 space-y-0.5">
        {paged.items.map((f) => (
          <li key={f.path} className="truncate" title={f.path}>
            {f.path} — {f.status === "unchanged" ? "already imported, unchanged" : f.reason}
          </li>
        ))}
      </ul>
      <Pagination paged={paged} label="Files not imported" sizes={[50, 100, 200]} />
    </>
  );
}
