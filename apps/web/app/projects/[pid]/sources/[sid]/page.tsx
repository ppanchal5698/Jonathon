"use client";

import type { Project, Source } from "@jonathon/contracts";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { DocumentIcon } from "@/components/icons";
import { Shell } from "@/components/shell";
import { Badge, Button, Card, ConfirmPhrase, cx, ErrorBanner, Loading, Notice, PageHeader, Time } from "@/components/ui";
import { type ApiError, api, post } from "@/lib/api";
import { useApi } from "@/lib/use-api";

interface Chunks {
  chunks: { chunk_id: string; ordinal: number; heading: string | null; locator: Record<string, string | number>; text: string }[];
}

export default function SourcePage() {
  return (
    <Shell>
      <SourceBody />
    </Shell>
  );
}

function SourceBody() {
  const { pid, sid } = useParams<{ pid: string; sid: string }>();
  const router = useRouter();
  const project = useApi<Project>(`/projects/${pid}`);
  const source = useApi<Source>(`/projects/${pid}/sources/${sid}`, { pollMs: 2_000, pollWhile: (s) => s.current?.extraction_status === "pending" });
  const [rev, setRev] = useState<string | null>(null);
  const revisionId = rev ?? source.data?.current_revision_id ?? null;
  const chunks = useApi<Chunks>(revisionId ? `/projects/${pid}/revisions/${revisionId}/chunks` : null);
  const [error, setError] = useState<ApiError | null>(null);
  const [confirm, setConfirm] = useState("");
  const [showDelete, setShowDelete] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (source.error) return <ErrorBanner error={source.error} />;
  if (!source.data) return <Loading />;
  const s = source.data;
  const current = s.revisions?.find((r) => r.id === revisionId) ?? s.current;
  const crumbs = [
    { label: project.data?.name ?? "Project", href: `/projects/${pid}` },
    { label: "Documents", href: `/projects/${pid}?tab=documents` },
    { label: s.display_name },
  ];

  return (
    <>
      <PageHeader title={s.display_name} crumbs={crumbs}>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {current && <Badge>{current.extraction_status}</Badge>}
          <span className="text-theme-sm text-gray-500 dark:text-gray-400">{s.revisions?.length ?? 1} revision(s)</span>
        </div>
      </PageHeader>
      <div className="grid grid-cols-12 gap-4 md:gap-6">
        <div className="col-span-12 space-y-4 md:space-y-6 xl:col-span-4">
          <Card title="Revisions">
            <ul className="space-y-3">
              {s.revisions?.map((r) => (
                <li key={r.id}>
                  <div
                    className={cx(
                      "rounded-xl border p-4 transition-colors",
                      r.id === revisionId ? "border-brand-300 bg-brand-25 dark:border-brand-800 dark:bg-brand-500/[0.08]" : "border-gray-200 dark:border-gray-800",
                    )}
                  >
                    <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => setRev(r.id)} aria-current={r.id === revisionId ? "true" : undefined}>
                      <span className="font-medium text-gray-800 dark:text-white/90">Revision {r.revision_number}</span>
                      {r.id === s.current_revision_id && <Badge tone="success">current</Badge>}
                    </button>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-theme-xs text-gray-500 dark:text-gray-400">
                      <Badge>{r.extraction_status}</Badge> {(r.size_bytes / 1024).toFixed(1)} KB · <Time iso={r.created_at} />
                    </div>
                    <p className="mt-2 font-mono text-[10px] break-all text-gray-500 dark:text-gray-400">sha256 {r.content_hash}</p>
                    <a
                      className="mt-3 inline-flex h-8 items-center rounded-lg px-3 text-theme-xs font-medium text-gray-700 ring-1 ring-gray-300 ring-inset hover:bg-gray-50 dark:text-gray-300 dark:ring-gray-700 dark:hover:bg-white/5"
                      href={`/api/v1/projects/${pid}/revisions/${r.id}/original`}
                      download
                    >
                      Download original
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
          {current && (
            <Card title="Extraction" desc={current.extractor ? `Extractor: ${current.extractor}` : undefined}>
              <div className="space-y-3">
                {current.extraction_warnings.length > 0 && (
                  <Notice tone="warning" title="Warnings">
                    <ul className="list-disc space-y-1 pl-5">
                      {current.extraction_warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </Notice>
                )}
                {current.extraction_status === "needs_ocr" && <Notice tone="warning">This file needs OCR, which is not configured. It is preserved but not searchable.</Notice>}
                {current.extraction_status === "unsupported" && (
                  <Notice>Jonathon cannot read this format. It is preserved and listed, but nothing in it is treated as understood.</Notice>
                )}
                {(current.extraction_status === "succeeded" || current.extraction_status === "partially_succeeded") && (
                  <Button
                    variant="secondary"
                    onClick={async () => {
                      try {
                        await post(`/projects/${pid}/revisions/${current.id}/interpret`);
                        setNotice("Draft extraction queued. Results appear as drafts for review.");
                      } catch (e) {
                        setError(e as ApiError);
                      }
                    }}
                  >
                    Propose drafts with AI
                  </Button>
                )}
                {notice && (
                  <p role="status" className="text-theme-sm text-green-600 dark:text-green-500">
                    {notice}
                  </p>
                )}
              </div>
            </Card>
          )}
          <Card title="Delete">
            {!showDelete ? (
              <Button variant="danger" onClick={() => setShowDelete(true)}>
                Delete this document…
              </Button>
            ) : (
              <div className="space-y-4">
                <Notice tone="warning">
                  Removes every revision&apos;s original, extraction and search index for this document. Knowledge that cited it is flagged stale. Backups made earlier still contain it, and
                  Jonathon cannot delete copies the model provider or Antigravity may hold.
                </Notice>
                <ConfirmPhrase phrase={`delete ${s.display_name}`} value={confirm} onChange={setConfirm} />
                <div className="flex gap-3">
                  <Button
                    variant="danger"
                    disabled={confirm !== `delete ${s.display_name}`}
                    onClick={async () => {
                      try {
                        await api("DELETE", `/projects/${pid}/sources/${sid}`, { confirmation: confirm });
                        router.replace(`/projects/${pid}?tab=documents`);
                      } catch (e) {
                        setError(e as ApiError);
                      }
                    }}
                  >
                    Delete permanently
                  </Button>
                  <Button variant="secondary" onClick={() => setShowDelete(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </Card>
          <ErrorBanner error={error} />
        </div>
        <Card title={`Extracted text (${chunks.data?.chunks.length ?? 0} chunks)`} desc="What retrieval and the model see, with the location of every passage." className="col-span-12 xl:col-span-8">
          {chunks.loading ? (
            <Loading />
          ) : chunks.data?.chunks.length ? (
            <ol className="space-y-3">
              {chunks.data.chunks.map((c) => (
                <li key={c.chunk_id} id={c.chunk_id} className="rounded-xl border border-gray-200 p-4 dark:border-gray-800">
                  <p className="mb-2 flex flex-wrap items-center gap-2 text-theme-xs text-gray-500 dark:text-gray-400">
                    <span className="rounded-md bg-gray-100 px-1.5 py-0.5 font-mono dark:bg-white/5">#{c.ordinal}</span>
                    {c.heading && <span className="font-medium text-gray-700 dark:text-gray-300">{c.heading}</span>}
                    <span>
                      {Object.entries(c.locator)
                        .map(([k, v]) => `${k} ${v}`)
                        .join(", ")}
                    </span>
                  </p>
                  <pre className="font-sans text-theme-sm whitespace-pre-wrap text-gray-700 dark:text-gray-300">{c.text}</pre>
                </li>
              ))}
            </ol>
          ) : (
            <div className="flex items-center gap-2 text-theme-sm text-gray-500">
              <DocumentIcon className="size-5" /> No extracted text for this revision.
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
