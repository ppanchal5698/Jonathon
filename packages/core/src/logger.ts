import pino, { type Logger } from "pino";

export type { Logger };

/** Structured logger. Never logs auth headers, cookies, keys or document bodies. */
export function createLogger(level: string, name: string): Logger {
  return pino({
    name,
    level,
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
      ],
      censor: "[redacted]",
    },
  });
}
