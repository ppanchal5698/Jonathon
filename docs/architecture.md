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

### Project memory graph (`services/graph.ts`)

Every project has a graph that connects everything Jonathon holds about it:

| Node | From |
|---|---|
| client document, passage | sources and their extracted chunks (current revisions only) |
| requirement, decision, open question, conflict, change proposal | knowledge entities |
| concept (actor, feature, system, external system, data entity, technology, business term, environment, metric, organization, workflow, regulation) | the `jonathon-graph` agent, one `graph_extract` job per uploaded revision |
| generated document | `documents/<doc_type>.json` |

| Link | Confidence | How it is found |
|---|---|---|
| document contains passage; knowledge cites passage; knowledge → knowledge (depends on, about, resolves, changes, references) | EXTRACTED | recorded structure |
| passage / knowledge **mentions** concept | EXTRACTED | code: the concept's name or an alias appears in the text (word-bounded, case and punctuation ignored) |
| concept → concept (uses, integrates with, stores, hosted on, authenticates with ...) | INFERRED | the agent labels it; kept only when its quote is found word for word in a passage it cites and both ends are known concepts |
| generated document built from passage / knowledge / concept | EXTRACTED | the document's citations |

The agent's concepts are kept only when their name (or an alias) is in a passage they cite; everything else is listed
with its reason in the job result. Concepts are merged across documents by normalized name and alias. Extractions are
stored per revision under `graph/extractions/<revision>.json`; the graph itself is computed from those files and the
database and cached per project state. When a document is removed, its passages, its extraction and every concept and
relation that only it supported disappear. Communities come from deterministic label propagation.

The graph is also written to `graph/graph.json` in graphify's node-link format (`nodes` with `id`, `label`,
`file_type`, `source_file`, `community`; `links` with `source`, `target`, `relation`, `confidence`,
`confidence_score`, `source_file`). graphify's offline commands (`query`, `path`, `explain`, `affected`, `god-nodes`,
`export html|obsidian|wiki|graphml`) can read it with `--graph <file>`. Jonathon does not run graphify's own
`extract`: that would send client content to a second model provider with separate keys, outside Jonathon's
review and audit.

### Generated technical documents (`services/documents.ts`, `docs/catalogue.ts`)

The catalogue has 66 document types in 10 categories (requirements, architecture, backend, frontend, database,
integrations, security, DevOps, engineering standards, testing); 25 are marked must-have. Each type lists its
sections, the search topics that find its client passages and the concept kinds it needs. A section is either:

* **compiled** by code from knowledge and the graph (requirement lists by type, acceptance criteria, stated NFR numbers,
  decisions, open questions and conflicts relevant to the document, concept tables with a verbatim sentence from the
  client material, document inventory, traceability matrix). No model; always in sync.
* **written** by `jonathon-doc-writer`, which returns typed blocks: *fact* (must cite E evidence or knowledge IDs),
  *proposal* (engineering recommendation, never presented as a client requirement), *gap* (a question the material
  does not answer) and *diagram* (Mermaid). Then:
  1. Code gate: unknown citations are dropped; a fact without a valid citation, or with numbers not in what it cites,
     is removed; diagrams must be Mermaid. Facts whose wording is in the cited evidence are `client_stated`.
  2. `jonathon-doc-verifier` checks restated facts (F) and proposals (P). Unsupported items are removed with the
     reason; a fact the verifier did not rule on is downgraded to an AI proposal (fail closed).

Every block carries its basis (`client_stated`, `evidence_based`, `knowledge`, `ai_proposed`, `gap`,
`human_authored`) and its references. Storage: `documents/<doc_type>.json` (authoritative), a Markdown rendering
next to it, and `documents/history/<doc_type>/r<n>.json` for every revision. The `generated_documents` table is a
projection, re-imported from the files when missing.

**Keeping documents current.** Written sections store a fingerprint of their inputs (the passages chosen for the
document with content hashes, the knowledge items with semantic hashes, the concepts, the section spec and the prompt
version). A `generate_documents` job in refresh mode is queued (debounced 45 s, coalesced into one job with the
reasons) after a knowledge change, a concept mapping or a source deletion. It waits while ingest, drafting or mapping
jobs are still running, then recompiles compiled sections and calls the writer only for documents whose fingerprint
changed. Each revision records why it was made and what it added and removed.

**Human edits.** Editing a section stores the person's Markdown and marks the section `human_edited`. Regeneration
never replaces it: new content is kept in `pending_update` until the person chooses "use regenerated" or "keep my
edit". If the Markdown file was edited outside Jonathon, it is copied to history before it is re-rendered. Approval
needs the human session and the phrase `approve <doc_type>`, is refused while a section has a pending update, and is
valid only for the exact revision and content hash (`approval_events`, entity type `document`).

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
