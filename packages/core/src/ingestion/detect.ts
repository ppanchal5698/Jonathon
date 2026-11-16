export type DocKind =
  | "text"
  | "markdown"
  | "pdf"
  | "docx"
  | "pptx"
  | "csv"
  | "xlsx"
  | "json"
  | "html"
  | "eml"
  | "image"
  | "unsupported";

export interface Detected {
  kind: DocKind;
  mediaType: string;
  reason: string | null;
}

const MEDIA: Record<string, string> = {
  txt: "text/plain",
  text: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  eml: "message/rfc822",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  tif: "image/tiff",
  tiff: "image/tiff",
};

/** Formats that may carry macros or active content. Preserved, never parsed. */
const ACTIVE_CONTENT = new Set(["docm", "xlsm", "xlsb", "pptm", "dotm", "xltm", "exe", "dll", "js", "vbs", "ps1", "bat", "cmd", "sh", "jar", "msi", "scr", "hta"]);

function startsWith(b: Uint8Array, sig: number[]): boolean {
  return sig.every((v, i) => b[i] === v);
}

function looksLikeText(b: Uint8Array): boolean {
  const n = Math.min(b.length, 8192);
  for (let i = 0; i < n; i++) if (b[i] === 0) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(0, n));
    return true;
  } catch {
    // Truncation in the middle of a multi-byte char at the boundary is fine; retry with the whole buffer if small.
    if (b.length <= 8192) return false;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(0, n - 4));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Detect the document type from the extension AND the content. A mismatch (e.g. a ".pdf" that is not a PDF)
 * is reported as unsupported rather than guessed.
 */
export function detectType(bytes: Uint8Array, extension: string): Detected {
  const ext = extension.toLowerCase();
  const media = MEDIA[ext] ?? "application/octet-stream";
  if (ACTIVE_CONTENT.has(ext)) return { kind: "unsupported", mediaType: media, reason: `.${ext} files can contain macros or executable content; preserved but not parsed` };
  const isZip = startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return ext === "pdf" ? { kind: "pdf", mediaType: media, reason: null } : { kind: "unsupported", mediaType: "application/pdf", reason: "PDF content with a non-.pdf extension" };
  }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) || startsWith(bytes, [0xff, 0xd8, 0xff]) || startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) {
    return { kind: "image", mediaType: media, reason: "image content requires OCR" };
  }
  if (["png", "jpg", "jpeg", "gif", "webp", "tif", "tiff"].includes(ext)) return { kind: "image", mediaType: media, reason: "image content requires OCR" };
  if (isZip) {
    if (ext === "docx") return { kind: "docx", mediaType: media, reason: null };
    if (ext === "xlsx") return { kind: "xlsx", mediaType: media, reason: null };
    if (ext === "pptx") return { kind: "pptx", mediaType: media, reason: null };
    return { kind: "unsupported", mediaType: media, reason: "ZIP-based file of an unsupported type" };
  }
  if (["docx", "xlsx", "pptx", "pdf"].includes(ext)) return { kind: "unsupported", mediaType: media, reason: `content does not match the .${ext} format` };
  if (!looksLikeText(bytes)) return { kind: "unsupported", mediaType: media, reason: "binary content of an unsupported type" };
  switch (ext) {
    case "md":
    case "markdown":
      return { kind: "markdown", mediaType: media, reason: null };
    case "csv":
      return { kind: "csv", mediaType: media, reason: null };
    case "json":
      return { kind: "json", mediaType: media, reason: null };
    case "html":
    case "htm":
      return { kind: "html", mediaType: media, reason: null };
    case "eml":
      return { kind: "eml", mediaType: media, reason: null };
    case "txt":
    case "text":
    case "log":
    case "bin":
      return { kind: "text", mediaType: "text/plain", reason: null };
    default:
      return { kind: "unsupported", mediaType: media, reason: `.${ext} is not a supported text format` };
  }
}
