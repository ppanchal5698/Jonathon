# ADR 0001: Jonathon architecture

* Status: accepted; sections 3, 4 and the runtime flags in 5 are superseded by ADR 0002 (Jonathon-owned storage, tool-free runtime)
* Date: 2026-11-16
* Decider: Parth (runtime choice), implementation agent (everything else)

## Context

Jonathon is a single-user, local-first requirements and knowledge service for client projects.
It ingests client material, preserves originals, extracts evidence, uses an AI CLI for
reasoning, keeps reviewed knowledge in Obsidian, and serves a Next.js UI plus an MCP endpoint
for Claude Code. See `docs/compatibility.md` for verified versions.

## Decisions

### 1. Process layout: three processes, one shared core

| Process | Entry | Binds |
|---|---|---|
| API + MCP server (Fastify) | `apps/server/src/main.ts` | `127.0.0.1:4100` |
| Worker (ingestion, answering, extraction jobs) | `apps/server/src/worker.ts` | none |
| Web UI (Next.js App Router) | `apps/web` | `127.0.0.1:3000` |

The worker lives in `apps/server` as a second entry point instead of a separate `apps/worker`
package. Both entry points compose the same `@jonathon/core` services, so HTTP routes, MCP tools
and jobs share one implementation of each operation. A separate package would only add another
build configuration.

The web UI never talks to SQLite, Obsidian, or the runtime. It calls the API through a Next.js
rewrite (`/api/*` → `127.0.0.1:4100`), so the browser sees one origin and the session cookie is
first-party.

### 2. Packages

* `packages/contracts`: zod v4 schemas shared by server, web and MCP (API DTOs, answer contract,
  error codes, MCP tool inputs). No Node-only imports.
* `packages/core`: config, db, security, vault, runtime, ingestion, retrieval, services, MCP tool
  registration. Subfolders replace the many small packages the brief suggested
  (`db`, `vault`, `gemini`, `ingestion`, ...). They are folders with explicit `index.ts` boundaries.
  Promoting one to a package later is mechanical.

Internal packages export TypeScript source. `tsx` runs the server and worker, Vitest runs the
tests, and Next.js compiles `@jonathon/contracts` through `transpilePackages`. This avoids
build-order coupling between workspace packages.

### 3. Storage and source of truth

* **Obsidian vault (via Local REST API)** is authoritative for project metadata, originals,
  extracted representations, requirements, decisions, questions, conflicts, specifications and
  knowledge history. Every entity file carries a stable opaque `id` in frontmatter.
* **SQLite (`node:sqlite`, WAL)** holds operational state: users, sessions, MCP tokens, jobs and
  leases, conversations, runtime session mappings, audit log, FTS5 indexes, and projections of
  vault entities.
* Projections are rebuildable from the vault (`POST /api/v1/ops/reindex`). Conversations, audit
  events, jobs and tokens are **not** reconstructable and need their own backup (`docs/operations.md`).
* No transaction spans SQLite and the vault. Writes go **vault first** (conditional
  `If-None-Match: *` / `If-Match`), then the projection. A crash between the two is repaired by
  reconciliation, which re-reads vault files and upserts projections by `id` and content hash.

### 4. Demo mode is explicit and labelled

`JONATHON_MODE=demo` swaps in:

* `DemoFilesystemVault`, which writes to `data/demo-vault/` with the same layout. Health and the UI
  report `vault: demo-filesystem` and a banner shows **DEMO MODE: not Obsidian**.
* `DemoExtractiveRuntime`, which uses no AI. It quotes retrieved evidence and builds heuristic drafts,
  labelled `provider: "demo-extractive"` with a warning on every answer.

Live mode never falls back to demo adapters. If Obsidian or the runtime is unavailable, the
operation fails with `OBSIDIAN_UNAVAILABLE` / `RUNTIME_UNAVAILABLE`.

### 5. Reasoning runtime: Antigravity CLI

* `ReasoningRuntime` interface; production implementation `AntigravityCliRuntime`.
* Spawned with an argument array (no shell): `agy --input-format stream-json --output-format
  stream-json --mode plan --sandbox --json-schema <app-owned schema file> [--conversation <uuid>]`.
* The prompt (instructions + bounded evidence) is written to stdin as one NDJSON line, then stdin closes.
* `cwd` is an empty per-project workspace under `data/runtime/workspaces/<project_id>/`. No client
  files are placed there. Evidence is passed in the prompt only.
* Environment is scrubbed to an allowlist (PATH, system and profile dirs, TEMP). Obsidian keys, the session
  secret and MCP tokens are never inherited.
* The stream guard aborts on an unexpected `permission_mode` or on any tool step other than `finish`.
* The CLI envelope (`result`), the model payload (`structured_output`) and the application schema
  (zod) are validated separately. One bounded repair attempt, then `INVALID_MODEL_OUTPUT`.
* Conversation mapping: (project, Jonathon conversation, runtime version) → `agy` conversation
  UUID captured from `init`. Never `--continue`. If resume fails, Jonathon starts a new runtime
  conversation, rebuilds bounded history from SQLite, and returns a `runtime_session_reset` warning.
* Turns in one conversation are serialized: answer jobs for a conversation are leased one at a time.

Gemini CLI 0.68.0 was evaluated first (verified `--session-id`, `--resume <uuid>`, `--policy`
deny-all). Parth chose Antigravity. The interface keeps a second adapter possible.

### 6. Jobs

Durable SQLite queue: `queued → running → (succeeded | partially_succeeded | failed | cancelled |
unsupported | needs_ocr | retrying)`. Leases with expiry handle crash recovery. Retries use bounded
exponential backoff, idempotency keys are unique, and cancellation is cooperative through
`cancel_requested` plus an `AbortSignal` into parsers and the runtime.

Answering is a job. API and MCP callers enqueue it and wait up to a fast-path deadline (default 25 s).
After that they get `{status:"pending", job_id}` and poll `get_job`. Polling is a Jonathon
application contract, not an MCP protocol feature.

### 7. Authentication and authorization

* Local account (scrypt hash), session cookie (`HttpOnly`, `SameSite=Strict`), CSRF double-submit
  header on writes, Host/Origin allowlist (DNS rebinding).
* MCP: bearer tokens `jon_...`, stored as SHA-256 hashes, shown once, scoped to projects and to
  `read` / `propose`. No MCP tool can approve anything.
* Every service method takes a `Principal` and an explicit `projectId`. Authorization is enforced
  in services, and every SQL query filters by `project_id`.

### 8. Retrieval

FTS5 lexical retrieval first, with project filter in the `WHERE` clause, exact requirement ID
lookup, and heading/page/cell locators on chunks. Embeddings are deferred behind a
`SemanticRetriever` interface until the lexical baseline is tested.

## Consequences

* Single machine, loopback only. Remote access needs a reverse proxy with TLS and is out of scope.
* Client content sent to the runtime leaves the machine and persists in Antigravity's local store.
* The runtime tool guard is containment, not a sandbox. Global deny rules are recommended
  (see `docs/threat-model.md`).
