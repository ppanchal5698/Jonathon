"use client";

/** Typed error from the Jonathon API ({ error: { code, message, correlation_id } }). */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly correlationId?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;
export function setCsrf(token: string | null) {
  csrfToken = token;
}

async function ensureCsrf(): Promise<void> {
  if (csrfToken) return;
  const r = await fetch("/api/v1/auth/session", { credentials: "same-origin" });
  if (r.ok) csrfToken = ((await r.json()) as { data: { csrf_token: string } }).data.csrf_token;
}

export async function api<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  if (method !== "GET") {
    await ensureCsrf();
    if (csrfToken) headers["x-csrf-token"] = csrfToken;
  }
  const res = await fetch(`/api/v1${path}`, { method, headers, body: payload, credentials: "same-origin" });
  const json = (await res.json().catch(() => null)) as {
    data?: T;
    error?: { code: string; message: string; correlation_id?: string; details?: unknown };
  } | null;
  if (!res.ok || !json || json.error) {
    const e = json?.error;
    if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/auth/") && !path.startsWith("/setup/")) {
      window.location.href = "/login";
    }
    throw new ApiError(e?.code ?? "HTTP_ERROR", e?.message ?? `Request failed (${res.status})`, res.status, e?.correlation_id, e?.details);
  }
  return json.data as T;
}

export const get = <T>(path: string) => api<T>("GET", path);
export const post = <T>(path: string, body?: unknown) => api<T>("POST", path, body ?? {});
