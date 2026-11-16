"use client";

import type { Source } from "@jonathon/contracts";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { Shell } from "@/components/shell";
import { A, Badge, Button, Card, ConfirmPhrase, ErrorBanner, Loading, Time } from "@/components/ui";
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

  return (
    <div className="space-y-4">
      <p className="text-sm"><A href={`/projects/${pid}?tab=documents`}>← Documents</A></p>
      <h1 className="text-xl font-bold">{s.display_name}</h1>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4">
          <Card title="Revisions">
            <ul className="space-y-2 text-sm">
              {s.revisions?.map((r) => (
                <li key={r.id} className="rounded border border-slate-200 p-2 dark:border-slate-700">
                  <button type="button" className="text-left" onClick={() => setRev(r.id)} aria-current={r.id === revisionId ? "true" : undefined}>
                    <span className="font-medium">Revision {r.revision_number}</span> {r.id === s.current_revision_id && <Badge tone="ok">current</Badge>}
                  </button>
                  <div className="mt-1 flex flex-wrap gap-2 text-xs"><Badge>{r.extraction_status}</Badge> {(r.size_bytes / 1024).toFixed(1)} KB · <Time iso={r.created_at} /></div>
                  <p className="mt-1 break-all font-mono text-[10px] text-slate-500">sha256 {r.content_hash}</p>
                  <a className="mt-1 inline-block text-xs text-indigo-700 underline dark:text-indigo-300" href={`/api/v1/projects/${pid}/revisions/${r.id}/original`} download>
                    Download original
                  </a>
                </li>
              ))}
            </ul>
          </Card>
          {current && (
            <Card title="Extraction">
              <p className="text-sm">Status: <Badge>{current.extraction_status}</Badge> {current.extractor && <span className="text-xs text-slate-500">({current.extractor})</span>}</p>
              {current.extraction_warnings.length > 0 && (
                <ul className="mt-2 list-disc pl-5 text-xs text-amber-800 dark:text-amber-300">{current.extraction_warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
              )}
              {current.extraction_status === "needs_ocr" && <p className="mt-2 text-xs">This file needs OCR, which is not configured. It is preserved but not searchable.</p>}
              {current.extraction_status === "unsupported" && <p className="mt-2 text-xs">Jonathon cannot read this format. It is preserved and listed, but nothing in it is treated as understood.</p>}
              {(current.extraction_status === "succeeded" || current.extraction_status === "partially_succeeded") && (
                <Button className="mt-3" variant="secondary" onClick={async () => {
                  try {
                    await post(`/projects/${pid}/revisions/${current.id}/interpret`);
                    setNotice("Draft extraction queued. Results appear as drafts for review.");
                  } catch (e) {
                    setError(e as ApiError);
                  }
                }}>Propose drafts with AI</Button>
              )}
              {notice && <p role="status" className="mt-2 text-xs">{notice}</p>}
            </Card>
          )}
          <Card title="Delete">
            {!showDelete ? (
              <Button variant="danger" onClick={() => setShowDelete(true)}>Delete this document…</Button>
            ) : (
              <div className="space-y-2 text-sm">
                <p>Removes every revision&apos;s original, extraction and search index for this document. Knowledge that cited it is flagged stale. Backups made earlier still contain it, and Jonathon cannot delete copies the model provider or Antigravity may hold.</p>
                <ConfirmPhrase phrase={`delete ${s.display_name}`} value={confirm} onChange={setConfirm} />
                <div className="flex gap-2">
                  <Button variant="danger" disabled={confirm !== `delete ${s.display_name}`} onClick={async () => {
                    try {
                      await api("DELETE", `/projects/${pid}/sources/${sid}`, { confirmation: confirm });
                      router.replace(`/projects/${pid}?tab=documents`);
                    } catch (e) {
                      setError(e as ApiError);
                    }
                  }}>Delete permanently</Button>
                  <Button variant="secondary" onClick={() => setShowDelete(false)}>Cancel</Button>
                </div>
              </div>
            )}
          </Card>
          <ErrorBanner error={error} />
        </div>
        <Card title={`Extracted text (${chunks.data?.chunks.length ?? 0} chunks)`} className="lg:col-span-2">
          {chunks.loading ? <Loading /> : (
            <ol className="space-y-3">
              {chunks.data?.chunks.map((c) => (
                <li key={c.chunk_id} id={c.chunk_id} className="rounded border border-slate-200 p-2 dark:border-slate-700">
                  <p className="mb-1 text-xs text-slate-500">#{c.ordinal} {c.heading ? `· ${c.heading}` : ""} · {Object.entries(c.locator).map(([k, v]) => `${k} ${v}`).join(", ")}</p>
                  <pre className="whitespace-pre-wrap font-sans text-sm">{c.text}</pre>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </div>
  );
}
