"use client";

import type { Answer, Citation, Job } from "@jonathon/contracts";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { type ApiError, get, post } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { Markdown } from "./markdown";
import { A, Badge, Button, Card, cx, Empty, ErrorBanner, Field, Input, Loading, Textarea, Time } from "./ui";

interface Conv {
  id: string;
  title: string;
  owner_kind: string;
  feature_scope: string | null;
  updated_at: string;
}
interface Msg {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: string;
  job_id: string | null;
  stale: boolean;
  answer: Answer | null;
  created_at: string;
}

const AUTHORITY_LABEL: Record<string, [string, string]> = {
  source_evidence: ["client source", "pending"],
  approved_requirement: ["approved requirement", "approved"],
  unapproved_requirement: ["UNAPPROVED requirement", "draft"],
  approved_decision: ["approved decision", "approved"],
  unapproved_decision: ["UNAPPROVED decision", "draft"],
  open_conflict: ["open conflict", "conflicting_sources"],
  open_question: ["open question", "open"],
  other_knowledge: ["knowledge", "pending"],
};

export function Chat({ pid }: { pid: string }) {
  const convs = useApi<Conv[]>(`/projects/${pid}/conversations`);
  const [active, setActive] = useState<string | null>(null);
  return (
    <div className="grid gap-4 lg:grid-cols-4">
      <Card title="Conversations" actions={<Button variant="ghost" onClick={() => setActive(null)}>New</Button>}>
        <ul className="space-y-1 text-sm">
          {(convs.data ?? []).map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => setActive(c.id)} aria-current={active === c.id ? "true" : undefined}
                className={cx("w-full rounded px-2 py-1 text-left", active === c.id ? "bg-indigo-50 dark:bg-slate-800" : "hover:bg-slate-50 dark:hover:bg-slate-800")}>
                <span className="block truncate">{c.title}</span>
                <span className="text-xs text-slate-500">{c.owner_kind === "mcp_token" ? "via MCP · " : ""}<Time iso={c.updated_at} /></span>
              </button>
            </li>
          ))}
          {!convs.loading && !convs.data?.length && <li className="text-slate-500">No conversations yet.</li>}
        </ul>
      </Card>
      <div className="lg:col-span-3">
        <Conversation key={active ?? "new"} pid={pid} conversationId={active} onCreated={(id) => { setActive(id); void convs.reload(); }} />
      </div>
    </div>
  );
}

