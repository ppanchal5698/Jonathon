import { audit } from "../audit";
import { all, one, run, tx } from "../db";
import type { Logger } from "../logger";
import { AntigravityCliRuntime } from "../runtime/antigravity";
import { AUTH_CODE_RE } from "../runtime/agy-auth";
import { assertHuman, type Principal } from "../security/principal";
import { AppError, newId, nowIso, parseJson, sleep } from "../util";
import type { Ctx } from "./context";
import type { OpsService } from "./ops";

/**
 * "Sign in with Google" / "Sign out" for the Antigravity CLI running in the Docker worker.
 *
 * The API never runs agy (JONATHON_RUNTIME_IN_WORKER). It records a request in runtime_auth_requests; the worker's
 * RuntimeAuthAgent claims it, runs agy in the worker (whose $HOME is the dedicated JONATHON_AGY_HOME volume), and
 * writes the outcome back. Only the signed-in human can start, follow, answer or cancel a request. MCP tokens and the
 * system principal are refused. The Google password is typed on Google's own page, never into Jonathon.
 */

export type AuthAction = "sign_in" | "sign_out" | "check";
export type AuthStatus = "pending" | "running" | "awaiting_code" | "verifying" | "succeeded" | "failed" | "cancelled" | "expired";
const ACTIVE: AuthStatus[] = ["pending", "running", "awaiting_code", "verifying"];

