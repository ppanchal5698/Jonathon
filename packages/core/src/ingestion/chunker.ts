import type { Locator } from "@jonathon/contracts";

export interface Chunk {
  ordinal: number;
  heading: string | null;
  locator: Locator;
  text: string;
}

export interface Block {
  heading: string | null;
  locator: Locator;
  text: string;
}

const MAX_CHARS = 1_400;

/** Pack consecutive blocks under the same heading into chunks of at most MAX_CHARS, keeping locators. */
export function packBlocks(blocks: Block[], maxChars = MAX_CHARS): Chunk[] {
  const out: Chunk[] = [];
  let cur: { heading: string | null; locators: Locator[]; parts: string[]; size: number } | null = null;
  const flush = () => {
    if (!cur || cur.parts.length === 0) return;
    out.push({ ordinal: out.length, heading: cur.heading, locator: mergeLocators(cur.locators), text: cur.parts.join("\n\n") });
    cur = null;
  };
  for (const b of blocks) {
    const text = b.text.trim();
    if (!text) continue;
    for (const piece of splitLong(text, maxChars)) {
      if (!cur || cur.heading !== b.heading || cur.size + piece.length > maxChars) {
        flush();
        cur = { heading: b.heading, locators: [], parts: [], size: 0 };
      }
      cur.parts.push(piece);
      cur.locators.push(b.locator);
      cur.size += piece.length + 2;
    }
  }
  flush();
  return out;
}

function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(". ", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

/** Combine locators: numeric line/paragraph/page/row keys become ranges; strings keep the first value. */
function mergeLocators(ls: Locator[]): Locator {
  if (ls.length === 1) return ls[0]!;
  const out: Locator = {};
  for (const key of new Set(ls.flatMap((l) => Object.keys(l)))) {
    const vals = ls.map((l) => l[key]).filter((v) => v !== undefined);
    if (vals.every((v) => typeof v === "number")) {
      const nums = vals as number[];
      const lo = Math.min(...nums);
      const hi = Math.max(...nums);
      if (lo === hi) out[key] = lo;
      else {
        out[`${key}_start`] = lo;
        out[`${key}_end`] = hi;
      }
    } else if (key === "range") out[key] = boundingRange(vals.map(String));
    else out[key] = [...new Set(vals.map(String))].join(", ");
  }
  return out;
}

/** Smallest A1-style range covering all inputs ("A1:D2" + "A5:D7" → "A1:D7"). Falls back to a list if any is not A1-style. */
function boundingRange(ranges: string[]): string {
  const colNum = (c: string) => [...c].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const colName = (n: number) => {
    let s = "";
    for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
    return s;
  };
  let c1 = Infinity, r1 = Infinity, c2 = 0, r2 = 0;
  for (const r of ranges) {
    const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(r);
    if (!m) return [...new Set(ranges)].join(", ");
    const [a, b] = [colNum(m[1]!), Number(m[2])];
    const [c, d] = m[3] ? [colNum(m[3]), Number(m[4])] : [a, b];
    c1 = Math.min(c1, a, c);
    r1 = Math.min(r1, b, d);
    c2 = Math.max(c2, a, c);
    r2 = Math.max(r2, b, d);
  }
  return `${colName(c1)}${r1}:${colName(c2)}${r2}`;
}

/** Split plain or Markdown text into heading-aware blocks with line locators. */
export function textBlocks(text: string, markdown: boolean): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  const headingPath: string[] = [];
  let para: string[] = [];
  let paraStart = 1;
  const flush = (endLine: number) => {
    if (para.join("").trim()) {
      blocks.push({ heading: headingPath.length ? headingPath.join(" > ") : null, locator: { line: paraStart, line_end_hint: endLine }, text: para.join("\n") });
    }
    para = [];
  };
  lines.forEach((line, i) => {
    const n = i + 1;
    const h = markdown ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (h) {
      flush(n - 1);
      const level = h[1]!.length;
      headingPath.splice(level - 1);
      headingPath[level - 1] = h[2]!.trim();
      for (let k = 0; k < level - 1; k++) if (headingPath[k] === undefined) headingPath[k] = "";
      blocks.push({ heading: headingPath.filter(Boolean).join(" > "), locator: { line: n }, text: line.replace(/^#+\s*/, "") });
      paraStart = n + 1;
      return;
    }
    if (!line.trim()) {
      flush(n - 1);
      paraStart = n + 1;
      return;
    }
    if (para.length === 0) paraStart = n;
    para.push(line);
  });
  flush(lines.length);
  // line_end_hint is only used for merging; drop it from single-block locators.
  return blocks.map((b) => {
    const { line_end_hint, ...rest } = b.locator as Record<string, string | number>;
    void line_end_hint;
    return { ...b, locator: rest };
  });
}