function Conversation({ pid, conversationId, onCreated }: { pid: string; conversationId: string | null; onCreated: (id: string) => void }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [kr, setKr] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [scope, setScope] = useState("");
  const [pendingJob, setPendingJob] = useState<Job | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [drawer, setDrawer] = useState<{ answer: Answer; citationId: string } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const load = async (id: string) => {
    const d = await get<{ messages: Msg[]; knowledge_revision: number }>(`/projects/${pid}/conversations/${id}`);
    setMessages(d.messages);
    setKr(d.knowledge_revision);
  };
  useEffect(() => {
    if (conversationId) void load(conversationId).catch((e) => setError(e));
  }, [conversationId]);
  useEffect(() => {
    // Newer browsers return a Promise from scroll methods; never return it from an effect.
    void endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, pendingJob?.progress?.stage]);

  // Poll the real job record while an answer is pending. Progress text comes from the worker, never invented here.
  useEffect(() => {
    if (!pendingJob) return;
    const t = setInterval(async () => {
      try {
        const r = await get<{ job: Job; answer?: Answer }>(`/projects/${pid}/jobs/${pendingJob.id}`);
        if (["queued", "running", "retrying"].includes(r.job.status)) setPendingJob(r.job);
        else {
          setPendingJob(null);
          if (r.job.status === "failed" || r.job.status === "cancelled") {
            setError({ code: r.job.error_code ?? r.job.status.toUpperCase(), message: r.job.error_message ?? `The answer job ${r.job.status}.`, name: "", status: 0 } as unknown as ApiError);
          }
          const convId = r.answer?.conversation_id ?? conversationId;
          if (convId) await load(convId);
        }
      } catch (e) {
        setError(e as ApiError);
      }
    }, 1_000);
    return () => clearInterval(t);
  }, [pendingJob?.id, pid]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setError(null);
    try {
      const r = await post<Answer | { status: "pending"; job_id: string; conversation_id: string }>(`/projects/${pid}/ask`, {
        message: text,
        conversation_id: conversationId ?? undefined,
        feature_scope: scope || undefined,
        knowledge_revision: kr ?? undefined,
        request_id: crypto.randomUUID(),
        wait_ms: 1_500,
      });
      setText("");
      if (!conversationId) onCreated(r.conversation_id);
      if (r.status === "pending") {
        setPendingJob({ id: (r as { job_id: string }).job_id, status: "queued", progress: null } as Job);
        await load(r.conversation_id);
      } else await load(r.conversation_id);
    } catch (err) {
      setError(err as ApiError);
    }
  };

  const cancel = async () => {
    if (pendingJob) await post(`/projects/${pid}/jobs/${pendingJob.id}/cancel`).catch((e) => setError(e));
  };
  const retry = async (jobId: string) => {
    await post(`/projects/${pid}/jobs/${jobId}/retry`).catch((e) => setError(e));
    setPendingJob({ id: jobId, status: "queued", progress: null } as Job);
  };

  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <div className="space-y-4" aria-live="polite">
          {!conversationId && messages.length === 0 && (
            <Empty title="Ask about this project">Answers cite stored evidence, label approved vs draft knowledge, and say when something is unknown.</Empty>
          )}
          {messages.map((m) => (
            <div key={m.id} className={cx("rounded-lg p-3", m.role === "user" ? "ml-12 bg-indigo-50 dark:bg-indigo-950" : "mr-4 bg-slate-50 dark:bg-slate-800/60")}>
              {m.role === "user" ? (
                <>
                  <p className="whitespace-pre-wrap text-sm">{m.content}</p>
                  {m.status === "pending" && m.job_id && !pendingJob && (
                    <Button variant="ghost" className="mt-1" onClick={() => retry(m.job_id!)}>Retry this question</Button>
                  )}
                </>
              ) : m.answer ? (
                <AnswerView answer={m.answer} stale={m.stale} onCite={(id) => setDrawer({ answer: m.answer!, citationId: id })} pid={pid} />
              ) : (
                <p className="text-sm">{m.content}</p>
              )}
            </div>
          ))}
          {pendingJob && (
            <div role="status" className="flex items-center gap-3 rounded-md bg-slate-50 p-3 text-sm dark:bg-slate-800">
              <Badge>{pendingJob.status}</Badge>
              <span>{pendingJob.progress ? `${pendingJob.progress.stage}${pendingJob.progress.detail ? ` (${pendingJob.progress.detail})` : ""}` : "waiting for the worker"}</span>
              <Button variant="secondary" className="ml-auto" onClick={cancel}>Cancel</Button>
            </div>
          )}
          <div ref={endRef} />
        </div>
        <ErrorBanner error={error} />
        <form onSubmit={send} className="mt-4 space-y-2 border-t border-slate-200 pt-3 dark:border-slate-700">
          <Field label={conversationId ? "Follow-up question" : "Question"}>
            {(id) => (
              <Textarea id={id} rows={3} value={text} onChange={(e) => setText(e.target.value)} disabled={!!pendingJob}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void send(e as unknown as FormEvent); }} />
            )}
          </Field>
          <div className="flex items-end gap-2">
            <Field label="Feature scope (optional)" hint="Readiness is only assessed for a named feature.">
              {(id) => <Input id={id} value={scope} onChange={(e) => setScope(e.target.value)} placeholder="email-verification" />}
            </Field>
            <Button type="submit" disabled={!!pendingJob || !text.trim()} className="ml-auto">Ask (Ctrl+Enter)</Button>
          </div>
        </form>
      </Card>
      <EvidenceDrawer pid={pid} drawer={drawer} onClose={() => setDrawer(null)} />
    </div>
  );
}

