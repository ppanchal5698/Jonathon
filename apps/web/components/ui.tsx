"use client";

/*
 * Shared UI primitives styled after TailAdmin (MIT, Copyright (c) TailAdmin): rounded-2xl bordered cards,
 * brand-500 primary buttons, light badges, h-11 inputs with brand focus rings, and gray-50 table headers.
 */
import Link from "next/link";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { useId } from "react";
import type { ApiError } from "@/lib/api";
import { AlertIcon, ChevronRightIcon } from "./icons";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "danger" | "ghost";
type Size = "sm" | "md";

const BTN: Record<Variant, string> = {
  primary: "bg-brand-500 text-white shadow-theme-xs hover:bg-brand-600 disabled:bg-brand-300 dark:disabled:bg-brand-800 dark:disabled:text-brand-400",
  secondary:
    "bg-white text-gray-700 ring-1 ring-inset ring-gray-300 shadow-theme-xs hover:bg-gray-50 hover:text-gray-800 disabled:text-gray-300 dark:bg-gray-800 dark:text-gray-300 dark:ring-gray-700 dark:hover:bg-white/[0.06] dark:hover:text-white dark:disabled:text-gray-600",
  danger: "bg-red-500 text-white shadow-theme-xs hover:bg-red-600 disabled:bg-red-300 dark:disabled:bg-red-950 dark:disabled:text-red-400",
  ghost: "text-brand-500 hover:bg-brand-50 hover:text-brand-600 disabled:text-gray-300 dark:text-brand-400 dark:hover:bg-brand-500/[0.12] dark:disabled:text-gray-600",
};

export function Button({ variant = "primary", size = "md", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      type="button"
      {...p}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed [&_svg]:size-4",
        size === "sm" ? "h-8 px-3 text-theme-xs" : "h-10 px-4 text-theme-sm",
        BTN[variant],
        className,
      )}
    />
  );
}

export function Card({ title, desc, actions, children, className, bodyClassName }: { title?: ReactNode; desc?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
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
const TONE_CLASS: Record<Tone, string> = {
  success: "bg-green-50 text-green-600 dark:bg-green-500/15 dark:text-green-500",
  warning: "bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-orange-400",
  error: "bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-500",
  info: "bg-sky-50 text-sky-600 dark:bg-sky-500/15 dark:text-sky-400",
  primary: "bg-brand-50 text-brand-500 dark:bg-brand-500/15 dark:text-brand-400",
  gray: "bg-gray-100 text-gray-700 dark:bg-white/5 dark:text-white/80",
  orange: "bg-orange-50 text-orange-600 dark:bg-orange-500/15 dark:text-orange-400",
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

export function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-theme-sm font-medium text-gray-700 dark:text-gray-400">
        {label}
      </label>
      {children(id)}
      {hint && <p className="text-theme-xs text-gray-500 dark:text-gray-400">{hint}</p>}
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-gray-300 bg-transparent px-4 text-theme-sm text-gray-800 shadow-theme-xs placeholder:text-gray-400 focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white/90 dark:placeholder:text-white/30 dark:focus:border-brand-800";
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(inputCls, "h-11 py-2.5", p.className)} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={cx(inputCls, "py-2.5", p.className)} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cx(inputCls, "h-11 py-2.5 pr-10 dark:bg-gray-900", p.className)} />;

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
              <li key={i}>{d.path ? `${d.path}: ` : ""}{d.message ?? JSON.stringify(d)}</li>
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

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-gray-300 px-6 py-10 text-center dark:border-gray-700">
      {icon && <div className="mb-3 flex size-12 items-center justify-center rounded-xl bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 [&_svg]:size-6">{icon}</div>}
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
export function PageHeader({ title, crumbs = [], actions, children }: { title: ReactNode; crumbs?: { label: string; href?: string }[]; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-title-sm font-semibold text-gray-800 sm:text-xl dark:text-white/90">{title}</h1>
        {children}
      </div>
      <div className="flex items-center gap-3">
        {actions}
        <nav aria-label="Breadcrumb">
          <ol className="flex flex-wrap items-center gap-1.5 text-theme-sm">
            <li>
              <Link href="/" className="inline-flex items-center gap-1.5 text-gray-500 hover:text-brand-500 dark:text-gray-400">
                Home
                <ChevronRightIcon className="size-4" />
              </Link>
            </li>
            {crumbs.map((c, i) => (
              <li key={i} className="inline-flex items-center gap-1.5">
                {c.href ? (
                  <Link href={c.href} className="text-gray-500 hover:text-brand-500 dark:text-gray-400">
                    {c.label}
                  </Link>
                ) : (
                  <span className="text-gray-800 dark:text-white/90">{c.label}</span>
                )}
                {i < crumbs.length - 1 && <ChevronRightIcon className="size-4 text-gray-500" />}
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
      <div className="flex size-12 items-center justify-center rounded-xl bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-white/90 [&_svg]:size-6">{icon}</div>
      <div className="mt-5 flex items-end justify-between gap-2">
        <div>
          <span className="text-theme-sm text-gray-500 dark:text-gray-400">{label}</span>
          <p className="mt-2 text-title-sm font-bold text-gray-800 dark:text-white/90">{value}</p>
        </div>
        {footer}
      </div>
    </>
  );
  const cls = "block rounded-2xl border border-gray-200 bg-white p-5 md:p-6 dark:border-gray-800 dark:bg-white/[0.03]";
  return href ? (
    <Link href={href} className={cx(cls, "transition-shadow hover:shadow-theme-md")}>
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

/** Pill tabs (TailAdmin tab group). Buttons keep role="tab" for keyboard and screen-reader users. */
export function Tabs({ tabs, active, onChange, label }: { tabs: readonly (readonly [string, string])[]; active: string; onChange: (key: string) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="no-scrollbar flex w-full gap-0.5 overflow-x-auto rounded-xl bg-gray-100 p-1 dark:bg-white/[0.04]">
      {tabs.map(([key, text]) => (
        <button
          key={key}
          role="tab"
          type="button"
          aria-selected={active === key}
          onClick={() => onChange(key)}
          className={cx(
            "shrink-0 rounded-lg px-3 py-2 text-theme-sm font-medium transition-colors",
            active === key ? "bg-white text-gray-900 shadow-theme-xs dark:bg-white/[0.08] dark:text-white" : "text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200",
          )}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