interface Row {
  id: string;
  action: AuthAction;
  status: AuthStatus;
  auth_url: string | null;
  code: string | null;
  detail: string | null;
  error_code: string | null;
  requested_by_id: string;
  requested_by_name: string;
  worker_id: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

export interface AuthRequestView {
  id: string;
  action: AuthAction;
  status: AuthStatus;
  /** Google's sign-in page; present only while the request waits for the code. */
  auth_url: string | null;
  expires_at: string | null;
  detail: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

/** agy waits 60 s for the code after printing the link; Jonathon stops accepting it a little earlier. */
export const CODE_WINDOW_MS = 55_000;
/** A request nobody picked up (worker stopped) expires after this. */
const PICKUP_MS = 30_000;

function view(r: Row): AuthRequestView {
  const waiting = r.status === "awaiting_code" && (!r.expires_at || r.expires_at > nowIso());
  return {
    id: r.id,
    action: r.action,
    status: r.status,
    auth_url: waiting ? r.auth_url : null,
    expires_at: r.expires_at,
    detail: r.detail,
    error_code: r.error_code,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export class RuntimeAuthService {
  constructor(private readonly ctx: Ctx) {}

  /** Whether this deployment manages agy's sign-in (Docker, live mode). */
  available(): boolean {
    return this.ctx.config.runtimeInWorker && this.ctx.config.mode === "live";
  }

  // ------------------------------------------------------------------ API side

  status(principal: Principal): { available: boolean; mode: string; runtime: Record<string, unknown> | null; request: AuthRequestView | null } {
    assertHuman(principal);
    this.expireStale();
    const rt = one<{ status: string; checked_at: string; details: string }>(this.ctx.db, "SELECT * FROM integration_health WHERE name = 'runtime'");
    const last = one<Row>(this.ctx.db, "SELECT * FROM runtime_auth_requests ORDER BY created_at DESC LIMIT 1");
    return {
      available: this.available(),
      mode: this.ctx.config.mode,
      runtime: rt ? { status: rt.status, checked_at: rt.checked_at, ...parseJson<Record<string, unknown>>(rt.details, {}) } : null,
      request: last ? view(last) : null,
    };
  }

  /** Start sign-in, sign-out or an authentication check. Returns the already-active request instead of a second one. */
  request(principal: Principal, action: AuthAction, correlationId?: string): AuthRequestView {
    assertHuman(principal);
    if (action !== "check" && !this.available()) {
      throw new AppError(
        "INVALID_TRANSITION",
        this.ctx.config.mode !== "live"
          ? "Sign-in is only needed in live mode (JONATHON_DOCKER_MODE=live)."
          : "Jonathon manages the Antigravity sign-in only in the Docker worker. Natively, run agy in a terminal to sign in.",
      );
    }
    this.expireStale();
    return tx(this.ctx.db, () => {
      const active = one<Row>(this.ctx.db, `SELECT * FROM runtime_auth_requests WHERE status IN (${ACTIVE.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT 1`, ...ACTIVE);
      if (active) return view(active);
      const id = newId("rta");
      const now = nowIso();
      run(
        this.ctx.db,
        "INSERT INTO runtime_auth_requests (id, action, status, requested_by_id, requested_by_name, created_at, updated_at) VALUES (?,?, 'pending', ?,?,?,?)",
        id,
        action,
        principal.userId,
        principal.username,
        now,
        now,
      );
      if (action !== "check") audit(this.ctx.db, { principal, action: `runtime.${action}_requested`, entityType: "runtime_auth", entityId: id, correlationId: correlationId ?? null });
      return view(one<Row>(this.ctx.db, "SELECT * FROM runtime_auth_requests WHERE id = ?", id)!);
    });
  }

  get(principal: Principal, id: string): AuthRequestView {
    assertHuman(principal);
    this.expireStale();
    const r = one<Row>(this.ctx.db, "SELECT * FROM runtime_auth_requests WHERE id = ?", id);
    if (!r) throw new AppError("NOT_FOUND", "sign-in request not found");
    return view(r);
  }

  /** The person pasted the code shown by Google's callback page. Accepted once, only while the request waits for it. */
  submitCode(principal: Principal, id: string, code: string): AuthRequestView {
    assertHuman(principal);
    const c = code.trim();
    if (!AUTH_CODE_RE.test(c)) throw new AppError("VALIDATION_FAILED", "paste the whole authorization code shown after you signed in");
    return tx(this.ctx.db, () => {
      const r = one<Row>(this.ctx.db, "SELECT * FROM runtime_auth_requests WHERE id = ?", id);
      if (!r) throw new AppError("NOT_FOUND", "sign-in request not found");
      if (r.action !== "sign_in" || r.status !== "awaiting_code" || r.code) throw new AppError("INVALID_TRANSITION", "this sign-in is not waiting for a code; start again");
      if (r.expires_at && r.expires_at <= nowIso()) throw new AppError("INVALID_TRANSITION", "the sign-in link expired; start again");
      run(this.ctx.db, "UPDATE runtime_auth_requests SET code = ?, status = 'verifying', updated_at = ? WHERE id = ?", c, nowIso(), id);
      return view(one<Row>(this.ctx.db, "SELECT * FROM runtime_auth_requests WHERE id = ?", id)!);
    });
  }

  cancel(principal: Principal, id: string): AuthRequestView {
    assertHuman(principal);
    run(
      this.ctx.db,
      `UPDATE runtime_auth_requests SET status = 'cancelled', code = NULL, detail = 'cancelled', updated_at = ? WHERE id = ? AND status IN (${ACTIVE.map(() => "?").join(",")})`,
      nowIso(),
      id,
      ...ACTIVE,
    );
    return this.get(principal, id);
  }

  /** Docker API: runtime diagnostics come from the worker. With auth, ask the worker to check and wait for it. */
  async diagnostics(principal: Principal, includeAuth: boolean): Promise<Record<string, unknown>> {
    assertHuman(principal);
    if (includeAuth) {
      const req = this.request(principal, "check");
      const end = Date.now() + 45_000;
      for (;;) {
        const r = this.get(principal, req.id);
        if (!ACTIVE.includes(r.status)) break;
        if (Date.now() > end) throw new AppError("ANTIGRAVITY_UNAVAILABLE", "the worker did not answer; check that it is running", { retryable: true });
        await sleep(500);
      }
    }
    const s = this.status(principal);
    if (!s.runtime) return { status: "unchecked", provider: "antigravity-cli", installation: { installed: false, executable: "agy (worker)", version: null, error: "the worker has not reported yet" }, capabilities: null, auth: null, auth_checked: false, location: "worker" };
    return { ...s.runtime, location: "worker" };
  }

  private expireStale(): void {
    const now = Date.now();
    const rows = all<Row>(this.ctx.db, `SELECT * FROM runtime_auth_requests WHERE status IN (${ACTIVE.map(() => "?").join(",")})`, ...ACTIVE);
    for (const r of rows) {
      const pickupLate = r.status === "pending" && now - Date.parse(r.created_at) > PICKUP_MS;
      const codeLate = r.status === "awaiting_code" && r.expires_at && Date.parse(r.expires_at) < now;
      const stuck = now - Date.parse(r.updated_at) > 5 * 60_000;
      if (pickupLate || codeLate || stuck) {
        run(
          this.ctx.db,
          "UPDATE runtime_auth_requests SET status = 'expired', code = NULL, detail = ?, updated_at = ? WHERE id = ? AND status = ?",
          pickupLate ? "the worker did not pick this up; is it running?" : codeLate ? "the sign-in link expired before a code was entered; start again" : "no progress for 5 minutes",
          nowIso(),
          r.id,
          r.status,
        );
      }
    }
  }
}

// -------------------------------------------------------------------- worker side

/**
 * Worker loop: claims one runtime-auth request at a time and performs it with the worker's agy. Runs only when the
 * worker owns a dedicated agy home (JONATHON_AGY_HOME, containers only).
 */
export class RuntimeAuthAgent {
  readonly workerId = newId("wra");
  private stopping = false;
  private loop: Promise<void> | null = null;
  private current: AbortController | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly ops: OpsService,
    private readonly log: Logger,
    private readonly pollMs = 500,
  ) {}

  start(): void {
    this.loop = this.mainLoop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.current?.abort();
    await this.loop;
  }

  private claim(): Row | null {
    return tx(this.ctx.db, () => {
      const r = one<Row>(this.ctx.db, "SELECT * FROM runtime_auth_requests WHERE status = 'pending' ORDER BY created_at LIMIT 1");
      if (!r) return null;
      run(this.ctx.db, "UPDATE runtime_auth_requests SET status = 'running', worker_id = ?, updated_at = ? WHERE id = ?", this.workerId, nowIso(), r.id);
      return { ...r, status: "running" };
    });
  }

  private async mainLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        const r = this.claim();
        if (r) await this.handle(r);
      } catch (e) {
        this.log.error({ err: (e as Error).message }, "runtime auth loop error");
      }
      await sleep(this.pollMs).catch(() => undefined);
    }
  }

