"use client";

/*
 * Shared UI primitives styled after TailAdmin (MIT, Copyright (c) TailAdmin): rounded-2xl bordered cards,
 * brand-500 primary buttons, light badges, h-11 inputs with brand focus rings, and gray-50 table headers.
 */
import Link from "next/link";
import type {
  ButtonHTMLAttributes,
  ComponentPropsWithRef,
  CSSProperties,
  InputHTMLAttributes,
  KeyboardEvent,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import type { ApiError } from "@/lib/api";
import { AlertIcon, ChevronRightIcon } from "./icons";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "danger" | "danger-ghost" | "ghost";
type Size = "sm" | "md";

const BTN: Record<Variant, string> = {
  primary: "bg-brand-500 text-white shadow-theme-xs hover:bg-brand-600 disabled:bg-brand-300 dark:disabled:bg-brand-800 dark:disabled:text-brand-400",
  secondary:
    "bg-white text-gray-700 ring-1 ring-inset ring-gray-300 shadow-theme-xs hover:bg-gray-50 hover:text-gray-800 disabled:text-gray-400 dark:bg-gray-800 dark:text-gray-300 dark:ring-gray-700 dark:hover:bg-white/[0.06] dark:hover:text-white dark:disabled:text-gray-500",
  danger: "bg-red-500 text-white shadow-theme-xs hover:bg-red-600 disabled:bg-red-300 dark:disabled:bg-red-950 dark:disabled:text-red-400",
  "danger-ghost":
    "text-red-600 hover:bg-red-50 hover:text-red-700 disabled:text-gray-400 dark:text-red-400 dark:hover:bg-red-500/15 dark:hover:text-red-300 dark:disabled:text-gray-500",
  ghost:
    "text-brand-500 hover:bg-brand-50 hover:text-brand-600 disabled:text-gray-400 dark:text-brand-400 dark:hover:bg-brand-500/[0.12] dark:disabled:text-gray-500",
};

/** Button styling, also used for links that look like buttons (downloads, "Edit" links), so both share one look and focus ring. */
export function buttonClass(variant: Variant = "primary", size: Size = "md", className?: string) {
  return cx(
    "inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-colors select-none disabled:cursor-not-allowed aria-disabled:pointer-events-none [&_svg]:size-4",
    size === "sm" ? "h-8 px-3 text-theme-xs" : "h-10 px-4 text-theme-sm",
    BTN[variant],
    className,
  );
}

export function Button({ variant = "primary", size = "md", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return <button type="button" {...p} className={buttonClass(variant, size, className)} />;
}

export function Card({
  title,
  desc,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  desc?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  const hasHeader = !!(title || actions);
  return (
    <section className={cx("rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-white/[0.03]", className)}>
      {hasHeader && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 sm:px-6">
          <div className="min-w-0">
            {title && <h2 className="text-base font-medium text-gray-800 dark:text-white/90">{title}</h2>}
            {desc && <p className="mt-0.5 text-theme-sm text-gray-500 dark:text-gray-400">{desc}</p>}
          </div>
          {actions}
        </div>
      )}
      <div className={cx(hasHeader && "border-t border-gray-100 dark:border-gray-800", "p-5 sm:p-6", bodyClassName)}>{children}</div>
    </section>
  );
}

type Tone = "success" | "warning" | "error" | "info" | "primary" | "gray" | "orange";
// Light-mode text is one step darker than TailAdmin's defaults so every badge reaches 4.5:1 on its tint (measured).
const TONE_CLASS: Record<Tone, string> = {
  success: "bg-green-50 text-green-700 dark:bg-green-500/15 dark:text-green-400",
  warning: "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-orange-400",
  error: "bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-400",
  info: "bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-400",
  primary: "bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-400",
  gray: "bg-gray-100 text-gray-700 dark:bg-white/5 dark:text-white/80",
  orange: "bg-orange-50 text-orange-700 dark:bg-orange-500/15 dark:text-orange-400",
};

/** Status words map onto TailAdmin's badge colours. Unknown words render grey. */
const STATUS_TONE: Record<string, Tone> = {
  approved: "success",
  answered: "success",
  succeeded: "success",
  resolved: "success",
  ok: "success",
  accepted: "success",
  draft: "warning",
  open: "orange",
  needs_clarification: "warning",
  in_review: "info",
  partially_answered: "info",
  partially_succeeded: "info",
  running: "primary",
  queued: "primary",
  pending: "primary",
  retrying: "primary",
  failed: "error",
  rejected: "error",
  conflicting_sources: "error",
  superseded: "gray",
  cancelled: "gray",
  dismissed: "gray",
  withdrawn: "gray",
  stale: "gray",
  unsupported: "gray",
  insufficient_evidence: "gray",
  needs_ocr: "orange",
  demo: "primary",
};

export function Badge({ children, tone }: { children: ReactNode; tone?: string }) {
  const text = typeof children === "string" ? children : null;
  const t: Tone = (tone && (tone in TONE_CLASS ? (tone as Tone) : STATUS_TONE[tone])) || (text ? STATUS_TONE[text] : undefined) || "gray";
  return (
    <span className={cx("inline-flex w-fit shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-theme-xs font-medium whitespace-nowrap", TONE_CLASS[t])}>
      {text !== null ? text.replace(/_/g, " ") : children}
    </span>
  );
}

/** Ids of the hint and error under the current Field, so its control can point at them with aria-describedby. */
const FieldCtx = createContext<{ describedBy?: string; invalid: boolean } | null>(null);

/**
 * Label + control + hint + error. The control is linked to the label (htmlFor) and, through context, to the hint
 * and error text (aria-describedby), so screen readers announce the help text, not just the placeholder.
 */
export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-theme-sm font-medium text-gray-700 dark:text-gray-300">
        {label}
        {required && (
          <span className="ml-0.5 text-red-600 dark:text-red-400" aria-hidden="true">
            *
          </span>
        )}
      </label>
      <FieldCtx.Provider value={{ describedBy, invalid: !!error }}>{children(id)}</FieldCtx.Provider>
      {hint && (
        <p id={hintId} className="text-theme-xs text-gray-500 dark:text-gray-400">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="flex items-center gap-1.5 text-theme-xs font-medium text-red-700 dark:text-red-400">
          <AlertIcon className="size-4 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}

/** aria-describedby / aria-invalid from the surrounding Field, merged with anything the caller passed. */
function useFieldAria(p: { "aria-describedby"?: string; "aria-invalid"?: InputHTMLAttributes<HTMLInputElement>["aria-invalid"] }) {
  const f = useContext(FieldCtx);
  const describedBy = [p["aria-describedby"], f?.describedBy].filter(Boolean).join(" ") || undefined;
  return { "aria-describedby": describedBy, "aria-invalid": p["aria-invalid"] ?? (f?.invalid ? true : undefined) };
}

const inputCls =
  "w-full min-w-0 rounded-lg border border-gray-300 bg-transparent px-4 text-theme-sm text-gray-800 shadow-theme-xs placeholder:text-gray-500 focus:border-brand-500 focus:ring-3 focus:ring-brand-500/20 focus:outline-hidden aria-invalid:border-red-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white/90 dark:placeholder:text-gray-400 dark:focus:border-brand-400 dark:aria-invalid:border-red-400";
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} {...useFieldAria(p)} className={cx(inputCls, "h-11 py-2.5", p.className)} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea {...p} {...useFieldAria(p)} className={cx(inputCls, "py-2.5", p.className)} />
);
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...p} {...useFieldAria(p)} className={cx(inputCls, "h-11 py-2.5 pr-10 dark:bg-gray-900", p.className)} />
);

