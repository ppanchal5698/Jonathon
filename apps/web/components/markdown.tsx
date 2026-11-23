import { Fragment, type ReactNode } from "react";

/**
 * Deliberately small Markdown renderer for model and knowledge text: headings, paragraphs, bullet and numbered
 * lists, block quotes, horizontal rules, **bold**, *italic*, `code`, and [cite_1]/[E1]/[REQ-001] tokens.
 * It parses line by line, so headings and lists work even when mixed with other lines in one block.
 * It builds React elements only; raw HTML in the text is shown as text and never interpreted (stored-XSS
 * protection). Links are not rendered as links.
 */
type Block =
  | { kind: "h"; level: number; text: string }
  | { kind: "p"; lines: string[] }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "hr" };

function parse(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const last = () => blocks[blocks.length - 1];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      blocks.push({ kind: "p", lines: [] }); // paragraph break marker; empty ones are dropped later
      continue;
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({ kind: "h", level: h[1]!.length, text: h[2]!.replace(/\s*#+\s*$/, "") });
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: "hr" });
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      const b = last();
      if (b?.kind === "ul") b.items.push(ul[1]!);
      else blocks.push({ kind: "ul", items: [ul[1]!] });
      continue;
    }
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ol) {
      const b = last();
      if (b?.kind === "ol") b.items.push(ol[1]!);
      else blocks.push({ kind: "ol", items: [ol[1]!] });
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      const b = last();
      if (b?.kind === "quote") b.lines.push(q[1]!);
      else blocks.push({ kind: "quote", lines: [q[1]!] });
      continue;
    }
    const b = last();
    // A continuation line after a list item belongs to that item.
    if ((b?.kind === "ul" || b?.kind === "ol") && /^\s{2,}\S/.test(raw)) {
      b.items[b.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    if (b?.kind === "p" && b.lines.length > 0) b.lines.push(line);
    else blocks.push({ kind: "p", lines: [line] });
  }
  return blocks.filter((b) => b.kind !== "p" || b.lines.length > 0);
}

const H_CLASS = [
  "text-base font-semibold",
  "text-base font-semibold",
  "text-theme-sm font-semibold",
  "text-theme-sm font-semibold",
  "text-theme-sm font-medium",
  "text-theme-sm font-medium",
];

export function Markdown({ text, onCite }: { text: string; onCite?: (token: string) => void }) {
  return (
    <div className="space-y-2.5 text-theme-sm leading-relaxed text-gray-700 dark:text-gray-300">
      {parse(text).map((b, i) => {
        switch (b.kind) {
          case "h":
            return (
              <p key={i} role="heading" aria-level={Math.min(b.level + 2, 6)} className={`${H_CLASS[b.level - 1]} pt-1 text-gray-800 dark:text-white/90`}>
                {inline(b.text, onCite)}
              </p>
            );
          case "ul":
            return (
              <ul key={i} className="list-disc space-y-1 pl-5">
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, onCite)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i} className="list-decimal space-y-1 pl-5">
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, onCite)}</li>
                ))}
              </ol>
            );
          case "quote":
            return (
              <blockquote key={i} className="border-l-4 border-gray-300 pl-3 text-gray-600 dark:border-gray-700 dark:text-gray-400">
                {b.lines.map((l, j) => (
                  <Fragment key={j}>
                    {j > 0 && <br />}
                    {inline(l, onCite)}
                  </Fragment>
                ))}
              </blockquote>
            );
          case "hr":
            return <hr key={i} className="border-gray-200 dark:border-gray-800" />;
          default:
            return (
              <p key={i}>
                {b.lines.map((l, j) => (
                  <Fragment key={j}>
                    {j > 0 && <br />}
                    {inline(l, onCite)}
                  </Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}

function inline(s: string, onCite?: (t: string) => void): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|(?<![*\w])\*[^*\s][^*]*\*(?!\*)|`[^`]+`|\[(?:E\d+|cite_\d+|REQ-\d+|DEC-\d+|QUESTION-\d+|CONFLICT-\d+)\])/g;
  let last = 0;
  let m: RegExpExecArray | null = re.exec(s);
  while (m) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**"))
      out.push(
        <strong key={m.index} className="font-semibold text-gray-800 dark:text-white/90">
          {tok.slice(2, -2)}
        </strong>,
      );
    else if (tok.startsWith("*")) out.push(<em key={m.index}>{tok.slice(1, -1)}</em>);
    else if (tok.startsWith("`"))
      out.push(
        <code key={m.index} className="rounded-md bg-gray-100 px-1 py-0.5 text-theme-xs dark:bg-white/5">
          {tok.slice(1, -1)}
        </code>,
      );
    else {
      const label = tok.slice(1, -1);
      out.push(
        onCite ? (
          <button
            key={m.index}
            type="button"
            onClick={() => onCite(label)}
            className="mx-0.5 rounded-md bg-brand-50 px-1.5 py-0.5 text-theme-xs font-medium text-brand-600 hover:bg-brand-100 dark:bg-brand-500/15 dark:text-brand-400 dark:hover:bg-brand-500/25"
          >
            {label}
          </button>
        ) : (
          <span key={m.index} className="mx-0.5 rounded-md bg-gray-100 px-1.5 py-0.5 text-theme-xs dark:bg-white/5">
            {label}
          </span>
        ),
      );
    }
    last = m.index + tok.length;
    m = re.exec(s);
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
