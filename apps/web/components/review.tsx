"use client";

/*
 * Human review of knowledge that Jonathon's AI extraction proposed from uploaded documents.
 * Accept / Edit / Reject / Delete, each confirmed in a TailAdmin-style modal. The server still requires the exact
 * "<verb> <ID>" confirmation phrase and a human session; the modal sends it only after the user confirms.
 */
import { ENTITY_SPECS, type KnowledgeEntity, type Statement } from "@jonathon/contracts";
import Link from "next/link";
import { type FormEvent, type ReactNode, type SVGProps, useEffect, useId, useRef, useState } from "react";
import { type ApiError, api, post } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import {
  AlertIcon,
  CheckCircleIcon,
  ChecklistIcon,
  CloseIcon,
  InboxIcon,
  PencilIcon,
  ProposalIcon,
  QuestionIcon,
  SparkleIcon,
  TrashIcon,
  XCircleIcon,
} from "./icons";
import { A, Badge, Button, buttonClass, CardSkeleton, Checkbox, cx, Empty, ErrorBanner, Field, Input, Pagination, Skeleton, Textarea, usePaged } from "./ui";

type Ent = KnowledgeEntity;

/** Mirrors KnowledgeService.reviewVerbs: the phrase the server expects for each action. */
export function reviewVerbs(type: Ent["entity_type"]): { accept: string; reject: string } {
  if (type === "requirement" || type === "decision") return { accept: "approve", reject: "reject" };
  if (type === "conflict") return { accept: "accept", reject: "dismiss" };
  if (type === "open_question") return { accept: "accept", reject: "withdraw" };
  return { accept: "accept", reject: "reject" };
}

export const TYPE_LABEL: Record<string, string> = {
  requirement: "Requirement",
  decision: "Decision",
  conflict: "Conflict",
  open_question: "Open question",
  change_proposal: "Change proposal",
};

/** Is this item still waiting for a human decision? */
export function needsReview(e: Ent): boolean {
  if (e.entity_type === "requirement" || e.entity_type === "decision") return e.status === "draft" || e.status === "in_review";
  if (e.entity_type === "open_question" || e.entity_type === "conflict") return e.status === "open" && e.fields.reviewed !== true;
  return e.status === "open";
}

function statements(e: Ent): Statement[] {
  return Object.values(e.sections).flatMap((v) =>
    Array.isArray(v) ? (v as unknown[]).filter((s): s is Statement => typeof s === "object" && s !== null) : [],
  );
}

/** "[behavior · client-stated] text" → parts (see ENTITY_SPECS.change_proposal). */
export function parseAddition(line: string): { section: string; basis: string; text: string } | null {
  const m = /^\[([a-z_]+)\s*·\s*(client-stated|AI-inferred)\]\s+([\s\S]+)$/.exec(line.trim());
  return m ? { section: m[1]!.replace(/_/g, " "), basis: m[2]!, text: m[3]! } : null;
}

