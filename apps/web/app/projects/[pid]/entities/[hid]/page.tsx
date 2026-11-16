"use client";

import type { KnowledgeEntity, Statement } from "@jonathon/contracts";
import { useParams } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Markdown } from "@/components/markdown";
import { Shell } from "@/components/shell";
import { A, Badge, Button, Card, ConfirmPhrase, ErrorBanner, Field, Input, Loading, Select, Textarea, Time } from "@/components/ui";
import { type ApiError, api, get, post } from "@/lib/api";
import { useApi } from "@/lib/use-api";

export default function EntityPage() {
  return (
    <Shell>
      <EntityBody />
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
  const e = useApi<KnowledgeEntity>(`/projects/${pid}/entities/${hid}`);
  const history = useApi<{ revisions: number[]; events: Array<Record<string, any>> }>(`/projects/${pid}/entities/${hid}/history`);
  const [error, setError] = useState<ApiError | null>(null);
  const [editing, setEditing] = useState(false);
  const reload = () => {
    setError(null);
    void e.reload();
    void history.reload();
  };
  if (e.error) return <ErrorBanner error={e.error} />;
  if (!e.data) return <Loading />;
  const ent = e.data;
  const proposed = Object.values(ent.sections).flatMap((v) => (Array.isArray(v) ? (v as unknown[]).filter((s) => typeof s === "object" && (s as Statement).review_state === "proposed") : []));

  return (
    <div className="space-y-4">
      <p className="text-sm"><A href={`/projects/${pid}?tab=${tabFor(ent.entity_type)}`}>← Back</A></p>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold"><span className="font-mono">{ent.human_id}</span>: {ent.title}</h1>
        <Badge>{ent.status}</Badge>
        {ent.approval_valid && <Badge tone="approved">approved by {ent.approval?.approved_by}</Badge>}
        {ent.status === "approved" && !ent.approval_valid && <Badge tone="failed">approval not valid for this content</Badge>}
        {ent.fields.origin === "ai_proposed" && <Badge tone="pending">AI-proposed draft</Badge>}
        {ent.file_state !== "ok" && <Badge tone="failed">file {ent.file_state}</Badge>}
        {ent.stale && <Badge tone="needs_ocr">stale</Badge>}
      </div>
      <ErrorBanner error={error} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {editing ? (
            <EditForm pid={pid} ent={ent} onDone={() => { setEditing(false); reload(); }} onError={setError} />
          ) : (
            <Card title={`Revision ${ent.revision}`} actions={ent.entity_type !== "change_proposal" && !["superseded", "rejected", "resolved", "accepted"].includes(ent.status) && <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>}>
              {ent.approval_valid && <p className="mb-2 text-xs text-amber-800 dark:text-amber-300">Editing an approved item creates a new revision in review; the approval stays with revision {ent.revision}.</p>}
              <Fields ent={ent} />
              <Sections ent={ent} />
            </Card>
          )}
          <Card title="Source traceability">
            {ent.source_refs.length ? (
              <ul className="space-y-2 text-sm">
                {ent.source_refs.map((r, i) => (
                  <li key={i} className="rounded border border-slate-200 p-2 dark:border-slate-700">
                    {r.label && <Badge tone="open">{r.label}</Badge>} <A href={`/projects/${pid}/sources/${r.source_id}`}>Open source</A>
                    <span className="ml-2 text-xs text-slate-500">{Object.entries(r.locator).map(([k, v]) => `${k} ${v}`).join(", ")}</span>
                    {r.excerpt && <blockquote className="mt-1 whitespace-pre-wrap border-l-4 border-slate-300 pl-2 text-xs">{r.excerpt}</blockquote>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-500">No source references. Treat this as human-authored.</p>
            )}
          </Card>
          <Diff pid={pid} hid={hid} revisions={history.data?.revisions ?? []} />
        </div>
        <div className="space-y-4">
          <Review key={`review-${ent.revision}`} pid={pid} ent={ent} proposedCount={proposed.length} onDone={reload} onError={setError} />
          {ent.entity_type === "conflict" && ent.status === "open" && <ResolveConflict key={`resolve-${ent.revision}`} pid={pid} ent={ent} onDone={reload} onError={setError} />}
          {ent.entity_type === "open_question" && ent.status === "open" && <AnswerQuestion key={`answer-${ent.revision}`} pid={pid} ent={ent} onDone={reload} onError={setError} />}
          <Card title="History">
            <ul className="space-y-1 text-xs">
              {history.data?.events.map((ev) => (
                <li key={ev.id}><Badge>{ev.action}</Badge> rev {ev.revision} by {ev.actor_id} · <Time iso={ev.at} /></li>
              ))}
              <li className="text-slate-500">Stored revisions: {history.data?.revisions.join(", ")}</li>
              <li className="text-slate-500">File: <code>{ent.storage_path}</code></li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}

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
    <dl className="mb-3 grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1 text-sm">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-slate-500">{k.replace(/_/g, " ")}</dt>
          <dd><FieldValue pid={ent.project_id} value={v} /></dd>
        </div>
      ))}
    </dl>
  );
}

function Sections({ ent }: { ent: KnowledgeEntity }) {
  return (
    <div className="space-y-3">
      {Object.entries(ent.sections).map(([k, v]) => {
        if (v === "" || (Array.isArray(v) && v.length === 0)) return null;
        return (
          <section key={k}>
            <h3 className="text-sm font-semibold">{k === "_extra" ? "Other notes (from manual edits)" : k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}</h3>
            {typeof v === "string" ? (
              <Markdown text={v} />
            ) : (
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                {(v as Array<string | Statement>).map((s, i) =>
                  typeof s === "string" ? <li key={i}>{s}</li> : (
                    <li key={i}>
                      {s.text}{" "}
                      {s.basis === "ai_inferred" && <Badge tone="pending">AI-inferred</Badge>}{" "}
                      {s.basis === "source_stated" && <Badge tone="cancelled">source-stated</Badge>}{" "}
                      {s.review_state === "proposed" && <Badge tone="draft">proposed, not reviewed</Badge>}
                    </li>
                  ),
                )}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function Review({ pid, ent, proposedCount, onDone, onError }: { pid: string; ent: KnowledgeEntity; proposedCount: number; onDone: () => void; onError: (e: ApiError) => void }) {
  const options = NEXT[ent.entity_type]?.[ent.status] ?? [];
  const [to, setTo] = useState(options[0] ?? "");
  const [confirm, setConfirm] = useState("");
  const [note, setNote] = useState("");
  if (!options.length && (proposedCount === 0 || !["draft", "in_review"].includes(ent.status))) return null;
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
    <Card title="Review">
      {proposedCount > 0 && ["draft", "in_review"].includes(ent.status) && (
        <div className="mb-3 rounded-md bg-amber-50 p-2 text-sm dark:bg-amber-950">
          <p>{proposedCount} AI-proposed statement(s) are not reviewed. Edit or remove the ones you disagree with, then accept the rest. Approval is blocked until then.</p>
          <Button className="mt-2" variant="secondary" onClick={async () => {
            try {
              await post(`/projects/${pid}/entities/${ent.human_id}/accept-proposed`, { expected_revision: ent.revision });
              onDone();
            } catch (err) {
              onError(err as ApiError);
            }
          }}>I reviewed them: accept all</Button>
        </div>
      )}
      {options.length > 0 && (
        <form onSubmit={submit} className="space-y-2">
          <Field label="Change status to">{(id) => (
            <Select id={id} value={to} onChange={(e) => { setTo(e.target.value); setConfirm(""); }}>
              {options.map((o) => <option key={o} value={o}>{o.replace("_", " ")}</option>)}
            </Select>
          )}</Field>
          {verb && <ConfirmPhrase phrase={phrase} value={confirm} onChange={setConfirm} />}
          <Field label="Note (optional)">{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
          {to === "approved" && <p className="text-xs text-slate-500">Approval is recorded for revision {ent.revision} and this exact content. Any later edit needs a new approval.</p>}
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
      <form className="space-y-2" onSubmit={async (e) => {
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
      <form className="space-y-2" onSubmit={async (e) => {
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

function EditForm({ pid, ent, onDone, onError }: { pid: string; ent: KnowledgeEntity; onDone: () => void; onError: (e: ApiError) => void }) {
  const [title, setTitle] = useState(ent.title);
  const [json, setJson] = useState(JSON.stringify({ fields: ent.fields, sections: ent.sections }, null, 2));
  return (
    <Card title={`Edit (based on revision ${ent.revision})`}>
      <form className="space-y-2" onSubmit={async (e) => {
        e.preventDefault();
        try {
          const parsed = JSON.parse(json) as { fields: Record<string, unknown>; sections: Record<string, unknown> };
          await api("PUT", `/projects/${pid}/entities/${ent.human_id}`, { title, fields: parsed.fields, sections: parsed.sections, expected_revision: ent.revision });
          onDone();
        } catch (err) {
          onError(err instanceof SyntaxError ? ({ code: "VALIDATION_FAILED", message: `Invalid JSON: ${err.message}` } as ApiError) : (err as ApiError));
        }
      }}>
        <Field label="Title">{(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} required />}</Field>
        <Field label="Fields and sections (JSON)" hint='Statements: {"text", "basis": source_stated | ai_inferred | human_authored, "review_state": proposed | accepted}. You can also edit the Markdown file directly; run reconciliation afterwards.'>
          {(id) => <Textarea id={id} rows={18} value={json} onChange={(e) => setJson(e.target.value)} className="font-mono text-xs" />}
        </Field>
        <div className="flex gap-2"><Button type="submit">Save new revision</Button><Button variant="secondary" onClick={onDone}>Cancel</Button></div>
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
      <div className="flex items-end gap-2">
        <Field label="From">{(id) => <Select id={id} value={f} onChange={(e) => setFrom(Number(e.target.value))}>{revisions.map((r) => <option key={r}>{r}</option>)}</Select>}</Field>
        <Field label="To">{(id) => <Select id={id} value={t} onChange={(e) => setTo(Number(e.target.value))}>{revisions.map((r) => <option key={r}>{r}</option>)}</Select>}</Field>
        <Button variant="secondary" onClick={async () => setLines((await get<{ lines: { op: string; text: string }[] }>(`/projects/${pid}/entities/${hid}/diff?from=${f}&to=${t}`)).lines)}>Compare</Button>
      </div>
    }>
      {lines && (
        <pre className="max-h-96 overflow-auto text-xs">
          {lines.filter((l, i, a) => l.op !== " " || a[i - 1]?.op !== " " || a[i + 1]?.op !== " ").map((l, i) => (
            <div key={i} className={l.op === "+" ? "bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200" : l.op === "-" ? "bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-200" : "text-slate-500"}>
              {l.op} {l.text}
            </div>
          ))}
        </pre>
      )}
    </Card>
  );
}