/** Native checkbox at a comfortable size in the brand colour. Wrap it in a <label> with its text. */
export const Checkbox = ({ className, ...p }: Omit<ComponentPropsWithRef<"input">, "type">) => (
  <input type="checkbox" {...p} className={cx("size-4 shrink-0 cursor-pointer rounded accent-brand-500 disabled:cursor-not-allowed", className)} />
);

export function ErrorBanner({ error }: { error: ApiError | Error | null | undefined }) {
  if (!error) return null;
  const e = error as ApiError;
  return (
    <div role="alert" className="flex gap-3 rounded-xl border border-red-500 bg-red-50 p-4 dark:border-red-500/30 dark:bg-red-500/15">
      <AlertIcon className="mt-0.5 size-5 shrink-0 text-red-500" />
      <div className="min-w-0 text-theme-sm">
        <p className="font-semibold text-gray-800 dark:text-white/90">{e.code ? `${e.code.replace(/_/g, " ")}` : "Error"}</p>
        <p className="text-gray-600 dark:text-gray-300">{e.message}</p>
        {Array.isArray(e.details) && (
          <ul className="mt-1 list-disc pl-5 text-theme-xs text-gray-600 dark:text-gray-300">
            {(e.details as { path?: string; message?: string }[]).slice(0, 5).map((d, i) => (
              <li key={i}>
                {d.path ? `${d.path}: ` : ""}
                {d.message ?? JSON.stringify(d)}
              </li>
            ))}
          </ul>
        )}
        {e.correlationId && <p className="mt-1 text-theme-xs text-gray-500 dark:text-gray-400">Reference: {e.correlationId}</p>}
      </div>
    </div>
  );
}

