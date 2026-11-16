import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { audit } from "../audit";
import { all, type Db, one, run, tx } from "../db";
import { AppError, newId, nowIso, parseJson, randomToken, sha256 } from "../util";
import type { McpScope, Principal } from "./principal";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, saltB64, keyB64] = stored.split("$");
  if (alg !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const key = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export interface SessionInfo {
  sessionId: string;
  userId: string;
  username: string;
  csrfToken: string;
  expiresAt: string;
}

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly sessionTtlHours: number,
  ) {}

  isSetUp(): boolean {
    return !!one(this.db, "SELECT id FROM users LIMIT 1");
  }

  async createAccount(username: string, password: string): Promise<{ userId: string }> {
    const hash = await hashPassword(password);
    return tx(this.db, () => {
      if (this.isSetUp()) throw new AppError("ALREADY_SET_UP", "the local account already exists");
      const id = newId("usr");
      run(this.db, "INSERT INTO users (id, username, password_hash, created_at) VALUES (?,?,?,?)", id, username, hash, nowIso());
      audit(this.db, { principal: { kind: "user", userId: id, username }, action: "account.created" });
      return { userId: id };
    });
  }

  /** Simple lockout: more than 10 failures in 15 minutes for a username → RATE_LIMITED. */
  async login(username: string, password: string): Promise<{ token: string; session: SessionInfo }> {
    const since = new Date(Date.now() - 15 * 60_000).toISOString();
    const failures = one<{ n: number }>(
      this.db,
      "SELECT COUNT(*) AS n FROM login_attempts WHERE username = ? AND at > ? AND success = 0",
      username,
      since,
    )!.n;
    if (failures >= 10) throw new AppError("RATE_LIMITED", "too many failed sign-in attempts; wait 15 minutes");
    const user = one<{ id: string; username: string; password_hash: string }>(this.db, "SELECT * FROM users WHERE username = ?", username);
    // Verify against a dummy hash when the user does not exist to keep timing similar.
    let ok = false;
    if (user) ok = await verifyPassword(password, user.password_hash);
    else await verifyPassword(password, "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    run(this.db, "INSERT INTO login_attempts (username, at, success) VALUES (?,?,?)", username, nowIso(), ok ? 1 : 0);
    if (!ok || !user) throw new AppError("UNAUTHENTICATED", "invalid username or password");
    const token = randomToken(32);
    const csrf = randomToken(24);
    const now = nowIso();
    const expiresAt = new Date(Date.now() + this.sessionTtlHours * 3_600_000).toISOString();
    const sessionId = newId("ses");
    run(
      this.db,
      "INSERT INTO sessions (id, user_id, token_hash, csrf_token, created_at, expires_at, last_seen_at) VALUES (?,?,?,?,?,?,?)",
      sessionId,
      user.id,
      sha256(token),
      csrf,
      now,
      expiresAt,
      now,
    );
    audit(this.db, { principal: { kind: "user", userId: user.id, username: user.username }, action: "session.login" });
    return { token, session: { sessionId, userId: user.id, username: user.username, csrfToken: csrf, expiresAt } };
  }

  resolveSession(token: string | undefined): SessionInfo | null {
    if (!token || token.length > 200) return null;
    const row = one<{ id: string; user_id: string; username: string; csrf_token: string; expires_at: string }>(
      this.db,
      `SELECT s.id, s.user_id, u.username, s.csrf_token, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
      sha256(token),
    );
    if (!row) return null;
    if (row.expires_at < nowIso()) {
      run(this.db, "DELETE FROM sessions WHERE id = ?", row.id);
      return null;
    }
    run(this.db, "UPDATE sessions SET last_seen_at = ? WHERE id = ?", nowIso(), row.id);
    return { sessionId: row.id, userId: row.user_id, username: row.username, csrfToken: row.csrf_token, expiresAt: row.expires_at };
  }

  logout(sessionId: string): void {
    run(this.db, "DELETE FROM sessions WHERE id = ?", sessionId);
  }

  // ---------- MCP tokens ----------

  createMcpToken(
    principal: Principal,
    input: { name: string; projectIds: string[]; scopes: McpScope[]; expiresInDays?: number; rotatedFrom?: string },
  ): { id: string; token: string; prefix: string } {
    const secret = randomToken(32);
    const token = `jon_${secret}`;
    const id = newId("tok");
    const expires = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString() : null;
    tx(this.db, () => {
      for (const pid of input.projectIds) {
        if (!one(this.db, "SELECT id FROM projects WHERE id = ?", pid)) throw new AppError("PROJECT_NOT_FOUND", `project ${pid} not found`);
      }
      run(
        this.db,
        `INSERT INTO mcp_tokens (id, name, token_hash, token_prefix, scopes, project_ids, created_by, created_at, expires_at, rotated_from)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        id,
        input.name,
        sha256(token),
        token.slice(0, 10),
        JSON.stringify([...new Set(input.scopes)]),
        JSON.stringify([...new Set(input.projectIds)]),
        principal.kind === "user" ? principal.userId : "system",
        nowIso(),
        expires,
        input.rotatedFrom ?? null,
      );
      audit(this.db, {
        principal,
        action: "mcp_token.created",
        entityType: "mcp_token",
        entityId: id,
        details: { name: input.name, scopes: input.scopes, project_ids: input.projectIds },
      });
    });
    return { id, token, prefix: token.slice(0, 10) };
  }

  rotateMcpToken(principal: Principal, tokenId: string): { id: string; token: string; prefix: string } {
    const t = one<{ name: string; scopes: string; project_ids: string; expires_at: string | null; revoked_at: string | null }>(
      this.db,
      "SELECT * FROM mcp_tokens WHERE id = ?",
      tokenId,
    );
    if (!t || t.revoked_at) throw new AppError("NOT_FOUND", "token not found or already revoked");
    const created = this.createMcpToken(principal, {
      name: t.name,
      projectIds: parseJson(t.project_ids, []),
      scopes: parseJson(t.scopes, []),
      rotatedFrom: tokenId,
    });
    this.revokeMcpToken(principal, tokenId);
    return created;
  }

  revokeMcpToken(principal: Principal, tokenId: string): void {
    const r = run(this.db, "UPDATE mcp_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", nowIso(), tokenId);
    if (r.changes === 0) throw new AppError("NOT_FOUND", "token not found or already revoked");
    audit(this.db, { principal, action: "mcp_token.revoked", entityType: "mcp_token", entityId: tokenId });
  }

  listMcpTokens(): Array<Record<string, unknown>> {
    return all<Record<string, unknown>>(
      this.db,
      "SELECT id, name, token_prefix, scopes, project_ids, created_at, expires_at, revoked_at, rotated_from, last_used_at FROM mcp_tokens ORDER BY created_at DESC",
    ).map((r) => ({ ...r, scopes: parseJson(r.scopes as string, []), project_ids: parseJson(r.project_ids as string, []) }));
  }

  mcpAccessLog(tokenId: string, limit = 100): Array<Record<string, unknown>> {
    return all(this.db, "SELECT at, tool, project_id, outcome, error_code FROM mcp_access_log WHERE token_id = ? ORDER BY at DESC LIMIT ?", tokenId, limit);
  }

  resolveMcpToken(bearer: string | undefined): Extract<Principal, { kind: "mcp_token" }> | null {
    if (!bearer?.startsWith("jon_") || bearer.length > 200) return null;
    const t = one<{ id: string; name: string; scopes: string; project_ids: string; expires_at: string | null; revoked_at: string | null }>(
      this.db,
      "SELECT * FROM mcp_tokens WHERE token_hash = ?",
      sha256(bearer),
    );
    if (!t || t.revoked_at) return null;
    if (t.expires_at && t.expires_at < nowIso()) return null;
    run(this.db, "UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?", nowIso(), t.id);
    return {
      kind: "mcp_token",
      tokenId: t.id,
      name: t.name,
      projectIds: parseJson<string[]>(t.project_ids, []),
      scopes: parseJson<McpScope[]>(t.scopes, []),
    };
  }

  logMcpAccess(tokenId: string, tool: string, projectId: string | null, outcome: string, errorCode: string | null, correlationId?: string): void {
    run(
      this.db,
      "INSERT INTO mcp_access_log (id, token_id, at, tool, project_id, outcome, error_code, correlation_id) VALUES (?,?,?,?,?,?,?,?)",
      newId("mal"),
      tokenId,
      nowIso(),
      tool,
      projectId,
      outcome,
      errorCode,
      correlationId ?? null,
    );
  }
}
