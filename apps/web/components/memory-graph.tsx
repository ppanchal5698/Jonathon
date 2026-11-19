"use client";

import type { GraphEdge, GraphNode } from "@jonathon/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { A, Badge, Button, Card, cx, ErrorBanner, Input, Loading, Notice, Time } from "@/components/ui";
import { type ApiError, post } from "@/lib/api";
import { useApi } from "@/lib/use-api";

interface Overview {
  built_at: string;
  nodes: number;
  edges: number;
  by_type: Record<string, number>;
  concept_kinds: Record<string, number>;
  inferred_relations: number;
  hubs: GraphNode[];
  communities: { id: number; label: string; size: number }[];
  documents_mapped: number;
  documents_total: number;
  unmapped_documents: string[];
  mapping_jobs_pending: number;
  graphify_file: string;
}

interface NodeDetail {
  node: GraphNode;
  location: string | null;
  text: string | null;
  aliases: string[];
  mentioned_in: number | null;
  links: { direction: "in" | "out"; relation: string; confidence: string; quote: string | null; node: GraphNode }[];
  link_count: number;
}

interface Hood {
  center: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

const TYPE_COLOR: Record<string, string> = {
  concept: "#465fff",
  requirement: "#12b76a",
  decision: "#0ba5ec",
  open_question: "#f79009",
  conflict: "#f04438",
  change_proposal: "#7a5af8",
  source: "#667085",
  passage: "#98a2b3",
  document: "#ee46bc",
};
const TYPE_LABEL: Record<string, string> = {
  concept: "concept",
  requirement: "requirement",
  decision: "decision",
  open_question: "open question",
  conflict: "conflict",
  change_proposal: "proposal",
  source: "client document",
  passage: "passage",
  document: "generated document",
};

/** A small force-directed layout (no dependency): repulsion between all nodes, springs on edges, gentle centring. */
function layout(nodes: GraphNode[], edges: GraphEdge[], center: string, w: number, h: number): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number; vx: number; vy: number }>();
  nodes.forEach((n, i) => {
    const a = (i / Math.max(nodes.length, 1)) * Math.PI * 2;
    const r = n.id === center ? 0 : Math.min(w, h) * 0.35;
    pos.set(n.id, { x: w / 2 + Math.cos(a) * r, y: h / 2 + Math.sin(a) * r, vx: 0, vy: 0 });
  });
  const k = Math.sqrt((w * h) / Math.max(nodes.length, 1)) * 0.55;
  const list = [...pos.entries()];
  for (let iter = 0; iter < 260; iter++) {
    const t = 1 - iter / 260;
    for (let i = 0; i < list.length; i++) {
      const [, a] = list[i]!;
      for (let j = i + 1; j < list.length; j++) {
        const [, b] = list[j]!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          d2 = 0.5;
        }
        const f = (k * k) / d2;
        a.vx += dx * f * 0.02;
        a.vy += dy * f * 0.02;
        b.vx -= dx * f * 0.02;
        b.vy -= dy * f * 0.02;
      }
    }
    for (const e of edges) {
      const a = pos.get(e.source);
      const b = pos.get(e.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = ((d - k) / d) * 0.06;
      a.vx += dx * f;
      a.vy += dy * f;
      b.vx -= dx * f;
      b.vy -= dy * f;
    }
    for (const [id, p] of list) {
      if (id === center) {
        p.x = w / 2;
        p.y = h / 2;
        p.vx = p.vy = 0;
        continue;
      }
      p.vx += (w / 2 - p.x) * 0.002;
      p.vy += (h / 2 - p.y) * 0.002;
      const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      const max = 18 * t + 1;
      if (sp > max) {
        p.vx = (p.vx / sp) * max;
        p.vy = (p.vy / sp) * max;
      }
      p.x = Math.min(w - 20, Math.max(20, p.x + p.vx));
      p.y = Math.min(h - 20, Math.max(20, p.y + p.vy));
      p.vx *= 0.6;
      p.vy *= 0.6;
    }
  }
  return new Map([...pos.entries()].map(([id, p]) => [id, { x: p.x, y: p.y }]));
}

