"use client";

import Link from "next/link";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { useId } from "react";
import type { ApiError } from "@/lib/api";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

export function Button({ variant = "primary", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost" }) {
  const styles = {
    primary: "bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300",
    secondary: "bg-white text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-600 dark:hover:bg-slate-700",
    danger: "bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300",
    ghost: "text-indigo-700 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-slate-800",
  }[variant];
  return <button type="button" {...p} className={cx("inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed", styles, className)} />;
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-lg bg-white p-4 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800", className)}>
      {(title || actions) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

const TONES: Record<string, string> = {
  approved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200",
  answered: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200",
  succeeded: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200",
  resolved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200",
  ok: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200",
  draft: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
  in_review: "bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-200",
  partially_answered: "bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-200",
  partially_succeeded: "bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-200",
  open: "bg-orange-100 text-orange-900 dark:bg-orange-900/40 dark:text-orange-200",
  conflicting_sources: "bg-orange-100 text-orange-900 dark:bg-orange-900/40 dark:text-orange-200",
  needs_clarification: "bg-orange-100 text-orange-900 dark:bg-orange-900/40 dark:text-orange-200",
  insufficient_evidence: "bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-100",
  failed: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  rejected: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  cancelled: "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200",
  unsupported: "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200",
  needs_ocr: "bg-purple-100 text-purple-900 dark:bg-purple-900/40 dark:text-purple-200",
  running: "bg-indigo-100 text-indigo-900 dark:bg-indigo-900/40 dark:text-indigo-200",
  queued: "bg-indigo-100 text-indigo-900 dark:bg-indigo-900/40 dark:text-indigo-200",
  pending: "bg-indigo-100 text-indigo-900 dark:bg-indigo-900/40 dark:text-indigo-200",
  retrying: "bg-indigo-100 text-indigo-900 dark:bg-indigo-900/40 dark:text-indigo-200",
};

export function Badge({ children, tone }: { children: ReactNode; tone?: string }) {
  const text = typeof children === "string" ? children : null;
  const key = tone ?? text ?? "";
  return (
    <span className={cx("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium", TONES[key] ?? "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200")}>
      {text !== null ? text.replace(/_/g, " ") : children}
    </span>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children(id)}
      {hint && <p className="text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
    </div>
  );
}

const inputCls = "rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800";
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(inputCls, p.className)} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={cx(inputCls, p.className)} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cx(inputCls, p.className)} />;

export function ErrorBanner({ error }: { error: ApiError | Error | null | undefined }) {
  if (!error) return null;
  const e = error as ApiError;
  return (
    <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
      <p className="font-medium">{e.code ? `${e.code}: ` : ""}{e.message}</p>
      {e.correlationId && <p className="mt-1 text-xs opacity-75">Reference: {e.correlationId}</p>}
      {Array.isArray(e.details) && (
        <ul className="mt-1 list-disc pl-5 text-xs">
          {(e.details as { path?: string; message?: string }[]).slice(0, 5).map((d, i) => (
            <li key={i}>{d.path ? `${d.path}: ` : ""}{d.message ?? JSON.stringify(d)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <p role="status" className="text-sm text-slate-500">
      {label}…
    </p>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-slate-300 p-6 text-center dark:border-slate-700">
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">{children}</div>}
    </div>
  );
}

export function A({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <Link href={href} className={cx("text-indigo-700 underline-offset-2 hover:underline dark:text-indigo-300", className)}>
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
