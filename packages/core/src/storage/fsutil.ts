import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { AppError } from "../util";

function writeTemp(dir: string, data: string | Uint8Array): string {
  const tmp = join(dir, `.tmp-${randomBytes(8).toString("hex")}`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return tmp;
}

function fsyncDir(dir: string): void {
  if (process.platform === "win32") return; // directories cannot be fsynced on Windows
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* best effort */
  }
}

/** Write-then-rename in the same directory. Readers see the old or the new file, never a partial one. */
export function writeFileAtomic(path: string, data: string | Uint8Array): void {
  const dir = dirname(path);
  const tmp = writeTemp(dir, data);
  try {
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new AppError("STORAGE_UNAVAILABLE", "atomic replace failed", { cause: e, retryable: true });
  }
  fsyncDir(dir);
}

/**
 * Create a file that must not already exist (immutable originals, history revisions).
 * Uses a hard link from a fully written temp file, so the final name appears only with complete content.
 */
export function writeFileCreateOnly(path: string, data: string | Uint8Array): void {
  const dir = dirname(path);
  const tmp = writeTemp(dir, data);
  try {
    try {
      linkSync(tmp, path);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw new AppError("REVISION_CONFLICT", "immutable file already exists");
      // Filesystems without hard links: fall back to exclusive check + rename (small race window, documented).
      if (existsSync(path)) throw new AppError("REVISION_CONFLICT", "immutable file already exists");
      renameSync(tmp, path);
      return;
    }
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
  fsyncDir(dir);
}

export function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new AppError("STORAGE_UNAVAILABLE", "could not read file", { cause: e, retryable: true });
  }
}