function GraphCanvas({ hood, selected, onSelect }: { hood: Hood; selected: string; onSelect: (id: string) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 800, h: 520 });
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: Math.max(320, el.clientWidth), h: el.clientWidth < 640 ? 380 : 520 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pos = useMemo(() => layout(hood.nodes, hood.edges, hood.center, size.w, size.h), [hood, size]);
  const radius = (n: GraphNode) => (n.id === hood.center ? 11 : n.type === "passage" ? 4 : Math.min(9, 5 + Math.log2(1 + n.degree)));

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size.w * dpr;
    c.height = size.h * dpr;
    const g = c.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size.w, size.h);
    const dark = document.documentElement.classList.contains("dark");
    // Large neighbourhoods: label only the best-connected nodes (plus the selected and hovered ones) so text stays readable.
    const labelled = new Set(
      hood.nodes.length <= 50
        ? hood.nodes.map((n) => n.id)
        : [...hood.nodes]
            .filter((n) => n.type !== "passage")
            .sort((a, b) => b.degree - a.degree)
            .slice(0, 25)
            .map((n) => n.id),
    );
    const near = new Set([hover ?? selected]);
    for (const e of hood.edges) {
      if (e.source === (hover ?? selected)) near.add(e.target);
      if (e.target === (hover ?? selected)) near.add(e.source);
    }
    for (const e of hood.edges) {
      const a = pos.get(e.source);
      const b = pos.get(e.target);
      if (!a || !b) continue;
      const lit = near.has(e.source) && near.has(e.target);
      g.strokeStyle =
        e.confidence === "INFERRED"
          ? lit
            ? "#465fff"
            : "rgba(70,95,255,0.35)"
          : lit
            ? dark
              ? "rgba(255,255,255,0.55)"
              : "rgba(52,64,84,0.55)"
            : dark
              ? "rgba(255,255,255,0.12)"
              : "rgba(52,64,84,0.14)";
      g.lineWidth = e.confidence === "INFERRED" ? 1.6 : 1;
      g.setLineDash(e.confidence === "INFERRED" ? [4, 3] : []);
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
    }
    g.setLineDash([]);
    for (const n of hood.nodes) {
      const p = pos.get(n.id)!;
      g.fillStyle = TYPE_COLOR[n.type] ?? "#667085";
      g.globalAlpha = near.has(n.id) || hood.nodes.length < 30 ? 1 : 0.55;
      g.beginPath();
      g.arc(p.x, p.y, radius(n), 0, Math.PI * 2);
      g.fill();
      if (n.id === selected) {
        g.strokeStyle = dark ? "#fff" : "#101828";
        g.lineWidth = 2;
        g.stroke();
      }
      g.globalAlpha = 1;
      if ((n.type !== "passage" && labelled.has(n.id)) || n.id === hover || n.id === selected) {
        const label = n.label.length > 34 ? `${n.label.slice(0, 33)}…` : n.label;
        g.font = `${n.id === selected ? "600 " : ""}11px Outfit, system-ui, sans-serif`;
        g.fillStyle = dark ? "rgba(255,255,255,0.85)" : "#344054";
        g.fillText(label, p.x + radius(n) + 3, p.y + 4);
      }
    }
  }, [hood, pos, selected, hover, size]);

  const pick = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    const r = ev.currentTarget.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const y = ev.clientY - r.top;
    let best: string | null = null;
    let bd = 14 * 14;
    for (const n of hood.nodes) {
      const p = pos.get(n.id)!;
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bd) [best, bd] = [n.id, d];
    }
    return best;
  };

  return (
    <div ref={wrap} className="relative w-full overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
      <canvas
        ref={ref}
        style={{ width: size.w, height: size.h, cursor: hover ? "pointer" : "default" }}
        onMouseMove={(e) => setHover(pick(e))}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const id = pick(e);
          if (id) onSelect(id);
        }}
        role="img"
        aria-label={`Graph around ${hood.nodes.find((n) => n.id === hood.center)?.label ?? "the selected node"}: ${hood.nodes.length} nodes. Use the list beside it to navigate with the keyboard.`}
      />
      {hover && (
        <div className="pointer-events-none absolute left-3 top-3 max-w-sm rounded-lg bg-gray-900/90 px-3 py-2 text-theme-xs text-white">
          {hood.nodes.find((n) => n.id === hover)?.label}
        </div>
      )}
      <div className="absolute bottom-2 left-3 flex flex-wrap gap-x-3 gap-y-1 text-theme-xs text-gray-500">
        {Object.entries(TYPE_LABEL).map(([t, l]) => (
          <span key={t} className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: TYPE_COLOR[t] }} />
            {l}
          </span>
        ))}
        <span>· dashed: AI-labelled relation (quote verified)</span>
      </div>
    </div>
  );
}

