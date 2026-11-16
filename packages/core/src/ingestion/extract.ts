import type { Locator } from "@jonathon/contracts";
import { type Block, type Chunk, packBlocks, textBlocks } from "./chunker";
import type { DocKind } from "./detect";

export type ExtractionOutcome = {
  status: "succeeded" | "partially_succeeded" | "failed" | "unsupported" | "needs_ocr";
  extractor: string;
  warnings: string[];
  chunks: Chunk[];
  markdown: string;
};

const MAX_ZIP_UNCOMPRESSED = 250 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 20_000;
const ROWS_PER_CHUNK = 25;

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
}

function toMarkdown(chunks: Chunk[]): string {
  return chunks
    .map((c) => `<!-- chunk ${c.ordinal} ${JSON.stringify(c.locator)} -->\n${c.heading ? `### ${c.heading}\n\n` : ""}${c.text}`)
    .join("\n\n");
}

function done(extractor: string, blocks: Block[], warnings: string[], partial = false): ExtractionOutcome {
  const chunks = packBlocks(blocks);
  if (chunks.length === 0) return { status: "failed", extractor, warnings: [...warnings, "no text could be extracted"], chunks: [], markdown: "" };
  return { status: partial || warnings.some((w) => w.startsWith("partial:")) ? "partially_succeeded" : "succeeded", extractor, warnings, chunks, markdown: toMarkdown(chunks) };
}

/** Reject zip bombs before handing an Office file to a parser. */
async function checkZip(bytes: Uint8Array): Promise<void> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: false });
  const files = Object.values(zip.files);
  if (files.length > MAX_ZIP_ENTRIES) throw new Error("archive has too many entries");
  let total = 0;
  for (const f of files) {
    const size = (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    total += size;
  }
  if (total > MAX_ZIP_UNCOMPRESSED) throw new Error("archive expands beyond the allowed size");
  if (files.some((f) => /vbaProject\.bin$/i.test(f.name))) throw new Error("document contains a macro project; preserved but not parsed");
}

async function extractPdf(bytes: Uint8Array): Promise<ExtractionOutcome> {
  const { getDocumentProxy, extractText } = await import("unpdf");
  // The bundled pdf.js no longer has the eval-based font path (no isEvalSupported option). Font faces are
  // disabled and no external resources are fetched; parsing runs in a time- and memory-limited worker.
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { disableFontFace: true, useSystemFonts: false, stopAtErrors: false });
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const blocks: Block[] = [];
  let emptyPages = 0;
  text.forEach((pageText, i) => {
    const t = pageText.replace(/[ \t]+\n/g, "\n").trim();
    if (t.length < 20) emptyPages++;
    for (const para of t.split(/\n\s*\n/)) if (para.trim()) blocks.push({ heading: `Page ${i + 1}`, locator: { page: i + 1 }, text: para.trim() });
  });
  const totalChars = text.join("").trim().length;
  if (totalChars < 20 * Math.max(1, totalPages)) {
    return { status: "needs_ocr", extractor: "unpdf", warnings: [`${totalPages} page(s) with little or no text layer; OCR is not configured`], chunks: [], markdown: "" };
  }
  const warnings = emptyPages > 0 ? [`partial: ${emptyPages} of ${totalPages} page(s) had no text layer (possibly scanned)`] : [];
  return done("unpdf", blocks, warnings);
}

