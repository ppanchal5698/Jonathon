"use client";

/* Split-screen sign-in layout adapted from TailAdmin's auth pages (MIT, Copyright (c) TailAdmin). */
import type { ReactNode } from "react";
import { LogoMark, MoonIcon, SunIcon } from "./icons";
import { useTheme } from "./theme";

export function AuthLayout({ title, subtitle, children, wide = false }: { title: string; subtitle?: ReactNode; children: ReactNode; wide?: boolean }) {
  const { resolved, toggle } = useTheme();
  return (
    <div className="relative min-h-screen bg-white dark:bg-gray-900">
      <div className="flex min-h-screen flex-col lg:flex-row">
        <main className="flex flex-1 flex-col justify-center px-6 py-10 sm:px-10">
          <div className={wide ? "mx-auto w-full max-w-2xl" : "mx-auto w-full max-w-md"}>
            <div className="mb-8 flex items-center gap-2.5 lg:hidden">
              <LogoMark className="size-9" />
              <span className="text-xl font-semibold">Jonathon</span>
            </div>
            <h1 className="mb-2 text-title-sm font-semibold text-gray-800 sm:text-title-lg dark:text-white/90">{title}</h1>
            {subtitle && <p className="mb-8 text-theme-sm text-gray-500 dark:text-gray-400">{subtitle}</p>}
            {children}
          </div>
        </main>
        <aside className="relative hidden w-1/2 items-center justify-center overflow-hidden bg-brand-950 lg:flex dark:bg-white/5" aria-hidden="true">
          <GridShape className="absolute top-0 right-0 w-full max-w-[250px] xl:max-w-[450px]" />
          <GridShape className="absolute bottom-0 left-0 w-full max-w-[250px] rotate-180 xl:max-w-[450px]" />
          <div className="relative z-10 flex max-w-xs flex-col items-center text-center">
            <LogoMark className="mb-4 size-14" />
            <p className="text-2xl font-semibold text-white">Jonathon</p>
            <p className="mt-3 text-gray-400">
              Client evidence in, approved requirements out. Local-first knowledge for you and for Claude Code.
            </p>
          </div>
        </aside>
      </div>
      <button
        type="button"
        onClick={toggle}
        aria-label={resolved === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        className="fixed right-6 bottom-6 z-50 flex size-14 items-center justify-center rounded-full bg-brand-500 text-white transition-colors hover:bg-brand-600"
      >
        {resolved === "dark" ? <SunIcon className="size-6" /> : <MoonIcon className="size-6" />}
      </button>
    </div>
  );
}

/** Decorative dotted grid (TailAdmin's grid-shape motif), drawn inline. */
function GridShape({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 450 254" fill="none" aria-hidden="true">
      <defs>
        <pattern id="jon-grid" width="34" height="34" patternUnits="userSpaceOnUse">
          <path d="M34 0H0V34" stroke="white" strokeOpacity="0.08" />
        </pattern>
      </defs>
      <rect width="450" height="254" fill="url(#jon-grid)" />
    </svg>
  );
}
