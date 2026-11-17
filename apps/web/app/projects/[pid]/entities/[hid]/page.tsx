"use client";

import type { KnowledgeEntity, Project, Statement } from "@jonathon/contracts";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useState } from "react";
import { Markdown } from "@/components/markdown";
import { EntityEditor, needsReview, parseAddition, ReviewButtons, useReviewAction } from "@/components/review";
import { Shell } from "@/components/shell";
import { A, Badge, Button, Card, ConfirmPhrase, ErrorBanner, Field, Input, Loading, Notice, PageHeader, Select, Textarea, Time } from "@/components/ui";
import { type ApiError, get, post } from "@/lib/api";
import { useApi } from "@/lib/use-api";

export default function EntityPage() {
  return (
    <Shell>
      <Suspense fallback={<Loading />}>
        <EntityBody />
      </Suspense>
    </Shell>
  );
}

const NEXT: Record<string, Record<string, string[]>> = {
  requirement: { draft: ["in_review", "approved", "rejected"], in_review: ["draft", "approved", "rejected"], approved: ["superseded"], rejected: ["draft"] },
  decision: { draft: ["in_review", "approved", "rejected"], in_review: ["draft", "approved", "rejected"], approved: ["superseded"], rejected: ["draft"] },
  open_question: { open: ["withdrawn"], withdrawn: ["open"] },
  conflict: { open: ["dismissed"], dismissed: ["open"] },
  change_proposal: { open: ["accepted", "rejected"] },
};
const VERB: Record<string, string> = { approved: "approve", rejected: "reject", superseded: "supersede", dismissed: "dismiss", accepted: "accept", withdrawn: "withdraw" };