/** Informational banner (TailAdmin alert styles). */
export function Notice({ tone = "info", title, children }: { tone?: "info" | "warning" | "success"; title?: string; children: ReactNode }) {
  const c = {
    info: "border-sky-500 bg-sky-50 dark:border-sky-500/30 dark:bg-sky-500/15",
    warning: "border-amber-500 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/15",
    success: "border-green-500 bg-green-50 dark:border-green-500/30 dark:bg-green-500/15",
  }[tone];
  return (
    <div className={cx("rounded-xl border p-4 text-theme-sm text-gray-600 dark:text-gray-300", c)}>
      {title && <p className="mb-1 font-semibold text-gray-800 dark:text-white/90">{title}</p>}
      {children}
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <p role="status" className="flex items-center gap-2 text-theme-sm text-gray-500 dark:text-gray-400">
      <span className="size-4 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" aria-hidden="true" />
      {label}…
    </p>
  );
}

// =====================================================================================================================
// Skeleton loaders: each one has the shape of the content it stands in for, so the page does not jump when data arrives.
// =====================================================================================================================

/** One shimmering block. Decorative: the surrounding skeleton announces "Loading" once for screen readers. */
export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <span aria-hidden="true" style={style} className={cx("block animate-pulse rounded-md bg-gray-200 dark:bg-gray-800", className)} />;
}

function SkeletonFrame({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={`Loading ${label}`} className={className}>
      <span className="sr-only">Loading {label}…</span>
      {children}
    </div>
  );
}

const WIDTHS = ["w-11/12", "w-4/5", "w-2/3", "w-3/4", "w-1/2", "w-5/6"];

/** Paragraph lines. */
export function SkeletonText({ lines = 3, label = "content", className }: { lines?: number; label?: string; className?: string }) {
  return (
    <SkeletonFrame label={label} className={cx("space-y-2.5", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cx("h-3.5", WIDTHS[i % WIDTHS.length])} />
      ))}
    </SkeletonFrame>
  );
}

/** A table with header and rows, in the same frame as `table.wrap`. */
export function TableSkeleton({ rows = 5, cols = 4, label = "table" }: { rows?: number; cols?: number; label?: string }) {
  return (
    <SkeletonFrame label={label} className="overflow-hidden rounded-xl border border-gray-200 dark:border-gray-800">
      <div className="flex gap-6 border-b border-gray-100 bg-gray-50 px-4 py-3.5 dark:border-gray-800 dark:bg-white/[0.02]">
        {Array.from({ length: cols }, (_, c) => (
          <Skeleton key={c} className={cx("h-3", c === 0 ? "w-24" : c === 1 ? "flex-1" : "w-16")} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex items-center gap-6 border-b border-gray-100 px-4 py-4 last:border-b-0 dark:border-gray-800">
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} className={cx("h-3.5", c === 0 ? "w-24" : c === 1 ? cx("flex-1", r % 2 ? "max-w-md" : "max-w-lg") : "w-16")} />
          ))}
        </div>
      ))}
    </SkeletonFrame>
  );
}

/** A vertical list of rows (badge + text + meta). */
export function ListSkeleton({ rows = 4, label = "list", boxed = false }: { rows?: number; label?: string; boxed?: boolean }) {
  return (
    <SkeletonFrame label={label} className={boxed ? "space-y-3" : "divide-y divide-gray-100 dark:divide-gray-800"}>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className={cx("flex items-center gap-3", boxed ? "rounded-xl border border-gray-200 p-3 dark:border-gray-800" : "py-3 first:pt-0 last:pb-0")}
        >
          <Skeleton className="h-5 w-14 rounded-full" />
          <Skeleton className={cx("h-3.5 flex-1", i % 2 ? "max-w-xs" : "max-w-sm")} />
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </SkeletonFrame>
  );
}

