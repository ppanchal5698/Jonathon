"use client";

import type { Answer, Citation, Job } from "@jonathon/contracts";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { type ApiError, get, post } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { Markdown } from "./markdown";
import { ChatIcon, PlusIcon } from "./icons";
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
  source_evidence: ["client source", "gray"],
  approved_requirement: ["approved requirement", "success"],
  unapproved_requirement: ["UNAPPROVED requirement", "warning"],
  approved_decision: ["approved decision", "success"],
  unapproved_decision: ["UNAPPROVED decision", "warning"],
  open_conflict: ["open conflict", "error"],
  open_question: ["open question", "orange"],
  other_knowledge: ["knowledge", "info"],
};

export function Chat({ pid }: { pid: string }) {
  const convs = useApi<Conv[]>(`/projects/${pid}/conversations`);
  const [active, setActive] = useState<string | null>(null);
  return (
    <div className="grid grid-cols-12 gap-4 md:gap-6">
      <Card
        title="Conversations"
        className="col-span-12 lg:col-span-4 2xl:col-span-3"
        bodyClassName="p-3 sm:p-3"
        actions={
          <Button size="sm" onClick={() => setActive(null)}>
            <PlusIcon /> New
          </Button>
        }
      >
        <ul className="custom-scrollbar max-h-[560px] space-y-1 overflow-y-auto">
          {(convs.data ?? []).map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => setActive(c.id)} aria-current={active === c.id ? "true" : undefined}
                className={cx("flex w-full items-start gap-3 rounded-lg p-3 text-left", active === c.id ? "bg-brand-50 dark:bg-brand-500/[0.12]" : "hover:bg-gray-100 dark:hover:bg-white/5")}>
                <span className={cx("flex size-10 shrink-0 items-center justify-center rounded-full", c.owner_kind === "mcp_token" ? "bg-sky-50 text-sky-600 dark:bg-sky-500/15 dark:text-sky-400" : "bg-brand-50 text-brand-500 dark:bg-brand-500/15 dark:text-brand-400")}>
                  <ChatIcon className="size-5" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-theme-sm font-medium text-gray-800 dark:text-white/90">{c.title}</span>
                  <span className="text-theme-xs text-gray-500 dark:text-gray-400">{c.owner_kind === "mcp_token" ? "via MCP · " : ""}<Time iso={c.updated_at} /></span>
                </span>
              </button>
            </li>
          ))}
          {!convs.loading && !convs.data?.length && <li className="p-3 text-theme-sm text-gray-500">No conversations yet.</li>}
        </ul>
      </Card>
      <div className="col-span-12 lg:col-span-8 2xl:col-span-9">
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
  /** Job of an unanswered question whose job ended without an answer (failed/cancelled): offer Retry. */
  const [stuckJobId, setStuckJobId] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [drawer, setDrawer] = useState<{ answer: Answer; citationId: string } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  /**
   * Load the conversation from the server. If the latest question is still unanswered, look up its job and resume
   * progress polling, so a remount (first question creates the conversation) or a page reload never loses it.
   */
  const load = async (id: string) => {
    const d = await get<{ messages: Msg[]; knowledge_revision: number; conversation: { feature_scope: string | null } }>(`/projects/${pid}/conversations/${id}`);
    setMessages(d.messages);
    setKr(d.knowledge_revision);
    if (d.conversation.feature_scope) setScope((s) => s || d.conversation.feature_scope!);
    const lastUser = [...d.messages].reverse().find((m) => m.role === "user");
    if (lastUser?.status === "pending" && lastUser.job_id) {
      const r = await get<{ job: Job }>(`/projects/${pid}/jobs/${lastUser.job_id}`);
      if (["queued", "running", "retrying"].includes(r.job.status)) {
        setPendingJob(r.job);
        setStuckJobId(null);
      } else if (r.job.status === "failed" || r.job.status === "cancelled") setStuckJobId(r.job.id);
    } else setStuckJobId(null);
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
      if (!conversationId) {
        // The parent switches to the new conversation; that view reloads it and resumes polling by itself.
        onCreated(r.conversation_id);
        return;
      }
      await load(r.conversation_id);
    } catch (err) {
      setError(err as ApiError);
    }
  };

  const cancel = async () => {
    if (pendingJob) await post(`/projects/${pid}/jobs/${pendingJob.id}/cancel`).catch((e) => setError(e));
  };
  const retry = async (jobId: string) => {
    try {
      setPendingJob(await post<Job>(`/projects/${pid}/jobs/${jobId}/retry`));
      setStuckJobId(null);
      setError(null);
    } catch (e) {
      setError(e as ApiError);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-4 md:gap-6 2xl:grid-cols-3">
      <Card className="2xl:col-span-2">
        <div className="space-y-5" aria-live="polite">
          {!conversationId && messages.length === 0 && (
            <Empty title="Ask about this project" icon={<ChatIcon />}>Answers cite stored evidence, label approved vs draft knowledge, and say when something is unknown.</Empty>
          )}
          {messages.map((m) => (
            <div key={m.id} className={cx("max-w-[92%] rounded-2xl px-4 py-3", m.role === "user" ? "ml-auto rounded-tr-sm bg-brand-500 text-white" : "mr-auto rounded-tl-sm border border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-white/[0.03]")}>
              {m.role === "user" ? (
                <>
                  <p className="text-theme-sm whitespace-pre-wrap">{m.content}</p>
                  {m.job_id && m.job_id === stuckJobId && !pendingJob && (
                    <Button variant="secondary" size="sm" className="mt-2" onClick={() => retry(m.job_id!)}>Retry this question</Button>
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
            <div role="status" className="flex items-center gap-3 rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 text-theme-sm dark:border-gray-800 dark:bg-white/[0.03]">
              <span className="size-4 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" aria-hidden="true" />
              <Badge>{pendingJob.status}</Badge>
              <span>{pendingJob.progress ? `${pendingJob.progress.stage}${pendingJob.progress.detail ? ` (${pendingJob.progress.detail})` : ""}` : "waiting for the worker"}</span>
              <Button variant="secondary" size="sm" className="ml-auto" onClick={cancel}>Cancel</Button>
            </div>
          )}
          <div ref={endRef} />
        </div>
        <ErrorBanner error={error} />
        <form onSubmit={send} className="mt-6 space-y-4 border-t border-gray-100 pt-5 dark:border-gray-800">
          <Field label={conversationId ? "Follow-up question" : "Question"}>
            {(id) => (
              <Textarea id={id} rows={3} value={text} onChange={(e) => setText(e.target.value)} disabled={!!pendingJob}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void send(e as unknown as FormEvent); }} />
            )}
          </Field>
          <div className="flex flex-wrap items-end gap-3">
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
        {answer.runtime.provider === "demo-extractive" && <Badge tone="primary">demo, no AI</Badge>}
        {answer.runtime.provider === "none" && <Badge tone="gray">no model used</Badge>}
        {stale && <Badge tone="error">stale: evidence changed since</Badge>}
        <span className="text-theme-xs text-gray-500 dark:text-gray-400">knowledge rev {answer.knowledge_revision}</span>
      </div>
      <Markdown text={answer.answer_markdown} onCite={(t) => onCite(t)} />
      {answer.citations.length > 0 && (
        <div>
          <p className="text-theme-xs font-medium text-gray-500 uppercase dark:text-gray-400">Sources</p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {answer.citations.map((c) => {
              const [label, tone] = AUTHORITY_LABEL[c.authority] ?? ["source", "pending"];
              return (
                <li key={c.citation_id}>
                  <button type="button" onClick={() => onCite(c.citation_id)} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-theme-xs text-gray-700 hover:border-brand-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:border-brand-800">
                    {c.citation_id} · {c.entity_id ?? c.document_title} <Badge tone={tone}>{label}</Badge>
                    {c.support_check === "quote_not_found" && <Badge tone="error">quote not found</Badge>}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {answer.conflicts.length > 0 && (
        <div className="rounded-xl border border-orange-300 bg-orange-50 p-3 text-theme-sm text-gray-700 dark:border-orange-500/30 dark:bg-orange-500/10 dark:text-gray-300">
          <p className="font-semibold text-gray-800 dark:text-white/90">Conflicts</p>
          <ul className="list-disc pl-5">
            {answer.conflicts.map((c, i) => (
              <li key={i}>{c.conflict_id ? <A href={`/projects/${pid}/entities/${c.conflict_id}`}>{c.conflict_id}</A> : null} {c.summary}</li>
            ))}
          </ul>
        </div>
      )}
      {answer.unresolved_questions.length > 0 && (
        <div className="text-theme-sm text-gray-700 dark:text-gray-300">
          <p className="font-semibold text-gray-800 dark:text-white/90">Not established</p>
          <ul className="list-disc pl-5">{answer.unresolved_questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
        </div>
      )}
      {answer.inferences.length > 0 && (
        <div className="text-theme-sm text-gray-700 dark:text-gray-300">
          <p className="font-semibold text-gray-800 dark:text-white/90">Inferences (not stated in evidence)</p>
          <ul className="list-disc pl-5 italic">{answer.inferences.map((q, i) => <li key={i}>{q}</li>)}</ul>
        </div>
      )}
      {answer.verification ? (
        <div className="rounded-xl bg-white p-3 text-theme-xs text-gray-700 ring-1 ring-gray-200 dark:bg-gray-900 dark:text-gray-300 dark:ring-gray-800">
          <span className="font-semibold text-gray-800 dark:text-white/90">Claim check: </span>
          <Badge tone={answer.verification.removed.length ? "warning" : "success"}>
            {answer.verification.removed.length
              ? `${answer.verification.removed.length} unsupported claim${answer.verification.removed.length === 1 ? "" : "s"} removed`
              : `${answer.verification.supported} of ${answer.verification.checked} claims supported`}
          </Badge>{" "}
          <span className="text-gray-500 dark:text-gray-400">A separate verifier agent checked each statement against the evidence.</span>
          {answer.verification.removed.length > 0 && (
            <details className="mt-1">
              <summary className="cursor-pointer text-brand-500 dark:text-brand-400">Show removed claims</summary>
              <ul className="mt-1 list-disc pl-5">
                {answer.verification.removed.map((r, i) => (
                  <li key={i}>
                    <span className="line-through decoration-red-400">{r.text}</span> <span className="text-gray-500">({r.reason})</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      ) : (
        answer.runtime.provider === "antigravity-cli" && (
          <p className="rounded-xl bg-amber-50 p-3 text-theme-xs text-amber-700 dark:bg-amber-500/15 dark:text-orange-400">Claims in this answer were not checked by the verifier.</p>
        )
      )}
      <div className="rounded-xl bg-white p-3 text-theme-xs text-gray-700 ring-1 ring-gray-200 dark:bg-gray-900 dark:text-gray-300 dark:ring-gray-800">
        <span className="font-semibold text-gray-800 dark:text-white/90">Implementation ready{answer.readiness_scope ? ` (${answer.readiness_scope})` : ""}: </span>
        <Badge tone={answer.implementation_ready ? "success" : "error"}>{answer.implementation_ready ? "yes" : "no"}</Badge>
        {answer.readiness_reasons.length > 0 && <ul className="mt-1 list-disc pl-5 text-gray-600 dark:text-gray-300">{answer.readiness_reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
      </div>
      {answer.warnings.length > 0 && (
        <details className="text-theme-xs text-amber-600 dark:text-orange-400">
          <summary>{answer.warnings.length} warning(s)</summary>
          <ul className="list-disc pl-5">{answer.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </details>
      )}
      <p className="text-theme-xs text-gray-500 dark:text-gray-400">
        {answer.runtime.provider}{answer.runtime.runtime_version ? ` ${answer.runtime.runtime_version}` : ""} · {(answer.runtime.duration_ms / 1000).toFixed(1)} s
        {answer.runtime.context_rebuilt ? " · runtime context rebuilt" : ""}
      </p>
    </div>
  );
}

function EvidenceDrawer({ pid, drawer, onClose }: { pid: string; drawer: { answer: Answer; citationId: string } | null; onClose: () => void }) {
  const c: Citation | undefined = drawer?.answer.citations.find((x) => x.citation_id === drawer.citationId);
  return (
    <aside aria-label="Evidence" className="2xl:sticky 2xl:top-24 2xl:self-start">
      <Card title="Evidence" actions={drawer && <Button variant="ghost" onClick={onClose}>Close</Button>}>
        {!c ? (
          <p className="text-theme-sm text-gray-500 dark:text-gray-400">Select a citation to see the stored passage, its location and its authority.</p>
        ) : (
          <div className="space-y-3 text-theme-sm">
            <p className="font-semibold text-gray-800 dark:text-white/90">{c.citation_id}: {c.entity_id ?? c.document_title}</p>
            <p><Badge tone={(AUTHORITY_LABEL[c.authority] ?? ["", "pending"])[1]}>{(AUTHORITY_LABEL[c.authority] ?? [c.authority])[0]}</Badge></p>
            <blockquote className="rounded-r-lg border-l-4 border-brand-500 bg-brand-25 py-2 pr-2 pl-3 whitespace-pre-wrap text-gray-700 dark:bg-brand-500/[0.08] dark:text-gray-200">{c.excerpt}</blockquote>
            <dl className="grid grid-cols-[6rem_1fr] gap-x-2 gap-y-1.5 text-theme-xs text-gray-700 dark:text-gray-300">
              <dt className="text-gray-500">Location</dt><dd>{Object.entries(c.locator).map(([k, v]) => `${k} ${v}`).join(", ") || "–"}</dd>
              <dt className="text-gray-500">Quote check</dt><dd>{c.support_check === "quote_verified" ? "found verbatim in stored evidence" : "NOT found; showing stored passage"}</dd>
              <dt className="text-gray-500">Revision</dt><dd className="break-all">{c.source_revision ?? "–"}</dd>
              <dt className="text-gray-500">Hash</dt><dd className="break-all font-mono">{c.content_hash.slice(0, 16)}…</dd>
            </dl>
            <p className="text-theme-xs text-gray-500 dark:text-gray-400">A verified quote proves where the text came from, not that it supports the claim. Read the passage.</p>
            {c.source_id ? <A href={`/projects/${pid}/sources/${c.source_id}`}>Open source document</A> : c.entity_id ? <A href={`/projects/${pid}/entities/${c.entity_id}`}>Open {c.entity_id}</A> : null}
          </div>
        )}
      </Card>
    </aside>
  );
}

export { Loading };