function AnswerView({ answer, stale, onCite, pid }: { answer: Answer; stale: boolean; onCite: (id: string) => void; pid: string }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{answer.status}</Badge>
        {answer.runtime.provider === "demo-extractive" && <Badge tone="needs_ocr">demo, no AI</Badge>}
        {answer.runtime.provider === "none" && <Badge tone="cancelled">no model used</Badge>}
        {stale && <Badge tone="failed">stale: evidence changed since</Badge>}
        <span className="text-xs text-slate-500">knowledge rev {answer.knowledge_revision}</span>
      </div>
      <Markdown text={answer.answer_markdown} onCite={(t) => onCite(t)} />
      {answer.citations.length > 0 && (
        <div>
          <p className="text-xs font-medium text-slate-500">Sources</p>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {answer.citations.map((c) => {
              const [label, tone] = AUTHORITY_LABEL[c.authority] ?? ["source", "pending"];
              return (
                <li key={c.citation_id}>
                  <button type="button" onClick={() => onCite(c.citation_id)} className="rounded border border-slate-200 px-2 py-0.5 text-xs hover:bg-white dark:border-slate-600 dark:hover:bg-slate-700">
                    {c.citation_id} · {c.entity_id ?? c.document_title} <Badge tone={tone}>{label}</Badge>
                    {c.support_check === "quote_not_found" && <Badge tone="failed">quote not found</Badge>}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {answer.conflicts.length > 0 && (
        <div className="rounded-md border border-orange-300 p-2 text-sm dark:border-orange-800">
          <p className="font-medium">Conflicts</p>
          <ul className="list-disc pl-5">
            {answer.conflicts.map((c, i) => (
              <li key={i}>{c.conflict_id ? <A href={`/projects/${pid}/entities/${c.conflict_id}`}>{c.conflict_id}</A> : null} {c.summary}</li>
            ))}
          </ul>
        </div>
      )}
      {answer.unresolved_questions.length > 0 && (
        <div className="text-sm">
          <p className="font-medium">Not established</p>
          <ul className="list-disc pl-5">{answer.unresolved_questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
        </div>
      )}
      {answer.inferences.length > 0 && (
        <div className="text-sm">
          <p className="font-medium">Inferences (not stated in evidence)</p>
          <ul className="list-disc pl-5 italic">{answer.inferences.map((q, i) => <li key={i}>{q}</li>)}</ul>
        </div>
      )}
      <div className="text-xs">
        <span className="font-medium">Implementation ready{answer.readiness_scope ? ` (${answer.readiness_scope})` : ""}: </span>
        {answer.implementation_ready ? "yes" : "no"}
        {answer.readiness_reasons.length > 0 && <ul className="mt-1 list-disc pl-5 text-slate-600 dark:text-slate-300">{answer.readiness_reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
      </div>
      {answer.warnings.length > 0 && (
        <details className="text-xs text-amber-800 dark:text-amber-300">
          <summary>{answer.warnings.length} warning(s)</summary>
          <ul className="list-disc pl-5">{answer.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </details>
      )}
      <p className="text-xs text-slate-500">
        {answer.runtime.provider}{answer.runtime.runtime_version ? ` ${answer.runtime.runtime_version}` : ""} · {(answer.runtime.duration_ms / 1000).toFixed(1)} s
        {answer.runtime.context_rebuilt ? " · runtime context rebuilt" : ""}
      </p>
    </div>
  );
}

function EvidenceDrawer({ pid, drawer, onClose }: { pid: string; drawer: { answer: Answer; citationId: string } | null; onClose: () => void }) {
  const c: Citation | undefined = drawer?.answer.citations.find((x) => x.citation_id === drawer.citationId);
  return (
    <aside aria-label="Evidence" className="xl:sticky xl:top-4 xl:self-start">
      <Card title="Evidence" actions={drawer && <Button variant="ghost" onClick={onClose}>Close</Button>}>
        {!c ? (
          <p className="text-sm text-slate-500">Select a citation to see the stored passage, its location and its authority.</p>
        ) : (
          <div className="space-y-2 text-sm">
            <p className="font-medium">{c.citation_id}: {c.entity_id ?? c.document_title}</p>
            <p><Badge tone={(AUTHORITY_LABEL[c.authority] ?? ["", "pending"])[1]}>{(AUTHORITY_LABEL[c.authority] ?? [c.authority])[0]}</Badge></p>
            <blockquote className="whitespace-pre-wrap border-l-4 border-indigo-300 pl-3 text-slate-700 dark:text-slate-200">{c.excerpt}</blockquote>
            <dl className="grid grid-cols-[6rem_1fr] gap-1 text-xs">
              <dt className="text-slate-500">Location</dt><dd>{Object.entries(c.locator).map(([k, v]) => `${k} ${v}`).join(", ") || "–"}</dd>
              <dt className="text-slate-500">Quote check</dt><dd>{c.support_check === "quote_verified" ? "found verbatim in stored evidence" : "NOT found; showing stored passage"}</dd>
              <dt className="text-slate-500">Revision</dt><dd className="break-all">{c.source_revision ?? "–"}</dd>
              <dt className="text-slate-500">Hash</dt><dd className="break-all font-mono">{c.content_hash.slice(0, 16)}…</dd>
            </dl>
            <p className="text-xs text-slate-500">A verified quote proves where the text came from, not that it supports the claim. Read the passage.</p>
            {c.source_id ? <A href={`/projects/${pid}/sources/${c.source_id}`}>Open source document</A> : c.entity_id ? <A href={`/projects/${pid}/entities/${c.entity_id}`}>Open {c.entity_id}</A> : null}
          </div>
        )}
      </Card>
    </aside>
  );
}

export { Loading };