/** A card with a title, a description line and body lines. */
export function CardSkeleton({ lines = 3, label = "section", children }: { lines?: number; label?: string; children?: ReactNode }) {
  return (
    <section className="rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-white/[0.03]">
      <SkeletonFrame label={label}>
        <div className="space-y-2 px-5 py-4 sm:px-6">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-72 max-w-full" />
        </div>
        <div className="space-y-2.5 border-t border-gray-100 p-5 sm:p-6 dark:border-gray-800">
          {children ?? Array.from({ length: lines }, (_, i) => <Skeleton key={i} className={cx("h-3.5", WIDTHS[i % WIDTHS.length])} />)}
        </div>
      </SkeletonFrame>
    </section>
  );
}

/** Metric tiles (StatCard layout). */
export function StatsSkeleton({ count = 4, label = "metrics" }: { count?: number; label?: string }) {
  return (
    <SkeletonFrame label={label} className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:gap-6 xl:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-2xl border border-gray-200 bg-white p-5 md:p-6 dark:border-gray-800 dark:bg-white/[0.03]">
          <Skeleton className="size-12 rounded-xl" />
          <Skeleton className="mt-5 h-3 w-24" />
          <Skeleton className="mt-3 h-6 w-16" />
        </div>
      ))}
    </SkeletonFrame>
  );
}

/** A page: title, a row of tabs and two cards. Used while a page's main record loads. */
export function PageSkeleton({ label = "page", tabs = 0 }: { label?: string; tabs?: number }) {
  return (
    <SkeletonFrame label={label} className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-4 w-36" />
        </div>
        <Skeleton className="h-4 w-48" />
      </div>
      {tabs > 0 && (
        <div className="flex gap-2 rounded-xl bg-gray-100 p-1 dark:bg-white/[0.04]">
          {Array.from({ length: tabs }, (_, i) => (
            <Skeleton key={i} className="h-8 w-20 rounded-lg" />
          ))}
        </div>
      )}
      <CardSkeleton lines={4} />
      <CardSkeleton lines={3} />
    </SkeletonFrame>
  );
}

// =====================================================================================================================
// Pagination (client side: the API returns the list, the page shows one slice of it)
// =====================================================================================================================

export const PAGE_SIZES = [10, 20, 50, 100] as const;

/**
 * Paginate an array. The page resets to 1 when `resetKey` changes (a filter or tab) and is clamped when the list
 * shrinks (an item was deleted on the last page).
 */
export function usePaged<T>(items: readonly T[] | null | undefined, initialSize = 20, resetKey: unknown = null) {
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(initialSize);
  const [key, setKey] = useState(resetKey);
  if (key !== resetKey) {
    setKey(resetKey);
    setPage(1);
  }
  const total = items?.length ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const current = Math.min(page, pageCount);
  const start = (current - 1) * size;
  return {
    items: (items ?? []).slice(start, start + size),
    page: current,
    pageCount,
    size,
    total,
    from: total ? start + 1 : 0,
    to: Math.min(start + size, total),
    setPage,
    setSize: (n: number) => {
      setSize(n);
      setPage(1);
    },
  };
}

type Paged = ReturnType<typeof usePaged>;

function pageList(page: number, count: number): (number | "…")[] {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1);
  const out: (number | "…")[] = [1];
  const lo = Math.max(2, page - 1);
  const hi = Math.min(count - 1, page + 1);
  if (lo > 2) out.push("…");
  for (let i = lo; i <= hi; i++) out.push(i);
  if (hi < count - 1) out.push("…");
  out.push(count);
  return out;
}

/**
 * TailAdmin-style pagination bar: "Showing 21–40 of 113", previous/next, page numbers with gaps, rows per page.
 * Hidden when everything fits on one page at the smallest size.
 */
