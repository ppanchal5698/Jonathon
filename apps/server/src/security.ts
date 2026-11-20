import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError, type JonathonApp, type Principal, type SessionInfo } from "@jonathon/core";

export const SESSION_COOKIE = "jon_session";

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
    session?: SessionInfo;
  }
}

/** Hosts we answer to. Anything else is a DNS-rebinding attempt or a misconfiguration. */
export function allowedHosts(port: number, webOrigins: string[]): Set<string> {
  const hosts = new Set<string>([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  for (const o of webOrigins) {
    try {
      hosts.add(new URL(o).host);
    } catch {
      /* ignore malformed */
    }
  }
  return hosts;
}

/** Google redirects the browser here (a cross-site top-level GET); it is protected by state + PKCE + the binder cookie. */
export const GOOGLE_CALLBACK_PATH = "/api/v1/auth/google/callback";

export function checkHostAndOrigin(req: FastifyRequest, hosts: Set<string>, origins: Set<string>): void {
  const host = (req.headers.host ?? "").toLowerCase();
  if (!hosts.has(host)) throw new AppError("FORBIDDEN", "invalid Host header");
  const origin = req.headers.origin;
  // Browsers send Origin on cross-origin requests and on all POSTs. Non-browser clients (MCP, curl) may omit it.
  if (origin && origin !== "null" && !origins.has(origin)) throw new AppError("FORBIDDEN", "cross-origin request rejected");
  if (origin === "null") throw new AppError("FORBIDDEN", "opaque origin rejected");
  const site = req.headers["sec-fetch-site"];
  const googleReturn = req.method === "GET" && req.url.split("?")[0] === GOOGLE_CALLBACK_PATH;
  if (site === "cross-site" && !googleReturn) throw new AppError("FORBIDDEN", "cross-site request rejected");
}

export function readCookie(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      return undefined; // malformed %-escape: treat as no cookie (401), never a 500
    }
  }
  return undefined;
}

export function sessionCookie(token: string, maxAgeSec: number): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/** Cookie-authenticated user. Mutations also require the session's CSRF token in X-CSRF-Token. */
export function requireUser(app: JonathonApp, req: FastifyRequest): Extract<Principal, { kind: "user" }> {
  const s = app.auth.resolveSession(readCookie(req, SESSION_COOKIE));
  if (!s) throw new AppError("UNAUTHENTICATED", "sign in required");
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (mutating) {
    const header = req.headers["x-csrf-token"];
    if (typeof header !== "string" || header.length !== s.csrfToken.length || header !== s.csrfToken) {
      throw new AppError("FORBIDDEN", "missing or invalid CSRF token");
    }
  }
  req.session = s;
  const p = { kind: "user" as const, userId: s.userId, username: s.username };
  req.principal = p;
  return p;
}

export function securityHeaders(reply: FastifyReply): void {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Cross-Origin-Resource-Policy", "same-origin");
  reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; sandbox");
  reply.header("Cache-Control", "no-store");
}
