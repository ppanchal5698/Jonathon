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
    } else out[key] = vals[0]!;
  }
  return out;
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