export function Pagination({
  paged,
  label,
  sizes = PAGE_SIZES,
  className,
}: {
  paged: Pick<Paged, "page" | "pageCount" | "size" | "total" | "from" | "to" | "setPage" | "setSize">;
  label: string;
  sizes?: readonly number[];
  className?: string;
}) {
  const { page, pageCount, size, total, from, to, setPage, setSize } = paged;
  const sizeId = useId();
  if (total <= Math.min(size, sizes[0] ?? size)) return null;
  const btn =
    "inline-flex h-9 min-w-9 items-center justify-center rounded-lg px-2.5 text-theme-sm font-medium tabular-nums ring-1 ring-inset ring-gray-300 text-gray-700 transition-colors hover:bg-gray-50 disabled:pointer-events-none disabled:opacity-40 dark:ring-gray-700 dark:text-gray-300 dark:hover:bg-white/[0.06] [&_svg]:size-4";
  return (
    <nav aria-label={`${label} pages`} className={cx("mt-4 flex flex-wrap items-center justify-between gap-3", className)}>
      <p className="text-theme-sm text-gray-500 tabular-nums dark:text-gray-400" aria-live="polite">
        Showing <span className="font-medium text-gray-800 dark:text-white/90">{from}</span>–
        <span className="font-medium text-gray-800 dark:text-white/90">{to}</span> of{" "}
        <span className="font-medium text-gray-800 dark:text-white/90">{total}</span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={sizeId} className="text-theme-xs text-gray-500 dark:text-gray-400">
          Per page
        </label>
        <select
          id={sizeId}
          value={size}
          onChange={(e) => setSize(Number(e.target.value))}
          className="h-9 cursor-pointer rounded-lg border border-gray-300 bg-transparent px-2 text-theme-sm text-gray-700 focus:border-brand-500 focus:ring-3 focus:ring-brand-500/20 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:focus:border-brand-400"
        >
          {sizes.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button type="button" className={btn} onClick={() => setPage(page - 1)} disabled={page <= 1} aria-label="Previous page">
          <ChevronRightIcon className="rotate-180" />
        </button>
        {pageList(page, pageCount).map((p, i) =>
          p === "…" ? (
            <span key={`gap${i}`} className="px-1 text-gray-500 dark:text-gray-400" aria-hidden="true">
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              onClick={() => setPage(p)}
              aria-current={p === page ? "page" : undefined}
              aria-label={`Page ${p}`}
              className={cx(
                btn,
                p === page && "bg-brand-500 text-white ring-brand-500 hover:bg-brand-600 dark:text-white dark:ring-brand-500 dark:hover:bg-brand-600",
              )}
            >
              {p}
            </button>
          ),
        )}
        <button type="button" className={btn} onClick={() => setPage(page + 1)} disabled={page >= pageCount} aria-label="Next page">
          <ChevronRightIcon />
        </button>
      </div>
    </nav>
  );
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-gray-300 px-6 py-10 text-center dark:border-gray-700">
      {icon && (
        <div className="mb-3 flex size-12 items-center justify-center rounded-xl bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 [&_svg]:size-6">
          {icon}
        </div>
      )}
      <p className="font-medium text-gray-800 dark:text-white/90">{title}</p>
      {children && <div className="mt-1 max-w-md text-theme-sm text-gray-500 dark:text-gray-400">{children}</div>}
    </div>
  );
}

export function A({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <Link href={href} className={cx("font-medium text-brand-500 underline-offset-2 hover:underline dark:text-brand-400", className)}>
      {children}
    </Link>
  );
}