  private finish(id: string, status: AuthStatus, detail: string, errorCode: string | null = null): void {
    run(
      this.ctx.db,
      "UPDATE runtime_auth_requests SET status = ?, detail = ?, error_code = ?, code = NULL, auth_url = NULL, updated_at = ? WHERE id = ?",
      status,
      detail.slice(0, 500),
      errorCode,
      nowIso(),
      id,
    );
  }

  private async handle(r: Row): Promise<void> {
    const principal: Principal = { kind: "user", userId: r.requested_by_id, username: r.requested_by_name };
    const rt = this.ctx.runtime;
    if (r.action === "check") {
      const d = await this.ops.runtimeDiagnostics(true);
      const auth = d.auth as { status?: string; detail?: string } | null;
      this.finish(r.id, "succeeded", auth ? `${auth.status}` : String(d.status));
      return;
    }
    const home = this.ctx.config.agyHome;
    if (!(rt instanceof AntigravityCliRuntime) || !home) {
      this.finish(r.id, "failed", "this worker does not manage an Antigravity sign-in (needs live mode and JONATHON_AGY_HOME)", "UNAVAILABLE");
      return;
    }
    const controller = new AbortController();
    this.current = controller;
    try {
      if (r.action === "sign_in") await this.signIn(r, rt, controller.signal, principal);
      else await this.signOut(r, rt, home, principal);
    } finally {
      this.current = null;
    }
  }