async function htmlBlocks(html: string, warnings: string[]): Promise<Block[]> {
  const { parse } = await import("node-html-parser");
  const root = parse(html, { comment: false, blockTextElements: { script: false, style: false, noscript: false, pre: true } });
  for (const el of root.querySelectorAll("script,style,noscript,iframe,object,embed,link,meta,svg,img,template,form")) el.remove();
  const blocks: Block[] = [];
  const path: string[] = [];
  let para = 0;
  let table = 0;
  for (const el of root.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,table,td,dd,dt")) {
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      path.splice(level - 1);
      path[level - 1] = el.text.trim();
      continue;
    }
    if (tag === "td" && el.closest("table")) continue;
    const heading = path.filter(Boolean).join(" > ") || null;
    if (tag === "table") {
      table++;
      const rows = el.querySelectorAll("tr").map((tr) => tr.querySelectorAll("th,td").map((c) => c.text.trim().replace(/\s+/g, " ")).join(" | "));
      if (rows.length) blocks.push({ heading, locator: { table }, text: rows.join("\n") });
      continue;
    }
    if (el.closest("table")) continue;
    if (tag === "li" && el.querySelector("p")) continue;
    const text = el.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    para++;
    blocks.push({ heading, locator: { paragraph: para }, text: tag === "li" ? `- ${text}` : text });
  }
  if (blocks.length === 0) {
    const t = root.text.replace(/\s+/g, " ").trim();
    if (t) {
      warnings.push("partial: document structure not recognised; extracted plain text");
      blocks.push({ heading: null, locator: { paragraph: 1 }, text: t });
    }
  }
  return blocks;
}

async function extractDocx(bytes: Uint8Array): Promise<ExtractionOutcome> {
  await checkZip(bytes);
  const mammoth = (await import("mammoth")).default;
  // Images are dropped; mammoth does not run macros or fetch external resources.
  const res = await mammoth.convertToHtml(
    { buffer: Buffer.from(bytes) },
    { convertImage: mammoth.images.imgElement(async () => ({ src: "" })) },
  );
  const warnings = res.messages.filter((m) => m.type === "warning").slice(0, 10).map((m) => `docx: ${m.message.slice(0, 200)}`);
  return done("mammoth", await htmlBlocks(res.value, warnings), warnings);
}

async function extractPptx(bytes: Uint8Array): Promise<ExtractionOutcome> {
  await checkZip(bytes);
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(bytes);
  const slides = Object.keys(zip.files)
    .map((n) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(n))
    .filter((m): m is RegExpExecArray => !!m)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  const blocks: Block[] = [];
  for (const m of slides) {
    const xml = await zip.file(m[0])!.async("string");
    const paras = xml.split(/<\/a:p>/).map((p) => [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => t[1]).join("")).map(decodeEntities).filter((t) => t.trim());
    if (paras.length) blocks.push({ heading: `Slide ${m[1]}`, locator: { slide: Number(m[1]) }, text: paras.join("\n") });
    const notesName = `ppt/notesSlides/notesSlide${m[1]}.xml`;
    if (zip.file(notesName)) {
      const nx = await zip.file(notesName)!.async("string");
      const notes = [...nx.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => decodeEntities(t[1]!)).join(" ").trim();
      if (notes && !/^\d+$/.test(notes)) blocks.push({ heading: `Slide ${m[1]} notes`, locator: { slide: Number(m[1]), notes: "speaker" }, text: notes });
    }
  }
  return done("pptx-xml", blocks, []);
}

