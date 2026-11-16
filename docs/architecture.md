# Jonathon architecture

Jonathon is a single-user, local-first service that keeps client evidence, reviewed requirements and decisions,
and answers questions about them. People use it through a Next.js UI. Claude Code uses it through an MCP endpoint.
Both go through the same application services.

Decisions and their reasons are in [ADR 0001](adr/0001-architecture.md) and [ADR 0002](adr/0002-owned-storage-and-runtime-isolation.md).
Verified versions are in [compatibility.md](compatibility.md).

## Processes

```
 Browser (Parth)                         Claude Code
     │  http://127.0.0.1:3000                │  POST http://127.0.0.1:4100/mcp
     ▼                                       │  Authorization: Bearer jon_…
 ┌────────────────────┐   /api/v1/* proxy    │
 │ apps/web (Next.js) │──────────────┐       │
 └────────────────────┘              ▼       ▼
                         ┌───────────────────────────────────┐
                         │ apps/server  main.ts (Fastify)     │  loopback only
                         │  Host/Origin checks, session+CSRF, │
                         │  REST /api/v1, MCP Streamable HTTP │
                         └───────────────┬───────────────────┘
                                         │ same composition root (createApp)
                         ┌───────────────▼───────────────────┐
                         │ packages/core services             │
                         │  projects · sources · knowledge    │
                         │  answering · extraction · ops      │
                         │  authz · retrieval · audit · jobs  │
                         └──────┬───────────────┬────────────┘
                                │               │
            ┌───────────────────▼──┐   ┌────────▼──────────────────────┐
            │ SQLite (node:sqlite) │   │ Data root (files, authoritative)│
            │ users, sessions,     │   │ projects/<id>/project.md        │
            │ MCP token hashes,    │   │  sources/<src>/<rev>/original.* │
            │ conversations, jobs, │   │  extracted/<src>/<rev>.md       │
            │ approval events,     │   │  requirements/REQ-001.md …      │
            │ audit, projections,  │   │  history/<ID>/r<n>.md           │
            │ FTS5 index           │   │  specifications/<snapshot>.md   │
            └──────────▲───────────┘   └─────────────▲──────────────────┘
                       │ leases / jobs               │
            ┌──────────┴─────────────────────────────┴──┐
            │ apps/server worker.ts (separate process)   │
            │  ingest → extract (worker thread, limits)  │
            │  answer → AntigravityCliRuntime            │
            │  extract_knowledge → drafts only           │
            └──────────────────────┬─────────────────────┘
                                   │ spawn (no shell), stdin NDJSON
                     ┌─────────────▼──────────────────────────────┐
                     │ agy --agent jonathon-reasoner|extractor     │
                     │  --settings <deny policy> --json-schema …   │
                     │  --sandbox --disable-slash-commands         │
                     │  cwd = runtime-workspaces/<project> (empty) │
                     └─────────────┬──────────────────────────────┘
                                   │ provider API (Google / third-party model)
                                   ▼
```

## Request flows

### Upload → evidence

1. `POST /api/v1/projects/:id/sources` (multipart, several files). The server authorizes the request, checks the size,
   cleans up the display name, hashes the content and checks for a duplicate in the same project.
2. The original is written **create-only** to `sources/<src>/<rev>/original.<ext>`, followed by `metadata.json`.
3. An `ingest` job is queued (idempotency key `ingest:<rev>`).
4. The worker detects the type from **content and extension together**, then runs the parser in a **worker thread** with a
   wall-clock timeout and a heap limit. It writes `extracted/<src>/<rev>.md` and `.locators.json`, then indexes
   the chunks (FTS5) with locators: page, sheet and range, heading path, line, slide, JSON pointer.
5. If AI processing is enabled for the project, an `extract_knowledge` job proposes **drafts**. Every statement is
   `proposed`, and its basis is decided by the server through a verbatim match against the cited evidence.

### Question → answer

1. `ask` (UI or MCP) authorizes the project and conversation ownership, stores the user message, and queues an `answer`
   job serialized per conversation. The caller waits up to `JONATHON_ASK_WAIT_MS`, then gets `{status:"pending", job_id}`.
2. The worker retrieves project-scoped evidence (FTS5, exact IDs, approved knowledge and open blockers in the feature scope,
   the previous question and the previous answer's evidence for follow-ups) and labels each item's authority.
3. If nothing is found, the answer is `insufficient_evidence` and the model is never called. If AI is disabled,
   the answer lists the evidence without any model.
4. Otherwise it builds a bounded prompt with fenced, untrusted evidence and history. It resumes the explicitly mapped runtime
   conversation (never "most recent"), runs `agy`, and validates the envelope, then the model JSON, then the application schema
   (with one repair attempt). It allows bounded `request_more_evidence` iterations within the same project.
5. Server-side checks: citations must reference supplied evidence and existing chunks in this project. Quotes are
   matched verbatim. Unknown requirement or decision IDs are dropped. Open conflicts are always surfaced. Readiness is
   feature-scoped and overridden by known blockers, unapproved knowledge or unverifiable citations.
6. The answer is persisted with an evidence snapshot (`answer_sources`), so later changes mark it stale.

### Approval

Only the signed-in human can approve, reject, supersede, resolve or answer, and each action needs a typed confirmation
phrase (`approve REQ-001`). The approval event records the entity revision and semantic hash. An entity is approved
only while its current content still matches that event. See ADR 0002.

## Package map

| Path | Role |
|---|---|
| `packages/contracts` | Zod schemas shared by server, web and MCP: domain, API bodies, answer contract, model output schemas, error codes |
| `packages/core/src/db` | `node:sqlite` open, migrations, `tx()` (BEGIN IMMEDIATE) |
| `packages/core/src/storage` | Safe paths, atomic and create-only writes, entity Markdown format, `KnowledgeStore`, `ProjectFiles` |
| `packages/core/src/security` | Principals and authorization, scrypt passwords, sessions, MCP tokens |
| `packages/core/src/jobs` | Durable queue (leases, retries, cancel, recovery) and the worker loop |
| `packages/core/src/runtime` | `AntigravityCliRuntime`, policy files, NDJSON parser, process-tree kill, demo runtime |
| `packages/core/src/ingestion` | Type detection, extractors, chunker, worker-thread isolation |
| `packages/core/src/retrieval` | FTS5 indexer and project-scoped search |
| `packages/core/src/services` | Projects, sources, knowledge governance, answering, extraction, operations |
| `packages/core/src/mcp` | MCP tool registration (official SDK v2) |
| `apps/server` | Fastify API and MCP endpoint (`main.ts`), worker (`worker.ts`) |
| `apps/web` | Next.js App Router UI |
| `packages/test-fixtures` | Fictional demo project, fake `agy` for fixture playback |