function EntityBody() {
  const { pid, hid } = useParams<{ pid: string; hid: string }>();
  const project = useApi<Project>(`/projects/${pid}`);
  const e = useApi<KnowledgeEntity>(`/projects/${pid}/entities/${hid}`);
  const history = useApi<{ revisions: number[]; events: Array<Record<string, any>> }>(`/projects/${pid}/entities/${hid}/history`);
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<ApiError | null>(null);
  const [editing, setEditing] = useState(params.get("edit") === "1");
  const [done, setDone] = useState<string | null>(null);
  const reload = () => {
    setError(null);
    void e.reload();
    void history.reload();
  };
  const { ask, modal } = useReviewAction(pid, (action, ent) => {
    if (action === "delete") {
      router.push(`/projects/${pid}?tab=${tabFor(ent.entity_type)}`);
      return;
    }
    setDone(action === "accept" ? "Saved. The review decision is recorded in History." : "Saved.");
    reload();
  });
  if (e.error) return <ErrorBanner error={e.error} />;
  if (!e.data) return <Loading />;
  const ent = e.data;

  const crumbs = [
    { label: project.data?.name ?? "Project", href: `/projects/${pid}` },
    { label: TAB_LABEL[ent.entity_type] ?? "Knowledge", href: `/projects/${pid}?tab=${tabFor(ent.entity_type)}` },
    { label: ent.human_id },
  ];

  return (
    <>
      <PageHeader
        title={
          <>
            <span className="font-mono text-brand-500 dark:text-brand-400">{ent.human_id}</span>
            <span className="text-gray-400"> · </span>
            {ent.title}
          </>
        }
        crumbs={crumbs}
      >
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Badge>{ent.status}</Badge>
          {ent.approval_valid && <Badge tone="success">approved by {ent.approval?.approved_by}</Badge>}
          {ent.status === "approved" && !ent.approval_valid && <Badge tone="error">approval not valid for this content</Badge>}
          {ent.fields.origin === "ai_proposed" && <Badge tone="primary">AI-proposed draft</Badge>}
          {ent.file_state !== "ok" && <Badge tone="error">file {ent.file_state}</Badge>}
          {ent.stale && <Badge tone="gray">stale</Badge>}
          <span className="text-theme-sm text-gray-500 dark:text-gray-400">revision {ent.revision}</span>
        </div>
      </PageHeader>
      {modal}
      {error && (
        <div className="mb-6">
          <ErrorBanner error={error} />
        </div>
      )}
      {done && !error && (
        <p role="status" className="mb-6 rounded-xl border border-green-500 bg-green-50 px-4 py-3 text-theme-sm text-gray-700 dark:border-green-500/30 dark:bg-green-500/15 dark:text-gray-300">
          {done}
        </p>
      )}
      <div className="grid grid-cols-12 gap-4 md:gap-6">
        <div className="col-span-12 space-y-4 md:space-y-6 xl:col-span-8">
          {editing ? (
            <Card title={`Edit ${ent.human_id}`} desc={`Based on revision ${ent.revision}. Saving creates a new revision; earlier ones stay in history.`}>
              <EntityEditor
                pid={pid}
                ent={ent}
                onDone={() => {
                  setEditing(false);
                  setDone("Saved as a new revision.");
                  router.replace(`/projects/${pid}/entities/${hid}`);
                  reload();
                }}
                onCancel={() => {
                  setEditing(false);
                  router.replace(`/projects/${pid}/entities/${hid}`);
                }}
              />
            </Card>
          ) : (
            <Card title={`Revision ${ent.revision}`}>
              {ent.approval_valid && (
                <div className="mb-5">
                  <Notice tone="info">Editing an approved item creates a new revision in review; the approval stays with revision {ent.revision}.</Notice>
                </div>
              )}
              <Fields ent={ent} />
              <Sections ent={ent} />
            </Card>
          )}
          <Card title="Source traceability" desc="Where this knowledge came from, with the exact passage.">
            {ent.source_refs.length ? (
              <ul className="space-y-3">
                {ent.source_refs.map((r, i) => (
                  <li key={i} className="rounded-xl border border-gray-200 p-4 dark:border-gray-800">
                    <div className="flex flex-wrap items-center gap-2 text-theme-sm">
                      {r.label && <Badge tone="orange">{r.label}</Badge>}
                      <A href={`/projects/${pid}/sources/${r.source_id}`}>Open source</A>
                      <span className="text-theme-xs text-gray-500 dark:text-gray-400">
                        {Object.entries(r.locator)
                          .map(([k, v]) => `${k} ${v}`)
                          .join(", ")}
                      </span>
                    </div>
                    {r.excerpt && (
                      <blockquote className="mt-3 border-l-4 border-brand-200 pl-3 text-theme-sm whitespace-pre-wrap text-gray-600 dark:border-brand-800 dark:text-gray-300">{r.excerpt}</blockquote>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-theme-sm text-gray-500 dark:text-gray-400">No source references. Treat this as human-authored.</p>
            )}
          </Card>
          <Diff pid={pid} hid={hid} revisions={history.data?.revisions ?? []} />
        </div>
        <div className="col-span-12 space-y-4 md:space-y-6 xl:col-span-4">
          <Card title="Review" desc={needsReview(ent) ? "Jonathon proposed this. It is not part of approved knowledge until you accept it." : undefined}>
            <ReviewButtons pid={pid} ent={ent} onAsk={ask} onEdit={editing ? null : () => setEditing(true)} />
            {ent.entity_type === "open_question" && ent.status === "open" && ent.fields.reviewed === true && (
              <p className="mt-3 text-theme-xs text-gray-500 dark:text-gray-400">Reviewed. Record the answer below when you have it.</p>
            )}
            {ent.entity_type === "conflict" && ent.status === "open" && ent.fields.reviewed === true && (
              <p className="mt-3 text-theme-xs text-gray-500 dark:text-gray-400">Reviewed. Resolve it with a decision below.</p>
            )}
          </Card>
          <Review key={`review-${ent.revision}`} pid={pid} ent={ent} onDone={reload} onError={setError} />
          {ent.entity_type === "conflict" && ent.status === "open" && <ResolveConflict key={`resolve-${ent.revision}`} pid={pid} ent={ent} onDone={reload} onError={setError} />}
          {ent.entity_type === "open_question" && ent.status === "open" && <AnswerQuestion key={`answer-${ent.revision}`} pid={pid} ent={ent} onDone={reload} onError={setError} />}
          <Card title="History">
            {history.data && history.data.events.length === 0 && (
              <p className="text-theme-sm text-gray-500 dark:text-gray-400">No approval, rejection or resolution recorded yet.</p>
            )}
            <ol className={history.data?.events.length ? "relative space-y-4 border-l border-gray-200 pl-5 dark:border-gray-800" : "hidden"}>
              {history.data?.events.map((ev) => (
                <li key={ev.id} className="relative">
                  <span className="absolute top-1.5 -left-[25px] size-2.5 rounded-full border-2 border-white bg-brand-500 dark:border-gray-900" aria-hidden="true" />
                  <p className="flex flex-wrap items-center gap-2 text-theme-sm text-gray-800 dark:text-white/90">
                    <Badge>{ev.action}</Badge> rev {ev.revision} by {ev.actor_id}
                  </p>
                  <p className="text-theme-xs text-gray-500 dark:text-gray-400">
                    <Time iso={ev.at} />
                  </p>
                </li>
              ))}
            </ol>
            <dl className="mt-5 space-y-1 border-t border-gray-100 pt-4 text-theme-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
              <div>
                <dt className="inline">Stored revisions: </dt>
                <dd className="inline">{history.data?.revisions.join(", ")}</dd>
              </div>
              <div>
                <dt className="inline">File: </dt>
                <dd className="inline break-all">
                  <code>{ent.storage_path}</code>
                </dd>
              </div>
            </dl>
          </Card>
        </div>
      </div>
    </>
  );
}

const TAB_LABEL: Record<string, string> = {
  requirement: "Requirements",
  decision: "Decisions",
  conflict: "Conflicts",
  open_question: "Open questions",
  change_proposal: "Proposals",
};

function tabFor(t: string) {
  return { requirement: "requirements", decision: "decisions", conflict: "conflicts", open_question: "questions", change_proposal: "proposals" }[t] ?? "overview";
}

const ENTITY_ID = /^(REQ|DEC|QUESTION|CONFLICT|CHANGE)-\d{3,6}$/;

function FieldValue({ pid, value }: { pid: string; value: unknown }) {
  const items = Array.isArray(value) ? value.map(String) : [String(value)];
  return (
    <>
      {items.map((v, i) => (
        <span key={v + i}>
          {i > 0 && ", "}
          {ENTITY_ID.test(v) ? <A href={`/projects/${pid}/entities/${v}`} className="font-mono">{v}</A> : v}
        </span>
      ))}
    </>
  );
}

function Fields({ ent }: { ent: KnowledgeEntity }) {
  const entries = Object.entries(ent.fields).filter(([, v]) => v !== null && !(Array.isArray(v) && v.length === 0) && v !== "");
  if (!entries.length) return null;
  return (
    <dl className="mb-6 grid grid-cols-1 gap-x-6 gap-y-4 rounded-xl bg-gray-50 p-4 sm:grid-cols-2 lg:grid-cols-3 dark:bg-white/[0.02]">
      {entries.map(([k, v]) => (
        <div key={k}>
          <dt className="mb-1 text-theme-xs text-gray-500 capitalize dark:text-gray-400">{k.replace(/_/g, " ")}</dt>
          <dd className="text-theme-sm font-medium text-gray-800 dark:text-white/90">
            <FieldValue pid={ent.project_id} value={v} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Sections({ ent }: { ent: KnowledgeEntity }) {
  return (
    <div className="space-y-5">
      {Object.entries(ent.sections).map(([k, v]) => {
        if (v === "" || (Array.isArray(v) && v.length === 0)) return null;
        return (
          <section key={k}>
            <h3 className="mb-2 text-theme-sm font-semibold text-gray-800 dark:text-white/90">{k === "_extra" ? "Other notes (from manual edits)" : k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}</h3>
            {typeof v === "string" ? (
              <Markdown text={v} />
            ) : (
              <ul className="list-disc space-y-2 pl-5 text-theme-sm text-gray-700 dark:text-gray-300">
                {(v as Array<string | Statement>).map((s, i) => {
                  const add = typeof s === "string" && k === "proposed_additions" ? parseAddition(s) : null;
                  if (add)
                    return (
                      <li key={i}>
                        <span className="text-theme-xs font-medium text-green-700 dark:text-green-400">+ {add.section}</span> {add.text}{" "}
                        <Badge tone={add.basis === "AI-inferred" ? "primary" : "gray"}>{add.basis}</Badge>
                      </li>
                    );
                  return typeof s === "string" ? <li key={i}>{s}</li> : (
                    <li key={i}>
                      {s.text}{" "}
                      {s.basis === "ai_inferred" && <Badge tone="primary">AI-inferred</Badge>}{" "}
                      {s.basis === "source_stated" && <Badge tone="gray">source-stated</Badge>}{" "}
                      {s.basis === "human_authored" && <Badge tone="success">human-authored</Badge>}{" "}
                      {s.review_state === "proposed" && <Badge tone="warning">proposed, not reviewed</Badge>}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** Status changes not covered by the review buttons (e.g. back to draft, supersede, reopen). */
function Review({ pid, ent, onDone, onError }: { pid: string; ent: KnowledgeEntity; onDone: () => void; onError: (e: ApiError) => void }) {
  const reviewTargets = ["approved", "rejected", "accepted", "dismissed", "withdrawn"];
  const options = (NEXT[ent.entity_type]?.[ent.status] ?? []).filter((o) => !reviewTargets.includes(o));
  const [to, setTo] = useState(options[0] ?? "");
  const [confirm, setConfirm] = useState("");
  const [note, setNote] = useState("");
  if (!options.length) return null;
  const verb = VERB[to];
  const phrase = verb ? `${verb} ${ent.human_id}` : "";
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await post(`/projects/${pid}/entities/${ent.human_id}/transition`, { to, expected_revision: ent.revision, confirmation: verb ? confirm : undefined, note: note || undefined });
      setConfirm("");
      onDone();
    } catch (err) {
      onError(err as ApiError);
    }
  };
  return (
    <Card title="Other status changes">
      {options.length > 0 && (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Change status to">{(id) => (
            <Select id={id} value={to} onChange={(e) => { setTo(e.target.value); setConfirm(""); }}>
              {options.map((o) => <option key={o} value={o}>{o.replace("_", " ")}</option>)}
            </Select>
          )}</Field>
          {verb && <ConfirmPhrase phrase={phrase} value={confirm} onChange={setConfirm} />}
          <Field label="Note (optional)">{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
          {to === "approved" && <p className="text-theme-xs text-gray-500 dark:text-gray-400">Approval is recorded for revision {ent.revision} and this exact content. Any later edit needs a new approval.</p>}
          <Button type="submit" variant={to === "rejected" ? "danger" : "primary"} disabled={!!verb && confirm.trim().toLowerCase() !== phrase.toLowerCase()}>Apply</Button>
        </form>
      )}
    </Card>
  );
}

function ResolveConflict({ pid, ent, onDone, onError }: { pid: string; ent: KnowledgeEntity; onDone: () => void; onError: (e: ApiError) => void }) {
  const sides = (ent.sections.sides as string[]) ?? [];
  const [selected, setSelected] = useState("");
  const [rationale, setRationale] = useState("");
  const [question, setQuestion] = useState(`What is the correct rule for: ${ent.title}?`);
  const [confirm, setConfirm] = useState("");
  const phrase = `resolve ${ent.human_id}`;
  return (
    <Card title="Resolve with a decision">
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault();
        try {
          await post(`/projects/${pid}/conflicts/${ent.human_id}/resolve`, { expected_revision: ent.revision, question, selected, rationale, options: sides, confirmation: confirm });
          onDone();
        } catch (err) {
          onError(err as ApiError);
        }
      }}>
        <Field label="Decision question">{(id) => <Input id={id} value={question} onChange={(e) => setQuestion(e.target.value)} required />}</Field>
        <Field label="Selected outcome" hint="Your decision as the business owner. Not inferred from the sources.">{(id) => <Textarea id={id} rows={2} value={selected} onChange={(e) => setSelected(e.target.value)} required />}</Field>
        <Field label="Rationale">{(id) => <Textarea id={id} rows={2} value={rationale} onChange={(e) => setRationale(e.target.value)} required minLength={3} />}</Field>
        <ConfirmPhrase phrase={phrase} value={confirm} onChange={setConfirm} />
        <Button type="submit" disabled={confirm.trim().toLowerCase() !== phrase.toLowerCase()}>Record approved decision</Button>
      </form>
    </Card>
  );
}

function AnswerQuestion({ pid, ent, onDone, onError }: { pid: string; ent: KnowledgeEntity; onDone: () => void; onError: (e: ApiError) => void }) {
  const [resolution, setResolution] = useState("");
  const [confirm, setConfirm] = useState("");
  const phrase = `answer ${ent.human_id}`;
  return (
    <Card title="Record the answer">
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault();
        try {
          await post(`/projects/${pid}/questions/${ent.human_id}/answer`, { expected_revision: ent.revision, resolution, confirmation: confirm });
          onDone();
        } catch (err) {
          onError(err as ApiError);
        }
      }}>
        <Field label="Answer" hint="Record what the client or you decided.">{(id) => <Textarea id={id} rows={3} value={resolution} onChange={(e) => setResolution(e.target.value)} required />}</Field>
        <ConfirmPhrase phrase={phrase} value={confirm} onChange={setConfirm} />
        <Button type="submit" disabled={confirm.trim().toLowerCase() !== phrase.toLowerCase()}>Save answer</Button>
      </form>
    </Card>
  );
}

function Diff({ pid, hid, revisions }: { pid: string; hid: string; revisions: number[] }) {
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const [lines, setLines] = useState<{ op: string; text: string }[] | null>(null);
  if (revisions.length < 2) return null;
  const f = from ?? revisions[revisions.length - 2]!;
  const t = to ?? revisions[revisions.length - 1]!;
  return (
    <Card title="Revision diff" actions={
      <div className="flex items-end gap-3">
        <Field label="From">{(id) => <Select id={id} value={f} onChange={(e) => setFrom(Number(e.target.value))}>{revisions.map((r) => <option key={r}>{r}</option>)}</Select>}</Field>
        <Field label="To">{(id) => <Select id={id} value={t} onChange={(e) => setTo(Number(e.target.value))}>{revisions.map((r) => <option key={r}>{r}</option>)}</Select>}</Field>
        <Button variant="secondary" onClick={async () => setLines((await get<{ lines: { op: string; text: string }[] }>(`/projects/${pid}/entities/${hid}/diff?from=${f}&to=${t}`)).lines)}>Compare</Button>
      </div>
    }>
      {lines && (
        <pre className="custom-scrollbar max-h-96 overflow-auto rounded-xl border border-gray-200 bg-gray-50 p-3 text-theme-xs dark:border-gray-800 dark:bg-white/[0.02]">
          {lines.filter((l, i, a) => l.op !== " " || a[i - 1]?.op !== " " || a[i + 1]?.op !== " ").map((l, i) => (
            <div key={i} className={l.op === "+" ? "bg-green-50 text-green-700 dark:bg-green-500/15 dark:text-green-400" : l.op === "-" ? "bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-400" : "text-gray-500"}>
              {l.op} {l.text}
            </div>
          ))}
        </pre>
      )}
    </Card>
  );
}
