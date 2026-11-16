import { Fragment, type ReactNode } from "react";

/**
 * Deliberately small Markdown renderer for model and knowledge text: paragraphs, lists, headings, **bold**,
 * `code`, and [E1]/[cite_1] citation tokens. It builds React elements only; raw HTML in the text is shown as
 * text and never interpreted (stored-XSS protection). Links are not rendered as links.
 */
export function Markdown({ text, onCite }: { text: string; onCite?: (token: string) => void }) {
  const blocks = text.replace(/\r\n/g, "\n").split(/\n{2,}/);
  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
          return (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*[-*]\s+/, ""), onCite)}</li>
              ))}
            </ul>
          );
        }
        if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
          return (
            <ol key={i} className="list-decimal space-y-1 pl-5">
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*\d+[.)]\s+/, ""), onCite)}</li>
              ))}
            </ol>
          );
        }
        const h = /^(#{1,4})\s+(.*)$/.exec(lines[0]!);
        if (h && lines.length === 1) return <p key={i} className="font-semibold">{inline(h[2]!, onCite)}</p>;
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(l, onCite)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

function inline(s: string, onCite?: (t: string) => void): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[(?:E\d+|cite_\d+|REQ-\d+|DEC-\d+|QUESTION-\d+|CONFLICT-\d+)\])/g;
  let last = 0;
  let m: RegExpExecArray | null = re.exec(s);
  while (m) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(<strong key={m.index}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={m.index} className="rounded bg-slate-100 px-1 text-xs dark:bg-slate-800">{tok.slice(1, -1)}</code>);
    else {
      const label = tok.slice(1, -1);
      out.push(
        onCite ? (
          <button key={m.index} type="button" onClick={() => onCite(label)} className="mx-0.5 rounded bg-indigo-100 px-1 text-xs font-medium text-indigo-800 hover:bg-indigo-200 dark:bg-indigo-900 dark:text-indigo-200">
            {label}
          </button>
        ) : (
          <span key={m.index} className="mx-0.5 rounded bg-slate-100 px-1 text-xs dark:bg-slate-800">{label}</span>
        ),
      );
    }
    last = m.index + tok.length;
    m = re.exec(s);
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
