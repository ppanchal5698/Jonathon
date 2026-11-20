import { createHash } from "node:crypto";
import { audit } from "../audit";
import type { JonathonConfig } from "../config";
import { type Db, one, run, tx } from "../db";
import { AppError, newId, nowIso, randomToken, sha256 } from "../util";
import type { AuthService, SessionInfo } from "./auth";

/**
 * Sign in with Google (OpenID Connect, authorization code + PKCE) for Jonathon's single local account.
 *
 * - start(): random state, nonce and PKCE verifier stored server-side (oauth_states, 10 min), plus a random "binder"
 *   that only the starting browser holds (HttpOnly cookie); the callback must present both.
 * - callback(): the code is exchanged at Google's token endpoint with the client secret and the PKCE verifier. The ID
 *   token comes straight from Google over TLS on that back-channel (OIDC Core 3.1.3.7 permits skipping its signature
 *   check in that case); its iss, aud, azp, exp, nonce and email_verified are checked.
 * - Owner binding: the first Google account to sign in to an install without an account becomes the owner (the
 *   same rule as the old account form). Afterwards only that Google identity (sub) may sign in. JONATHON_GOOGLE_ALLOWED_EMAILS
 *   restricts even the first sign-in.
 * - Nothing from Google is stored except the account's sub and email. Google's access/refresh tokens are discarded.
 */

const STATE_TTL_MS = 10 * 60_000;
const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export interface GoogleIdentity {
  sub: string;
  email: string;
}

