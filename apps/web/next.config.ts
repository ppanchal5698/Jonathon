import type { NextConfig } from "next";

const API = process.env.JONATHON_API_URL ?? "http://127.0.0.1:4100";
const dev = process.env.NODE_ENV !== "production";

/**
 * The browser only talks to this origin. /api/v1/* is proxied to the local Jonathon API so the session
 * cookie is first-party and SameSite=Strict. The UI never reads the database, files or runtime directly.
 */
const config: NextConfig = {
  transpilePackages: ["@jonathon/contracts"],
  poweredByHeader: false,
  async rewrites() {
    return [{ source: "/api/v1/:path*", destination: `${API}/api/v1/:path*` }];
  },
  async headers() {
    const csp = [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      `connect-src 'self'${dev ? " ws: http://127.0.0.1:* http://localhost:*" : ""}`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; ");
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default config;
