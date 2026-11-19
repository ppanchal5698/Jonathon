"use client";

/*
 * Application frame adapted from TailAdmin's admin layout (MIT, Copyright (c) TailAdmin): fixed collapsible sidebar
 * with grouped menus, sticky header with sidebar toggle, search, theme toggle and user menu.
 */
import type { Project, SearchHit } from "@jonathon/contracts";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { get, post, setCsrf } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import {
  AlertIcon,
  ChatIcon,
  ChecklistIcon,
  ChevronDownIcon,
  CloseIcon,
  CpuIcon,
  DocumentIcon,
  FolderIcon,
  GridIcon,
  InboxIcon,
  KeyIcon,
  LogoMark,
  LogoutIcon,
  MenuIcon,
  MoonIcon,
  ProposalIcon,
  BookIcon,
  GraphIcon,
  QuestionIcon,
  ScaleIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  SunIcon,
} from "./icons";
import { useTheme } from "./theme";
import { Badge, cx, Loading } from "./ui";

interface Session {
  username: string;
  csrf_token: string;
  mode: "live" | "demo";
}

export const PROJECT_SECTIONS = [
  ["overview", "Overview", GridIcon],
  ["review", "Review", InboxIcon],
  ["documents", "Documents", DocumentIcon],
  ["requirements", "Requirements", ChecklistIcon],
  ["decisions", "Decisions", ScaleIcon],
  ["conflicts", "Conflicts", AlertIcon],
  ["questions", "Open questions", QuestionIcon],
  ["proposals", "Proposals", ProposalIcon],
  ["techdocs", "Tech docs", BookIcon],
  ["graph", "Memory graph", GraphIcon],
  ["chat", "Chat", ChatIcon],
  ["settings", "Settings", SettingsIcon],
] as const;

