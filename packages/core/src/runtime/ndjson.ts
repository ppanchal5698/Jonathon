/**
 * Incremental NDJSON parser. Handles records split across chunks, multi-byte UTF-8 characters split across
 * chunks, CRLF line endings and a maximum line length. Invalid JSON lines are reported, not thrown.
 */
export class NdjsonParser {
  private buf = "";
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });

  constructor(
    private readonly onRecord: (value: unknown) => void,
    private readonly onInvalid: (line: string, reason: string) => void,
    private readonly maxLineBytes = 8 * 1024 * 1024,
  ) {}

  push(chunk: Uint8Array | string): void {
    this.buf += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    let nl = this.buf.indexOf("\n");
    while (nl !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this.handle(line);
      nl = this.buf.indexOf("\n");
    }
    if (this.buf.length > this.maxLineBytes) {
      this.onInvalid(this.buf.slice(0, 200), "line exceeds maximum length");
      this.buf = "";
    }
  }

  end(): void {
    this.buf += this.decoder.decode();
    if (this.buf.trim()) this.handle(this.buf);
    this.buf = "";
  }

  private handle(raw: string): void {
    const line = raw.replace(/\r$/, "").trim();
    if (!line) return;
    try {
      this.onRecord(JSON.parse(line));
    } catch {
      this.onInvalid(line.slice(0, 200), "invalid JSON");
    }
  }
}
