"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { get, post, setCsrf } from "@/lib/api";
import { cx, Loading } from "./ui";

interface Session {
  username: string;
  csrf_token: string;
  mode: "live" | "demo";
}

/** Authenticated application frame. Redirects to /setup or /login when needed. */
export function Shell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    (async () => {
      const status = await get<{ set_up: boolean }>("/setup/status").catch(() => null);
      if (status && !status.set_up) return router.replace("/setup");
      try {
        const s = await get<Session>("/auth/session");
        setCsrf(s.csrf_token);
        setSession(s);
      } catch {
        router.replace("/login");
      }
    })();
  }, [router]);

  if (!session) return <main className="p-8"><Loading label="Checking session" /></main>;

  const nav = [
    { href: "/", label: "Dashboard" },
    { href: "/mcp", label: "MCP access" },
    { href: "/operations", label: "Operations" },
    { href: "/setup", label: "Setup & runtime" },
  ];
  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:p-2">Skip to content</a>
      {session.mode === "demo" && (
        <div role="note" className="bg-amber-400 px-4 py-1.5 text-center text-sm font-semibold text-amber-950">
          DEMO MODE: no AI runtime is connected. Answers are extractive quotes, not Antigravity reasoning.
        </div>
      )}
      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-2.5">
          <Link href="/" className="text-lg font-bold tracking-tight">Jonathon</Link>
          <nav aria-label="Main" className="flex gap-1">
            {nav.map((n) => (
              <Link key={n.href} href={n.href} aria-current={path === n.href ? "page" : undefined}
                className={cx("rounded px-2.5 py-1 text-sm", path === n.href ? "bg-slate-100 font-medium dark:bg-slate-800" : "hover:bg-slate-50 dark:hover:bg-slate-800")}>
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-slate-500">{session.username}</span>
            <button type="button" className="underline-offset-2 hover:underline" onClick={async () => { await post("/auth/logout"); setCsrf(null); router.replace("/login"); }}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}
