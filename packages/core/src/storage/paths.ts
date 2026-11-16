import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { AppError } from "../util";

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Validate one path segment that Jonathon will use on disk. Only generated IDs, human IDs and fixed names
 * pass. Client-supplied filenames never become path segments (they are kept in metadata only).
 * Rejects: traversal, encoded traversal (%), separators, drive/ADS colons, NUL, leading dots,
 * Windows reserved device names and trailing dots/spaces.
 */
export function assertSafeSegment(segment: string): string {
  if (
    typeof segment !== "string" ||
    !SAFE_SEGMENT.test(segment) ||
    segment.includes("..") ||
    WINDOWS_RESERVED.test(segment) ||
    /[. ]$/.test(segment)
  ) {
    throw new AppError("UNSAFE_PATH", "unsafe path segment rejected", { details: { segment: String(segment).slice(0, 80) } });
  }
  return segment;
}

export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(sep));
}

/**
 * Resolve `segments` under `root`, refusing anything that escapes it, including through
 * symlinks or junctions on any existing component.
 */
export function resolveInside(root: string, ...segments: string[]): string {
  for (const s of segments) assertSafeSegment(s);
  const absRoot = resolve(root);
  const target = resolve(absRoot, ...segments);
  if (!isInside(target, absRoot)) throw new AppError("UNSAFE_PATH", "path escapes the data root");
  // Walk every existing component below the root: no symlinks/junctions allowed.
  let cur = absRoot;
  for (const s of segments) {
    cur = join(cur, s);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(cur);
    } catch {
      break; // does not exist yet; deeper components cannot exist either
    }
    if (st.isSymbolicLink()) throw new AppError("UNSAFE_PATH", "symlink in storage path rejected");
  }
  // Defence in depth: the real path of the root must contain the real path of the deepest existing ancestor.
  try {
    const realRoot = realpathSync.native(absRoot);
    let probe = target;
    for (;;) {
      try {
        const real = realpathSync.native(probe);
        if (!isInside(real, realRoot)) throw new AppError("UNSAFE_PATH", "path resolves outside the data root");
        break;
      } catch (e) {
        if (e instanceof AppError) throw e;
        const parent = resolve(probe, "..");
        if (parent === probe || !isInside(parent, absRoot)) break;
        probe = parent;
      }
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
  }
  return target;
}

export function ensureDirInside(root: string, ...segments: string[]): string {
  const p = resolveInside(root, ...segments);
  mkdirSync(p, { recursive: true });
  // Re-check after creation (a racing symlink would be caught here).
  return resolveInside(root, ...segments);
}

/** Clean a client-provided display filename for metadata and UI. Never used as a path. */
export function sanitizeDisplayName(name: string): string {
  const base = String(name ?? "")
    .replace(/[\\/]+/g, "/")
    .split("/")
    .pop()!
    .normalize("NFKC")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars on purpose
    .replace(/[\u0000-\u001f\u007f<>:"|?*‪-‮⁦-⁩]/g, "")
    .trim();
  const clean = base.replace(/^\.+/, "").slice(0, 200);
  return clean.length > 0 ? clean : "untitled";
}

/** Lowercase extension from a display name, limited to a safe charset. */
export function safeExtension(name: string): string {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  return m ? m[1]!.toLowerCase() : "bin";
}
