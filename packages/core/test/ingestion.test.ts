import { detectType, extractDocument, runExtraction } from "@jonathon/core";
import { buildBusinessRulesXlsx } from "../../test-fixtures/src/index";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

const enc = (s: string) => new TextEncoder().encode(s);

/** Minimal text-layer PDF with one page per string. */
export function makePdf(pages: string[]): Uint8Array {
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  const fontId = 3 + pages.length * 2;
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  pages.forEach((text, i) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, "")}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return enc(out);
}

export async function makeDocx(paragraphs: { style?: string; text: string }[]): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
  );
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file("word/styles.xml", `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`);
  const body = paragraphs
    .map((p) => `<w:p>${p.style ? `<w:pPr><w:pStyle w:val="${p.style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${p.text}</w:t></w:r></w:p>`)
    .join("");
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
}

describe("type detection", () => {
  it("uses content and extension together", () => {
    expect(detectType(enc("%PDF-1.4"), "pdf").kind).toBe("pdf");
    expect(detectType(enc("%PDF-1.4"), "txt").kind).toBe("unsupported");
    expect(detectType(enc("hello"), "pdf").kind).toBe("unsupported");
    expect(detectType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]), "png").kind).toBe("image");
    expect(detectType(enc("x"), "docm").kind).toBe("unsupported");
    expect(detectType(enc("x"), "exe").kind).toBe("unsupported");
    expect(detectType(new Uint8Array([1, 2, 0, 4]), "txt").kind).toBe("unsupported");
    expect(detectType(enc("# T"), "md").kind).toBe("markdown");
  });
});

describe("extractors keep locators", () => {
  it("markdown: heading paths and line numbers", async () => {
    const r = await extractDocument(enc("# Accounts\n\n## Verification\n\nCustomers must verify email.\n"), "markdown");
    const c = r.chunks.find((x) => x.text.includes("must verify"))!;
    expect(c.heading).toBe("Accounts > Verification");
    // The heading line and its paragraph are packed into one chunk, so the locator is a line range.
    const start = Number(c.locator.line ?? c.locator.line_start);
    const end = Number(c.locator.line ?? c.locator.line_end);
    expect(start).toBeLessThanOrEqual(5);
    expect(end).toBeGreaterThanOrEqual(5);
  });

  it("PDF: page numbers, and needs_ocr for a page without text", async () => {
    const r = await runExtraction(makePdf(["First page about invoices.", "Second page says passwords need 12 characters."]), "pdf", { timeoutMs: 20_000 });
    expect(r.status).toBe("succeeded");
    expect(r.chunks.find((c) => c.text.includes("12 characters"))?.locator.page).toBe(2);
    const scanned = await runExtraction(makePdf([""]), "pdf", { timeoutMs: 20_000 });
    expect(scanned.status).toBe("needs_ocr");
  });

  it("DOCX: headings and paragraphs (in a worker thread)", async () => {
    const bytes = await makeDocx([{ style: "Heading1", text: "Email verification" }, { text: "The link must be sent after sign-up." }]);
    const r = await runExtraction(bytes, "docx", { timeoutMs: 20_000 });
    expect(r.status).toBe("succeeded");
    const c = r.chunks.find((x) => x.text.includes("link must be sent"))!;
    expect(c.heading).toBe("Email verification");
    expect(c.locator.paragraph).toBe(1);
  });

  it("XLSX: sheet names and cell ranges; formulas not evaluated", async () => {
    const r = await runExtraction(await buildBusinessRulesXlsx(), "xlsx", { timeoutMs: 20_000 });
    expect(r.status).toBe("succeeded");
    const c = r.chunks.find((x) => x.text.includes("Minimum password length"))!;
    expect(c.locator.sheet).toBe("Business rules");
    expect(String(c.locator.range)).toMatch(/^A2:D/);
    expect(r.warnings.join(" ")).toMatch(/formulas were not evaluated/);
  });

  it("CSV, JSON, HTML (scripts removed), EML", async () => {
    const csv = await extractDocument(enc("Rule,Value\nPassword,12\nLockout,=1+1\n"), "csv");
    expect(csv.chunks[0]!.locator.range).toBe("A2:B3");
    expect(csv.warnings.join(" ")).toMatch(/not evaluated/);
    const json = await extractDocument(enc(JSON.stringify({ auth: { expiry: "unknown" }, list: [1, 2] })), "json");
    expect(json.chunks.length).toBeGreaterThan(0);
    const html = await extractDocument(enc("<h1>Spec</h1><script>alert(1)</script><p>Visible text.</p><img src='http://x/y.png'>"), "html");
    expect(html.markdown).toContain("Visible text.");
    expect(html.markdown).not.toContain("alert");
    const eml = await extractDocument(enc("From: a@b.example\nSubject: Follow-up\n\nPlease add a resend button.\n"), "eml");
    expect(eml.markdown).toContain("Subject: Follow-up");
    expect(eml.markdown).toContain("resend button");
  });

  it("PPTX slides", async () => {
    const zip = new JSZip();
    zip.file("ppt/slides/slide1.xml", "<p:sld><a:p><a:r><a:t>Roadmap</a:t></a:r></a:p><a:p><a:r><a:t>Portal launch &amp; invoices</a:t></a:r></a:p></p:sld>");
    const r = await runExtraction(new Uint8Array(await zip.generateAsync({ type: "uint8array" })), "pptx", { timeoutMs: 20_000 });
    expect(r.chunks[0]!.locator.slide).toBe(1);
    expect(r.chunks[0]!.text).toContain("Portal launch & invoices");
  });

  it("images need OCR; unknown binaries are unsupported; macro archives are refused", async () => {
    expect((await extractDocument(new Uint8Array([0x89, 0x50]), "image")).status).toBe("needs_ocr");
    expect((await extractDocument(new Uint8Array([1]), "unsupported")).status).toBe("unsupported");
    const zip = new JSZip();
    zip.file("word/vbaProject.bin", "x");
    await expect(runExtraction(new Uint8Array(await zip.generateAsync({ type: "uint8array" })), "docx", { timeoutMs: 20_000 })).rejects.toThrow(/macro/);
  });
});