export function Time({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <span>–</span>;
  const d = new Date(iso);
  // Times are shown in IST (Asia/Kolkata), 12-hour clock.
  const s = d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
  return <time dateTime={iso}>{s} IST</time>;
}

/**
 * Confirmation for consequential actions: the user must type the exact phrase (e.g. "approve REQ-001").
 * Mirrors the server-side check; the server enforces it regardless of the UI.
 */
export function ConfirmPhrase({ phrase, value, onChange }: { phrase: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={`Type "${phrase}" to confirm`}>
      {(id) => <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" spellCheck={false} />}
    </Field>
  );
}

/** Page title with TailAdmin-style breadcrumb. */
export function PageHeader({
  title,
  crumbs = [],
  actions,
  children,
}: {
  title: ReactNode;
  crumbs?: { label: string; href?: string }[];
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-title-sm font-semibold text-gray-800 sm:text-xl dark:text-white/90">{title}</h1>
        {children}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        {actions}
        <nav aria-label="Breadcrumb">
          <ol className="flex flex-wrap items-center gap-1.5 text-theme-sm">
            <li>
              <Link href="/" className="inline-flex items-center gap-1.5 text-gray-500 hover:text-brand-600 dark:text-gray-400 dark:hover:text-brand-400">
                Home
                <ChevronRightIcon className="size-4" />
              </Link>
            </li>
            {crumbs.map((c, i) => (
              <li key={i} className="inline-flex items-center gap-1.5">
                {c.href ? (
                  <Link href={c.href} className="[overflow-wrap:anywhere] text-gray-500 hover:text-brand-600 dark:text-gray-400 dark:hover:text-brand-400">
                    {c.label}
                  </Link>
                ) : (
                  <span aria-current={i === crumbs.length - 1 ? "page" : undefined} className="[overflow-wrap:anywhere] text-gray-800 dark:text-white/90">
                    {c.label}
                  </span>
                )}
                {i < crumbs.length - 1 && <ChevronRightIcon className="size-4 shrink-0 text-gray-500" />}
              </li>
            ))}
          </ol>
        </nav>
      </div>
    </div>
  );
}

/** Metric tile (TailAdmin "ecommerce metrics" layout). */
export function StatCard({ icon, label, value, href, footer }: { icon: ReactNode; label: string; value: ReactNode; href?: string; footer?: ReactNode }) {
  const body = (
    <>
      <div className="flex size-12 items-center justify-center rounded-xl bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-white/90 [&_svg]:size-6">
        {icon}
      </div>
      {/* Wraps instead of squeezing: a long label never pushes the badge into a second line inside itself. */}
      <div className="mt-5 flex flex-wrap items-end justify-between gap-x-2 gap-y-2">
        <div className="min-w-0">
          <span className="text-theme-sm text-gray-500 dark:text-gray-400">{label}</span>
          <p className="mt-2 text-title-sm font-bold text-gray-800 tabular-nums dark:text-white/90">{value}</p>
        </div>
        {footer}
      </div>
    </>
  );
  const cls = "block rounded-2xl border border-gray-200 bg-white p-5 md:p-6 dark:border-gray-800 dark:bg-white/[0.03]";
  return href ? (
    <Link href={href} className={cx(cls, "transition-[box-shadow,border-color] hover:border-gray-300 hover:shadow-theme-md dark:hover:border-gray-700")}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** Table styling helpers matching TailAdmin's basic tables. */
export const table = {
  wrap: "max-w-full overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800",
  table: "min-w-full text-left",
  thead: "border-b border-gray-100 bg-gray-50 dark:border-gray-800 dark:bg-white/[0.02]",
  th: "px-4 py-3 text-theme-xs font-medium whitespace-nowrap text-gray-500 dark:text-gray-400",
  tr: "border-b border-gray-100 last:border-b-0 dark:border-gray-800",
  td: "px-4 py-3 text-theme-sm text-gray-700 dark:text-gray-300",
};

/** Id of the tab button for `key`, so a tab panel can be labelled by its tab (`aria-labelledby`). */
export const tabId = (panelId: string, key: string) => `${panelId}-tab-${key}`;

/**
 * Pill tabs (TailAdmin tab group) following the WAI-ARIA tabs pattern: one tab in the Tab order, Arrow/Home/End
 * move focus between tabs, Enter/Space opens one (manual activation, since opening a tab loads data).
 * The strip wraps on tablet and desktop; on phones it scrolls sideways with the selected tab kept in view.
 */
export function Tabs({
  tabs,
  active,
  onChange,
  label,
  panelId,
}: {
  tabs: readonly (readonly [string, string])[];
  active: string;
  onChange: (key: string) => void;
  label: string;
  /** id of the element with role="tabpanel" that shows the active tab. */
  panelId?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Keep the selected tab visible in the sideways-scrolling strip (phones) without scrolling the page.
    const list = listRef.current;
    const btn = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (list && btn && list.scrollWidth > list.clientWidth) list.scrollLeft = btn.offsetLeft - list.clientWidth / 2 + btn.clientWidth / 2;
  }, [active]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const btns = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const next = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: btns.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    btns[(next + btns.length) % btns.length]?.focus();
  };
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="custom-scrollbar flex w-full gap-0.5 overflow-x-auto rounded-xl bg-gray-100 p-1 md:flex-wrap md:overflow-visible dark:bg-white/[0.04]"
    >
      {tabs.map(([key, text]) => {
        const selected = active === key;
        return (
          <button
            key={key}
            id={panelId ? tabId(panelId, key) : undefined}
            role="tab"
            type="button"
            aria-selected={selected}
            aria-controls={selected ? panelId : undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(key)}
            className={cx(
              "shrink-0 rounded-lg px-3 py-2 text-theme-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-offset-0",
              selected
                ? "bg-white text-gray-900 shadow-theme-xs dark:bg-white/[0.08] dark:text-white"
                : "text-gray-600 hover:bg-white/60 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/[0.04] dark:hover:text-gray-200",
            )}
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}
