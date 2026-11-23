import pino, { type Logger } from "pino";

export type { Logger };

/** OAuth/OIDC values that must never reach logs (authorization codes, state, tokens), in any URL query string. */
const SECRET_QUERY = /([?&](?:code|state|id_token|access_token|refresh_token|token|client_secret|code_verifier|nonce)=)[^&#\s]*/gi;

export function redactUrl(url: string): string {
  return url.replace(SECRET_QUERY, "$1[redacted]");
}

/** Structured logger. Never logs auth headers, cookies, keys, OAuth codes or document bodies. */
export function createLogger(level: string, name: string): Logger {
  return pino({
    name,
    level,
    serializers: {
      // Fastify logs every request's URL. The Google sign-in callback carries ?code=…&state=… in it.
      req: (req: { method?: string; url?: string; host?: string; hostname?: string; id?: string }) => ({
        method: req.method,
        url: typeof req.url === "string" ? redactUrl(req.url) : req.url,
        host: req.host ?? req.hostname,
      }),
    },
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'req.headers["x-csrf-token"]',
        "res.headers['set-cookie']",
        "*.apiKey",
        "*.api_key",
        "*.password",
        "*.token",
        "*.plaintext",
        "*.text",
        "*.content",
        "*.prompt",
        "*.auth_url",
      ],
      censor: "[redacted]",
    },
  });
}