// ---------------------------------------------------------------- modal

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  tone = "default",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer: ReactNode;
  tone?: "default" | "danger";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    // Focus the marked button (Cancel for destructive actions, the confirm button otherwise), never the close icon.
    (ref.current?.querySelector<HTMLElement>("[data-autofocus]") ?? ref.current?.querySelector<HTMLElement>("button"))?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
      // Keep Tab inside the dialog (aria-modal alone does not stop keyboard focus reaching the page behind).
      if (e.key === "Tab" && ref.current) {
        const items = [...ref.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select, a[href]")];
        const first = items[0];
        const last = items[items.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && (document.activeElement === first || !ref.current.contains(document.activeElement))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || !ref.current.contains(document.activeElement))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      prev?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[99999] flex items-center justify-center overflow-y-auto p-4">
      <div className="fixed inset-0 bg-gray-400/50 backdrop-blur-[32px] dark:bg-black/60" onClick={onClose} aria-hidden="true" />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-3xl bg-white p-6 shadow-theme-xl sm:p-8 dark:bg-gray-900"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-4 right-4 flex size-10 items-center justify-center rounded-full bg-gray-100 text-gray-500 transition-colors hover:bg-gray-200 hover:text-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white"
        >
          <CloseIcon className="size-5" />
        </button>
        <div
          className={cx(
            "mb-4 flex size-12 items-center justify-center rounded-full",
            tone === "danger" ? "bg-red-50 text-red-500 dark:bg-red-500/15" : "bg-brand-50 text-brand-500 dark:bg-brand-500/15",
          )}
        >
          {tone === "danger" ? <AlertIcon className="size-6" /> : <CheckCircleIcon className="size-6" />}
        </div>
        <h2 id={titleId} className="mb-2 pr-10 text-xl font-semibold [overflow-wrap:anywhere] text-gray-800 dark:text-white/90">
          {title}
        </h2>
        <div className="text-theme-sm text-gray-600 dark:text-gray-300">{children}</div>
        <div className="mt-6 flex flex-wrap justify-end gap-3">{footer}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- actions

type Action = "accept" | "reject" | "delete";

function actionCopy(e: Ent, a: Action): { title: string; button: string; body: ReactNode; danger: boolean } {
  const s = statements(e);
  const proposed = s.filter((x) => x.review_state === "proposed").length;
  const inferred = s.filter((x) => x.basis === "ai_inferred").length;
  const id = <span className="font-mono font-medium text-gray-800 dark:text-white/90">{e.human_id}</span>;
  if (a === "delete") {
    return {
      title: `Delete ${e.human_id}?`,
      button: "Delete",
      danger: true,
      body: (
        <>
          <p>
            {id} will be removed from the knowledge base, search and Claude Code. Its earlier revisions stay in the project&apos;s history folder for audit, and
            the ID will not be reused.
          </p>
          {e.approval_valid && (
            <p className="mt-2 font-medium text-red-600 dark:text-red-400">
              It is currently approved. Answers and specifications that relied on it will be marked stale.
            </p>
          )}
          <p className="mt-2">This cannot be undone in Jonathon. To keep a record instead, use Reject.</p>
        </>
      ),
    };
  }
  if (a === "reject") {
    const verb = reviewVerbs(e.entity_type).reject;
    const word = { reject: "Reject", dismiss: "Dismiss", withdraw: "Withdraw" }[verb] ?? "Reject";
    return {
      title: `${word} ${e.human_id}?`,
      button: word,
      danger: true,
      body: (
        <p>
          {id} stays in the knowledge base with status <strong>{{ reject: "rejected", dismiss: "dismissed", withdraw: "withdrawn" }[verb]}</strong>, so you can
          see later that it was considered and turned down.
          {e.entity_type === "change_proposal" && " The requirement is not changed."}
        </p>
      ),
    };
  }
  switch (e.entity_type) {
    case "requirement":
    case "decision":
      return {
        title: `Approve ${e.human_id}?`,
        button: "Approve",
        danger: false,
        body: (
          <>
            <p>Approval is recorded under your name for revision {e.revision} and this exact content. Any later edit sends it back to review.</p>
            {proposed > 0 && (
              <p className="mt-2">
                This also marks {proposed} AI-proposed statement{proposed === 1 ? "" : "s"} as reviewed
                {inferred > 0 ? (
                  <>
                    , including <strong className="text-gray-800 dark:text-white/90">{inferred} the client did not state</strong> (AI-inferred). Edit or remove
                    those first if they are not right.
                  </>
                ) : (
                  "."
                )}
              </p>
            )}
          </>
        ),
      };
    case "change_proposal": {
      const structured = !!e.sections.proposed_description || ((e.sections.proposed_additions as string[]) ?? []).length > 0;
      return {
        title: `Accept ${e.human_id}?`,
        button: structured ? "Accept and apply" : "Accept",
        danger: false,
        body: structured ? (
          <p>
            The proposed changes are applied to <span className="font-mono">{String(e.fields.requirement_id)}</span> as a new revision. If that requirement was
            approved, it goes back to review and needs a new approval.
          </p>
        ) : (
          <p>The proposal is marked accepted. Its text is free-form, so edit {String(e.fields.requirement_id)} yourself to reflect it.</p>
        ),
      };
    }
    default:
      return {
        title: `Accept ${e.human_id}?`,
        button: "Accept",
        danger: false,
        body: (
          <p>
            Confirms this {e.entity_type === "conflict" ? "conflict is real" : "question needs an answer"}. It stays open until you{" "}
            {e.entity_type === "conflict" ? "resolve it with a decision" : "record the answer"}.
          </p>
        ),
      };
  }
}

export function useReviewAction(pid: string, onDone: (a: Action, e: Ent) => void) {
  const [pending, setPending] = useState<{ action: Action; ent: Ent } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const run = async () => {
    if (!pending) return;
    const { action, ent } = pending;
    const verb = action === "delete" ? "delete" : reviewVerbs(ent.entity_type)[action];
    const body = { expected_revision: ent.revision, confirmation: `${verb} ${ent.human_id}` };
    setBusy(true);
    setError(null);
    try {
      if (action === "delete") await api("DELETE", `/projects/${pid}/entities/${ent.human_id}`, body);
      else await post(`/projects/${pid}/entities/${ent.human_id}/${action}`, body);
      setPending(null);
      onDone(action, ent);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  const copy = pending ? actionCopy(pending.ent, pending.action) : null;
  const modal = (
    <Modal
      open={!!pending}
      onClose={() => {
        if (!busy) {
          setPending(null);
          setError(null);
        }
      }}
      title={copy?.title ?? ""}
      tone={copy?.danger ? "danger" : "default"}
      footer={
        <>
          <Button variant="secondary" onClick={() => setPending(null)} disabled={busy} data-autofocus={copy?.danger ? true : undefined}>
            Cancel
          </Button>
          <Button variant={copy?.danger ? "danger" : "primary"} onClick={run} disabled={busy} data-autofocus={copy?.danger ? undefined : true}>
            {busy ? "Working…" : copy?.button}
          </Button>
        </>
      }
    >
      {copy?.body}
      {error && (
        <div className="mt-4">
          <ErrorBanner error={error} />
        </div>
      )}
    </Modal>
  );
  return { ask: (action: Action, ent: Ent) => setPending({ action, ent }), modal };
}

/** Accept / Edit / Reject / Delete buttons for one item. */
/** onEdit: undefined → link to the entity editor; null → hide Edit (already editing). */
export function ReviewButtons({
  pid,
  ent,
  onAsk,
  onEdit,
  size = "md",
}: {
  pid: string;
  ent: Ent;
  onAsk: (a: Action, e: Ent) => void;
  onEdit?: (() => void) | null;
  size?: "sm" | "md";
}) {
  const open = needsReview(ent);
  const editable =
    onEdit !== null &&
    ent.entity_type !== "change_proposal" &&
    !["superseded", "rejected", "resolved", "accepted", "answered", "dismissed", "withdrawn"].includes(ent.status);
  const verbs = reviewVerbs(ent.entity_type);
  const acceptLabel = verbs.accept === "approve" ? "Approve" : ent.entity_type === "change_proposal" ? "Accept" : "Accept";
  const rejectLabel = { reject: "Reject", dismiss: "Dismiss", withdraw: "Withdraw" }[verbs.reject] ?? "Reject";
  return (
    <div className="flex flex-wrap gap-2">
      {open && (
        <Button size={size} onClick={() => onAsk("accept", ent)} aria-label={`${acceptLabel} ${ent.human_id}`}>
          <CheckCircleIcon />
          {acceptLabel}
        </Button>
      )}
      {editable &&
        (onEdit ? (
          <Button size={size} variant="secondary" onClick={onEdit} aria-label={`Edit ${ent.human_id}`}>
            <PencilIcon />
            Edit
          </Button>
        ) : (
          <Link href={`/projects/${pid}/entities/${ent.human_id}?edit=1`} aria-label={`Edit ${ent.human_id}`} className={buttonClass("secondary", size)}>
            <PencilIcon />
            Edit
          </Link>
        ))}
      {open && (
        <Button size={size} variant="secondary" onClick={() => onAsk("reject", ent)} aria-label={`${rejectLabel} ${ent.human_id}`}>
          <XCircleIcon />
          {rejectLabel}
        </Button>
      )}
      <Button size={size} variant="danger-ghost" onClick={() => onAsk("delete", ent)} aria-label={`Delete ${ent.human_id}`}>
        <TrashIcon />
        Delete
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- review queue

const GROUPS = [
  ["requirement", "Requirements", ChecklistIcon],
  ["conflict", "Conflicts", AlertIcon],
  ["open_question", "Open questions", QuestionIcon],
  ["change_proposal", "Change proposals", ProposalIcon],
] as const;

export function ReviewQueue({ pid, onChanged }: { pid: string; onChanged?: () => void }) {
  const list = useApi<Ent[]>(`/projects/${pid}/entities?type=requirement,decision,conflict,open_question,change_proposal`);
  const [filter, setFilter] = useState<string>("all");
  const [done, setDone] = useState<string | null>(null);
  const { ask, modal } = useReviewAction(pid, (action, ent) => {
    const word =
      action === "delete"
        ? "deleted"
        : action === "reject"
          ? { reject: "rejected", dismiss: "dismissed", withdraw: "withdrawn" }[reviewVerbs(ent.entity_type).reject]
          : reviewVerbs(ent.entity_type).accept === "approve"
            ? "approved"
            : "accepted";
    setDone(`${ent.human_id} ${word}.`);
    void list.reload();
    onChanged?.();
  });
  if (list.error) return <ErrorBanner error={list.error} />;
  if (!list.data)
    return (
      <div className="space-y-4 md:space-y-6">
        <Skeleton className="h-11 w-full max-w-xl rounded-xl" />
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <CardSkeleton key={i} lines={4} label="review items" />
          ))}
        </div>
      </div>
    );
  const items = list.data.filter(needsReview);
  const all = list.data;
  const reqById = new Map(all.filter((e) => e.entity_type === "requirement").map((e) => [e.human_id, e]));
  const groups = GROUPS.map(([type, label, Icon]) => ({
    type,
    label,
    Icon,
    items: items.filter((e) => e.entity_type === type || (type === "requirement" && e.entity_type === "decision")),
  }));
  const shown = groups.filter((g) => filter === "all" || g.type === filter);
  return (
    <div className="space-y-4 md:space-y-6">
      {modal}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="group"
          aria-label="Filter review items"
          className="no-scrollbar flex gap-0.5 overflow-x-auto rounded-xl bg-gray-100 p-1 dark:bg-white/[0.04]"
        >
          {[["all", "All", items.length] as const, ...groups.map((g) => [g.type, g.label, g.items.length] as const)].map(([key, label, n]) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
              className={cx(
                "flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-theme-sm font-medium transition-colors",
                filter === key
                  ? "bg-white text-gray-900 shadow-theme-xs dark:bg-white/[0.08] dark:text-white"
                  : "text-gray-600 hover:bg-white/60 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/[0.04] dark:hover:text-gray-200",
              )}
            >
              {label}
              <span
                className={cx(
                  "rounded-full px-2 py-0.5 text-theme-xs tabular-nums",
                  n ? "bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300" : "bg-gray-200 text-gray-600 dark:bg-white/5 dark:text-gray-400",
                )}
              >
                {n}
              </span>
            </button>
          ))}
        </div>
        <p className="text-theme-sm text-gray-500 dark:text-gray-400">
          Jonathon drafts these from your documents. Nothing counts as approved until you approve it.
        </p>
      </div>
      {done && (
        <p
          role="status"
          className="rounded-xl border border-green-500 bg-green-50 px-4 py-3 text-theme-sm text-gray-700 dark:border-green-500/30 dark:bg-green-500/15 dark:text-gray-300"
        >
          {done}
        </p>
      )}
      {items.length === 0 ? (
        <Empty title="Nothing to review" icon={<InboxIcon />}>
          When you upload documents with AI processing on, Jonathon proposes requirements, open questions, conflicts and changes to existing requirements here.
        </Empty>
      ) : (
        shown.map((g) => g.items.length > 0 && <ReviewGroup key={g.type} pid={pid} group={g} reqById={reqById} onAsk={ask} />)
      )}
    </div>
  );
}

/** One group of the review queue (requirements, conflicts ...), paginated on its own. */
function ReviewGroup({
  pid,
  group: g,
  reqById,
  onAsk,
}: {
  pid: string;
  group: { type: string; label: string; Icon: (p: SVGProps<SVGSVGElement>) => ReactNode; items: Ent[] };
  reqById: Map<string, Ent>;
  onAsk: (a: Action, e: Ent) => void;
}) {
  const paged = usePaged(g.items, 10);
  return (
    <section aria-labelledby={`grp-${g.type}`}>
      <h2 id={`grp-${g.type}`} className="mb-3 flex items-center gap-2 text-base font-medium text-gray-800 dark:text-white/90">
        <g.Icon className="size-5 text-gray-500 dark:text-gray-400" />
        {g.label}
        <span className="text-theme-sm font-normal text-gray-500 dark:text-gray-400">({g.items.length})</span>
      </h2>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {paged.items.map((e) => (
          <ReviewCard
            key={e.id}
            pid={pid}
            ent={e}
            target={e.entity_type === "change_proposal" ? reqById.get(String(e.fields.requirement_id)) : undefined}
            onAsk={onAsk}
          />
        ))}
      </div>
      <Pagination paged={paged} label={g.label} />
    </section>
  );
}

function Clamp({ children, lines = 4 }: { children: ReactNode; lines?: number }) {
  return (
    <div className="overflow-hidden" style={{ display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical" }}>
      {children}
    </div>
  );
}

function ReviewCard({ pid, ent, target, onAsk }: { pid: string; ent: Ent; target?: Ent; onAsk: (a: Action, e: Ent) => void }) {
  const st = statements(ent);
  const inferred = st.filter((s) => s.basis === "ai_inferred").length;
  const stated = st.filter((s) => s.basis === "source_stated").length;
  const ref = ent.source_refs[0];
  const text =
    ent.entity_type === "requirement"
      ? String(ent.sections.description ?? "")
      : ent.entity_type === "open_question"
        ? String(ent.sections.context ?? "")
        : ent.entity_type === "conflict"
          ? String(ent.sections.description ?? "")
          : ent.entity_type === "decision"
            ? String(ent.sections.question ?? "")
            : String(ent.sections.proposed_change ?? "");
  const additions = ((ent.sections.proposed_additions as string[]) ?? []).map(parseAddition).filter((a) => a !== null);
  return (
    <article className="flex flex-col rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-white/[0.03]">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <A href={`/projects/${pid}/entities/${ent.human_id}`} className="font-mono text-theme-sm">
          {ent.human_id}
        </A>
        <Badge>{ent.status}</Badge>
        {(ent.fields.origin === "ai_proposed" || ent.fields.origin === "demo_heuristic") && (
          <Badge tone="primary">
            <SparkleIcon className="size-3" />
            {ent.fields.origin === "demo_heuristic" ? "demo heuristic" : "AI-proposed"}
          </Badge>
        )}
        {ent.fields.blocking === true && <Badge tone="error">blocking</Badge>}
        {ent.stale && <Badge tone="gray">stale</Badge>}
      </div>
      <h3 className="mb-2 font-medium text-gray-800 dark:text-white/90">{ent.title}</h3>
      {text && (
        <div className="mb-3 text-theme-sm text-gray-600 dark:text-gray-300">
          <Clamp>{text}</Clamp>
        </div>
      )}
      {ent.entity_type === "conflict" && (
        <ul className="mb-3 space-y-1.5 text-theme-sm text-gray-700 dark:text-gray-300">
          {((ent.sections.sides as string[]) ?? []).map((s, i) => (
            <li key={i} className="rounded-lg bg-orange-50 px-3 py-2 dark:bg-orange-500/10">
              {s}
            </li>
          ))}
        </ul>
      )}
      {ent.entity_type === "change_proposal" && (
        <div className="mb-3 space-y-2 text-theme-sm">
          <p className="text-gray-500 dark:text-gray-400">
            Changes{" "}
            <A href={`/projects/${pid}/entities/${String(ent.fields.requirement_id)}`} className="font-mono">
              {String(ent.fields.requirement_id)}
            </A>
            {target ? ` · ${target.title}` : ""}
            {target?.approval_valid ? " (approved: accepting sends it back to review)" : ""}
          </p>
          {ent.sections.proposed_description ? (
            <div className="rounded-lg bg-gray-50 p-3 dark:bg-white/[0.03]">
              <p className="mb-1 text-theme-xs font-medium text-gray-500 uppercase dark:text-gray-400">New description</p>
              <Clamp lines={5}>{String(ent.sections.proposed_description)}</Clamp>
            </div>
          ) : null}
          {additions.length > 0 && (
            <ul className="space-y-1.5">
              {additions.map((a, i) => (
                <li
                  key={i}
                  className="flex flex-wrap items-baseline gap-2 rounded-lg bg-green-50 px-3 py-2 text-gray-700 dark:bg-green-500/10 dark:text-gray-300"
                >
                  <span className="text-theme-xs font-medium text-green-700 dark:text-green-400">+ {a.section}</span>
                  <span className="min-w-0 flex-1">{a.text}</span>
                  <Badge tone={a.basis === "AI-inferred" ? "primary" : "gray"}>{a.basis}</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {st.length > 0 && (
        <p className="mb-3 flex flex-wrap gap-2 text-theme-xs">
          <Badge tone="gray">{`${stated} client-stated`}</Badge>
          {inferred > 0 && <Badge tone="primary">{`${inferred} AI-inferred`}</Badge>}
        </p>
      )}
      {ref?.excerpt && (
        <blockquote className="mb-4 border-l-4 border-brand-200 pl-3 text-theme-xs text-gray-500 italic dark:border-brand-800 dark:text-gray-400">
          <Clamp lines={3}>{ref.excerpt}</Clamp>
          <Link
            href={`/projects/${pid}/sources/${ref.source_id}`}
            className="mt-1 inline-block font-medium not-italic text-brand-600 hover:underline dark:text-brand-400"
          >
            View source
          </Link>
        </blockquote>
      )}
      <div className="mt-auto border-t border-gray-100 pt-4 dark:border-gray-800">
        <ReviewButtons pid={pid} ent={ent} onAsk={onAsk} size="sm" />
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- structured editor

/** Fields a human edits. System fields (origin, reviewed, proposal bookkeeping, resolution links) stay server-managed. */
const HIDDEN_FIELDS = new Set(["origin", "reviewed", "resolution_decision", "resolves_conflict", "requirement_id", "base_revision", "proposed_by"]);
const HIDDEN_SECTIONS: Record<string, string[]> = { open_question: ["resolution"], conflict: ["resolution"] };
const label = (k: string) => (k === "_extra" ? "Other notes (from manual edits)" : k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()));

type EditState = { title: string; fields: Record<string, unknown>; sections: Record<string, unknown> };

export function EntityEditor({ pid, ent, onDone, onCancel }: { pid: string; ent: Ent; onDone: () => void; onCancel: () => void }) {
  const spec = ENTITY_SPECS[ent.entity_type];
  const [s, setS] = useState<EditState>(() => ({
    title: ent.title,
    fields: { ...ent.fields },
    sections: structuredClone(ent.sections) as Record<string, unknown>,
  }));
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const setField = (k: string, v: unknown) => setS((p) => ({ ...p, fields: { ...p.fields, [k]: v } }));
  const setSection = (k: string, v: unknown) => setS((p) => ({ ...p, sections: { ...p.sections, [k]: v } }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const sections: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s.sections)) {
        if (spec.sections[k] === "statements") sections[k] = (v as Statement[]).filter((x) => x.text.trim()).map((x) => ({ ...x, text: x.text.trim() }));
        else if (spec.sections[k] === "list") sections[k] = (v as string[]).map((x) => x.trim()).filter(Boolean);
        else sections[k] = v;
      }
      await api("PUT", `/projects/${pid}/entities/${ent.human_id}`, { title: s.title, fields: s.fields, sections, expected_revision: ent.revision });
      onDone();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-6">
      {ent.approval_valid && (
        <p className="rounded-xl border border-sky-500 bg-sky-50 p-4 text-theme-sm text-gray-600 dark:border-sky-500/30 dark:bg-sky-500/15 dark:text-gray-300">
          Saving creates revision {ent.revision + 1} in review. The approval stays with revision {ent.revision}; approve again when you are done.
        </p>
      )}
      <Field label="Title">
        {(id) => <Input id={id} value={s.title} onChange={(e) => setS({ ...s, title: e.target.value })} required minLength={3} maxLength={200} />}
      </Field>
      {Object.entries(spec.sections)
        .filter(([k]) => !(HIDDEN_SECTIONS[ent.entity_type] ?? []).includes(k))
        .map(([k, kind]) => {
          if (kind === "text")
            return (
              <Field key={k} label={label(k)}>
                {(id) => (
                  <Textarea
                    id={id}
                    rows={k === "description" || k === "question" ? 4 : 3}
                    value={String(s.sections[k] ?? "")}
                    onChange={(e) => setSection(k, e.target.value)}
                  />
                )}
              </Field>
            );
          if (kind === "list")
            return (
              <Field key={k} label={label(k)} hint="One per line.">
                {(id) => (
                  <Textarea
                    id={id}
                    rows={3}
                    value={((s.sections[k] as string[]) ?? []).join("\n")}
                    onChange={(e) => setSection(k, e.target.value.split("\n"))}
                  />
                )}
              </Field>
            );
          return <StatementsEditor key={k} name={label(k)} value={(s.sections[k] as Statement[]) ?? []} onChange={(v) => setSection(k, v)} />;
        })}
      {typeof s.sections._extra === "string" && (
        <Field label={label("_extra")}>
          {(id) => <Textarea id={id} rows={3} value={String(s.sections._extra)} onChange={(e) => setSection("_extra", e.target.value)} />}
        </Field>
      )}
      <fieldset className="grid grid-cols-1 gap-4 rounded-xl bg-gray-50 p-4 sm:grid-cols-2 dark:bg-white/[0.02]">
        <legend className="sr-only">Details</legend>
        {Object.entries(spec.fields)
          .filter(([k]) => !HIDDEN_FIELDS.has(k))
          .map(([k, kind]) => {
            if (kind === "boolean")
              return (
                <label key={k} className="flex cursor-pointer items-center gap-3 self-end pb-2 text-theme-sm text-gray-700 dark:text-gray-300">
                  <Checkbox checked={s.fields[k] === true} onChange={(e) => setField(k, e.target.checked)} className="size-5" />
                  {label(k)}
                </label>
              );
            if (kind === "string_list")
              return (
                <Field key={k} label={label(k)} hint="Comma-separated">
                  {(id) => (
                    <Input
                      id={id}
                      value={((s.fields[k] as string[]) ?? []).join(", ")}
                      onChange={(e) =>
                        setField(
                          k,
                          e.target.value
                            .split(",")
                            .map((x) => x.trim())
                            .filter(Boolean),
                        )
                      }
                    />
                  )}
                </Field>
              );
            return (
              <Field key={k} label={label(k)}>
                {(id) => <Input id={id} value={s.fields[k] == null ? "" : String(s.fields[k])} onChange={(e) => setField(k, e.target.value)} />}
              </Field>
            );
          })}
      </fieldset>
      <ErrorBanner error={error} />
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save new revision"}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

const BASIS: Record<string, { label: string; tone: string }> = {
  source_stated: { label: "client-stated", tone: "gray" },
  ai_inferred: { label: "AI-inferred", tone: "primary" },
  human_authored: { label: "yours", tone: "success" },
};

/** Statement list editor. Changing a statement's wording makes it yours (human-authored, reviewed). */
function StatementsEditor({ name, value, onChange }: { name: string; value: Statement[]; onChange: (v: Statement[]) => void }) {
  const set = (i: number, patch: Partial<Statement>) => onChange(value.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <fieldset>
      <legend className="mb-1.5 text-theme-sm font-medium text-gray-700 dark:text-gray-400">{name}</legend>
      <ul className="space-y-2">
        {value.map((st, i) => (
          <li key={i} className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <Textarea
                aria-label={`${name} ${i + 1}`}
                rows={2}
                value={st.text}
                onChange={(e) => set(i, { text: e.target.value, basis: "human_authored", review_state: "accepted" })}
              />
              <div className="mt-1 flex flex-wrap gap-1.5">
                <Badge tone={BASIS[st.basis]?.tone}>{BASIS[st.basis]?.label ?? st.basis}</Badge>
                {st.review_state === "proposed" ? (
                  <button
                    type="button"
                    onClick={() => set(i, { review_state: "accepted" })}
                    className="rounded-full bg-amber-50 px-2.5 py-0.5 text-theme-xs font-medium text-amber-700 hover:bg-amber-100 dark:bg-amber-500/15 dark:text-orange-400 dark:hover:bg-amber-500/25"
                  >
                    proposed · mark reviewed
                  </button>
                ) : (
                  <Badge tone="success">reviewed</Badge>
                )}
              </div>
            </div>
            <Button
              variant="danger-ghost"
              size="sm"
              className="mt-1"
              aria-label={`Remove ${name} ${i + 1}`}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              <TrashIcon />
            </Button>
          </li>
        ))}
      </ul>
      <Button variant="ghost" size="sm" className="mt-2" onClick={() => onChange([...value, { text: "", basis: "human_authored", review_state: "accepted" }])}>
        + Add {name.toLowerCase()}
      </Button>
    </fieldset>
  );
}
