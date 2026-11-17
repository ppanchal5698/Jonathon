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
5. If AI processing is enabled for the project, an `extract_knowledge` job is queued automatically and proposes, for review:
   * **requirements** (draft, with a description and `proposed` statements whose basis is decided by the server through a
     verbatim match against the cited evidence);
   * **open questions**, including the ones raised while drafting a requirement (linked to it, listed in its
     `open_questions` section by ID);
   * **conflicts** between evidence blocks, or between the new document and an existing requirement (that requirement's
     evidence becomes side 2 and it is listed in `related_requirements`);
   * **change proposals** (`CHANGE-n`) when the document adds to or changes an existing requirement. The prompt lists
     existing requirements by ID; a proposal stores a replacement description and/or additions as
     `[<section> · client-stated|AI-inferred] text`, plus the base revision and evidence.
   To catch disagreements between documents whatever order they arrive in, each batch also carries up to 8 short
   passages from the project's **other** documents (project-scoped full-text search on the batch's distinctive terms,
   plus one search per technology or timeline topic it mentions, e.g. a database name → "database"). The model may use
   these `O` passages only for conflicts; the drafted document is always side 1, and requirements, updates and questions
   can cite only the drafted document. Drafting runs one document at a time per project.
   Near-duplicates of existing items are skipped (normalized text, token overlap with plural folding). Nothing produced
   here is approved or applied.

### Agent team (`JONATHON_AGENT_TEAM`, default on)

Drafting and answering are done by a team of tool-free `agy` agents, each defined in the runtime workspace with its own
system prompt, its own JSON schema and exactly one job. Code orchestrates them and has the last word.

| Step | Agent / check | Job |
|---|---|---|
| 1 | `jonathon-classifier` (once per document) | Document kind (requirements spec, brief, setup guide, plan/estimate, notes, other), subject system, numbering prefixes. Routes the specialists: plans and estimates never get the requirements or change specialists. |
| 2 | `jonathon-requirements`, `jonathon-questions`, `jonathon-conflicts`, `jonathon-changes` (in parallel per batch) | Each drafts only its own kind of item from the batch. Only the conflicts specialist sees other-document `O` passages. |
| 3 | Code gate | Drops any statement, question, conflict side or requirement title whose numbers or client IDs are not in the evidence it cites (evidence IDs such as `E3` and Jonathon IDs are ignored). |
| 4 | `jonathon-draft-verifier` | Gets every remaining candidate (`R1`, `R1-2`, `Q1`, `C1`, `U1` ...) and only the evidence those candidates cite. Returns supported / partly supported (with the unsupported statement IDs) / unsupported. Fail-closed: a candidate without a verdict is not kept. |
| 5 | Code | Statement basis (client-stated vs AI-inferred) by wording match, de-duplication, persistence as drafts. |

Every removal (by the code gate or the verifier) is recorded with its reason in the job result and shown under the
document on the Documents page. If any agent fails or returns output that does not match its schema, the job fails
(retryable) and nothing unverified is saved.

Answers: after the answering agent, `jonathon-answer-verifier` checks each sentence of the draft answer (`S1`, `S2` ...)
against the same evidence. Unsupported claims are removed from the answer and listed with the reason
(`answer.verification`); the status is lowered from `answered` and readiness is denied. If the verifier cannot run, the
answer is kept but labelled unverified and is never `answered`. Retrieval always includes the best original source
passages in addition to the mixed search, so derived drafts cannot crowd out client text.

Team agents run in parallel up to `AGY_MAX_CONCURRENT` (default 4) `agy` processes per process; further runs wait for a
slot. All team roles use the extraction effort (`AGY_EXTRACTION_EFFORT`, default `low`). Demo mode and
`JONATHON_AGENT_TEAM=false` use the earlier single-agent drafting and unverified answers.

### Review (accept / edit / reject / delete)

The project's **Review** tab lists every item still waiting for a human: draft or in-review requirements and decisions,
open questions and conflicts not yet reviewed, and open change proposals. Each action opens a confirmation dialog; the
server still requires the human session and the exact `<verb> <ID>` phrase, which the dialog sends after the click.

| Action | Requirement / decision | Open question / conflict | Change proposal |
|---|---|---|---|
| Accept | `approve`: marks every proposed statement reviewed and approves, in **one** revision, with an approval event | `accept`: sets `reviewed: true`; stays open until answered / resolved | `accept`: applies the description/additions to the requirement (new revision; an approved requirement returns to `in_review` and dependants go stale) and marks the proposal `accepted`. Refused if the requirement's content changed since the proposal's base revision. Free-text proposals are only marked accepted. |
| Edit | structured editor; edited statements become `human_authored`; editing approved content returns it to review | structured editor; counts as reviewed | not editable |
| Reject | `rejected` | `withdrawn` / `dismissed` | `rejected` |
| Delete | `delete <ID>`: removes the live file, projection row and search chunk. `history/<ID>/` keeps every revision plus a `deleted-r<n>.json` tombstone; the ID is never reused and reconciliation never re-imports it. Open proposals for a deleted requirement become `stale`. |||

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

Only the signed-in human can approve, reject, supersede, resolve, answer, accept or delete, and each action needs the
confirmation phrase (`approve REQ-001`): typed by hand on the entity page's "Other status changes", conflict-resolution and
answer forms, or sent by the review dialog after the user confirms. The approval event records the entity revision and semantic hash. An entity is approved
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