export function MemoryGraph({ pid, aiEnabled, initialNode }: { pid: string; aiEnabled: boolean; initialNode?: string | null }) {
  const ov = useApi<Overview>(`/projects/${pid}/graph`, { pollMs: 5000, pollWhile: (d) => d.mapping_jobs_pending > 0 });
  const [selected, setSelected] = useState<string | null>(initialNode ?? null);
  const [depth, setDepth] = useState(1);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const results = useApi<GraphNode[]>(query ? `/projects/${pid}/graph/search?q=${encodeURIComponent(query)}` : null);
  const start = selected ?? ov.data?.hubs[0]?.id ?? null;
  const hood = useApi<Hood>(start ? `/projects/${pid}/graph/neighborhood?id=${encodeURIComponent(start)}&depth=${depth}&limit=140` : null);
  const detail = useApi<NodeDetail>(start ? `/projects/${pid}/graph/node?id=${encodeURIComponent(start)}` : null);

  if (ov.error) return <ErrorBanner error={ov.error} />;
  if (!ov.data) return <Loading />;
  const o = ov.data;
  const map = async (force: boolean) => {
    setError(null);
    try {
      await post(`/projects/${pid}/graph/map`, { force });
      await ov.reload();
    } catch (e) {
      setError(e as ApiError);
    }
  };
  const groups = new Map<string, NodeDetail["links"]>();
  for (const l of detail.data?.links ?? [])
    groups.set(`${l.direction === "out" ? "" : "← "}${l.relation}`, [...(groups.get(`${l.direction === "out" ? "" : "← "}${l.relation}`) ?? []), l]);

  return (
    <div className="space-y-6">
      <Card
        title="Project memory graph"
        desc={`${o.nodes} nodes · ${o.edges} links · ${o.by_type.concept ?? 0} concepts · ${o.documents_mapped} of ${o.documents_total} documents mapped`}
        actions={
          <div className="flex flex-wrap gap-2">
            {o.documents_mapped < o.documents_total && (
              <Button disabled={!aiEnabled || o.mapping_jobs_pending > 0} onClick={() => void map(false)}>
                Map {o.documents_total - o.documents_mapped} document{o.documents_total - o.documents_mapped === 1 ? "" : "s"}
              </Button>
            )}
            <Button variant="secondary" disabled={!aiEnabled || o.mapping_jobs_pending > 0 || o.documents_total === 0} onClick={() => void map(true)}>
              Re-map all
            </Button>
            <a
              className="inline-flex items-center rounded-lg px-4 py-2.5 text-theme-sm font-medium text-brand-500 hover:bg-brand-50 dark:hover:bg-brand-500/[0.12]"
              href={`/api/v1/projects/${pid}/graph/export`}
            >
              Download graph.json
            </a>
          </div>
        }
      >
        <div className="space-y-3 text-theme-sm text-gray-600 dark:text-gray-400">
          <p>
            Every client document, passage, requirement, decision, question, conflict, generated document and concept (roles, systems, integrations, data
            objects, technologies, terms, environments, metrics, regulations) is a node. Links between passages, knowledge and concepts are found by code (a
            passage <em>mentions</em> a concept when it names it). Relations between concepts are labelled by the graph agent and kept only with a word-for-word
            quote from the cited passage.
          </p>
          <p>
            The graph is saved in graphify's format as <code className="text-theme-xs">{o.graphify_file}</code> in Jonathon's data folder, so the graphify CLI
            can query it, for example <code className="text-theme-xs">graphify explain "&lt;concept&gt;" --graph &lt;that file&gt;</code> or{" "}
            <code className="text-theme-xs">graphify export html --graph &lt;that file&gt;</code>.
          </p>
          {o.mapping_jobs_pending > 0 && <Notice tone="info">Mapping concepts in {o.mapping_jobs_pending} document(s)…</Notice>}
          {o.unmapped_documents.length > 0 && o.mapping_jobs_pending === 0 && (
            <Notice tone="warning">
              Not mapped yet: {o.unmapped_documents.slice(0, 6).join(", ")}
              {o.unmapped_documents.length > 6 ? "…" : ""}
            </Notice>
          )}
          {aiEnabled && <p className="text-theme-xs">Mapping sends each document's passages to the AI model service configured for Antigravity.</p>}
          <ErrorBanner error={error} />
          <p className="text-theme-xs">
            Built <Time iso={o.built_at} />.{" "}
            {Object.entries(o.concept_kinds)
              .map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`)
              .join(" · ")}
          </p>
        </div>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-4">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setQuery(q.trim());
            }}
          >
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a concept, requirement, document…" aria-label="Search the memory graph" />
            <Button type="submit" variant="secondary">
              Search
            </Button>
          </form>
          {query && results.data && (
            <div className="flex flex-wrap gap-2">
              {results.data.length === 0 && <span className="text-theme-sm text-gray-500">No match.</span>}
              {results.data.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => setSelected(n.id)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 px-3 py-1 text-theme-xs text-gray-700 hover:border-brand-300 dark:border-gray-700 dark:text-gray-300"
                >
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: TYPE_COLOR[n.type] }} />
                  {n.label.slice(0, 60)}
                </button>
              ))}
            </div>
          )}
          {o.nodes === 0 ? (
            <Notice tone="info">Upload documents to build the graph.</Notice>
          ) : hood.data ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-theme-sm text-gray-500">
                <span>Show</span>
                {[1, 2].map((d) => (
                  <Button key={d} size="sm" variant={depth === d ? "primary" : "secondary"} onClick={() => setDepth(d)}>
                    {d === 1 ? "direct links" : "two steps"}
                  </Button>
                ))}
                <span>
                  {hood.data.nodes.length} nodes{hood.data.truncated ? " (largest connections shown)" : ""}
                </span>
              </div>
              <GraphCanvas hood={hood.data} selected={start ?? ""} onSelect={setSelected} />
            </>
          ) : (
            <Loading />
          )}
        </div>

        <div className="space-y-4">
          {detail.data && (
            <Card
              title={detail.data.node.label}
              desc={`${TYPE_LABEL[detail.data.node.type] ?? detail.data.node.type}${detail.data.node.kind ? ` · ${detail.data.node.kind.replace(/_/g, " ")}` : ""} · ${detail.data.link_count} links`}
            >
              <div className="space-y-3 text-theme-sm text-gray-700 dark:text-gray-300">
                {detail.data.node.href && <A href={detail.data.node.href}>Open</A>}
                {detail.data.aliases.length > 0 && <p className="text-theme-xs text-gray-500">Also called: {detail.data.aliases.join(", ")}</p>}
                {detail.data.text ? (
                  <blockquote className="max-h-60 overflow-y-auto whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-theme-xs dark:bg-white/[0.03]">
                    {detail.data.text}
                  </blockquote>
                ) : (
                  detail.data.node.detail && <p>{detail.data.node.detail}</p>
                )}
                {detail.data.location && <p className="text-theme-xs text-gray-500">{detail.data.location}</p>}
                {[...groups.entries()].map(([rel, links]) => (
                  <div key={rel}>
                    <p className="mb-1 text-theme-xs font-medium uppercase tracking-wide text-gray-500">
                      {rel.replace(/_/g, " ")} ({links.length})
                    </p>
                    <ul className="space-y-1">
                      {links.slice(0, 25).map((l) => (
                        <li key={`${l.direction}${l.relation}${l.node.id}`}>
                          <button type="button" onClick={() => setSelected(l.node.id)} className={cx("text-left text-brand-500 hover:underline")}>
                            {l.node.label.slice(0, 90)}
                          </button>
                          {l.confidence === "INFERRED" && l.quote && <p className="text-theme-xs text-gray-500">AI-labelled · “{l.quote}”</p>}
                        </li>
                      ))}
                      {links.length > 25 && <li className="text-theme-xs text-gray-500">and {links.length - 25} more</li>}
                    </ul>
                  </div>
                ))}
              </div>
            </Card>
          )}
          <Card title="Most connected" desc="Hubs of the project: start here.">
            <div className="flex flex-wrap gap-2">
              {o.hubs.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => setSelected(n.id)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 px-3 py-1 text-theme-xs text-gray-700 hover:border-brand-300 dark:border-gray-700 dark:text-gray-300"
                >
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: TYPE_COLOR[n.type] }} />
                  {n.label.slice(0, 40)} <span className="text-gray-400">{n.degree}</span>
                </button>
              ))}
            </div>
          </Card>
          {o.communities.length > 1 && (
            <Card title="Clusters" desc="Groups of closely linked nodes, named after their best-connected concept.">
              <ul className="space-y-1 text-theme-sm text-gray-600 dark:text-gray-400">
                {o.communities.slice(0, 12).map((c) => (
                  <li key={c.id} className="flex justify-between gap-2">
                    <span className="truncate">{c.label}</span>
                    <Badge tone="gray">{String(c.size)}</Badge>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