/** Authenticated application frame. Redirects to /setup or /login when needed. */
export function Shell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [expanded, setExpanded] = useState(true); // desktop: full width vs icon rail
  const [hovered, setHovered] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();

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

  // Close the mobile drawer on navigation.
  useEffect(() => setMobileOpen(false), [pathname]);

  if (!session) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <Loading label="Checking session" />
      </main>
    );
  }

  const showText = expanded || hovered || mobileOpen;
  return (
    <div className="min-h-screen xl:flex">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[99999] focus:rounded-lg focus:bg-white focus:p-2">
        Skip to content
      </a>
      <Sidebar showText={showText} expanded={expanded} mobileOpen={mobileOpen} onHover={setHovered} />
      {mobileOpen && (
        <button type="button" aria-label="Close menu" className="fixed inset-0 z-40 bg-gray-900/50 xl:hidden" onClick={() => setMobileOpen(false)} />
      )}
      <div className={cx("flex min-w-0 flex-1 flex-col transition-all duration-300 ease-in-out", expanded ? "xl:ml-[290px]" : "xl:ml-[90px]")}>
        <Header
          session={session}
          mobileOpen={mobileOpen}
          onToggle={() => {
            if (window.matchMedia("(min-width: 1280px)").matches) setExpanded((v) => !v);
            else setMobileOpen((v) => !v);
          }}
          onSignOut={async () => {
            await post("/auth/logout");
            setCsrf(null);
            router.replace("/login");
          }}
        />
        {session.mode === "demo" && (
          <div
            role="note"
            className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-theme-sm font-medium text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-orange-400"
          >
            Demo mode: no AI runtime is connected. Answers are extractive quotes, not Antigravity reasoning.
          </div>
        )}
        <main id="main" className="mx-auto w-full max-w-(--breakpoint-2xl) p-4 md:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}

function Sidebar({ showText, expanded, mobileOpen, onHover }: { showText: boolean; expanded: boolean; mobileOpen: boolean; onHover: (v: boolean) => void }) {
  return (
    <aside
      aria-label="Main navigation"
      onMouseEnter={() => !expanded && onHover(true)}
      onMouseLeave={() => onHover(false)}
      className={cx(
        "fixed top-0 left-0 z-50 flex h-screen flex-col border-r border-gray-200 bg-white px-5 text-gray-900 transition-all duration-300 ease-in-out dark:border-gray-800 dark:bg-gray-900",
        showText ? "w-[290px]" : "w-[90px]",
        mobileOpen ? "translate-x-0" : "-translate-x-full xl:translate-x-0",
      )}
    >
      <div className={cx("flex py-8", showText ? "justify-start" : "justify-center")}>
        <Link href="/" aria-label="Jonathon home" className="flex items-center gap-2.5">
          <LogoMark className="size-8" />
          {showText && <span className="text-xl font-semibold tracking-tight text-gray-900 dark:text-white">Jonathon</span>}
        </Link>
      </div>
      <div className="no-scrollbar flex flex-1 flex-col overflow-y-auto">
        <Suspense fallback={null}>
          <SidebarNav showText={showText} />
        </Suspense>
        {showText && <StatusWidget />}
      </div>
    </aside>
  );
}

function GroupTitle({ showText, children }: { showText: boolean; children: string }) {
  return (
    <h2 className={cx("mb-4 flex text-theme-xs leading-5 text-gray-400 uppercase", showText ? "justify-start" : "justify-center")}>
      {showText ? children : <span aria-hidden="true">•••</span>}
      {!showText && <span className="sr-only">{children}</span>}
    </h2>
  );
}

function NavLink({ href, active, icon, label, showText }: { href: string; active: boolean; icon: ReactNode; label: string; showText: boolean }) {
  return (
    <Link
      href={href}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      title={showText ? undefined : label}
      className={cx("group menu-item", active ? "menu-item-active" : "menu-item-inactive", !showText && "justify-center")}
    >
      <span className={cx("[&_svg]:size-6", active ? "menu-item-icon-active" : "menu-item-icon-inactive")}>{icon}</span>
      {showText ? <span>{label}</span> : <span className="sr-only">{label}</span>}
    </Link>
  );
}

function SidebarNav({ showText }: { showText: boolean }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const projects = useApi<Project[]>("/projects");
  const currentPid = /^\/projects\/(prj_[0-9a-z]+)/.exec(pathname)?.[1] ?? null;
  const [openPid, setOpenPid] = useState<string | null>(currentPid);
  useEffect(() => setOpenPid(currentPid), [currentPid]);
  const tab = params.get("tab") ?? (pathname.includes("/entities/") || pathname.includes("/sources/") ? "" : "overview");

  return (
    <nav className="mb-6 flex flex-col gap-6">
      <div>
        <GroupTitle showText={showText}>Menu</GroupTitle>
        <ul className="flex flex-col gap-1">
          <li>
            <NavLink href="/" active={pathname === "/"} icon={<GridIcon />} label="Dashboard" showText={showText} />
          </li>
        </ul>
      </div>
      <div>
        <GroupTitle showText={showText}>Projects</GroupTitle>
        <ul className="flex flex-col gap-1">
          {(projects.data ?? []).map((p) => {
            const isCurrent = p.id === currentPid;
            const isOpen = openPid === p.id && showText;
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => setOpenPid(isOpen ? null : p.id)}
                  aria-expanded={isOpen}
                  aria-label={p.name}
                  title={showText ? undefined : p.name}
                  className={cx("group menu-item", isCurrent ? "menu-item-active" : "menu-item-inactive", !showText && "justify-center")}
                >
                  <span className={cx("[&_svg]:size-6", isCurrent ? "menu-item-icon-active" : "menu-item-icon-inactive")}>
                    <FolderIcon />
                  </span>
                  {showText ? (
                    <>
                      <span className="truncate text-left">{p.name}</span>
                      <ChevronDownIcon className={cx("ml-auto size-5 shrink-0 transition-transform", isOpen && "rotate-180")} />
                    </>
                  ) : (
                    <span className="sr-only">{p.name}</span>
                  )}
                </button>
                {isOpen && (
                  <ul className="mt-1 ml-9 flex flex-col gap-0.5">
                    {PROJECT_SECTIONS.map(([key, label]) => {
                      const active =
                        isCurrent && tab === key && !pathname.includes("/entities/") && !pathname.includes("/sources/") && !pathname.includes("/docs/");
                      return (
                        <li key={key}>
                          <Link
                            href={`/projects/${p.id}?tab=${key}`}
                            aria-current={active ? "page" : undefined}
                            className={cx("menu-dropdown-item", active ? "menu-dropdown-item-active" : "menu-dropdown-item-inactive")}
                          >
                            {label}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
          {projects.data?.length === 0 && showText && <li className="px-3 text-theme-sm text-gray-500">No projects yet.</li>}
        </ul>
      </div>
      <div>
        <GroupTitle showText={showText}>System</GroupTitle>
        <ul className="flex flex-col gap-1">
          <li>
            <NavLink href="/mcp" active={pathname === "/mcp"} icon={<KeyIcon />} label="MCP access" showText={showText} />
          </li>
          <li>
            <NavLink href="/operations" active={pathname === "/operations"} icon={<ServerIcon />} label="Operations" showText={showText} />
          </li>
          <li>
            <NavLink href="/setup" active={pathname === "/setup"} icon={<CpuIcon />} label="Setup & runtime" showText={showText} />
          </li>
        </ul>
      </div>
    </nav>
  );
}

/** Sidebar footer card (TailAdmin's widget slot) showing real worker and runtime health. */
function StatusWidget() {
  const health = useApi<{ status: string; worker: { alive: boolean }; runtime: { status: string }; jobs: { active: number; failed: number } }>("/ops/health", {
    pollMs: 15_000,
  });
  const h = health.data;
  return (
    <div className="mb-8 mt-auto rounded-2xl bg-gray-50 px-4 py-5 dark:bg-white/[0.03]">
      <p className="mb-3 text-theme-sm font-semibold text-gray-900 dark:text-white">System status</p>
      {!h ? (
        <Loading />
      ) : (
        <dl className="space-y-2 text-theme-sm">
          <div className="flex items-center justify-between">
            <dt className="text-gray-500 dark:text-gray-400">Worker</dt>
            <dd>{h.worker.alive ? <Badge tone="success">running</Badge> : <Badge tone="error">stopped</Badge>}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-gray-500 dark:text-gray-400">Runtime</dt>
            <dd>
              <Badge tone={h.runtime.status === "ok" ? "success" : h.runtime.status === "demo" ? "primary" : "warning"}>{h.runtime.status}</Badge>
            </dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-gray-500 dark:text-gray-400">Jobs</dt>
            <dd className="text-gray-700 dark:text-gray-300">
              {h.jobs.active} active{h.jobs.failed ? <span className="text-red-500"> · {h.jobs.failed} failed</span> : null}
            </dd>
          </div>
        </dl>
      )}
      <Link
        href="/operations"
        className="mt-4 flex h-9 items-center justify-center rounded-lg bg-brand-500 text-theme-sm font-medium text-white hover:bg-brand-600"
      >
        Operations
      </Link>
    </div>
  );
}

function Header({ session, mobileOpen, onToggle, onSignOut }: { session: Session; mobileOpen: boolean; onToggle: () => void; onSignOut: () => void }) {
  const { resolved, toggle } = useTheme();
  return (
    <header className="sticky top-0 z-30 flex w-full border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
      <div className="flex grow items-center justify-between gap-3 px-3 py-3 sm:gap-4 lg:px-6 lg:py-4">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={onToggle}
            aria-label={mobileOpen ? "Close sidebar" : "Toggle sidebar"}
            className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 lg:size-11 dark:border-gray-800 dark:text-gray-400 dark:hover:bg-white/5"
          >
            {mobileOpen ? <CloseIcon className="size-6" /> : <MenuIcon className="size-6" />}
          </button>
          <Link href="/" aria-label="Jonathon home" className="flex items-center gap-2 xl:hidden">
            <LogoMark className="size-8" />
            <span className="hidden text-lg font-semibold sm:inline">Jonathon</span>
          </Link>
          <Suspense fallback={null}>
            <HeaderSearch />
          </Suspense>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <button
            type="button"
            onClick={toggle}
            aria-label={resolved === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            className="flex size-10 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-500 hover:bg-gray-100 hover:text-gray-700 lg:size-11 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white"
          >
            {resolved === "dark" ? <SunIcon className="size-5" /> : <MoonIcon className="size-5" />}
          </button>
          <UserMenu username={session.username} onSignOut={onSignOut} />
        </div>
      </div>
    </header>
  );
}

function UserMenu({ username, onSignOut }: { username: string; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Account menu for ${username}`}
        className="flex items-center gap-2 text-gray-700 dark:text-gray-400"
      >
        <span className="flex size-10 items-center justify-center rounded-full bg-brand-50 text-theme-sm font-semibold text-brand-500 uppercase lg:size-11 dark:bg-brand-500/15 dark:text-brand-400">
          {username.slice(0, 2)}
        </span>
        <span className="hidden text-theme-sm font-medium sm:block">{username}</span>
        <ChevronDownIcon className={cx("size-4 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-3 w-60 rounded-2xl border border-gray-200 bg-white p-3 shadow-theme-lg dark:border-gray-800 dark:bg-gray-900"
        >
          <div className="border-b border-gray-200 px-2 pb-3 dark:border-gray-800">
            <p className="font-medium text-gray-700 dark:text-gray-300">{username}</p>
            <p className="text-theme-xs text-gray-500 dark:text-gray-400">Local account</p>
          </div>
          <Link
            role="menuitem"
            href="/setup"
            className="mt-2 flex items-center gap-3 rounded-lg px-2 py-2 text-theme-sm font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/5"
          >
            <CpuIcon className="size-5" /> Setup & runtime
          </Link>
          <button
            role="menuitem"
            type="button"
            onClick={onSignOut}
            className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-theme-sm font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/5"
          >
            <LogoutIcon className="size-5" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

type Hit = SearchHit & { text?: string };

/**
 * Ctrl+K search. Inside a project it searches that project's evidence and knowledge (same project-scoped search
 * the MCP tool uses); elsewhere it filters project names. Results are links; nothing is executed.
 */
function HeaderSearch() {
  const pathname = usePathname();
  const router = useRouter();
  const pid = /^\/projects\/(prj_[0-9a-z]+)/.exec(pathname)?.[1] ?? null;
  const projects = useApi<Project[]>(pid ? null : "/projects");
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!pid || q.trim().length < 2) {
      setHits([]);
      return;
    }
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await post<{ hits: Hit[] }>(`/projects/${pid}/search`, { query: q, limit: 8 });
        setHits(r.hits);
      } catch {
        setHits([]);
      } finally {
        setBusy(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q, pid]);

  const projectMatches = useMemo(
    () => (pid ? [] : (projects.data ?? []).filter((p) => q.trim() && p.name.toLowerCase().includes(q.toLowerCase())).slice(0, 8)),
    [pid, projects.data, q],
  );
  const hrefFor = useCallback(
    (h: Hit) => (h.kind === "evidence" ? `/projects/${pid}/sources/${h.source_id}` : `/projects/${pid}/entities/${h.human_id}`),
    [pid],
  );
  const go = (href: string) => {
    setOpen(false);
    setQ("");
    router.push(href);
  };

  const showPanel = open && q.trim().length >= (pid ? 2 : 1);
  return (
    <div className="relative hidden lg:block">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-gray-500 dark:text-gray-400" />
      <input
        ref={inputRef}
        type="search"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
          if (e.key === "Enter") {
            const first = pid ? hits[0] && hrefFor(hits[0]) : projectMatches[0] && `/projects/${projectMatches[0].id}`;
            if (first) go(first);
          }
        }}
        aria-label={pid ? "Search this project's evidence and knowledge" : "Find a project"}
        placeholder={pid ? "Search this project…" : "Find a project…"}
        className="h-11 w-full rounded-lg border border-gray-200 bg-transparent py-2.5 pr-14 pl-12 text-theme-sm text-gray-800 shadow-theme-xs placeholder:text-gray-400 focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden xl:w-[430px] dark:border-gray-800 dark:bg-white/[0.03] dark:text-white/90 dark:placeholder:text-white/30"
      />
      <kbd className="pointer-events-none absolute top-1/2 right-2.5 inline-flex -translate-y-1/2 items-center gap-0.5 rounded-lg border border-gray-200 bg-gray-50 px-[7px] py-[4.5px] text-theme-xs text-gray-500 dark:border-gray-800 dark:bg-white/[0.03] dark:text-gray-400">
        Ctrl K
      </kbd>
      {showPanel && (
        <div className="absolute top-full left-0 z-50 mt-2 w-full overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-theme-lg xl:w-[520px] dark:border-gray-800 dark:bg-gray-900">
          {pid ? (
            busy && hits.length === 0 ? (
              <div className="p-4">
                <Loading label="Searching" />
              </div>
            ) : hits.length === 0 ? (
              <p className="p-4 text-theme-sm text-gray-500">No matches in this project.</p>
            ) : (
              <ul className="custom-scrollbar max-h-96 overflow-y-auto p-2">
                {hits.map((h) => (
                  <li key={h.chunk_id}>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => go(hrefFor(h))}
                      className="w-full rounded-lg px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-white/5"
                    >
                      <span className="flex items-center gap-2">
                        <Badge tone={h.kind === "evidence" ? "gray" : h.approval_valid ? "success" : "warning"}>
                          {h.kind === "evidence" ? "source" : h.approval_valid ? "approved" : (h.status ?? h.entity_type)}
                        </Badge>
                        <span className="truncate text-theme-sm font-medium text-gray-800 dark:text-white/90">{h.title}</span>
                      </span>
                      <span className="mt-0.5 line-clamp-2 block text-theme-xs text-gray-500 dark:text-gray-400">{h.snippet}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : projectMatches.length === 0 ? (
            <p className="p-4 text-theme-sm text-gray-500">No matching project.</p>
          ) : (
            <ul className="p-2">
              {projectMatches.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => go(`/projects/${p.id}`)}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-theme-sm hover:bg-gray-100 dark:hover:bg-white/5"
                  >
                    <FolderIcon className="size-5 text-gray-500" /> {p.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