function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function colName(n: number): string {
  let s = "";
  let x = n;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

function rowsToBlocks(sheet: string | null, rows: string[][], firstRowNumber: number, warnings: string[]): Block[] {
  const blocks: Block[] = [];
  if (rows.length === 0) return blocks;
  const header = rows[0]!.map((h, i) => (h || `Column ${colName(i + 1)}`).trim());
  const width = Math.max(...rows.map((r) => r.length));
  for (let i = 1; i < rows.length; i += ROWS_PER_CHUNK) {
    const slice = rows.slice(i, i + ROWS_PER_CHUNK);
    const startRow = firstRowNumber + i;
    const endRow = startRow + slice.length - 1;
    const text = slice
      .map((r, k) => `Row ${startRow + k}: ${r.map((v, c) => (v?.trim() ? `${header[c] ?? colName(c + 1)} = ${v.trim()}` : "")).filter(Boolean).join("; ")}`)
      .join("\n");
    const locator: Locator = { range: `A${startRow}:${colName(width)}${endRow}` };
    if (sheet) locator.sheet = sheet;
    blocks.push({ heading: sheet ? `Sheet ${sheet}` : null, locator, text });
  }
  if (rows.length === 1) {
    const locator: Locator = { range: `A${firstRowNumber}:${colName(width)}${firstRowNumber}` };
    if (sheet) locator.sheet = sheet;
    blocks.push({ heading: sheet ? `Sheet ${sheet}` : null, locator, text: `Header: ${header.join(" | ")}` });
  }
  void warnings;
  return blocks;
}

async function extractCsv(bytes: Uint8Array): Promise<ExtractionOutcome> {
  const Papa = (await import("papaparse")).default;
  const res = Papa.parse<string[]>(decodeText(bytes), { skipEmptyLines: "greedy" });
  const warnings: string[] = [];
  if (res.errors.length) warnings.push(`partial: ${res.errors.length} CSV parse issue(s), e.g. row ${res.errors[0]?.row}: ${res.errors[0]?.message}`);
  if (res.data.some((r) => r.some((v) => /^[=+@-]/.test(v ?? "") && /^[=+@]/.test(v ?? "")))) {
    warnings.push("formula-like cell values were kept as plain text and not evaluated");
  }
  return done("papaparse", rowsToBlocks(null, res.data, 1, warnings), warnings);
}

async function extractXlsx(bytes: Uint8Array): Promise<ExtractionOutcome> {
  await checkZip(bytes);
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  const blocks: Block[] = [];
  const warnings: string[] = [];
  let formulas = 0;
  wb.eachSheet((ws) => {
    const rows: string[][] = [];
    let first = 0;
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (!first) first = rowNumber;
      const vals: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        const v = cell.value as unknown;
        let s = "";
        if (v == null) s = "";
        else if (typeof v === "object" && v !== null && "formula" in (v as object)) {
          formulas++;
          const r = (v as { result?: unknown }).result;
          s = r == null ? "" : String(typeof r === "object" && r && "error" in (r as object) ? (r as { error: string }).error : r);
        } else if (typeof v === "object" && v !== null && "richText" in (v as object)) {
          s = ((v as { richText: { text: string }[] }).richText ?? []).map((t) => t.text).join("");
        } else if (typeof v === "object" && v !== null && "text" in (v as object)) {
          s = String((v as { text: unknown }).text);
        } else if (v instanceof Date) s = v.toISOString().slice(0, 10);
        else s = String(v);
        vals[col - 1] = s;
      });
      rows.push(Array.from(vals, (x) => x ?? ""));
    });
    if (rows.length) blocks.push(...rowsToBlocks(ws.name, rows, first || 1, warnings));
  });
  if (formulas) warnings.push(`${formulas} formula cell(s): the stored cached value was used; formulas were not evaluated`);
  return done("exceljs", blocks, warnings);
}

function extractJson(bytes: Uint8Array): ExtractionOutcome {
  const text = decodeText(bytes);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { status: "failed", extractor: "json", warnings: [`invalid JSON: ${(e as Error).message.slice(0, 120)}`], chunks: [], markdown: "" };
  }
  const blocks: Block[] = [];
  const esc = (k: string) => k.replace(/~/g, "~0").replace(/\//g, "~1");
  const walk = (v: unknown, pointer: string, depth: number) => {
    const s = JSON.stringify(v, null, 2);
    if (s.length <= 1_200 || depth >= 6 || v === null || typeof v !== "object") {
      blocks.push({ heading: pointer || "/", locator: { json_pointer: pointer || "/" }, text: s });
      return;
    }
    if (Array.isArray(v)) for (const [i, x] of v.entries()) walk(x, `${pointer}/${i}`, depth + 1);
    else for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, `${pointer}/${esc(k)}`, depth + 1);
  };
  walk(value, "", 0);
  return done("json", blocks, []);
}