  private async signIn(r: Row, rt: AntigravityCliRuntime, signal: AbortSignal, principal: Principal): Promise<void> {
    const outcome = await rt.signIn({
      signal,
      onUrl: (url) => {
        run(
          this.ctx.db,
          "UPDATE runtime_auth_requests SET status = 'awaiting_code', auth_url = ?, expires_at = ?, updated_at = ? WHERE id = ? AND status = 'running'",
          url,
          new Date(Date.now() + CODE_WINDOW_MS).toISOString(),
          nowIso(),
          r.id,
        );
      },
      waitForCode: async (codeSignal) => {
        for (;;) {
          if (codeSignal.aborted) throw new Error("sign-in stopped");
          // Read and erase the code in one transaction: it is stored only until this moment.
          const got = tx(this.ctx.db, () => {
            const row = one<Row>(this.ctx.db, "SELECT * FROM runtime_auth_requests WHERE id = ?", r.id);
            if (!row || row.status === "cancelled" || row.status === "expired") return { stop: row?.status ?? "missing" };
            if (row.code) {
              run(this.ctx.db, "UPDATE runtime_auth_requests SET code = NULL, updated_at = ? WHERE id = ?", nowIso(), r.id);
              return { code: row.code };
            }
            if (row.expires_at && row.expires_at < nowIso()) return { stop: "expired" };
            return {};
          });
          if ("code" in got && got.code) return got.code;
          if ("stop" in got && got.stop) throw new Error(got.stop === "cancelled" ? "sign-in cancelled" : "the sign-in link expired before a code was entered; start again");
          await sleep(300);
        }
      },
    });
    if (!outcome.ok) {
      const current = one<{ status: string }>(this.ctx.db, "SELECT status FROM runtime_auth_requests WHERE id = ?", r.id);
      const status: AuthStatus = current?.status === "cancelled" ? "cancelled" : outcome.code === "TIMEOUT" ? "expired" : "failed";
      this.finish(r.id, status, outcome.message, outcome.code);
      audit(this.ctx.db, { principal, action: "runtime.sign_in_failed", entityType: "runtime_auth", entityId: r.id, details: { reason: outcome.code } });
      this.log.warn({ request: r.id, reason: outcome.code }, "agy sign-in did not complete");
      return;
    }
    const d = await this.ops.runtimeDiagnostics(true);
    const auth = d.auth as { status?: string; detail?: string } | null;
    if (auth?.status === "authenticated") {
      this.finish(r.id, "succeeded", `signed in; ${auth.detail ?? ""}`.trim());
      audit(this.ctx.db, { principal, action: "runtime.signed_in", entityType: "runtime_auth", entityId: r.id });
      this.log.info({ request: r.id }, "agy signed in");
    } else {
      this.finish(r.id, "failed", `agy accepted the code but does not report a sign-in (${auth?.status ?? "unknown"})`, "NOT_PERSISTED");
      audit(this.ctx.db, { principal, action: "runtime.sign_in_failed", entityType: "runtime_auth", entityId: r.id, details: { reason: "NOT_PERSISTED" } });
    }
  }

  private async signOut(r: Row, rt: AntigravityCliRuntime, home: string, principal: Principal): Promise<void> {
    let removed = rt.clearSignIn(home, false);
    let auth = await rt.checkAuthentication();
    if (auth.status === "authenticated") {
      removed = removed.concat(rt.clearSignIn(home, true));
      auth = await rt.checkAuthentication();
    }
    await this.ops.runtimeDiagnostics(true).catch(() => undefined);
    if (auth.status === "authenticated") {
      this.finish(r.id, "failed", "agy still reports a sign-in after its stored credentials were removed", "STILL_SIGNED_IN");
      audit(this.ctx.db, { principal, action: "runtime.sign_out_failed", entityType: "runtime_auth", entityId: r.id });
      return;
    }
    const confirmed = auth.status === "auth_required";
    this.finish(r.id, "succeeded", confirmed ? "signed out" : "stored credentials removed; agy could not confirm the state");
    audit(this.ctx.db, { principal, action: "runtime.signed_out", entityType: "runtime_auth", entityId: r.id, details: { removed: removed.length, confirmed } });
    this.log.info({ request: r.id, removed: removed.length, confirmed }, "agy signed out");
  }
}