export class GoogleSignIn {
  constructor(
    private readonly db: Db,
    private readonly config: JonathonConfig,
    private readonly auth: AuthService,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get enabled(): boolean {
    return !!this.config.google;
  }

  private get g() {
    if (!this.config.google) throw new AppError("NOT_FOUND", "Sign in with Google is not configured");
    return this.config.google;
  }

  /** Returns Google's authorization URL and the binder to set as a cookie. */
  start(): { url: string; binder: string } {
    const g = this.g;
    const state = randomToken(24);
    const binder = randomToken(24);
    const verifier = randomToken(48);
    const nonce = randomToken(24);
    const now = Date.now();
    run(this.db, "DELETE FROM oauth_states WHERE expires_at < ?", nowIso());
    run(
      this.db,
      "INSERT INTO oauth_states (state, binder_hash, code_verifier, nonce, created_at, expires_at) VALUES (?,?,?,?,?,?)",
      state,
      sha256(binder),
      verifier,
      nonce,
      new Date(now).toISOString(),
      new Date(now + STATE_TTL_MS).toISOString(),
    );
    const url = new URL(g.authUrl);
    url.search = new URLSearchParams({
      client_id: g.clientId,
      redirect_uri: g.redirectUri,
      response_type: "code",
      scope: "openid email",
      state,
      nonce,
      code_challenge: b64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    return { url: url.toString(), binder };
  }

  /** Finish a sign-in. Throws UNAUTHENTICATED/FORBIDDEN with a message safe to show. */
  async callback(
    q: { state?: string; code?: string; error?: string },
    binder: string | undefined,
  ): Promise<{ token: string; session: SessionInfo; created: boolean }> {
    const g = this.g;
    if (q.error) throw new AppError("UNAUTHENTICATED", q.error === "access_denied" ? "Google sign-in was cancelled" : "Google did not complete the sign-in");
    if (!q.state || !q.code || q.state.length > 200 || q.code.length > 2_000)
      throw new AppError("UNAUTHENTICATED", "the sign-in response is incomplete; start again");
    // One-time use: the state row is deleted whatever happens next.
    const st = tx(this.db, () => {
      const row = one<{ binder_hash: string; code_verifier: string; nonce: string; expires_at: string }>(
        this.db,
        "SELECT * FROM oauth_states WHERE state = ?",
        q.state!,
      );
      if (row) run(this.db, "DELETE FROM oauth_states WHERE state = ?", q.state!);
      return row;
    });
    if (!st || st.expires_at < nowIso()) throw new AppError("UNAUTHENTICATED", "the sign-in link expired or was already used; start again");
    if (!binder || sha256(binder) !== st.binder_hash) throw new AppError("UNAUTHENTICATED", "this sign-in was started in another browser; start again here");

    const res = await this.fetchImpl(g.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: q.code,
        redirect_uri: g.redirectUri,
        client_id: g.clientId,
        client_secret: g.clientSecret,
        code_verifier: st.code_verifier,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    }).catch((e) => {
      throw new AppError("UNAUTHENTICATED", "could not reach Google; check the internet connection and start again", { cause: e });
    });
    const body = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
    if (!res.ok || !body.id_token) {
      throw new AppError(
        "UNAUTHENTICATED",
        body.error === "invalid_client" ? "Google rejected Jonathon's OAuth client id or secret" : "Google rejected the sign-in; start again",
      );
    }
    const id = this.verifyIdToken(body.id_token, st.nonce);
    return this.bindOwner(id);
  }

  /** Claims of an ID token received directly from Google's token endpoint over TLS. */
  verifyIdToken(idToken: string, nonce: string): GoogleIdentity {
    const g = this.g;
    const parts = idToken.split(".");
    if (parts.length !== 3) throw new AppError("UNAUTHENTICATED", "Google returned an unreadable identity");
    let c: Record<string, unknown>;
    try {
      c = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new AppError("UNAUTHENTICATED", "Google returned an unreadable identity");
    }
    const now = Math.floor(Date.now() / 1000);
    const audOk = c.aud === g.clientId || (Array.isArray(c.aud) && c.aud.includes(g.clientId) && c.azp === g.clientId);
    if (!["https://accounts.google.com", "accounts.google.com"].includes(String(c.iss))) throw new AppError("UNAUTHENTICATED", "identity not issued by Google");
    if (!audOk) throw new AppError("UNAUTHENTICATED", "identity was issued for a different application");
    if (typeof c.exp !== "number" || c.exp < now - 60) throw new AppError("UNAUTHENTICATED", "the identity has expired; start again");
    if (c.nonce !== nonce) throw new AppError("UNAUTHENTICATED", "the identity does not belong to this sign-in; start again");
    if (typeof c.sub !== "string" || !c.sub || typeof c.email !== "string") throw new AppError("UNAUTHENTICATED", "Google did not share the account's email");
    if (c.email_verified !== true && c.email_verified !== "true") throw new AppError("FORBIDDEN", "this Google account's email is not verified");
    return { sub: c.sub, email: c.email.toLowerCase() };
  }

  private bindOwner(id: GoogleIdentity): { token: string; session: SessionInfo; created: boolean } {
    const g = this.g;
    if (g.allowedEmails.length && !g.allowedEmails.includes(id.email)) {
      throw new AppError("FORBIDDEN", `${id.email} is not allowed to sign in to this Jonathon`);
    }
    return tx(this.db, () => {
      const bound = one<{ id: string; username: string }>(this.db, "SELECT id, username FROM users WHERE google_sub = ?", id.sub);
      if (bound) {
        run(this.db, "UPDATE users SET email = ? WHERE id = ?", id.email, bound.id);
        return { ...this.auth.startSession(bound, "google"), created: false };
      }
      const owner = one<{ id: string; username: string; google_sub: string | null; email: string | null }>(
        this.db,
        "SELECT id, username, google_sub, email FROM users LIMIT 1",
      );
      if (!owner) {
        const userId = newId("usr");
        const username = id.email.slice(0, 64);
        // No password: "!" can never match a scrypt hash, so the password route stays closed for this account.
        run(
          this.db,
          "INSERT INTO users (id, username, password_hash, created_at, google_sub, email) VALUES (?,?,?,?,?,?)",
          userId,
          username,
          "!",
          nowIso(),
          id.sub,
          id.email,
        );
        audit(this.db, { principal: { kind: "user", userId, username }, action: "account.created", details: { via: "google" } });
        return { ...this.auth.startSession({ id: userId, username }, "google"), created: true };
      }
      // An install created with a password links to Google only for an explicitly allowed email.
      if (!owner.google_sub && g.allowedEmails.includes(id.email)) {
        run(this.db, "UPDATE users SET google_sub = ?, email = ? WHERE id = ?", id.sub, id.email, owner.id);
        audit(this.db, {
          principal: { kind: "user", userId: owner.id, username: owner.username },
          action: "account.linked_google",
          details: { email: id.email },
        });
        return { ...this.auth.startSession(owner, "google"), created: false };
      }
      throw new AppError("FORBIDDEN", "this Jonathon belongs to another Google account");
    });
  }
}