function decodeQuotedPrintable(s: string): string {
  return s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(Number.parseInt(h, 16)));
}

async function extractEml(bytes: Uint8Array): Promise<ExtractionOutcome> {
  const raw = decodeText(bytes).replace(/\r\n/g, "\n");
  const split = raw.indexOf("\n\n");
  const head = split === -1 ? raw : raw.slice(0, split);
  const body = split === -1 ? "" : raw.slice(split + 2);
  const headers = new Map<string, string>();
  for (const line of head.replace(/\n[ \t]+/g, " ").split("\n")) {
    const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (m) headers.set(m[1]!.toLowerCase(), m[2]!);
  }
  const warnings: string[] = [];
  let text = body;
  const ct = headers.get("content-type") ?? "text/plain";
  const boundary = /boundary="?([^";]+)"?/i.exec(ct)?.[1];
  const decodePart = (h: string, b: string) => {
    if (/content-transfer-encoding:\s*base64/i.test(h)) return Buffer.from(b.replace(/\s+/g, ""), "base64").toString("utf8");
    if (/content-transfer-encoding:\s*quoted-printable/i.test(h)) return decodeQuotedPrintable(b);
    return b;
  };
  if (boundary) {
    const parts = body.split(`--${boundary}`).slice(1, -1);
    const plain = parts.find((p) => /content-type:\s*text\/plain/i.test(p));
    const html = parts.find((p) => /content-type:\s*text\/html/i.test(p));
    const pick = plain ?? html;
    const attachments = parts.filter((p) => /content-disposition:\s*attachment/i.test(p)).length;
    if (attachments) warnings.push(`partial: ${attachments} attachment(s) inside the email were not extracted; upload them separately`);
    if (pick) {
      const i = pick.indexOf("\n\n");
      text = decodePart(pick.slice(0, i), pick.slice(i + 2));
      if (!plain && html) text = (await htmlBlocks(text, warnings)).map((b) => b.text).join("\n\n");
    } else text = "";
  } else {
    text = decodePart(head, body);
    if (/text\/html/i.test(ct)) text = (await htmlBlocks(text, warnings)).map((b) => b.text).join("\n\n");
  }
  const meta = ["from", "to", "cc", "date", "subject"].filter((k) => headers.has(k)).map((k) => `${k[0]!.toUpperCase()}${k.slice(1)}: ${headers.get(k)}`);
  const blocks: Block[] = [{ heading: "Email headers", locator: { part: "headers" }, text: meta.join("\n") }];
  blocks.push(...textBlocks(text, false).map((b) => ({ ...b, heading: headers.get("subject") ?? "Email body", locator: { part: "body", ...b.locator } })));
  return done("eml-basic", blocks, warnings);
}

/** Dispatch to the parser for a detected kind. Runs inside a worker thread (see run-extraction.ts). */
export async function extractDocument(bytes: Uint8Array, kind: DocKind): Promise<ExtractionOutcome> {
  switch (kind) {
    case "text":
      return done("text", textBlocks(decodeText(bytes), false), []);
    case "markdown":
      return done("markdown", textBlocks(decodeText(bytes), true), []);
    case "pdf":
      return extractPdf(bytes);
    case "docx":
      return extractDocx(bytes);
    case "pptx":
      return extractPptx(bytes);
    case "csv":
      return extractCsv(bytes);
    case "xlsx":
      return extractXlsx(bytes);
    case "json":
      return extractJson(bytes);
    case "html": {
      const warnings: string[] = [];
      return done("node-html-parser", await htmlBlocks(decodeText(bytes), warnings), warnings);
    }
    case "eml":
      return extractEml(bytes);
    case "image":
      return { status: "needs_ocr", extractor: "none", warnings: ["image content needs OCR, which is not configured on this host"], chunks: [], markdown: "" };
    default:
      return { status: "unsupported", extractor: "none", warnings: ["unsupported format; the original is preserved"], chunks: [], markdown: "" };
  }
}
